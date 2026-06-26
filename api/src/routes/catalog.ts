import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { CATALOG_PRODUCTS } from '../catalog/catalogData.js';
import { findProducts, searchProducts } from '../catalog/match.js';
import { buildDraftPrompt } from '../llm/prompt.js';
import { callClaude } from '../llm/anthropic.js';
import { parseDraft } from '../llm/parser.js';
import { applyGuardrails } from '../llm/guardrails.js';
import { PRODUCT_PHOTO_DIR } from './content.js';

const SKU_RE = /^[A-Za-z0-9_-]+$/;

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // GET /api/catalog/search?q= — products matching a query by NAME or SKU. Powers the
  // console's manual "add product" search (when the AI's auto-match isn't right).
  app.get('/api/catalog/search', async (req) => {
    const q = String((req.query as { q?: string }).q ?? '');
    return { products: await searchProducts(q, 12) };
  });

  // GET /api/catalog/crosssell/:sku — learned cross-sell links for an anchor product
  // (transparency into the learning loop), highest score first.
  app.get<{ Params: { sku: string } }>('/api/catalog/crosssell/:sku', async (req) => {
    const links = await prisma.crossSellLink.findMany({
      where: { anchorSku: req.params.sku },
      orderBy: { score: 'desc' },
    });
    return { anchorSku: req.params.sku, links };
  });

  // POST /api/catalog/test-draft {q} — dry-run a draft for a question without
  // creating any customer/message. Verifies the price-from-catalog path safely.
  app.post('/api/catalog/test-draft', async (req, reply) => {
    const q = String((req.body as { q?: string }).q ?? '').trim();
    if (!q) return reply.code(400).send({ error: 'missing_q' });
    const mainRaw = (req.body as { mainSkus?: unknown }).mainSkus;
    const mainSkus = Array.isArray(mainRaw) ? mainRaw.filter((s): s is string => typeof s === 'string') : [];
    const kb = await prisma.kbEntry.findMany({ where: { status: 'active' } });
    const products = await findProducts(q);
    const confirmedProducts = mainSkus.length
      ? (await prisma.product.findMany({ where: { sku: { in: mainSkus } } })).map((p) => ({
          sku: p.sku, nameEn: p.nameEn, nameTh: p.nameTh, price: p.price, promo: p.promo, note: p.note,
          photoSku: p.photoSku, stock: p.stock, stockAt: p.stockAt,
        }))
      : [];
    const all = [...products, ...confirmedProducts];
    const grounded = all.filter((p) => p.price > 0).map((p) => `${p.price}บาท`).join(' ');
    const groundedStock = all.some((p) => p.stock != null);
    const { system, user } = buildDraftPrompt({ question: q, kb, products, confirmedProducts });
    const parsed = parseDraft(await callClaude(user, system));
    const citedKb = kb.filter((k) =>
      parsed.used_kb.map((s) => s.toLowerCase()).includes(k.id.toLowerCase()),
    );
    const guarded = applyGuardrails(parsed, q, citedKb, grounded, groundedStock);
    return { matched: products, confirmed: confirmedProducts, result: guarded.result, reason: guarded.reason };
  });

  // Quick health/visibility of the imported catalog.
  app.get('/api/catalog/stats', async () => {
    const [total, priced, withPhoto] = await Promise.all([
      prisma.product.count(),
      prisma.product.count({ where: { price: { gt: 0 } } }),
      prisma.product.count({ where: { photoSku: { not: null } } }),
    ]);
    return { total, priced, withPhoto };
  });

  // Supervisor-only: wipe + re-import the bundled catalog (after data fixes /
  // re-extraction). Lets us refresh prices without clobbering on every boot.
  app.post('/api/catalog/reimport', async (req, reply) => {
    if (req.agent?.role !== 'supervisor') return reply.code(403).send({ error: 'forbidden' });
    await prisma.product.deleteMany({});
    const data = CATALOG_PRODUCTS.map((p) => ({
      sku: p.sku,
      nameEn: p.nameEn,
      nameTh: p.nameTh,
      price: p.price,
      promo: p.promo,
      note: p.note,
      page: p.page ?? null,
      photoSku: p.photoSku ?? null,
      keywords: p.keywords,
    }));
    const res = await prisma.product.createMany({ data, skipDuplicates: true });
    return { ok: true, imported: res.count };
  });

  // Supervisor-only: upload a product photo (base64 PNG) to the persistent volume,
  // served publicly at /content/product/:sku. Used by scripts/upload_photos.js.
  app.post<{ Params: { sku: string } }>('/api/catalog/photo/:sku', async (req, reply) => {
    if (req.agent?.role !== 'supervisor') return reply.code(403).send({ error: 'forbidden' });
    const { sku } = req.params;
    if (!SKU_RE.test(sku)) return reply.code(400).send({ error: 'bad_sku' });
    const b64 = (req.body as { dataB64?: string }).dataB64;
    if (!b64) return reply.code(400).send({ error: 'missing_data' });
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return reply.code(400).send({ error: 'empty' });
    await fs.mkdir(PRODUCT_PHOTO_DIR, { recursive: true });
    await fs.writeFile(path.join(PRODUCT_PHOTO_DIR, `${sku}.png`), buf);
    return { ok: true, sku, bytes: buf.length };
  });

  // How many product photos are present on the volume (upload progress).
  app.get('/api/catalog/photos/count', async () => {
    try {
      const files = await fs.readdir(PRODUCT_PHOTO_DIR);
      return { count: files.filter((f) => f.endsWith('.png')).length };
    } catch {
      return { count: 0 };
    }
  });
}
