import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireApp } from '../auth/middleware.js';
import { buildSlipUrl } from '../finance/slipLink.js';

// Supervisor-only audit of staff-corrected payment amounts. Sales (agent role) have no
// access — this is the tamper-proof home for the "ตรวจสอบยอด" report.
export async function financeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireApp('minerva'));

  // GET /api/finance/audits?status=open|resolved|all
  app.get('/api/finance/audits', async (req, reply) => {
    if (req.agent?.role !== 'supervisor') return reply.code(403).send({ error: 'forbidden' });
    const status = (req.query as { status?: string })?.status ?? 'open';
    const where = status === 'all' ? {} : status === 'resolved' ? { resolvedAt: { not: null } } : { resolvedAt: null };
    const audits = await prisma.financeAudit.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    const base = `${(req.headers['x-forwarded-proto'] as string) || req.protocol}://${req.headers.host}`;
    return { audits: audits.map((a) => ({ ...a, slipUrl: buildSlipUrl(base, a.messageId) })) };
  });

  // POST /api/finance/audits/:id/resolve — a supervisor marks the discrepancy verified.
  app.post<{ Params: { id: string } }>('/api/finance/audits/:id/resolve', async (req, reply) => {
    if (req.agent?.role !== 'supervisor') return reply.code(403).send({ error: 'forbidden' });
    const a = await prisma.financeAudit
      .update({ where: { id: req.params.id }, data: { resolvedAt: new Date(), resolvedById: req.agent.id } })
      .catch(() => null);
    if (!a) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
