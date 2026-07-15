import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prisma } from '../db/prisma.js';
import { UPLOAD_DIR, readImageContent } from '../line/contentStore.js';
import { readStaffUploadMeta, readStaffUploadFile } from '../line/staffUploads.js';
import { slipToken, isPdfSlip, isSlipCapable } from '../finance/slipLink.js';

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
        // Long cache with revalidation. NOT immutable — the URL is sku-addressed (not
        // content-addressed), so a re-uploaded photo must still be picked up eventually.
        .header('cache-control', 'public, max-age=2592000, stale-while-revalidate=86400')
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
      // application/pdf is the ONE non-raster type served inline — bank apps export payment
      // slips as PDFs and the Juno drawer embeds them in an iframe. Gated on the %PDF- magic
      // bytes so a mislabeled body can't ride an inline disposition (the same job
      // looksLikeRaster does for images); everything else still downloads, keeping the
      // stored-XSS posture above unchanged (fixed content-type + nosniff).
      const isRealPdf = meta.contentType === 'application/pdf' && buf.subarray(0, 5).toString('latin1') === '%PDF-';
      reply.header(
        'content-disposition',
        `${isRealPdf ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.fileName)}`,
      );
    }
    return reply.send(buf);
  });

  // PUBLIC (tokenized) — a customer's payment-slip image, linkable from the finance
  // Google Sheet so finance can open it without a console login. The token is an HMAC
  // of the message id (unguessable); only image messages are served.
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>('/content/slip/:id', async (req, reply) => {
    if (!req.query.t || req.query.t !== slipToken(req.params.id)) return reply.code(403).send({ error: 'forbidden' });
    const msg = await prisma.message.findUnique({ where: { id: req.params.id } });
    // Image slips (classic) or PDF file slips (bank-app exports) — same set the
    // แจ้งการเงิน forward accepts; anything else stays a 404.
    if (!msg || !isSlipCapable(msg)) return reply.code(404).send({ error: 'not_found' });
    const buf = await readImageContent(req.params.id);
    if (!buf) return reply.code(404).send({ error: 'content_unavailable' });
    if (isPdfSlip(msg)) {
      // Inline only when the bytes really are a PDF (%PDF- magic — same job looksLikeRaster
      // does for images); a mislabeled body downloads instead of rendering. nosniff below
      // keeps the browser from second-guessing the declared type.
      const realPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
      reply.header(
        'content-disposition',
        `${realPdf ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(msg.attachmentName || 'slip.pdf')}`,
      );
      return reply
        .header('content-type', 'application/pdf')
        .header('cache-control', 'private, max-age=3600')
        .header('x-content-type-options', 'nosniff')
        .send(buf);
    }
    return reply
      .header('content-type', msg.attachmentRef || 'image/jpeg')
      .header('cache-control', 'private, max-age=3600')
      .header('x-content-type-options', 'nosniff')
      .send(buf);
  });
}
