import type { FastifyInstance } from 'fastify';
import { requireCeresAuth } from '../../ceres/auth.js';
import { readCeresReceiptMeta, readCeresReceiptFile } from '../../ceres/receiptStore.js';
import { verifyCeresReceiptToken } from '../../ceres/receiptLink.js';
import { ceresLoginRoute } from './login.js';
import { p1Routes } from './p1.js';
import { requestsRoutes } from './requests.js';
import { ceoRoutes } from './ceo.js';
import { statementsRoutes } from './statements.js';
import { exportsRoutes } from './exports.js';
import { categoryAdminRoutes } from './categories.js';

// Ceres (expenses & petty cash) API. Two PUBLIC routes (receipt image serving —
// tokenized, and the messenger login-name picker) plus a scoped sub-plugin gated
// by requireCeresAuth for everything else (P1 messenger/gm/ceo routes — see p1.ts).
export async function ceresRoutes(app: FastifyInstance) {
  // PUBLIC (tokenized) — a receipt photo, servable without a login (mirrors
  // /content/slip/:id). The token is an HMAC of the uploadId (unguessable).
  app.get<{ Params: { id: string }; Querystring: { t?: string; expires?: string } }>(
    '/content/ceres-receipt/:id',
    async (req, reply) => {
      if (!verifyCeresReceiptToken(req.params.id, req.query.t, req.query.expires)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const meta = await readCeresReceiptMeta(req.params.id);
      const buf = await readCeresReceiptFile(req.params.id);
      if (!meta || !buf) return reply.code(404).send({ error: 'not_found' });
      return reply
        .header('content-type', meta.contentType)
        .header('cache-control', 'private, max-age=600')
        .header('x-content-type-options', 'nosniff')
        .send(buf);
    },
  );

  // Compatibility-only public name-card list for the explicit ?local=1 break-glass path.
  ceresLoginRoute(app);

  // Everything else requires a Ceres-facing login (messenger | gm | ceo/supervisor).
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', requireCeresAuth);
    p1Routes(scoped);
    requestsRoutes(scoped);
    ceoRoutes(scoped);
    statementsRoutes(scoped);
    exportsRoutes(scoped);
    categoryAdminRoutes(scoped);
  });
}
