import type { FastifyInstance } from 'fastify';
import { requireCeresAuth } from '../../ceres/auth.js';
import { buildLoginCards } from '../../auth/loginCards.js';
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

  // PUBLIC — the name-card login list (alias of GET /api/auth/logins?app=ceres):
  // Dr. M + Nee as password cards, then every ceres-granted employee as a PIN card.
  app.get('/api/ceres/logins', async () => buildLoginCards('ceres'));

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
