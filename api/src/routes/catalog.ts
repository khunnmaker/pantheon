import type { FastifyInstance } from 'fastify';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../auth/middleware.js';
import { CATALOG_PRODUCTS } from '../catalog/catalogData.js';
import { findProducts } from '../catalog/match.js';
import { buildDraftPrompt } from '../llm/prompt.js';
import { callClaude } from '../llm/anthropic.js';
import { parseDraft } from '../llm/parser.js';
import { applyGuardrails } from '../llm/guardrails.js';

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // GET /api/catalog/search?q= — products matching a query (debug/tuning).
  app.get('/api/catalog/search', async (req) => {
    const q = String((req.query as { q?: string }).q ?? '');
    return { products: await findProducts(q, 8) };
  });

  // POST /api/catalog/test-draft {q} — dry-run a draft for a question without
  // creating any customer/message. Verifies the price-from-catalog path safely.
  app.post('/api/catalog/test-draft', async (req, reply) => {
    const q = String((req.body as { q?: string }).q ?? '').trim();
    if (!q) return reply.code(400).send({ error: 'missing_q' });
    const kb = await prisma.kbEntry.findMany({ where: { status: 'active' } });
    const products = await findProducts(q);
    const grounded = products.filter((p) => p.price > 0).map((p) => `${p.price}บาท`).join(' ');
    const { system, user } = buildDraftPrompt({ question: q, kb, products });
    const parsed = parseDraft(await callClaude(user, system));
    const citedKb = kb.filter((k) =>
      parsed.used_kb.map((s) => s.toLowerCase()).includes(k.id.toLowerCase()),
    );
    const guarded = applyGuardrails(parsed, q, citedKb, grounded);
    return { matched: products, result: guarded.result, reason: guarded.reason };
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
}
