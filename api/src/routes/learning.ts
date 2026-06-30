import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireRole } from '../auth/middleware.js';

export async function learningRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  const supervisorOnly = { preHandler: [requireRole('supervisor')] };

  // GET /api/learned?status=pending — captured edits (any agent can view).
  app.get('/api/learned', async (req) => {
    const status = (req.query as { status?: string })?.status;
    const learned = await prisma.learnedAnswer.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
    return { learned };
  });

  // POST /api/learned/:id/promote — supervisor turns an edited answer into KB.
  app.post<{ Params: { id: string } }>('/api/learned/:id/promote', supervisorOnly, async (req, reply) => {
    const rec = await prisma.learnedAnswer.findUnique({ where: { id: req.params.id } });
    if (!rec) return reply.code(404).send({ error: 'not_found' });
    if (rec.status === 'approved') return reply.code(409).send({ error: 'already_promoted' });

    const kb = await prisma.kbEntry.create({
      data: {
        category: 'เรียนรู้จากพนักงาน',
        questionVariants: [rec.customerQuestion],
        answer: rec.finalAnswer,
        sensitivity: 'normal',
        source: 'learned',
        status: 'active',
        ownerAgentId: req.agent?.id,
      },
    });
    await prisma.learnedAnswer.update({
      where: { id: rec.id },
      data: { status: 'approved', promotedKbId: kb.id },
    });
    return { ok: true, kb };
  });

  // POST /api/learned/:id/reject — supervisor discards a captured edit.
  app.post<{ Params: { id: string } }>('/api/learned/:id/reject', supervisorOnly, async (req, reply) => {
    const rec = await prisma.learnedAnswer.findUnique({ where: { id: req.params.id } });
    if (!rec) return reply.code(404).send({ error: 'not_found' });
    await prisma.learnedAnswer.update({ where: { id: rec.id }, data: { status: 'rejected' } });
    return { ok: true };
  });

  // GET /api/learned/metrics — AI-accuracy data (supervisor only): per-category accept-verbatim
  // / edit / escalation counts + rate, plus a weekly trend, from the Stage-1 ReplyOutcome table.
  app.get('/api/learned/metrics', supervisorOnly, async () => {
    const cats = await prisma.$queryRaw<
      { category: string; accepted: number; edited: number; escalated: number; total: number }[]
    >`
      SELECT coalesce(category, 'general') AS category,
        count(*) FILTER (WHERE outcome = 'accepted_verbatim')::int AS accepted,
        count(*) FILTER (WHERE outcome = 'edited')::int AS edited,
        count(*) FILTER (WHERE outcome = 'escalated')::int AS escalated,
        count(*)::int AS total
      FROM "ReplyOutcome"
      GROUP BY 1 ORDER BY total DESC`;
    const weekly = await prisma.$queryRaw<
      { week: string; accepted: number; edited: number; escalated: number; total: number }[]
    >`
      SELECT to_char(date_trunc('week', "sentAt"), 'YYYY-MM-DD') AS week,
        count(*) FILTER (WHERE outcome = 'accepted_verbatim')::int AS accepted,
        count(*) FILTER (WHERE outcome = 'edited')::int AS edited,
        count(*) FILTER (WHERE outcome = 'escalated')::int AS escalated,
        count(*)::int AS total
      FROM "ReplyOutcome"
      WHERE "sentAt" > now() - interval '84 days'
      GROUP BY 1 ORDER BY 1`;
    const rate = (r: { accepted: number; edited: number }) =>
      r.accepted + r.edited > 0 ? r.accepted / (r.accepted + r.edited) : null;
    const sum = (k: 'accepted' | 'edited' | 'escalated' | 'total') => cats.reduce((a, c) => a + c[k], 0);
    const overall = { accepted: sum('accepted'), edited: sum('edited'), escalated: sum('escalated'), total: sum('total') };
    return {
      overall: { ...overall, acceptRate: rate(overall) },
      byCategory: cats.map((c) => ({ ...c, acceptRate: rate(c) })),
      byWeek: weekly.map((w) => ({ ...w, acceptRate: rate(w) })),
    };
  });
}
