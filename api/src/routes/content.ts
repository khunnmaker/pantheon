import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prisma } from '../db/prisma.js';
import { UPLOAD_DIR, readImageContent } from '../line/contentStore.js';
import { readStaffUploadMeta, readStaffUploadFile } from '../line/staffUploads.js';
import { slipToken } from '../finance/slipLink.js';

// SKU path segment whitelist — blocks path traversal on the public route.
const SKU_RE = /^[A-Za-z0-9_-]+$/;

export const PRODUCT_PHOTO_DIR = path.join(UPLOAD_DIR, 'products');

// PUBLIC content (no auth). Product catalog photos are non-sensitive and must be
// fetchable by LINE's servers (which include the URL in an outgoing image message)
// and shown in the console. Served from the persistent volume.
export async function contentRoutes(app: FastifyInstance) {
  app.get<{ Params: { sku: string } }>('/content/product/:sku', async (req, reply) => {
    const { sku } = req.params;
    if (!SKU_RE.test(sku)) return reply.code(400).send({ error: 'bad_sku' });
    try {
      const buf = await fs.readFile(path.join(PRODUCT_PHOTO_DIR, `${sku}.png`));
      return reply
        .header('content-type', 'image/png')
        .header('cache-control', 'public, max-age=86400')
        .header('x-content-type-options', 'nosniff')
        .send(buf);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });

  // PUBLIC — a staff-uploaded attachment sent to a customer (LINE fetches images;
  // customers download files). Unguessable UUID path; files download with their name.
  app.get<{ Params: { id: string } }>('/content/upload/:id', async (req, reply) => {
    const meta = await readStaffUploadMeta(req.params.id);
    const buf = await readStaffUploadFile(req.params.id);
    if (!meta || !buf) return reply.code(404).send({ error: 'not_found' });
    reply
      .header('content-type', meta.contentType)
      .header('cache-control', 'public, max-age=86400')
      // Never let the browser sniff a mislabeled body into an executable type; only allowlisted
      // rasters ever reach kind='image' (see saveStaffUpload), everything else downloads.
      .header('x-content-type-options', 'nosniff');
    if (meta.kind === 'file') {
      reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(meta.fileName)}`);
    }
    return reply.send(buf);
  });

  // PUBLIC (tokenized) — a customer's payment-slip image, linkable from the finance
  // Google Sheet so finance can open it without a console login. The token is an HMAC
  // of the message id (unguessable); only image messages are served.
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>('/content/slip/:id', async (req, reply) => {
    if (!req.query.t || req.query.t !== slipToken(req.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const msg = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!msg || msg.attachmentType !== 'image') return reply.code(404).send({ error: 'not_found' });
    const buf = await readImageContent(req.params.id);
    if (!buf) return reply.code(404).send({ error: 'content_unavailable' });
    return reply
      .header('content-type', msg.attachmentRef || 'image/jpeg')
      .header('cache-control', 'private, max-age=3600')
      .header('x-content-type-options', 'nosniff')
      .send(buf);
  });
}
