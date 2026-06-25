import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from '../line/contentStore.js';

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
        .send(buf);
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
  });
}
