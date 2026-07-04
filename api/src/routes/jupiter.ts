import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import type { Role } from '../auth/jwt.js';

// Jupiter — the portal's badges endpoint. Returns pending-work counts ONLY for the
// apps the caller's role may enter (never leak a count for an app the caller can't
// open). Phase 1: no SSO, any authenticated account, today's localStorage-JWT auth.
// See docs/JUPITER_BRIEF.md §5.
//
// Role→app "who may enter" map (mirrors the actual route gates in the suite):
//   - Minerva (web/)   : agent + supervisor      → /api/queue, requireAuth only
//   - Vulcan  (vulcan/): supervisor only         → /api/stock/*, requireRole('supervisor')
//   - Juno    (juno/)  : supervisor only         → /api/juno/*,  requireRole('supervisor')
//   - Ceres   (ceres/) : messenger + md + CEO    → /api/ceres/*, requireCeresRole(...)
//
// The auth layer now issues 'agent' | 'supervisor' | 'messenger' | 'md' (see auth/jwt.ts).
// Ceres maps those onto its own vocabulary (ceres/auth.ts): messenger→messenger, md→md,
// supervisor→ceo; a plain 'agent' has NO Ceres access. A Ceres badge is only ever emitted
// for a caller whose role can actually enter Ceres.

// A tiny in-process cache keyed by the shape of counts a role can see. Badges are a
// glance-level hint (a small number on a tile), not an authoritative figure, so a ~30s
// staleness is fine and spares the DB a burst of count() queries when the whole team
// opens the portal at once. Most counts are global, so the cache key is the role bucket —
// EXCEPT the Ceres messenger badge, which is per-user (a messenger sees only their OWN
// drafts/rejections). For messengers the key is therefore role+agentId so one messenger's
// count is never served to another. See cacheKey() below.
const CACHE_TTL_MS = 30_000;

type BadgeBucket = { minerva?: { pending: number }; juno?: { toVerify: number }; vulcan?: { lowStock: number }; ceres?: { awaitingAction: number } };
const cache = new Map<string, { at: number; value: BadgeBucket }>();

// Which apps each role may ENTER. Keep this the single source of truth for gating so a
// count is computed only when the caller can open the app it belongs to.
const MINERVA_ENTER: Role[] = ['agent', 'supervisor'];
const VULCAN_ENTER: Role[] = ['supervisor'];
const JUNO_ENTER: Role[] = ['supervisor'];
// Ceres: messenger + md self-entry/approval, plus the CEO (supervisor) for oversight.
const CERES_ENTER: Role[] = ['messenger', 'md', 'supervisor'];

// Minerva "pending" = customers whose LATEST message is a customer message that is still
// awaiting a reply (after any "ตอบแล้ว" answeredThroughAt cutoff). This mirrors the
// /api/queue waiting filter (console.ts) but as a single set-based count instead of
// loading every customer + newest message into JS. The correlated subquery finds each
// active customer's newest message once (indexed on Message.customerId).
async function minervaPending(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n
    FROM "Customer" c
    WHERE c.active = true
      AND EXISTS (
        SELECT 1 FROM "Message" m
        WHERE m."customerId" = c.id
          AND m.role = 'customer'
          AND (c."answeredThroughAt" IS NULL OR m."createdAt" > c."answeredThroughAt")
          AND m."createdAt" = (
            SELECT max(m2."createdAt") FROM "Message" m2 WHERE m2."customerId" = c.id
          )
      )`;
  return Number(rows[0]?.n ?? 0);
}

// Vulcan low-stock = active products at/below their reorder point. Column-vs-column
// compare → raw SQL (same query the Vulcan summary uses in stock.ts).
async function vulcanLowStock(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM "Product"
    WHERE status = 'active' AND stock IS NOT NULL AND "reorderPoint" IS NOT NULL
      AND stock <= "reorderPoint"`;
  return Number(rows[0]?.n ?? 0);
}

// Juno to-verify = Payment rows still in 'received' (not yet verified). Indexed on status.
async function junoToVerify(): Promise<number> {
  return prisma.payment.count({ where: { status: 'received' } });
}

// Ceres "awaiting action" — computed per the CALLER's Ceres role so the badge matches
// exactly what THAT person can act on (never a queue they can't touch). Field names
// verified against api/prisma/schema.prisma (CeresExpense.status/partyId,
// CeresPaymentRequest.status, CeresParty.agentEmail).
//   - ceo (supervisor): escalated payment requests — the only queue the CEO alone clears
//     (requests/:id/decide is requireCeresRole('ceo')). Indexed on status.
//   - md              : pending expenses awaiting her approve/reject (global, not party-
//     scoped — the MD approves ANY pending expense). Indexed on status.
//   - messenger       : their OWN drafts + rejections — pending (still editable/deletable)
//     and rejected (needs fixing/resubmit), scoped to the messenger's own party. Per-user.
async function ceresCeoAwaiting(): Promise<number> {
  return prisma.ceresPaymentRequest.count({ where: { status: 'escalated' } });
}
async function ceresMdAwaiting(): Promise<number> {
  return prisma.ceresExpense.count({ where: { status: 'pending' } });
}
async function ceresMessengerAwaiting(agentEmail: string): Promise<number> {
  // A messenger's expenses are keyed by their own CeresParty (the login→party link).
  // No party ⇒ nothing to act on. Count only rows this messenger can still act on.
  const party = await prisma.ceresParty.findFirst({ where: { agentEmail }, select: { id: true } });
  if (!party) return 0;
  return prisma.ceresExpense.count({ where: { partyId: party.id, status: { in: ['pending', 'rejected'] } } });
}

export async function jupiterRoutes(app: FastifyInstance) {
  // GET /api/jupiter/badges — pending-work counts, gated to the apps this role can enter.
  app.get('/api/jupiter/badges', { preHandler: requireAuth }, async (req) => {
    const agent = req.agent!;
    const role = agent.role;

    // The Ceres messenger badge is per-user, so its cache key must include the agent id;
    // every other badge in the bucket is global, so a plain role key suffices otherwise.
    const cacheKey = role === 'messenger' ? `messenger:${agent.id}` : role;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    // Compute ONLY the badges this role may see; an app the role can't enter is never queried.
    // Ceres resolves to a single count per role (ceo/md/messenger); a plain 'agent' — which
    // can't enter Ceres — gets no ceres query and no ceres key at all.
    const ceresAwaiting: Promise<number | null> = !CERES_ENTER.includes(role)
      ? Promise.resolve(null)
      : role === 'supervisor'
        ? ceresCeoAwaiting()
        : role === 'md'
          ? ceresMdAwaiting()
          : ceresMessengerAwaiting(agent.email);

    const [pending, lowStock, toVerify, awaitingAction] = await Promise.all([
      MINERVA_ENTER.includes(role) ? minervaPending() : Promise.resolve(null),
      VULCAN_ENTER.includes(role) ? vulcanLowStock() : Promise.resolve(null),
      JUNO_ENTER.includes(role) ? junoToVerify() : Promise.resolve(null),
      ceresAwaiting,
    ]);

    const value: BadgeBucket = {};
    if (pending !== null) value.minerva = { pending };
    if (lowStock !== null) value.vulcan = { lowStock };
    if (toVerify !== null) value.juno = { toVerify };
    if (awaitingAction !== null) value.ceres = { awaitingAction };

    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  });
}
