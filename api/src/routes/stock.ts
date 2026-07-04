import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { searchProducts } from '../catalog/match.js';
import { toStockRow } from '../stock/helpers.js';
import { decodeExpressBytes, parseExpressReport, type ParsedStockRow } from '../stock/parseExpressReport.js';
import { buildAliases, groupOf } from '../stock/aliases.js';

// Attach the short alias (e.g. "TR34") to a set of rows in one query. Generic so any
// {sku, alias?} shape (StockRow, etc.) can reuse it.
async function withAliases<T extends { sku: string; alias?: string | null }>(rows: T[]): Promise<T[]> {
  if (rows.length) {
    const aliases = await prisma.productAlias.findMany({
      where: { sku: { in: rows.map((r) => r.sku) } },
      select: { sku: true, alias: true },
    });
    const byId = new Map(aliases.map((a) => [a.sku, a.alias]));
    for (const r of rows) r.alias = byId.get(r.sku) ?? null;
  }
  return rows;
}

// Vulcan stock-management API. Writes Product.stock/stockAt (which Minerva reads)
// plus a reorderPoint per SKU, and logs StockImport / StockAdjustment audit rows.
// Gated to supervisor for v1 (the stock manager logs in as Dr. M). See VULCAN_BRIEF.md.

const SKU_RE = /^[A-Za-z0-9_-]+$/;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // Express reports are ~1.5 MB; cap generously.

// In-memory staging for previewed imports: the manager previews, eyeballs the diff,
// then applies the EXACT parsed set (server-authoritative — the client can't re-send
// tampered numbers). Lost on restart (harmless: just re-upload). Small + short-lived.
interface StagedImport { fileName: string; rows: ParsedStockRow[]; unresolved: number; at: number }
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
  // Auth runs at onRequest (BEFORE body parsing) so unauthenticated bodies are never
  // parsed — preHandler runs AFTER body parsing, and with a 17 MB route limit that
  // would let anonymous clients make the server buffer+parse 17 MB per request.
  app.addHook('onRequest', requireAuth);
  app.addHook('onRequest', requireRole('supervisor'));

  // GET /api/stock/summary — headline counts for the Vulcan dashboard / login landing.
  app.get('/api/stock/summary', async () => {
    const [total, withStock, outOfStock, unknown, lastImport] = await Promise.all([
      prisma.product.count({ where: { status: 'active' } }),
      prisma.product.count({ where: { status: 'active', stock: { not: null } } }),
      prisma.product.count({ where: { status: 'active', stock: 0 } }),
      prisma.product.count({ where: { status: 'active', stock: null } }),
      prisma.stockImport.findFirst({ orderBy: { importedAt: 'desc' } }),
    ]);
    // Low count needs a column-vs-column compare (stock <= reorderPoint) → raw SQL.
    const lowRows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM "Product"
      WHERE status = 'active' AND stock IS NOT NULL AND "reorderPoint" IS NOT NULL
        AND stock <= "reorderPoint"`;
    const low = Number(lowRows[0]?.n ?? 0);
    return { total, withStock, outOfStock, unknown, low, lastImport };
  });

  // GET /api/stock/list?q=&filter=all|low|unknown&limit= — the searchable stock table.
  // Empty q + filter=all returns the most-recently-updated products (a sensible default
  // landing list). filter=low|out|unknown query the WHOLE catalog (not just a page) so the
  // counts the dashboard shows and the rows here always agree. A search query (q) takes
  // precedence and is then narrowed by the filter.
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
      let rows = products.map(toStockRow);
      if (filter === 'low') rows = rows.filter((r) => r.low);
      else if (filter === 'out') rows = rows.filter((r) => r.stock === 0);
      else if (filter === 'unknown') rows = rows.filter((r) => r.stock == null);
      return { products: await withAliases(rows) };
    }

    if (filter === 'low') {
      // Column-vs-column compare → raw SQL for the SKUs, then fetch full rows.
      const lowSkus = await prisma.$queryRaw<{ sku: string }[]>`
        SELECT sku FROM "Product"
        WHERE status = 'active' AND stock IS NOT NULL AND "reorderPoint" IS NOT NULL
          AND stock <= "reorderPoint"
        ORDER BY (stock::float / NULLIF("reorderPoint", 0)) ASC NULLS FIRST, stock ASC
        LIMIT ${take}`;
      products = await prisma.product.findMany({ where: { sku: { in: lowSkus.map((r) => r.sku) } } });
      const ord = new Map(lowSkus.map((r, i) => [r.sku, i]));
      products.sort((a, b) => (ord.get(a.sku) ?? 0) - (ord.get(b.sku) ?? 0));
    } else if (filter === 'out') {
      products = await prisma.product.findMany({
        where: { status: 'active', stock: 0 },
        orderBy: { sku: 'asc' },
        take,
      });
    } else if (filter === 'unknown') {
      products = await prisma.product.findMany({
        where: { status: 'active', stock: null },
        orderBy: { sku: 'asc' },
        take,
      });
    } else {
      products = await prisma.product.findMany({
        where: { status: 'active' },
        orderBy: [{ stockAt: 'desc' }, { updatedAt: 'desc' }],
        take,
      });
    }

    return { products: await withAliases(products.map(toStockRow)) };
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
  app.post('/api/stock/import/preview', {
    // The daily Express report is ~1.5 MB and arrives base64-inside-JSON (×4/3): the
    // Fastify default 1 MiB bodyLimit would 413 it before the handler runs. Sized to
    // MAX_UPLOAD_BYTES after base64 inflation, plus envelope headroom.
    bodyLimit: 17 * 1024 * 1024,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { dataB64, fileName } = req.body as { dataB64?: string; fileName?: string };
    if (!dataB64 || typeof dataB64 !== 'string') return reply.code(400).send({ error: 'missing_data' });
    // Reject oversized payloads by encoded length before paying for a decode.
    if (dataB64.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) return reply.code(413).send({ error: 'too_large' });
    // Node's base64 decoder never throws (it silently skips invalid chars), so there's
    // no bad_base64 branch here.
    const buf = Buffer.from(dataB64, 'base64');
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
      select: { sku: true, stock: true, nameEn: true, nameTh: true, photoSku: true },
    });
    const cat = new Map(existing.map((p) => [p.sku, p]));

    let matched = 0;
    let willChange = 0;
    const rows = parsed.rows.map((r) => {
      const c = cat.get(r.sku);
      const isMatched = !!c;
      const currentStock = c ? c.stock : null;
      const changes = isMatched && r.qty !== currentStock;
      if (isMatched) matched++;
      if (changes) willChange++;
      return {
        sku: r.sku,
        // Prefer the clean catalog name; fall back to the raw Express text (unmatched rows).
        name: c ? c.nameTh || c.nameEn || r.name : r.name,
        photoSku: c?.photoSku ?? null,
        csvName: r.name,
        qty: r.qty,
        matched: isMatched,
        currentStock,
        willChange: changes,
      };
    });

    const token = stash({ fileName: String(fileName ?? ''), rows: parsed.rows, unresolved: parsed.unresolved, at: Date.now() });
    return {
      token,
      fileName: String(fileName ?? ''),
      encoding,
      rowsParsed: parsed.rows.length,
      matched,
      unmatched: parsed.rows.length - matched,
      willChange,
      unresolved: parsed.unresolved,
      unresolvedSamples: parsed.unresolvedSamples,
      rows,
    };
  });

  // POST /api/stock/import/apply { token, note } — apply a previewed import. Writes
  // Product.stock = qty + stockAt = now for every MATCHED SKU; logs a StockImport row.
  app.post('/api/stock/import/apply', async (req, reply) => {
    const { token, note } = req.body as { token?: string; note?: string };
    const staged = token ? previews.get(token) : undefined;
    // Enforce the TTL explicitly here — eviction elsewhere is lazy (only on new uploads).
    if (!token || !staged || Date.now() - staged.at > PREVIEW_TTL_MS) {
      if (token) previews.delete(token);
      return reply.code(410).send({ error: 'preview_expired', detail: 'พรีวิวหมดอายุ — กรุณาอัปโหลดไฟล์ใหม่' });
    }
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
    let failNote = '';
    const CHUNK = 50;
    try {
      for (let i = 0; i < toApply.length; i += CHUNK) {
        const slice = toApply.slice(i, i + CHUNK);
        const results = await Promise.all(
          slice.map((r) =>
            prisma.product.updateMany({ where: { sku: r.sku }, data: { stock: r.qty, stockAt: importedAt } }),
          ),
        );
        skusUpdated += results.reduce((n, x) => n + x.count, 0);
      }
    } catch (err) {
      failNote = `partial_failure: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    }
    const skusUnmatched = staged.rows.length - toApply.length;

    const noteJoined = [
      String(note ?? ''),
      staged.unresolved > 0 ? `unresolved_lines:${staged.unresolved}` : '',
      failNote,
    ].filter(Boolean).join(' | ');

    const imp = await prisma.stockImport.create({
      data: {
        importedBy: req.agent?.id,
        fileName: staged.fileName,
        rowsParsed: staged.rows.length,
        skusUpdated,
        skusUnmatched,
        note: noteJoined,
      },
    });

    if (failNote) {
      return reply.code(500).send({
        error: 'apply_partial',
        skusUpdated,
        importId: imp.id,
        detail: 'นำเข้าไม่สมบูรณ์ — บางรายการอาจอัปเดตแล้ว กรุณาอัปโหลดและนำเข้าใหม่',
      });
    }
    return { ok: true, skusUpdated, skusUnmatched, importId: imp.id };
  });

  // ─── Product aliases (short human codes, e.g. "TR34") ──────────────────
  // GET /api/stock/aliases — every active product grouped by family, with its alias.
  app.get('/api/stock/aliases', async () => {
    const [products, aliases] = await Promise.all([
      prisma.product.findMany({
        where: { status: 'active' },
        select: { sku: true, nameEn: true, nameTh: true },
        orderBy: { sku: 'asc' },
      }),
      prisma.productAlias.findMany(),
    ]);
    const aliasBySku = new Map(aliases.map((a) => [a.sku, a]));
    const groupsMap = new Map<string, { group: string; prefix: string; items: Array<{ sku: string; alias: string | null; nameEn: string; nameTh: string; third: string }> }>();
    for (const p of products) {
      const g = groupOf(p.sku);
      let entry = groupsMap.get(g);
      if (!entry) { entry = { group: g, prefix: '', items: [] }; groupsMap.set(g, entry); }
      const a = aliasBySku.get(p.sku);
      if (a && !entry.prefix) entry.prefix = a.prefix;
      entry.items.push({ sku: p.sku, alias: a?.alias ?? null, nameEn: p.nameEn, nameTh: p.nameTh, third: p.sku.split('-')[2] ?? '' });
    }
    const groups = [...groupsMap.values()]
      .sort((x, y) => (x.group < y.group ? -1 : 1))
      .map((g) => ({ group: g.group, prefix: g.prefix, count: g.items.length, items: g.items }));
    return { groups };
  });

  // POST /api/stock/aliases/generate { regenerate? } — auto-assign grouped aliases.
  // fill (default): keep existing rows + prefixes, only assign products with no alias.
  // regenerate: wipe + rebuild all (overwrites manual edits).
  app.post('/api/stock/aliases/generate', async (req) => {
    const regenerate = (req.body as { regenerate?: boolean }).regenerate === true;
    const products = await prisma.product.findMany({
      where: { status: 'active' },
      select: { sku: true, nameEn: true, nameTh: true },
    });
    const write = async (rows: { sku: string; alias: string; groupKey: string; prefix: string }[]) => {
      const CHUNK = 50;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await prisma.productAlias.createMany({
          data: rows.slice(i, i + CHUNK).map((a) => ({ sku: a.sku, alias: a.alias, groupKey: a.groupKey, prefix: a.prefix })),
          skipDuplicates: true,
        });
      }
    };

    if (regenerate) {
      await prisma.productAlias.deleteMany({});
      const assignments = buildAliases(products);
      await write(assignments);
      return { ok: true, mode: 'regenerate', groups: new Set(assignments.map((a) => a.groupKey)).size, aliased: assignments.length };
    }

    const existing = await prisma.productAlias.findMany();
    const existingSkus = new Set(existing.map((e) => e.sku));
    const existingPrefixByGroup: Record<string, string> = {};
    const keepAliases: Record<string, string> = {};
    for (const e of existing) { existingPrefixByGroup[e.groupKey] = e.prefix; keepAliases[e.sku] = e.alias; }
    const fresh = buildAliases(products, { existingPrefixByGroup, keepAliases }).filter((a) => !existingSkus.has(a.sku));
    await write(fresh);
    return { ok: true, mode: 'fill', groups: new Set(fresh.map((a) => a.groupKey)).size, aliased: fresh.length };
  });

  // POST /api/stock/aliases/group-prefix { group, prefix } — rename a family's prefix and
  // regenerate its members' aliases (alias = prefix + item segment).
  app.post('/api/stock/aliases/group-prefix', async (req, reply) => {
    const body = req.body as { group?: string; prefix?: string };
    const g = String(body.group ?? '').trim();
    const pfx = String(body.prefix ?? '').trim().toUpperCase();
    if (!g) return reply.code(400).send({ error: 'bad_group' });
    if (!/^[A-Z0-9]{1,4}$/.test(pfx)) return reply.code(400).send({ error: 'bad_prefix' });
    const clash = await prisma.productAlias.findFirst({ where: { prefix: pfx, groupKey: { not: g } } });
    if (clash) return reply.code(409).send({ error: 'prefix_taken' });

    const products = await prisma.product.findMany({
      where: { status: 'active', sku: { startsWith: `${g}-` } },
      select: { sku: true },
    });
    if (!products.length) return reply.code(404).send({ error: 'empty_group' });
    const newAliases = products
      .map((p) => ({ sku: p.sku, alias: `${pfx}${p.sku.split('-')[2] ?? ''}`, third: p.sku.split('-')[2] ?? '' }))
      .filter((x) => x.third);
    const aliasClash = await prisma.productAlias.findFirst({
      where: { alias: { in: newAliases.map((a) => a.alias) }, sku: { notIn: newAliases.map((a) => a.sku) } },
    });
    if (aliasClash) return reply.code(409).send({ error: 'alias_taken' });

    let updated = 0;
    for (const a of newAliases) {
      await prisma.productAlias.upsert({
        where: { sku: a.sku },
        update: { alias: a.alias, groupKey: g, prefix: pfx },
        create: { sku: a.sku, alias: a.alias, groupKey: g, prefix: pfx },
      });
      updated++;
    }
    return { ok: true, group: g, prefix: pfx, updated };
  });

  // POST /api/stock/aliases/set { sku, alias } — set/clear one product's alias (alias=''
  // clears it). Uniqueness enforced.
  app.post('/api/stock/aliases/set', async (req, reply) => {
    const body = req.body as { sku?: string; alias?: string };
    const sku = String(body.sku ?? '').trim();
    if (!sku || !SKU_RE.test(sku)) return reply.code(400).send({ error: 'bad_sku' });
    const product = await prisma.product.findUnique({ where: { sku } });
    if (!product) return reply.code(404).send({ error: 'unknown_sku' });
    const raw = String(body.alias ?? '').trim().toUpperCase();
    if (raw === '') {
      await prisma.productAlias.deleteMany({ where: { sku } });
      return { ok: true, sku, alias: null };
    }
    if (!/^[A-Z0-9]{2,12}$/.test(raw)) return reply.code(400).send({ error: 'bad_alias' });
    const clash = await prisma.productAlias.findFirst({ where: { alias: raw, sku: { not: sku } } });
    if (clash) return reply.code(409).send({ error: 'alias_taken' });
    const prefix = raw.replace(/[0-9]+$/, '') || raw;
    await prisma.productAlias.upsert({
      where: { sku },
      update: { alias: raw, groupKey: groupOf(sku), prefix },
      create: { sku, alias: raw, groupKey: groupOf(sku), prefix },
    });
    return { ok: true, sku, alias: raw };
  });
}
