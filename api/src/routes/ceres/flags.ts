import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { requireCeresRole } from '../../ceres/auth.js';
import { CeresFlagError, createFlag, FLAG_TARGET_TYPES, getFlagCounts, listFlags, resolveFlag } from '../../ceres/flags.js';

function flagError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, err: unknown) {
  if (!(err instanceof CeresFlagError)) throw err;
  const status = err.code === 'not_found' ? 404 : err.code === 'already_flagged' ? 409 : 403;
  return reply.code(status).send({ error: err.code });
}

// Batch-load a lightweight subject summary per flagged target — same pattern as the AI
// review "subject" enrichment in routes/ceres/ceo.ts — so the review UI (GM's อนุมัติ tab,
// CEO's ภาพรวม) can render a flag card without a second round-trip per row.
async function loadTargetSummaries(flags: { targetType: string; targetId: string }[]) {
  const requestIds = [...new Set(flags.filter((f) => f.targetType === 'request').map((f) => f.targetId))];
  const expenseIds = [...new Set(flags.filter((f) => f.targetType === 'expense').map((f) => f.targetId))];
  const [requests, expenses] = await Promise.all([
    requestIds.length
      ? prisma.ceresPaymentRequest.findMany({
          where: { id: { in: requestIds } },
          select: { id: true, payee: true, amount: true, requestType: true, approvalStatus: true },
        })
      : Promise.resolve([]),
    expenseIds.length
      ? prisma.ceresExpense.findMany({
          where: { id: { in: expenseIds } },
          select: { id: true, partyName: true, amount: true, category: true, status: true },
        })
      : Promise.resolve([]),
  ]);
  const requestMap = new Map(requests.map((r) => [r.id, { payee: r.payee, amount: r.amount, requestType: r.requestType, status: r.approvalStatus }]));
  const expenseMap = new Map(expenses.map((e) => [e.id, { partyName: e.partyName, amount: e.amount, category: e.category, status: e.status }]));
  return { requestMap, expenseMap };
}

// Feature: staff-flagged review queue (owner directive, 2026-07-21: "each person should be
// able to flag any transaction for review"). Mounted inside the requireCeresAuth scope (see
// routes/ceres/index.ts) — every route here already has req.agent set.
export function flagsRoutes(app: FastifyInstance) {
  const createBody = z.object({
    targetType: z.enum(FLAG_TARGET_TYPES),
    targetId: z.string().min(1),
    note: z.string().trim().min(1).max(300),
  });
  // POST /api/ceres/flags — ANY authenticated Ceres persona, but only on a row they can
  // already see (server-enforced inside createFlag(), reusing the same visibility rule the
  // list endpoints use — see flags.ts's assertRequestVisible/assertExpenseVisible).
  app.post('/api/ceres/flags', { preHandler: requireCeresRole('messenger', 'gm', 'ceo') }, async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      const flag = await createFlag({ ...parsed.data, agent: req.agent! });
      return { flag };
    } catch (err) {
      return flagError(reply, err);
    }
  });

  // GET /api/ceres/flags?status=open|resolved — gm/ceo review queue, enriched with a
  // subject summary per row.
  app.get('/api/ceres/flags', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const parsed = z.object({ status: z.enum(['open', 'resolved']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() })
      .safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const flags = await listFlags(parsed.data.status ?? 'open', parsed.data.limit ?? 200);
    const { requestMap, expenseMap } = await loadTargetSummaries(flags);
    return {
      flags: flags.map((f) => ({
        ...f,
        createdAt: f.createdAt.toISOString(),
        resolvedAt: f.resolvedAt ? f.resolvedAt.toISOString() : null,
        subject: f.targetType === 'request' ? requestMap.get(f.targetId) ?? null
          : f.targetType === 'expense' ? expenseMap.get(f.targetId) ?? null
            : null,
      })),
    };
  });

  // GET /api/ceres/flags/counts?targetType=request&targetIds=id1,id2,... — open-flag counts
  // for a batch of ids, ANY authenticated Ceres persona (see flags.ts's getFlagCounts doc —
  // this is what lets a staff member's own request cards show a 🚩 badge without the
  // gm/ceo-only GET /flags above). A messenger's ids are narrowed to what they can actually
  // see server-side (getFlagCounts) — this route never trusts the caller's own filtering.
  app.get('/api/ceres/flags/counts', { preHandler: requireCeresRole('messenger', 'gm', 'ceo') }, async (req, reply) => {
    const parsed = z.object({ targetType: z.enum(FLAG_TARGET_TYPES), targetIds: z.string().min(1) }).safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const ids = [...new Set(parsed.data.targetIds.split(',').map((id) => id.trim()).filter(Boolean))].slice(0, 500);
    const counts = await getFlagCounts(parsed.data.targetType, ids, req.agent!);
    return { counts };
  });

  // POST /api/ceres/flags/:id/resolve { resolutionNote } — gm/ceo.
  const resolveBody = z.object({ resolutionNote: z.string().trim().min(1).max(600) });
  app.post<{ Params: { id: string } }>(
    '/api/ceres/flags/:id/resolve',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const parsed = resolveBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      try {
        const flag = await resolveFlag(req.params.id, parsed.data.resolutionNote, req.agent!);
        return { flag };
      } catch (err) {
        return flagError(reply, err);
      }
    },
  );
}
