import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../db/prisma.js';
import { LOW_STOCK_WHERE } from '../db/lowStock.js';
import { requireAnyAuth } from '../auth/middleware.js';
import { hasAppAccess, type AppName } from '../auth/jwt.js';
import { ceresRole } from '../ceres/auth.js';
import { ageStuckAIReviews } from '../ceres/requestService.js';

// Pantheon — the portal's badges endpoint. Returns pending-work counts ONLY for the
// apps the caller may actually enter (never leak a count for an app they can't open).
// Phase 1: no SSO, any authenticated account, today's localStorage-JWT auth.
// See docs/JUPITER_BRIEF.md §5.
//
// Post unified-auth (PR #7): "who may enter an app" is a PER-PERSON grant, not a role
// list. hasAppAccess(agent, app) is the single gate (supervisor → everything; gm → its
// implicit GM_APPS; agm/employee → their own Agent.apps). We compute+emit a badge for an app IFF
// hasAppAccess is true for that app, so each person's badges match exactly the tiles they
// can open. AppName values (minerva | vesta | juno | ceres) come straight from auth/jwt.ts.
//
// Ceres has an extra persona layer on top of the grant: ceresRole(agent) maps a caller to
// 'ceo' | 'gm' | 'messenger' | null, and each persona has a DIFFERENT awaiting-action queue.
// hasAppAccess(agent,'ceres') and ceresRole(agent) !== null agree for every account, so we
// use ceresRole to both gate the ceres badge AND pick the right per-persona count.

// A tiny in-process cache keyed by exactly what counts a caller can see. Badges are a
// glance-level hint (a small number on a tile), not an authoritative figure, so a ~30s
// staleness is fine and spares the DB a burst of count() queries when the whole team opens
// the portal at once.
//
// Cache-key correctness under per-person grants: two accounts with the SAME role can now
// have DIFFERENT app grants (employee A has minerva+ceres, employee B has only ceres), so a
// role-only key would leak one person's set of counts to another. The key is therefore the
// caller's full identity — the agent id — for EVERY caller. (The Ceres messenger badge is
// per-user anyway.) This is strictly safe; the small cost is supervisors/GMs no longer share
// a cache slot, which is negligible at this team size.
const CACHE_TTL_MS = 30_000;

type BadgeBucket = { minerva?: { pending: number }; juno?: { toVerify: number }; vesta?: { lowStock: number }; ceres?: { awaitingAction: number }; mercury?: { pending: number } };
const cache = new Map<string, { at: number; value: BadgeBucket }>();

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

// Vesta low-stock = active products at/below their reorder point. Column-vs-column
// compare → raw SQL (same query the Vesta summary uses in stock.ts).
async function vestaLowStock(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM "Product" WHERE ${LOW_STOCK_WHERE}`;
  return Number(rows[0]?.n ?? 0);
}

// Juno to-verify = Payment rows still in 'received' (not yet verified). Indexed on status.
async function junoToVerify(): Promise<number> {
  return prisma.payment.count({ where: { status: 'received' } });
}

// Mercury pending = purchase requests still awaiting action ('pending'). Indexed on status.
async function mercuryPending(): Promise<number> {
  return prisma.mercuryRequest.count({ where: { status: 'pending' } });
}

// Ceres "awaiting action" — computed per the CALLER's Ceres persona so the badge matches
// exactly what THAT person can act on (never a queue they can't touch). Field names verified
// against api/prisma/schema.prisma (CeresExpense.status/partyId, CeresPaymentRequest.status,
// CeresParty.agentEmail).
//   - ceo (supervisor): escalated payment requests — the only queue the CEO alone clears
//     (requests/:id/decide is requireCeresRole('ceo')). Indexed on status.
//   - gm              : pending expenses awaiting approve/reject (global, not party-
//     scoped — the GM approves ANY pending expense). Indexed on status.
//   - messenger (an employee with the ceres grant): their OWN drafts + rejections — pending
//     (still editable/deletable) and rejected (needs fixing/resubmit), scoped to their own
//     party. Per-user.
async function ceresCeoAwaiting(): Promise<number> {
  await ageStuckAIReviews();
  return prisma.ceresPaymentRequest.count({
    where: {
      OR: [
        { workflowVersion: 1, status: 'escalated' },
        { workflowVersion: 2, approvalStatus: 'pending_ceo' },
      ],
    },
  });
}
async function ceresMdAwaiting(): Promise<number> {
  await ageStuckAIReviews();
  const [expenses, requests] = await Promise.all([
    prisma.ceresExpense.count({ where: { status: 'pending' } }),
    prisma.ceresPaymentRequest.count({ where: { workflowVersion: 2, approvalStatus: 'pending_nee' } }),
  ]);
  return expenses + requests;
}
async function ceresMessengerAwaiting(agentId: string, agentEmail: string): Promise<number> {
  // A messenger's expenses are keyed by their own CeresParty (the login→party link).
  // No party ⇒ nothing to act on. Count only rows this messenger can still act on.
  const party = await prisma.ceresParty.findFirst({ where: { agentEmail }, select: { id: true } });
  const [expenses, requests] = await Promise.all([
    party
      ? prisma.ceresExpense.count({ where: { partyId: party.id, status: { in: ['pending', 'rejected'] } } })
      : Promise.resolve(0),
    prisma.ceresPaymentRequest.count({
      where: { workflowVersion: 2, requestedById: agentId, approvalStatus: 'rejected' },
    }),
  ]);
  return expenses + requests;
}

async function badgesHandler(req: FastifyRequest): Promise<BadgeBucket> {
    const agent = req.agent!;

    // Per-person grants ⇒ cache per identity, never per role (see note above).
    const cacheKey = `agent:${agent.id}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const can = (a: AppName) => hasAppAccess(agent, a);

    // Ceres resolves to a single count per persona (ceo/gm/messenger). A caller without the
    // ceres grant has ceresRole === null and gets no ceres query and no ceres key at all.
    const cRole = ceresRole(agent);
    const ceresAwaiting: Promise<number | null> = cRole === null
      ? Promise.resolve(null)
      : cRole === 'ceo'
        ? ceresCeoAwaiting()
        : cRole === 'gm'
          ? ceresMdAwaiting()
          : ceresMessengerAwaiting(agent.id, agent.email);

    // Compute ONLY the badges this caller may see; an app they can't enter is never queried.
    const [pending, lowStock, toVerify, awaitingAction, mercuryPend] = await Promise.all([
      can('minerva') ? minervaPending() : Promise.resolve(null),
      can('vesta') ? vestaLowStock() : Promise.resolve(null),
      can('juno') ? junoToVerify() : Promise.resolve(null),
      ceresAwaiting,
      can('mercury') ? mercuryPending() : Promise.resolve(null),
    ]);

    const value: BadgeBucket = {};
    if (pending !== null) value.minerva = { pending };
    if (lowStock !== null) value.vesta = { lowStock };
    if (toVerify !== null) value.juno = { toVerify };
    if (awaitingAction !== null) value.ceres = { awaitingAction };
    if (mercuryPend !== null) value.mercury = { pending: mercuryPend };

    cache.set(cacheKey, { at: Date.now(), value });
    return value;
}

export async function pantheonRoutes(app: FastifyInstance) {
  // GET /api/pantheon/badges — pending-work counts, gated to the apps this caller can enter.
  app.get('/api/pantheon/badges', { preHandler: requireAnyAuth }, badgesHandler);

  // Deprecated: kept so an already-open old portal bundle keeps its badges during a rolling
  // deploy. Delete after a few weeks.
  app.get('/api/jupiter/badges', { preHandler: requireAnyAuth }, badgesHandler);
}
