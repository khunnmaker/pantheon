import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db/prisma.js';
import { requireCeresAuth } from '../../ceres/auth.js';
import { readCeresReceiptMeta, readCeresReceiptFile } from '../../ceres/receiptStore.js';
import { ceresReceiptToken } from '../../ceres/receiptLink.js';
import { p1Routes } from './p1.js';
import { requestsRoutes } from './requests.js';
import { ceoRoutes } from './ceo.js';
import { statementsRoutes } from './statements.js';
import { exportsRoutes } from './exports.js';

// Ceres (expenses & petty cash) API. Two PUBLIC routes (receipt image serving —
// tokenized, and the messenger login-name picker) plus a scoped sub-plugin gated
// by requireCeresAuth for everything else (P1 messenger/md/ceo routes — see p1.ts).
export async function ceresRoutes(app: FastifyInstance) {
  // PUBLIC (tokenized) — a receipt photo, servable without a login (mirrors
  // /content/slip/:id). The token is an HMAC of the uploadId (unguessable).
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>(
    '/content/ceres-receipt/:id',
    async (req, reply) => {
      if (!req.query.t || req.query.t !== ceresReceiptToken(req.params.id)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const meta = await readCeresReceiptMeta(req.params.id);
      const buf = await readCeresReceiptFile(req.params.id);
      if (!meta || !buf) return reply.code(404).send({ error: 'not_found' });
      return reply
        .header('content-type', meta.contentType)
        .header('cache-control', 'private, max-age=3600')
        .send(buf);
    },
  );

  // PUBLIC — the pick-your-name PIN login screen for messengers. Names only, no
  // ids/roles beyond that (a messenger picks their name, then enters their PIN).
  app.get('/api/ceres/logins', async () => {
    const parties = await prisma.ceresParty.findMany({
      where: { active: true, kind: 'person', agentEmail: { not: null } },
      orderBy: { sortOrder: 'asc' },
    });
    const emails = parties.map((p) => p.agentEmail).filter((e): e is string => !!e);
    const agents = await prisma.agent.findMany({
      where: { email: { in: emails } },
      select: { email: true },
    });
    const known = new Set(agents.map((a) => a.email));
    const logins = parties
      .filter((p) => p.agentEmail && known.has(p.agentEmail))
      .map((p) => ({ email: p.agentEmail as string, name: p.name }));
    return logins;
  });

  // Everything else requires a Ceres-facing login (messenger | md | ceo/supervisor).
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', requireCeresAuth);
    p1Routes(scoped);
    requestsRoutes(scoped);
    ceoRoutes(scoped);
    statementsRoutes(scoped);
    exportsRoutes(scoped);
  });
}
