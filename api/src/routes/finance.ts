import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireApp, requireRole } from '../auth/middleware.js';
import { buildSlipUrl } from '../finance/slipLink.js';

// Audit of staff-corrected payment amounts (the "ตรวจสอบยอด" mis-read report). This now lives
// with Juno, not Minerva: the corrections are on payments finance (Benz/Meow) verify, so the
// gate is requireApp('juno') — leftover requireApp('minerva') kept finance out (they hold the
// 'juno' grant, not 'minerva'). Supervisors pass every requireApp, so the Minerva console
// (web/, supervisor-only) keeps working unchanged.
//
// READ (list) is open to any Juno user so finance can SEE the flags on payments they process;
// RESOLVE (marking a discrepancy verified) stays supervisor-only via a per-route requireRole.
export async function financeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireApp('juno'));

  // GET /api/finance/audits?status=open|resolved|all — readable by any Juno user (finance
  // employees included), so no supervisor sub-check here; requireApp('juno') is the only gate.
  app.get('/api/finance/audits', async (req) => {
    const status = (req.query as { status?: string })?.status ?? 'open';
    const where = status === 'all' ? {} : status === 'resolved' ? { resolvedAt: { not: null } } : { resolvedAt: null };
    const audits = await prisma.financeAudit.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    const base = `${(req.headers['x-forwarded-proto'] as string) || req.protocol}://${req.headers.host}`;
    return { audits: audits.map((a) => ({ ...a, slipUrl: buildSlipUrl(base, a.messageId) })) };
  });

  // POST /api/finance/audits/:id/resolve — a supervisor marks the discrepancy verified.
  // requireApp('juno') (hook) + requireRole('supervisor') (route) — READ-open, RESOLVE-closed.
  app.post<{ Params: { id: string } }>(
    '/api/finance/audits/:id/resolve',
    { preHandler: requireRole('supervisor') },
    async (req, reply) => {
      const a = await prisma.financeAudit
        .update({ where: { id: req.params.id }, data: { resolvedAt: new Date(), resolvedById: req.agent!.id } })
        .catch(() => null);
      if (!a) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
}
