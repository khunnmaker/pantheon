import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireApp, requireRole } from '../auth/middleware.js';
import { buildSlipUrl } from '../finance/slipLink.js';
import { BILL_ISSUER_EMAILS } from './juno.js';

// Audit of staff-corrected payment amounts (the "ตรวจสอบยอด" mis-read report). This now lives
// with Juno, not Minerva: the corrections are on payments finance (Benz/Meow) verify, so the
// gate is requireApp('juno') — leftover requireApp('minerva') kept finance out (they hold the
// 'juno' grant, not 'minerva'). Supervisors pass every requireApp, so the Minerva console
// (web/, supervisor-only) keeps working unchanged.
//
// READ (list) is open to staff/supervisor so finance can SEE the flags on payments they
// process; gm is denied at the router hook. RESOLVE stays supervisor-only via requireRole.
export async function financeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireApp('juno'));
  // Owner decision 2026-07-13: gm is bills-only in Juno; the separate FinanceAudit router
  // is entirely outside that lane. Staff and supervisors retain their existing access.
  // Mail (per-person BILL_ISSUER_EMAILS, 2026-07-21) rides the same bills-only lane as gm and
  // is denied here too — she must not inherit the staff FinanceAudit surface just because
  // her 'central' role otherwise behaves like staff elsewhere.
  app.addHook('preHandler', async (req, reply) => {
    if (req.agent?.role === 'gm' || BILL_ISSUER_EMAILS.has(req.agent?.email ?? '')) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  });

  // GET /api/finance/audits?status=open|resolved|all — readable by finance staff and the
  // supervisor; the router hook above denies gm.
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
