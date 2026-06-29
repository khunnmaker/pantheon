import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { searchProducts } from '../catalog/match.js';
import { toStockRow } from '../stock/helpers.js';
import { decodeExpressBytes, parseExpressReport, type ParsedStockRow } from '../stock/parseExpressReport.js';

// Vulcan stock-management API. Writes Product.stock/stockAt (which Minerva reads)
// plus a reorderPoint per SKU, and logs StockImport / StockAdjustment audit rows.
// Gated to supervisor for v1 (the stock manager logs in as Dr. M). See VULCAN_BRIEF.md.

const SKU_RE = /^[A-Za-z0-9_-]+$/;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // Express reports are ~1.5 MB; cap generously.

// In-memory staging for previewed imports: the manager previews, eyeballs the diff,
// then applies the EXACT parsed set (server-authoritative — the client can't re-send
// tampered numbers). Lost on restart (harmless: just re-upload). Small + short-lived.
interface StagedImport { fileName: string; rows: ParsedStockRow[]; at: number }
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const previews = new Map<string, StagedImport>();
function stash(s: StagedImport): string {
  // Evict expired + cap to the 10 most recent so the map can't grow unbounded.
  const now = Date.now();
  for (const [k, v] of previews) if (now - v.at > PREVIEW_TTL_MS) previews.delete(k);
  while (previews.size >= 10) previews.delete(previews.keys().next().value as string);
  const token = randomUUID();
  previews.set(token, s);
  return token;
}

export async function stockRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireRole('supervisor'));

  // GET /api/stock/summary — headline counts for the Vulcan dashboard / login landing.
  app.get('/api/stock/summary', async () => {
    const [total, withStock, lastImport] = await Promise.all([
      prisma.product.count({ where: { status: 'active' } }),
      prisma.product.count({ where: { status: 'active', stock: { not: null } } }),
      prisma.stockImport.findFirst({ orderBy: { importedAt: 'desc' } }),
    ]);
    // Low count needs a column-vs-column compare (stock <= reorderPoint) → raw SQL.
    const lowRows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM "Product"
      WHERE status = 'active' AND stock IS NOT NULL AND "reorderPoint" IS NOT NULL
        AND stock <= "reorderPoint"`;
    const low = Number(lowRows[0]?.n ?? 0);
    return { total, withStock, low, lastImport };
  });

  // GET /api/stock/list?q=&filter=all|low|unknown&limit= — the searchable stock table.
  // Empty q + filter=all returns the most-recently-updated products (a sensible default
  // landing list); filter=low returns only low-stock SKUs; unknown = stock IS NULL.
  app.get('/api/stock/list', async (req) => {
    const { q, filter, limit } = req.query as { q?: string; filter?: string; limit?: string };
    const take = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const query = String(q ?? '').trim();

    let products;
    if (query) {
      // Reuse Minerva's name/SKU search, then re-fetch full rows (search returns a lite shape).
      const matches = await searchProducts(query, take);
      const skus = matches.map((m) => m.sku);
      products = skus.length
        ? await prisma.product.findMany({ where: { sku: { in: skus } } })
        : [];
      // Preserve search ranking order.
      const order = new Map(skus.map((s, i) => [s, i]));
      products.sort((a, b) => (order.get(a.sku) ?? 0) - (order.get(b.sku) ?? 0));
    } else {
      products = await prisma.product.findMany({
        where: { status: 'active' },
        orderBy: [{ stockAt: 'desc' }, { updatedAt: 'desc' }],
        take,
      });
    }

    let rows = products.map(toStockRow);
    if (filter === 'low') rows = rows.filter((r) => r.low);
    else if (filter === 'unknown') rows = rows.filter((r) => r.stock == null);
    return { products: rows };
  });

  // POST /api/stock/adjust { sku, toQty, reason } — manual correction between imports.
  // Writes Product.stock (+ stockAt = now) and logs a StockAdjustment. toQty=null clears
  // the stock to unknown. Never creates a catalog row — unknown SKU is rejected.
  app.post('/api/stock/adjust', async (req, reply) => {
    const body = req.body as { sku?: string; toQty?: unknown; reason?: string };
    const sku = String(body.sku ?? '').trim();
    if (!sku || !SKU_RE.test(sku)) return reply.code(400).send({ error: 'bad_sku' });

    let toQty: number | null;
    if (body.toQty === null || body.toQty === undefined || body.toQty === '') {
      toQty = null;
    } else {
      const n = Number(body.toQty);
      if (!Number.isInteger(n) || n < 0) return reply.code(400).send({ error: 'bad_qty' });
      toQty = n;
    }
    const reason = String(body.reason ?? '').trim();

    const product = await prisma.product.findUnique({ where: { sku } });
    if (!product) return reply.code(404).send({ error: 'unknown_sku' });
    if (product.stock === toQty) {
      return { ok: true, product: toStockRow(product), unchanged: true };
    }

    const [updated] = await prisma.$transaction([
      prisma.product.update({
        where: { sku },
        data: { stock: toQty, stockAt: new Date() },
      }),
      prisma.stockAdjustment.create({
        data: { sku, fromQty: product.stock, toQty, reason, byAgentId: req.agent?.id },
      }),
    ]);
    return { ok: true, product: toStockRow(updated) };
  });

  // POST /api/stock/reorder-point { sku, reorderPoint } — set/clear the low-stock
  // threshold for a SKU. reorderPoint=null clears it (no threshold). Not audited
  // (it's config, not a stock movement).
  app.post('/api/stock/reorder-point', async (req, reply) => {
    const body = req.body as { sku?: string; reorderPoint?: unknown };
    const sku = String(body.sku ?? '').trim();
    if (!sku || !SKU_RE.test(sku)) return reply.code(400).send({ error: 'bad_sku' });

    let rp: number | null;
    if (body.reorderPoint === null || body.reorderPoint === undefined || body.reorderPoint === '') {
      rp = null;
    } else {
      const n = Number(body.reorderPoint);
      if (!Number.isInteger(n) || n < 0) return reply.code(400).send({ error: 'bad_value' });
      rp = n;
    }

    const product = await prisma.product.findUnique({ where: { sku } });
    if (!product) return reply.code(404).send({ error: 'unknown_sku' });
    const updated = await prisma.product.update({ where: { sku }, data: { reorderPoint: rp } });
    return { ok: true, product: toStockRow(updated) };
  });

  // GET /api/stock/imports?limit= — recent daily-import audit rows.
  app.get('/api/stock/imports', async (req) => {
    const limit = Math.min(Math.max(Number((req.query as { limit?: string }).limit) || 20, 1), 100);
    const imports = await prisma.stockImport.findMany({
      orderBy: { importedAt: 'desc' },
      take: limit,
    });
    return { imports };
  });

  // GET /api/stock/adjustments?sku=&limit= — manual-edit audit log (all, or per SKU).
  app.get('/api/stock/adjustments', async (req) => {
    const { sku, limit } = req.query as { sku?: string; limit?: string };
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const where = sku ? { sku: String(sku).trim() } : {};
    const adjustments = await prisma.stockAdjustment.findMany({
      where,
      orderBy: { at: 'desc' },
      take,
    });
    return { adjustments };
  });

  // POST /api/stock/import/preview { dataB64, fileName } — parse the uploaded Express
  // stock report (Windows-874 .txt) and diff it against the catalog. NO writes. Returns
  // a token to apply this exact parsed set. Absent SKUs are left unchanged (the report is
  // a full snapshot, but we never auto-zero or auto-create from the stock file).
  app.post('/api/stock/import/preview', async (req, reply) => {
    const { dataB64, fileName } = req.body as { dataB64?: string; fileName?: string };
    if (!dataB64 || typeof dataB64 !== 'string') return reply.code(400).send({ error: 'missing_data' });
    let buf: Buffer;
    try {
      buf = Buffer.from(dataB64, 'base64');
    } catch {
      return reply.code(400).send({ error: 'bad_base64' });
    }
    if (!buf.length) return reply.code(400).send({ error: 'empty' });
    if (buf.length > MAX_UPLOAD_BYTES) return reply.code(413).send({ error: 'too_large' });

    const { text, encoding } = decodeExpressBytes(buf);
    const parsed = parseExpressReport(text);
    if (parsed.rows.length === 0) {
      return reply.code(422).send({ error: 'no_rows', detail: 'ไม่พบรายการสินค้าในไฟล์ — ตรวจสอบว่าเป็นรายงานสินค้าคงเหลือจาก Express' });
    }

    const skus = parsed.rows.map((r) => r.sku);
    const existing = await prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, stock: true },
    });
    const current = new Map(existing.map((p) => [p.sku, p.stock]));

    let matched = 0;
    let willChange = 0;
    const rows = parsed.rows.map((r) => {
      const isMatched = current.has(r.sku);
      const currentStock = isMatched ? current.get(r.sku)! : null;
      const changes = isMatched && r.qty !== currentStock;
      if (isMatched) matched++;
      if (changes) willChange++;
      return {
        sku: r.sku,
        csvName: r.name,
        qty: r.qty,
        matched: isMatched,
        currentStock,
        willChange: changes,
      };
    });

    const token = stash({ fileName: String(fileName ?? ''), rows: parsed.rows, at: Date.now() });
    return {
      token,
      fileName: String(fileName ?? ''),
      encoding,
      rowsParsed: parsed.rows.length,
      matched,
      unmatched: parsed.rows.length - matched,
      willChange,
      rows,
    };
  });

  // POST /api/stock/import/apply { token, note } — apply a previewed import. Writes
  // Product.stock = qty + stockAt = now for every MATCHED SKU; logs a StockImport row.
  app.post('/api/stock/import/apply', async (req, reply) => {
    const { token, note } = req.body as { token?: string; note?: string };
    const staged = token ? previews.get(token) : undefined;
    if (!token || !staged) return reply.code(410).send({ error: 'preview_expired', detail: 'พรีวิวหมดอายุ — กรุณาอัปโหลดไฟล์ใหม่' });
    previews.delete(token);

    const importedAt = new Date();
    const skus = staged.rows.map((r) => r.sku);
    const existing = await prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true },
    });
    const known = new Set(existing.map((p) => p.sku));

    // Apply only matched SKUs, chunked so a 1000+ row import doesn't serialize forever.
    const toApply = staged.rows.filter((r) => known.has(r.sku));
    let skusUpdated = 0;
    const CHUNK = 50;
    for (let i = 0; i < toApply.length; i += CHUNK) {
      const slice = toApply.slice(i, i + CHUNK);
      const results = await Promise.all(
        slice.map((r) =>
          prisma.product.updateMany({ where: { sku: r.sku }, data: { stock: r.qty, stockAt: importedAt } }),
        ),
      );
      skusUpdated += results.reduce((n, x) => n + x.count, 0);
    }
    const skusUnmatched = staged.rows.length - toApply.length;

    const imp = await prisma.stockImport.create({
      data: {
        importedBy: req.agent?.id,
        fileName: staged.fileName,
        rowsParsed: staged.rows.length,
        skusUpdated,
        skusUnmatched,
        note: String(note ?? ''),
      },
    });

    return { ok: true, skusUpdated, skusUnmatched, importId: imp.id };
  });
}
