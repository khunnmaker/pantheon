import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { LOW_STOCK_WHERE, LOW_STOCK_ORDER } from '../db/lowStock.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { searchProducts } from '../catalog/match.js';
import { toStockRow } from '../stock/helpers.js';
import { setStock } from '../stock/adjust.js';
import { decodeExpressBytes, parseExpressReport, type ParsedStockRow } from '../stock/parseExpressReport.js';
import { buildGroupAliases, groupOf } from '../stock/aliases.js';
import { autoAssignGroup, autoAssignSubgroup, SUBGROUPS } from '../stock/catalogGroups.js';
import { loadTaxonomy, PILLARS } from '../stock/taxonomy.js';
import { NAME_PROPOSALS } from '../catalog/nameProposals.js';
import { EXPRESS_NAMES } from '../catalog/expressNames.js';

// Merge a product's name tokens (alnum + Thai, length >= 2) into its keyword set, deduped +
// capped at 30. Shared by the rename route and the name-proposal review flow so an approved
// name becomes searchable exactly like a manual rename.
function mergeNameKeywords(existing: string[], nameEn: string, nameTh: string): string[] {
  const toks = `${nameEn} ${nameTh}`.toLowerCase().split(/[^a-z0-9฀-๿]+/i).filter((t) => t.length >= 2);
  return [...new Set([...existing, ...toks])].slice(0, 30);
}

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

// Vesta stock-management API. Writes Product.stock/stockAt (which Minerva reads)
// plus a reorderPoint per SKU, and logs StockImport / StockAdjustment audit rows.
// Gated to supervisor for v1 (the stock manager logs in as Dr. M). See VESTA_BRIEF.md.

const SKU_RE = /^[A-Za-z0-9_-]+$/;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // Express reports are ~1.5 MB; cap generously.

// In-memory staging for previewed imports: the manager previews, eyeballs the diff,
// then applies the EXACT parsed set (server-authoritative — the client can't re-send
// tampered numbers). Lost on restart (harmless: just re-upload). Small + short-lived.
interface StagedImport { fileName: string; rows: ParsedStockRow[]; unresolved: number; at: number; asOf: Date | null }
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

// Vesta manages catalog products ('active') PLUS 'stock_only' rows created from the Express stock
// import — tracked here but HIDDEN from Diana + the AI, which whitelist 'active'. Use this in
// Vesta's own product queries so those rows show up; never widen a Diana/Minerva query with it.
const VESTA_STATUS = { in: ['active', 'stock_only'] };
const VESTA_STATUSES = ['active', 'stock_only'];

export async function stockRoutes(app: FastifyInstance) {
  // Auth runs at onRequest (BEFORE body parsing) so unauthenticated bodies are never
  // parsed — preHandler runs AFTER body parsing, and with a 17 MB route limit that
  // would let anonymous clients make the server buffer+parse 17 MB per request.
  app.addHook('onRequest', requireAuth);
  app.addHook('onRequest', requireRole('supervisor'));

  // GET /api/stock/summary — headline counts for the Vesta dashboard / login landing.
  app.get('/api/stock/summary', async () => {
    const [total, withStock, outOfStock, unknown, lastImport] = await Promise.all([
      prisma.product.count({ where: { status: VESTA_STATUS } }),
      prisma.product.count({ where: { status: VESTA_STATUS, stock: { not: null } } }),
      prisma.product.count({ where: { status: VESTA_STATUS, stock: 0 } }),
      prisma.product.count({ where: { status: VESTA_STATUS, stock: null } }),
      prisma.stockImport.findFirst({ orderBy: { importedAt: 'desc' } }),
    ]);
    // Low count needs a column-vs-column compare (stock <= reorderPoint) → raw SQL.
    const lowRows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM "Product" WHERE ${LOW_STOCK_WHERE}`;
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
      const matches = await searchProducts(query, take, VESTA_STATUSES);
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
      else if (filter === 'noname') rows = rows.filter((r) => !r.nameTh.trim());
      return { products: await withAliases(rows) };
    }

    if (filter === 'low') {
      // Column-vs-column compare → raw SQL for the SKUs, then fetch full rows.
      const lowSkus = await prisma.$queryRaw<{ sku: string }[]>`
        SELECT sku FROM "Product" WHERE ${LOW_STOCK_WHERE} ${LOW_STOCK_ORDER} LIMIT ${take}`;
      products = await prisma.product.findMany({ where: { sku: { in: lowSkus.map((r) => r.sku) } } });
      const ord = new Map(lowSkus.map((r, i) => [r.sku, i]));
      products.sort((a, b) => (ord.get(a.sku) ?? 0) - (ord.get(b.sku) ?? 0));
    } else if (filter === 'out') {
      products = await prisma.product.findMany({
        where: { status: VESTA_STATUS, stock: 0 },
        orderBy: { sku: 'asc' },
        take,
      });
    } else if (filter === 'unknown') {
      products = await prisma.product.findMany({
        where: { status: VESTA_STATUS, stock: null },
        orderBy: { sku: 'asc' },
        take,
      });
    } else if (filter === 'noname') {
      products = await prisma.product.findMany({
        where: { status: VESTA_STATUS, nameTh: '' },
        orderBy: { sku: 'asc' },
        take,
      });
    } else {
      products = await prisma.product.findMany({
        where: { status: VESTA_STATUS },
        orderBy: [{ stockAt: 'desc' }, { updatedAt: 'desc' }],
        take,
      });
    }

    return { products: await withAliases(products.map(toStockRow)) };
  });

  // POST /api/stock/adjust { sku, toQty, reason } — manual correction between imports.
  // Writes Product.stock (+ stockAt = now) and logs a StockAdjustment. toQty=null clears
  // the stock to unknown. Never creates a catalog row — unknown SKU is rejected. Delegates to
  // the shared setStock helper (api/src/stock/adjust.ts) — the SINGLE stock-write path that
  // Mercury goods-receipt also calls, so the write + audit shape is identical everywhere.
  app.post('/api/stock/adjust', async (req, reply) => {
    const body = req.body as { sku?: string; toQty?: unknown; reason?: string };

    let toQty: number | null;
    if (body.toQty === null || body.toQty === undefined || body.toQty === '') {
      toQty = null;
    } else {
      const n = Number(body.toQty);
      if (!Number.isInteger(n) || n < 0) return reply.code(400).send({ error: 'bad_qty' });
      toQty = n;
    }

    const result = await setStock({
      sku: String(body.sku ?? ''),
      toQty,
      reason: String(body.reason ?? '').trim(),
      agentId: req.agent?.id,
    });
    if (!result.ok) {
      const code = result.error === 'unknown_sku' ? 404 : 400;
      return reply.code(code).send({ error: result.error });
    }
    return result.unchanged
      ? { ok: true, product: result.product, unchanged: true }
      : { ok: true, product: result.product };
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

  // POST /api/stock/catalog/name { sku, nameEn, nameTh } — rename a product. Merges the new
  // name's tokens into keywords so Minerva's search finds it by the new name.
  app.post('/api/stock/catalog/name', async (req, reply) => {
    const body = req.body as { sku?: string; nameEn?: string; nameTh?: string };
    const sku = String(body.sku ?? '').trim();
    if (!sku || !SKU_RE.test(sku)) return reply.code(400).send({ error: 'bad_sku' });
    const nameEn = String(body.nameEn ?? '').trim();
    const nameTh = String(body.nameTh ?? '').trim();
    if (!nameEn && !nameTh) return reply.code(400).send({ error: 'empty_name' });
    const product = await prisma.product.findUnique({ where: { sku } });
    if (!product) return reply.code(404).send({ error: 'unknown_sku' });
    const keywords = mergeNameKeywords(product.keywords, nameEn, nameTh);
    const updated = await prisma.product.update({ where: { sku }, data: { nameEn, nameTh, keywords } });
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

    const token = stash({ fileName: String(fileName ?? ''), rows: parsed.rows, unresolved: parsed.unresolved, at: Date.now(), asOf: parsed.asOf });
    return {
      token,
      fileName: String(fileName ?? ''),
      encoding,
      // the report's own "ณ วันที่" header — stock figures are as-of THIS date, and apply
      // stamps stockAt with it (fallback: apply time when the header wasn't found)
      asOf: parsed.asOf ? parsed.asOf.toISOString() : null,
      asOfText: parsed.asOfText,
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
    const { token, note, createNew } = req.body as { token?: string; note?: string; createNew?: boolean };
    const staged = token ? previews.get(token) : undefined;
    // Enforce the TTL explicitly here — eviction elsewhere is lazy (only on new uploads).
    if (!token || !staged || Date.now() - staged.at > PREVIEW_TTL_MS) {
      if (token) previews.delete(token);
      return reply.code(410).send({ error: 'preview_expired', detail: 'พรีวิวหมดอายุ — กรุณาอัปโหลดไฟล์ใหม่' });
    }
    previews.delete(token);

    const importedAt = new Date();
    // Stock figures are as-of the REPORT's header date, not upload time — stamping upload
    // time would make yesterday's report look fresher than it is (staleness badge lies).
    const stockAt = staged.asOf ?? importedAt;
    const skus = staged.rows.map((r) => r.sku);
    const existing = await prisma.product.findMany({
      where: { sku: { in: skus } },
      select: { sku: true },
    });
    const known = new Set(existing.map((p) => p.sku));

    // Apply matched SKUs in BULK — one UPDATE ... FROM (VALUES …) per chunk rather than 1000+
    // single-row updates, which on a small connection pool exhaust it / time out (that was the
    // "นำเข้าไม่สำเร็จ" on a full ~5k-row report). Each chunk sets every row's new qty in one query;
    // stockAt is the same date for all rows.
    const toApply = staged.rows.filter((r) => known.has(r.sku));
    let skusUpdated = 0;
    let failNote = '';
    const CHUNK = 500;
    try {
      for (let i = 0; i < toApply.length; i += CHUNK) {
        const slice = toApply.slice(i, i + CHUNK);
        // Explicit per-param casts so Postgres never fails to infer the VALUES column types.
        const tuples = Prisma.join(slice.map((r) => Prisma.sql`(${r.sku}::text, ${r.qty}::int)`));
        const n = await prisma.$executeRaw`
          UPDATE "Product" AS p
          SET stock = v.qty, "stockAt" = ${stockAt}
          FROM (VALUES ${tuples}) AS v(sku, qty)
          WHERE p.sku = v.sku`;
        skusUpdated += Number(n);
      }
    } catch (err) {
      failNote = `update_failure: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    }

    // Optionally CREATE the SKUs not yet in the catalog as 'stock_only' rows — tracked in Vesta
    // (stock + grouping) but hidden from Diana + the AI (they whitelist 'active') until someone
    // enriches them (price/photo/proper name) and promotes them to 'active'. Name = the raw Express
    // text; price 0 = unknown. skipDuplicates guards a concurrent create. Only when the stock
    // update above fully succeeded.
    let created = 0;
    if (createNew && !failNote) {
      const toCreate = staged.rows.filter((r) => !known.has(r.sku) && r.name.trim());
      const CREATE_CHUNK = 500;
      try {
        for (let i = 0; i < toCreate.length; i += CREATE_CHUNK) {
          const data = toCreate.slice(i, i + CREATE_CHUNK).map((r) => ({
            sku: r.sku,
            nameEn: r.name.trim(),
            keywords: [...new Set(r.name.toLowerCase().split(/[^a-z0-9฀-๿]+/i).filter((t) => t.length >= 2))].slice(0, 30),
            price: 0,
            status: 'stock_only',
            stock: r.qty,
            stockAt,
          }));
          const res = await prisma.product.createMany({ data, skipDuplicates: true });
          created += res.count;
        }
      } catch (err) {
        failNote = `create_failure: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      }
    }
    // remaining "not in catalog" after this import (created ones now exist)
    const skusUnmatched = staged.rows.length - toApply.length - created;

    const noteJoined = [
      String(note ?? ''),
      staged.asOf ? `asOf:${staged.asOf.toISOString().slice(0, 10)}` : '',
      created > 0 ? `created:${created}` : '',
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
      // The real cause is saved to StockImport.note (visible in ประวัติ) AND logged here for the
      // Railway logs. detail carries a trimmed reason so the supervisor sees WHY, not just "failed".
      req.log.error({ failNote, fileName: staged.fileName }, 'stock import apply failed');
      return reply.code(500).send({
        error: 'apply_partial',
        skusUpdated,
        created,
        importId: imp.id,
        detail: `นำเข้าไม่สมบูรณ์ — ${failNote.slice(0, 160)}`,
      });
    }
    return { ok: true, skusUpdated, skusUnmatched, created, importId: imp.id };
  });

  // ─── Product aliases (short human codes, e.g. "TR34") ──────────────────
  // GET /api/stock/aliases — every active product grouped by family, with its alias.
  app.get('/api/stock/aliases', async () => {
    const [products, aliases] = await Promise.all([
      prisma.product.findMany({
        where: { status: VESTA_STATUS },
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

  // POST /api/stock/aliases/generate { regenerate? } — (re)build GROUP-BASED codes:
  // alias = <2-letter group code> + running number (e.g. IM01, EN12). Only products that
  // HAVE a catalogGroup get a code. fill (default): keep existing codes + append new/regrouped
  // items. regenerate: renumber every group from 1 (overwrites manual edits).
  app.post('/api/stock/aliases/generate', async (req) => {
    const regenerate = (req.body as { regenerate?: boolean }).regenerate === true;
    const products = await prisma.product.findMany({
      where: { status: VESTA_STATUS, catalogGroup: { not: null } },
      select: { sku: true, catalogGroup: true, catalogSubgroup: true },
    });
    const existing = await prisma.productAlias.findMany();
    const keep = regenerate ? {} : Object.fromEntries(existing.map((e) => [e.sku, e.alias]));
    const tax = await loadTaxonomy();
    const assignments = buildGroupAliases(products, { keep, groupCode: tax.groupCodeByKey, subCodes: tax.subCodesByGroup });
    const keepSkus = new Set(assignments.map((a) => a.sku));

    let written = 0;
    if (regenerate) {
      await prisma.productAlias.deleteMany({});
      const CHUNK = 100;
      for (let i = 0; i < assignments.length; i += CHUNK) {
        await prisma.productAlias.createMany({ data: assignments.slice(i, i + CHUNK), skipDuplicates: true });
      }
      written = assignments.length;
    } else {
      // Drop codes for products that are no longer grouped, then write only the changed ones.
      const stale = existing.filter((e) => !keepSkus.has(e.sku)).map((e) => e.sku);
      if (stale.length) await prisma.productAlias.deleteMany({ where: { sku: { in: stale } } });
      const exBySku = new Map(existing.map((e) => [e.sku, e.alias]));
      for (const a of assignments) {
        if (exBySku.get(a.sku) === a.alias) continue;
        await prisma.productAlias.upsert({
          where: { sku: a.sku },
          update: { alias: a.alias, groupKey: a.groupKey, prefix: a.prefix },
          create: a,
        });
        written++;
      }
    }
    const ungrouped = await prisma.product.count({ where: { status: VESTA_STATUS, catalogGroup: null } });
    return { ok: true, mode: regenerate ? 'regenerate' : 'fill', coded: assignments.length, written, ungrouped };
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
      where: { status: VESTA_STATUS, sku: { startsWith: `${g}-` } },
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

  // ─── Catalog groups (merchandising taxonomy) ───────────────────────────
  // GET /api/stock/groups — the fixed group vocabulary + how many products are in each,
  // grouped by pillar, plus the unassigned count.
  app.get('/api/stock/groups', async () => {
    const counts = await prisma.product.groupBy({
      by: ['catalogGroup'],
      where: { status: VESTA_STATUS },
      _count: { _all: true },
    });
    const byKey = new Map(counts.map((c) => [c.catalogGroup ?? '', c._count._all]));
    const total = counts.reduce((n, c) => n + c._count._all, 0);
    const tax = await loadTaxonomy();
    const groups = tax.groups.map((g) => ({ ...g, count: byKey.get(g.key) ?? 0, subgroups: tax.subgroupsByGroup.get(g.key) ?? [] }));
    return { groups, total, unassigned: byKey.get('') ?? 0 };
  });

  // GET /api/stock/groups/products?group=&filter=all|unassigned&q=&limit= — products for the
  // review list, each with its current group + alias. group=<key> filters to that group.
  app.get('/api/stock/groups/products', async (req) => {
    const { group, filter, q, limit, sort } = req.query as { group?: string; filter?: string; q?: string; limit?: string; sort?: string };
    // Load the whole bucket by default so "select all" in the batch UI really covers everything —
    // the cap sits above the full active catalog (~1187) so even the all-unassigned bucket (before
    // auto-assign) loads completely. The UI still shows a "loaded N of M" warning if it ever caps.
    const take = Math.min(Math.max(Number(limit) || 2000, 1), 2000);
    const query = String(q ?? '').trim();

    const where: Record<string, unknown> = { status: VESTA_STATUS };
    if (group) where.catalogGroup = group;
    else if (filter === 'unassigned') where.catalogGroup = null;
    else if (filter === 'proposals') where.proposalStatus = 'pending';

    let products;
    if (query) {
      const matches = await searchProducts(query, take, VESTA_STATUSES);
      const skus = matches.map((m) => m.sku);
      products = skus.length
        ? await prisma.product.findMany({ where: { ...where, sku: { in: skus } } })
        : [];
      const order = new Map(skus.map((s, i) => [s, i]));
      products.sort((a, b) => (order.get(a.sku) ?? 0) - (order.get(b.sku) ?? 0));
    } else {
      // sort=sub clusters same-subgroup (ชนิด) rows; sort=name clusters similar names together
      // (great for the ยังไม่จัด pile — pick a range, batch-group). default is SKU order. Only the
      // browse path sorts — a search keeps its relevance rank.
      const orderBy =
        sort === 'sub' ? [{ catalogSubgroup: { sort: 'asc' as const, nulls: 'last' as const } }, { sku: 'asc' as const }]
        : sort === 'name' ? [{ nameTh: 'asc' as const }, { nameEn: 'asc' as const }, { sku: 'asc' as const }]
        : { sku: 'asc' as const };
      products = await prisma.product.findMany({ where, orderBy, take });
    }

    const aliases = products.length
      ? await prisma.productAlias.findMany({ where: { sku: { in: products.map((p) => p.sku) } }, select: { sku: true, alias: true } })
      : [];
    const aliasBySku = new Map(aliases.map((a) => [a.sku, a.alias]));
    return {
      products: products.map((p) => ({
        sku: p.sku, nameEn: p.nameEn, nameTh: p.nameTh, photoSku: p.photoSku,
        catalogGroup: p.catalogGroup, catalogSubgroup: p.catalogSubgroup,
        alias: aliasBySku.get(p.sku) ?? null,
        stock: p.stock, reorderPoint: p.reorderPoint,
        stockOnly: p.status === 'stock_only',
        // Same extra fields the old ตรวจทานชื่อ list carried — now every จัดกลุ่ม bucket can show
        // the Express reference name + proposal state, since the review flow lives here too.
        expressName: EXPRESS_NAMES[p.sku] ?? '',
        proposedNameEn: p.proposedNameEn,
        proposalStatus: p.proposalStatus,
        proposalNeedsReview: p.proposalNeedsReview,
      })),
    };
  });

  // POST /api/stock/groups/auto-assign { onlyUnassigned? } — run the keyword/category rules.
  // onlyUnassigned=true (default): fill GROUP for products with none, and fill SUBGROUP for any
  // grouped product still missing one. false: recompute both for everything. Never touches SKU.
  app.post('/api/stock/groups/auto-assign', async (req) => {
    const onlyUnassigned = (req.body as { onlyUnassigned?: boolean }).onlyUnassigned !== false;
    const CHUNK = 200;
    const tax = await loadTaxonomy();
    // Write a sku→value map bucketed by value (one updateMany per distinct value).
    const writeBucketed = async (bySku: Map<string, string>, field: 'catalogGroup' | 'catalogSubgroup') => {
      const byVal = new Map<string, string[]>();
      for (const [sku, v] of bySku) { if (!byVal.has(v)) byVal.set(v, []); byVal.get(v)!.push(sku); }
      let n = 0;
      for (const [v, skus] of byVal) {
        for (let i = 0; i < skus.length; i += CHUNK) {
          const res = await prisma.product.updateMany({ where: { sku: { in: skus.slice(i, i + CHUNK) } }, data: { [field]: v } });
          n += res.count;
        }
      }
      return n;
    };

    // ── GROUP pass ──
    const groupScope = await prisma.product.findMany({
      where: onlyUnassigned ? { status: VESTA_STATUS, catalogGroup: null } : { status: VESTA_STATUS },
      select: { sku: true, nameEn: true, nameTh: true, keywords: true },
    });
    const groupBySku = new Map<string, string>();
    for (const p of groupScope) { const g = autoAssignGroup(p); if (g) groupBySku.set(p.sku, g); }
    const assigned = await writeBucketed(groupBySku, 'catalogGroup');

    // ── SUBGROUP pass ── (after groups are written, so newly-grouped items are included)
    const subScope = await prisma.product.findMany({
      where: { status: VESTA_STATUS, catalogGroup: { not: null }, ...(onlyUnassigned ? { catalogSubgroup: null } : {}) },
      select: { sku: true, nameEn: true, nameTh: true, keywords: true, catalogGroup: true },
    });
    const subBySku = new Map<string, string>();
    for (const p of subScope) {
      const g = p.catalogGroup!;
      let s = autoAssignSubgroup(g, p);
      if (s) s = tax.builtinSubRemap[g]?.[s] ?? s;
      if (s && !tax.subCodesByGroup[g]?.has(s)) s = null;
      if (s) subBySku.set(p.sku, s);
    }
    const subAssigned = await writeBucketed(subBySku, 'catalogSubgroup');

    const stillNull = await prisma.product.count({ where: { status: VESTA_STATUS, catalogGroup: null } });
    return { ok: true, assigned, subAssigned, unassigned: stillNull, scanned: groupScope.length };
  });

  // POST /api/stock/groups/set-product { sku, group } — set/clear one product's group.
  // Changing the group clears any sub-group (a sub code only makes sense within its group).
  app.post('/api/stock/groups/set-product', async (req, reply) => {
    const body = req.body as { sku?: string; group?: string | null };
    const sku = String(body.sku ?? '').trim();
    if (!sku || !SKU_RE.test(sku)) return reply.code(400).send({ error: 'bad_sku' });
    const group = body.group === null || body.group === '' || body.group === undefined ? null : String(body.group);
    if (group !== null && !(await loadTaxonomy()).groupKeys.has(group)) return reply.code(400).send({ error: 'bad_group' });
    const existing = await prisma.product.findUnique({ where: { sku }, select: { catalogGroup: true } });
    if (!existing) return reply.code(404).send({ error: 'unknown_sku' });
    const clearSub = existing.catalogGroup !== group;
    await prisma.product.update({ where: { sku }, data: { catalogGroup: group, ...(clearSub ? { catalogSubgroup: null } : {}) } });
    return { ok: true, sku, group };
  });

  // POST /api/stock/groups/set-subgroup { sku, subgroup } — set/clear one product's sub-group
  // (a 2-letter code that must be valid for the product's current group).
  app.post('/api/stock/groups/set-subgroup', async (req, reply) => {
    const body = req.body as { sku?: string; subgroup?: string | null };
    const sku = String(body.sku ?? '').trim();
    if (!sku || !SKU_RE.test(sku)) return reply.code(400).send({ error: 'bad_sku' });
    const sub = body.subgroup === null || body.subgroup === '' || body.subgroup === undefined ? null : String(body.subgroup);
    const product = await prisma.product.findUnique({ where: { sku }, select: { catalogGroup: true } });
    if (!product) return reply.code(404).send({ error: 'unknown_sku' });
    if (sub !== null) {
      if (!product.catalogGroup) return reply.code(400).send({ error: 'no_group' });
      const tax = await loadTaxonomy();
      if (!tax.subCodesByGroup[product.catalogGroup]?.has(sub)) return reply.code(400).send({ error: 'bad_subgroup' });
    }
    await prisma.product.update({ where: { sku }, data: { catalogSubgroup: sub } });
    return { ok: true, sku, subgroup: sub };
  });

  // POST /api/stock/groups/set-family { family, group } — set the group for every product
  // in a family ("NN-NN"). Fast way to assign a whole coherent product line at once.
  app.post('/api/stock/groups/set-family', async (req, reply) => {
    const body = req.body as { family?: string; group?: string | null };
    const family = String(body.family ?? '').trim();
    if (!/^\d{2}-\d{2}$/.test(family)) return reply.code(400).send({ error: 'bad_family' });
    const group = body.group === null || body.group === '' || body.group === undefined ? null : String(body.group);
    if (group !== null && !(await loadTaxonomy()).groupKeys.has(group)) return reply.code(400).send({ error: 'bad_group' });
    const res = await prisma.product.updateMany({
      where: { status: VESTA_STATUS, sku: { startsWith: `${family}-` }, catalogGroup: group === null ? { not: null } : undefined },
      data: { catalogGroup: group },
    });
    return { ok: true, family, group, updated: res.count };
  });

  // POST /api/stock/groups/set-products { skus: string[], group } — set/clear the group for MANY
  // products at once (batch move from the จัดกลุ่ม tab). Changing a product's group clears its
  // sub-group (a sub code only makes sense within its group); we clear it only for the rows whose
  // group actually changes, so re-tagging within the same group keeps existing sub-groups.
  app.post('/api/stock/groups/set-products', async (req, reply) => {
    const body = req.body as { skus?: unknown; group?: string | null };
    const skus = Array.isArray(body.skus)
      ? [...new Set(body.skus.filter((s): s is string => typeof s === 'string' && SKU_RE.test(s)))]
      : [];
    if (skus.length === 0) return reply.code(400).send({ error: 'no_skus' });
    if (skus.length > 2000) return reply.code(413).send({ error: 'too_many' });
    const group = body.group === null || body.group === '' || body.group === undefined ? null : String(body.group);
    if (group !== null && !(await loadTaxonomy()).groupKeys.has(group)) return reply.code(400).send({ error: 'bad_group' });

    const CHUNK = 200;
    let updated = 0;
    for (let i = 0; i < skus.length; i += CHUNK) {
      const slice = skus.slice(i, i + CHUNK);
      // clear the sub-group only where the group is actually changing
      await prisma.product.updateMany({
        where: { sku: { in: slice }, status: VESTA_STATUS, NOT: { catalogGroup: group } },
        data: { catalogSubgroup: null },
      });
      const res = await prisma.product.updateMany({
        where: { sku: { in: slice }, status: VESTA_STATUS },
        data: { catalogGroup: group },
      });
      updated += res.count;
    }
    return { ok: true, group, updated };
  });

  // POST /api/stock/groups/set-subgroups { skus: string[], subgroup } — set/clear the sub-group for
  // MANY products at once. On SET, only products whose CURRENT group actually defines that sub-code
  // are changed (the rest are skipped, not errored) so a batch from a mixed selection stays valid.
  app.post('/api/stock/groups/set-subgroups', async (req, reply) => {
    const body = req.body as { skus?: unknown; subgroup?: string | null };
    const skus = Array.isArray(body.skus)
      ? [...new Set(body.skus.filter((s): s is string => typeof s === 'string' && SKU_RE.test(s)))]
      : [];
    if (skus.length === 0) return reply.code(400).send({ error: 'no_skus' });
    if (skus.length > 2000) return reply.code(413).send({ error: 'too_many' });
    const sub = body.subgroup === null || body.subgroup === '' || body.subgroup === undefined ? null : String(body.subgroup);

    const CHUNK = 200;
    if (sub === null) {
      let updated = 0;
      for (let i = 0; i < skus.length; i += CHUNK) {
        const res = await prisma.product.updateMany({
          where: { sku: { in: skus.slice(i, i + CHUNK) }, status: VESTA_STATUS },
          data: { catalogSubgroup: null },
        });
        updated += res.count;
      }
      return { ok: true, subgroup: null, updated, skipped: 0 };
    }
    // set: keep only the SKUs whose current group defines this sub-code
    const prods = await prisma.product.findMany({
      where: { sku: { in: skus }, status: VESTA_STATUS },
      select: { sku: true, catalogGroup: true },
    });
    const tax = await loadTaxonomy();
    const valid = prods.filter((p) => p.catalogGroup && tax.subCodesByGroup[p.catalogGroup]?.has(sub)).map((p) => p.sku);
    let updated = 0;
    for (let i = 0; i < valid.length; i += CHUNK) {
      const res = await prisma.product.updateMany({
        where: { sku: { in: valid.slice(i, i + CHUNK) }, status: VESTA_STATUS },
        data: { catalogSubgroup: sub },
      });
      updated += res.count;
    }
    return { ok: true, subgroup: sub, updated, skipped: skus.length - valid.length };
  });

  // ─── Staff-created groups + sub-groups (overlay on the built-in vocabulary) ─────────────
  // POST /api/stock/groups/create { nameTh, nameEn, code, pillar } — add a new group. code is a
  // 2-letter product-code prefix, globally unique across built-in + custom. key is derived from
  // the code so it never collides with a built-in key.
  app.post('/api/stock/groups/create', async (req, reply) => {
    const b = req.body as { nameTh?: string; nameEn?: string; code?: string; pillar?: string };
    const nameTh = String(b.nameTh ?? '').trim();
    const nameEn = String(b.nameEn ?? '').trim();
    const code = String(b.code ?? '').trim().toUpperCase();
    const pillar = String(b.pillar ?? 'lab');
    if (!nameTh && !nameEn) return reply.code(400).send({ error: 'name_required' });
    if (!/^[A-Z]{2}$/.test(code)) return reply.code(400).send({ error: 'bad_code' });
    if (!(PILLARS as readonly string[]).includes(pillar)) return reply.code(400).send({ error: 'bad_pillar' });
    const tax = await loadTaxonomy();
    if (tax.usedCodes.has(code)) return reply.code(409).send({ error: 'code_taken' });
    const key = `cg_${code.toLowerCase()}`;
    if (tax.groupKeys.has(key)) return reply.code(409).send({ error: 'key_taken' });
    const sortOrder = await prisma.catalogGroupDef.count();
    const g = await prisma.catalogGroupDef.create({ data: { key, code, nameTh, nameEn, pillar, sortOrder } });
    return { ok: true, group: { key: g.key, code: g.code, nameTh: g.nameTh, nameEn: g.nameEn, pillar: g.pillar, custom: true } };
  });

  // POST /api/stock/groups/create-subgroup { groupKey, nameTh, nameEn, code } — add a sub-group to
  // ANY group (built-in or custom). code is 2 letters/digits with at least one letter, unique
  // within that group.
  app.post('/api/stock/groups/create-subgroup', async (req, reply) => {
    const b = req.body as { groupKey?: string; nameTh?: string; nameEn?: string; code?: string };
    const groupKey = String(b.groupKey ?? '').trim();
    const nameTh = String(b.nameTh ?? '').trim();
    const nameEn = String(b.nameEn ?? '').trim();
    const code = String(b.code ?? '').trim().toUpperCase();
    if (!nameTh && !nameEn) return reply.code(400).send({ error: 'name_required' });
    // Pure digits could make group+subgroup prefixes indistinguishable from real product aliases.
    if (!/^(?=.*[A-Z])[A-Z0-9]{2}$/.test(code)) return reply.code(400).send({ error: 'bad_code' });
    const tax = await loadTaxonomy();
    if (!tax.groupKeys.has(groupKey)) return reply.code(400).send({ error: 'bad_group' });
    if (tax.subCodesByGroup[groupKey]?.has(code)) return reply.code(409).send({ error: 'code_taken' });
    const sortOrder = await prisma.catalogSubgroupDef.count({ where: { groupKey } });
    const s = await prisma.catalogSubgroupDef.create({ data: { groupKey, code, nameTh, nameEn, sortOrder } });
    return { ok: true, groupKey, subgroup: { code: s.code, nameTh: s.nameTh, nameEn: s.nameEn, custom: true } };
  });

  // POST /api/stock/groups/rename-subgroup { groupKey, code, nameTh, nameEn, newCode? } — update
  // display names and optionally re-key any sub-group, migrating products and retiring old aliases.
  app.post('/api/stock/groups/rename-subgroup', async (req, reply) => {
    const b = req.body as { groupKey?: string; code?: string; nameTh?: string; nameEn?: string; newCode?: string };
    const groupKey = String(b.groupKey ?? '').trim();
    const code = String(b.code ?? '').trim().toUpperCase();
    const newCode = b.newCode === undefined ? code : String(b.newCode).trim().toUpperCase();
    const nameTh = String(b.nameTh ?? '').trim();
    const nameEn = String(b.nameEn ?? '').trim();
    if (!nameTh && !nameEn) return reply.code(400).send({ error: 'name_required' });
    const tax = await loadTaxonomy();
    if (!tax.groupKeys.has(groupKey)) return reply.code(400).send({ error: 'bad_group' });
    if (!tax.subCodesByGroup[groupKey]?.has(code)) return reply.code(400).send({ error: 'bad_subgroup' });
    if (newCode !== code && !/^(?=.*[A-Z])[A-Z0-9]{2}$/.test(newCode)) return reply.code(400).send({ error: 'bad_code' });
    if (newCode !== code && tax.subCodesByGroup[groupKey]?.has(newCode)) return reply.code(409).send({ error: 'code_taken' });
    if (newCode !== code) {
      const isBuiltin = (SUBGROUPS[groupKey] ?? []).some((s) => s.code === code);
      const prefixOld = `${tax.groupCodeByKey.get(groupKey)}${code}`;
      // A subgroup code change is an identity migration, so its definition and every product move atomically.
      await prisma.$transaction(async (tx) => {
        const existing = await tx.catalogSubgroupDef.findUnique({ where: { groupKey_code: { groupKey, code } } });
        if (existing) {
          await tx.catalogSubgroupDef.update({
            where: { groupKey_code: { groupKey, code } },
            data: { code: newCode, nameTh, nameEn, ...(isBuiltin ? { replacesBuiltin: existing.replacesBuiltin ?? code } : {}) },
          });
        } else if (isBuiltin) {
          const sortOrder = await tx.catalogSubgroupDef.count({ where: { groupKey } });
          await tx.catalogSubgroupDef.create({ data: { groupKey, code: newCode, nameTh, nameEn, replacesBuiltin: code, sortOrder } });
        }
        await tx.product.updateMany({
          where: { catalogGroup: groupKey, catalogSubgroup: code },
          data: { catalogSubgroup: newCode },
        });
        // Aliases under the old subgroup prefix are invalid identities and will be re-issued explicitly later.
        await tx.productAlias.deleteMany({ where: { alias: { startsWith: prefixOld } } });
      });
      return { ok: true, groupKey, subgroup: { code: newCode, nameTh, nameEn } };
    }
    const sortOrder = await prisma.catalogSubgroupDef.count({ where: { groupKey } });
    await prisma.catalogSubgroupDef.upsert({
      where: { groupKey_code: { groupKey, code } },
      update: { nameTh, nameEn },
      create: { groupKey, code, nameTh, nameEn, sortOrder },
    });
    return { ok: true, groupKey, subgroup: { code, nameTh, nameEn } };
  });

  // POST /api/stock/groups/delete { key } — delete a STAFF-CREATED group (built-ins can't be
  // deleted). Its products become ungrouped (and lose their code); its custom sub-groups go too.
  app.post('/api/stock/groups/delete', async (req, reply) => {
    const key = String((req.body as { key?: string }).key ?? '').trim();
    const def = await prisma.catalogGroupDef.findUnique({ where: { key } });
    if (!def) return reply.code(404).send({ error: 'not_custom' }); // built-in or nonexistent
    const affected = await prisma.product.findMany({ where: { catalogGroup: key }, select: { sku: true } });
    await prisma.product.updateMany({ where: { catalogGroup: key }, data: { catalogGroup: null, catalogSubgroup: null } });
    if (affected.length) await prisma.productAlias.deleteMany({ where: { sku: { in: affected.map((p) => p.sku) } } });
    await prisma.catalogSubgroupDef.deleteMany({ where: { groupKey: key } });
    await prisma.catalogGroupDef.delete({ where: { key } });
    return { ok: true, key, ungrouped: affected.length };
  });

  // POST /api/stock/groups/delete-subgroup { groupKey, code } — delete a STAFF-CREATED sub-group
  // (built-in sub-groups can't be deleted). Products keep their group but lose this sub-group.
  app.post('/api/stock/groups/delete-subgroup', async (req, reply) => {
    const b = req.body as { groupKey?: string; code?: string };
    const groupKey = String(b.groupKey ?? '').trim();
    const code = String(b.code ?? '').trim().toUpperCase();
    if ((SUBGROUPS[groupKey] ?? []).some((s) => s.code === code)) return reply.code(404).send({ error: 'not_custom' });
    const def = await prisma.catalogSubgroupDef.findUnique({ where: { groupKey_code: { groupKey, code } } });
    if (!def) return reply.code(404).send({ error: 'not_custom' });
    await prisma.product.updateMany({ where: { catalogGroup: groupKey, catalogSubgroup: code }, data: { catalogSubgroup: null } });
    await prisma.catalogSubgroupDef.delete({ where: { groupKey_code: { groupKey, code } } });
    return { ok: true, groupKey, code };
  });

  // POST /api/stock/groups/empty-trash — archive every product currently in the ถังขยะ (trash)
  // group: status -> 'archived'. Archived rows are hidden from Vesta (VESTA_STATUS) AND from
  // Diana + the AI (they whitelist 'active'), and a re-import updates their stock but leaves them
  // archived — so trashed items don't resurrect. Reversible (status only), not a hard delete.
  app.post('/api/stock/groups/empty-trash', async () => {
    const res = await prisma.product.updateMany({
      where: { catalogGroup: 'trash', status: { in: VESTA_STATUSES } },
      data: { status: 'archived' },
    });
    return { ok: true, archived: res.count };
  });

  // ─── Name-normalization review (ตรวจทาน) ───────────────────────────────
  // Supervisors review AI-normalized English names before they replace the live name. A
  // proposal lives in Product.proposedNameEn (STAGING); the live Product.nameEn is left
  // untouched until the proposal is APPROVED here. Seed from api/src/catalog/nameProposals.ts.

  // Shape one row for the review UI. Reads only the proposal-relevant fields, so both the
  // list query (partial select) and a decide response (full Product) can pass through it.
  const proposalRow = (p: {
    sku: string; nameEn: string; nameTh: string; photoSku: string | null;
    proposedNameEn: string | null; proposalStatus: string; proposalNeedsReview: boolean;
    catalogGroup: string | null; catalogSubgroup: string | null; stock: number | null; reorderPoint: number | null;
  }, alias: string | null) => ({
    sku: p.sku, nameEn: p.nameEn, nameTh: p.nameTh, photoSku: p.photoSku,
    proposedNameEn: p.proposedNameEn, status: p.proposalStatus, needsReview: p.proposalNeedsReview,
    catalogGroup: p.catalogGroup, catalogSubgroup: p.catalogSubgroup,
    stock: p.stock, reorderPoint: p.reorderPoint, alias,
    // the RAW name from the Express accounting report (static reference data; often carries
    // variant details — shade codes, colors — that the catalog names lost)
    expressName: EXPRESS_NAMES[p.sku] ?? '',
  });

  const PROPOSAL_SELECT = {
    sku: true, nameEn: true, nameTh: true, photoSku: true, proposedNameEn: true,
    proposalStatus: true, proposalNeedsReview: true, catalogGroup: true, catalogSubgroup: true,
    stock: true, reorderPoint: true,
  } as const;

  // GET /api/stock/proposals/summary — counts for the review header / progress bar.
  app.get('/api/stock/proposals/summary', async () => {
    const grouped = await prisma.product.groupBy({
      by: ['proposalStatus'],
      where: { status: 'active', proposalStatus: { not: 'none' } },
      _count: { _all: true },
    });
    const by = new Map(grouped.map((r) => [r.proposalStatus, r._count._all]));
    const pending = by.get('pending') ?? 0;
    const approved = by.get('approved') ?? 0;
    const rejected = by.get('rejected') ?? 0;
    // "review" = the flagged (ต้องตรวจสอบ) ones still awaiting a decision.
    const review = await prisma.product.count({
      where: { status: 'active', proposalStatus: 'pending', proposalNeedsReview: true },
    });
    return { pending, approved, rejected, review, total: pending + approved + rejected };
  });

  // GET /api/stock/proposals?filter=pending|review|approved|rejected|all&q=&limit= — the list.
  // Only products that HAVE a proposal (proposalStatus != 'none') appear. review = pending & flagged.
  app.get('/api/stock/proposals', async (req) => {
    const { filter, q, limit } = req.query as { filter?: string; q?: string; limit?: string };
    // Default high enough to show the whole review set in one bucket (≈1k proposals) — this is a
    // supervisor tool and hiding rows behind an invisible cap would make the review look complete
    // when it isn't. Search/filter narrows it when needed.
    const take = Math.min(Math.max(Number(limit) || 1000, 1), 2000);
    const query = String(q ?? '').trim();

    const where: Record<string, unknown> = { status: 'active', proposalStatus: { not: 'none' } };
    if (filter === 'pending') where.proposalStatus = 'pending';
    else if (filter === 'approved') where.proposalStatus = 'approved';
    else if (filter === 'rejected') where.proposalStatus = 'rejected';
    else if (filter === 'review') { where.proposalStatus = 'pending'; where.proposalNeedsReview = true; }

    let products;
    if (query) {
      const matches = await searchProducts(query, take);
      const skus = matches.map((m) => m.sku);
      products = skus.length
        ? await prisma.product.findMany({ where: { ...where, sku: { in: skus } }, select: PROPOSAL_SELECT })
        : [];
      const order = new Map(skus.map((s, i) => [s, i]));
      products.sort((a, b) => (order.get(a.sku) ?? 0) - (order.get(b.sku) ?? 0));
    } else {
      products = await prisma.product.findMany({ where, orderBy: { sku: 'asc' }, take, select: PROPOSAL_SELECT });
    }

    const aliases = products.length
      ? await prisma.productAlias.findMany({ where: { sku: { in: products.map((p) => p.sku) } }, select: { sku: true, alias: true } })
      : [];
    const aliasBySku = new Map(aliases.map((a) => [a.sku, a.alias]));
    return { products: products.map((p) => proposalRow(p, aliasBySku.get(p.sku) ?? null)) };
  });

  // POST /api/stock/proposals/load — seed the staging column from nameProposals.ts. Only fills
  // rows still at proposalStatus='none' (never clobbers a decision or a manual edit), so it is
  // safe to re-run. NEVER touches the live nameEn.
  app.post('/api/stock/proposals/load', async () => {
    const skus = NAME_PROPOSALS.map((p) => p.sku);
    const existing = await prisma.product.findMany({
      where: { sku: { in: skus }, status: 'active' },
      select: { sku: true, proposalStatus: true },
    });
    const seedable = new Set(existing.filter((e) => e.proposalStatus === 'none').map((e) => e.sku));
    const toLoad = NAME_PROPOSALS.filter((p) => seedable.has(p.sku));

    let loaded = 0;
    const CHUNK = 50;
    for (let i = 0; i < toLoad.length; i += CHUNK) {
      const slice = toLoad.slice(i, i + CHUNK);
      const res = await Promise.all(slice.map((p) =>
        prisma.product.updateMany({
          where: { sku: p.sku, proposalStatus: 'none' },
          data: { proposedNameEn: p.nameEn, proposalNeedsReview: p.needsReview, proposalStatus: 'pending' },
        }),
      ));
      loaded += res.reduce((n, r) => n + r.count, 0);
    }
    const total = await prisma.product.count({ where: { status: 'active', proposalStatus: { not: 'none' } } });
    return { ok: true, loaded, skipped: NAME_PROPOSALS.length - toLoad.length, available: NAME_PROPOSALS.length, total };
  });

  // POST /api/stock/proposals/decide { sku, action, nameEn? }
  //   approve → write (nameEn ?? proposedNameEn) to the LIVE Product.nameEn (+ merge keywords),
  //             mark approved. The ONLY path that changes a live name.
  //   reject  → mark rejected; the live name is left as-is.
  //   edit    → save an edited proposedNameEn and keep it pending (decide later).
  app.post('/api/stock/proposals/decide', async (req, reply) => {
    const body = req.body as { sku?: string; action?: string; nameEn?: string };
    const sku = String(body.sku ?? '').trim();
    if (!sku || !SKU_RE.test(sku)) return reply.code(400).send({ error: 'bad_sku' });
    const action = String(body.action ?? '');
    if (!['approve', 'reject', 'edit'].includes(action)) return reply.code(400).send({ error: 'bad_action' });

    const product = await prisma.product.findUnique({ where: { sku } });
    if (!product) return reply.code(404).send({ error: 'unknown_sku' });
    if (product.proposalStatus === 'none') return reply.code(409).send({ error: 'no_proposal' });
    const editText = body.nameEn != null ? String(body.nameEn).trim() : null;

    if (action === 'edit') {
      if (!editText) return reply.code(400).send({ error: 'empty_name' });
      const updated = await prisma.product.update({ where: { sku }, data: { proposedNameEn: editText, proposalStatus: 'pending' } });
      return { ok: true, product: proposalRow(updated, null) };
    }
    if (action === 'reject') {
      // Guard the transition on the expected state (mirrors decide-bulk): reject is only valid
      // from 'pending'. If an approve raced ahead, this no-ops rather than flipping an approved
      // row to 'rejected' while its live name stays overwritten (a misleading status/name split).
      const res = await prisma.product.updateMany({ where: { sku, proposalStatus: 'pending' }, data: { proposalStatus: 'rejected' } });
      if (res.count === 0) return reply.code(409).send({ error: 'not_pending' });
      const updated = await prisma.product.findUnique({ where: { sku } });
      return { ok: true, product: proposalRow(updated!, null) };
    }
    // approve
    const finalName = editText || (product.proposedNameEn ?? '').trim();
    if (!finalName) return reply.code(400).send({ error: 'empty_name' });
    const keywords = mergeNameKeywords(product.keywords, finalName, product.nameTh);
    const updated = await prisma.product.update({
      where: { sku },
      data: { nameEn: finalName, keywords, proposedNameEn: finalName, proposalStatus: 'approved' },
    });
    return { ok: true, product: proposalRow(updated, null) };
  });

  // POST /api/stock/proposals/decide-bulk { scope: 'safe' } — approve every pending, NON-flagged
  // proposal at once (scope 'safe' = status pending AND needsReview=false). Writes each live name.
  // The flagged (ต้องตรวจสอบ) proposals are deliberately NEVER bulk-approved.
  app.post('/api/stock/proposals/decide-bulk', async (req, reply) => {
    const scope = String((req.body as { scope?: string }).scope ?? 'safe');
    if (scope !== 'safe') return reply.code(400).send({ error: 'bad_scope' });
    const targets = await prisma.product.findMany({
      where: { status: 'active', proposalStatus: 'pending', proposalNeedsReview: false },
      select: { sku: true, nameTh: true, keywords: true, proposedNameEn: true },
    });
    let approved = 0;
    const CHUNK = 50;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const slice = targets.slice(i, i + CHUNK);
      const res = await Promise.all(slice.map((p) => {
        const finalName = (p.proposedNameEn ?? '').trim();
        if (!finalName) return Promise.resolve({ count: 0 });
        const keywords = mergeNameKeywords(p.keywords, finalName, p.nameTh);
        return prisma.product.updateMany({
          where: { sku: p.sku, proposalStatus: 'pending' },
          data: { nameEn: finalName, keywords, proposedNameEn: finalName, proposalStatus: 'approved' },
        });
      }));
      approved += res.reduce((n, r) => n + r.count, 0);
    }
    return { ok: true, approved };
  });
}
