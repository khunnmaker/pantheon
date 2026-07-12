import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma, Product, ProductEnrichment } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../auth/password.js';
import { requireAuth, requireRole, requireApp } from '../auth/middleware.js';
import {
  signClinicToken,
  requireClinic,
  requireApprovedClinic,
} from '../auth/clinicAuth.js';
import { env } from '../env.js';
import { sendLineText } from '../line/send.js';
import { mergeProductSkus, safeSemanticProductSkus } from '../catalog/productEmbeddings.js';

// Diana — the B2B website (prominentdental.com) API. A 3rd READER of the shared
// catalog: it never writes Product/stock. The public catalog exposes names/photos
// + SEO enrichment (brand/category/description) but NO price or stock to protect
// the pricelist; prices, live stock, and ordering all sit behind an APPROVED clinic
// login. Order model is request-then-invoice (no online payment v1). See docs/DIANA_BRIEF.md.

const PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

type EnrichMap = Map<string, ProductEnrichment>;

// ── DTO mappers ───────────────────────────────────────────────────────────
function photoPath(p: Product): string {
  return `/content/product/${p.photoSku ?? p.sku}`;
}

// PUBLIC shape — SEO/discovery fields + enrichment. Never includes price or stock.
function publicDto(p: Product, e?: ProductEnrichment) {
  return {
    sku: p.sku,
    nameEn: p.nameEn,
    nameTh: p.nameTh,
    note: p.note,
    promo: p.promo,
    page: p.page,
    photo: photoPath(p),
    brand: e?.brand ?? '',
    category: e?.category ?? '',
    categoryEn: e?.categoryEn ?? '',
    descriptionTh: e?.descriptionTh ?? '',
    descriptionEn: e?.descriptionEn ?? '',
    specs: e?.specs ?? [],
  };
}

function availabilityOf(p: Product): 'in_stock' | 'low' | 'out' | 'unknown' {
  if (p.stock == null) return 'unknown';
  if (p.stock <= 0) return 'out';
  if (p.reorderPoint != null && p.stock <= p.reorderPoint) return 'low';
  return 'in_stock';
}

// PRICED shape — public fields PLUS price + live stock. Approved clinics only.
function pricedDto(p: Product, e?: ProductEnrichment) {
  return {
    ...publicDto(p, e),
    price: p.price, // baht; 0 = unknown (staff confirm on the order request)
    stock: p.stock,
    stockAt: p.stockAt,
    availability: availabilityOf(p),
  };
}

// ── validation ─────────────────────────────────────────────────────────────
const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(80).optional(),
  category: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(PAGE_SIZE),
});

const registerBody = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(8).max(200),
  clinicName: z.string().trim().min(1).max(200),
  contactName: z.string().trim().max(200).default(''),
  phone: z.string().trim().max(40).default(''),
  pdpaConsent: z.literal(true),
});

const loginBody = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1),
});

const orderBody = z.object({
  items: z
    .array(z.object({ sku: z.string().trim().min(1), qty: z.coerce.number().int().min(1).max(9999) }))
    .min(1)
    .max(200),
  note: z.string().trim().max(2000).default(''),
  tax: z
    .object({
      name: z.string().trim().max(200).default(''),
      address: z.string().trim().max(500).default(''),
      id: z.string().trim().max(40).default(''),
    })
    .optional(),
});

// Resolve the active-product WHERE for browse/search, honouring brand/category
// facets. Because enrichment lives in a separate table (no FK into Product), a
// facet filter is pre-resolved to a sku set, then intersected with the catalog query.
async function catalogWhere(q: string | undefined, brand?: string, category?: string) {
  const where: Prisma.ProductWhereInput = { status: 'active' };
  const raw = (q ?? '').trim();
  if (raw) {
    const nameArms = [
      { nameEn: { contains: raw, mode: 'insensitive' as const } },
      { nameTh: { contains: raw, mode: 'insensitive' as const } },
      { keywords: { hasSome: raw.toLowerCase().split(/\s+/).filter(Boolean) } },
    ];
    // SKU is DASH-INSENSITIVE: a buyer typing "071009" must match the stored "07-10-09".
    // Prisma can't transform a column inside `contains`, so resolve matching skus in raw SQL
    // (mirrors searchProducts in catalog/match.ts), then match by the resolved set.
    const skuFlat = raw.replace(/[^0-9a-z]/gi, '').toLowerCase();
    if (skuFlat.length >= 2) {
      const rows = await prisma.$queryRaw<{ sku: string }[]>`
        SELECT sku FROM "Product"
        WHERE status = 'active' AND replace(lower(sku), '-', '') LIKE ${`%${skuFlat}%`}
        LIMIT 500`;
      const hits = rows.map((r) => r.sku);
      where.OR = [{ sku: { in: hits } }, ...nameArms];
    } else {
      where.OR = nameArms;
    }
  }
  if (brand || category) {
    const enriched = await prisma.productEnrichment.findMany({
      where: { ...(brand ? { brand } : {}), ...(category ? { category } : {}) },
      select: { sku: true },
    });
    where.sku = { in: enriched.map((e) => e.sku) };
  }
  return where;
}

// Load one catalog page and attach enrichment by sku (left-join in app-land).
async function loadPage(where: Prisma.ProductWhereInput, page: number, pageSize: number) {
  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({ where, orderBy: { sku: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  const enrich = await prisma.productEnrichment.findMany({ where: { sku: { in: rows.map((r) => r.sku) } } });
  const em: EnrichMap = new Map(enrich.map((e) => [e.sku, e]));
  return { total, rows, em };
}

// Add semantic-only products after every keyword/SKU match, retaining semantic order.
// Candidate loading remains Prisma-managed; only the vector table itself uses raw SQL.
async function appendSemanticPage(
  q: string,
  brand: string | undefined,
  category: string | undefined,
  page: number,
  pageSize: number,
  keywordTotal: number,
  keywordRows: Product[],
  em: EnrichMap,
) {
  const semanticOffset = Math.max(0, (page - 1) * pageSize - keywordTotal);
  const needed = semanticOffset + pageSize - keywordRows.length;
  if (needed <= 0) return { total: keywordTotal, rows: keywordRows, em };

  // Fetch the bounded catalog candidate set once so facet/dedupe filtering can still fill
  // the page and `total` remains stable across semantic-result pages.
  const hits = await safeSemanticProductSkus(q, 1000);
  let candidates = hits.map((hit) => hit.sku);
  if (!candidates.length) return { total: keywordTotal, rows: keywordRows, em };

  // A semantic hit that also matches the original keyword WHERE belongs to the keyword
  // section (possibly on an earlier page), so never append it as a duplicate.
  const keywordWhere = await catalogWhere(q);
  const keywordHits = await prisma.product.findMany({
    where: { AND: [keywordWhere, { sku: { in: candidates } }] },
    select: { sku: true },
  });
  const keywordSet = new Set(keywordHits.map((row) => row.sku));
  candidates = candidates.filter((sku) => !keywordSet.has(sku));

  if (brand || category) {
    const allowed = await prisma.productEnrichment.findMany({
      where: { sku: { in: candidates }, ...(brand ? { brand } : {}), ...(category ? { category } : {}) },
      select: { sku: true },
    });
    const allowedSet = new Set(allowed.map((row) => row.sku));
    candidates = candidates.filter((sku) => allowedSet.has(sku));
  }

  const selected = candidates.slice(semanticOffset, semanticOffset + pageSize - keywordRows.length);
  const products = await prisma.product.findMany({ where: { status: 'active', sku: { in: selected } } });
  const bySku = new Map(products.map((product) => [product.sku, product]));
  const ordered = selected.map((sku) => bySku.get(sku)).filter((product): product is Product => !!product);
  const mergedSkus = mergeProductSkus(keywordRows.map((row) => row.sku), ordered.map((row) => row.sku), pageSize);
  const mergedBySku = new Map([...keywordRows, ...ordered].map((product) => [product.sku, product]));
  const rows = mergedSkus.map((sku) => mergedBySku.get(sku)).filter((product): product is Product => !!product);

  const enrich = await prisma.productEnrichment.findMany({ where: { sku: { in: ordered.map((row) => row.sku) } } });
  for (const item of enrich) em.set(item.sku, item);
  return { total: keywordTotal + candidates.length, rows, em };
}

// Best-effort LINE alert to the CEO when a web order lands, so this low-volume,
// LINE-driven business never leaves an order sitting unseen. Fail-open: a LINE
// failure must never affect the order flow (the order is already persisted).
async function notifyNewOrder(o: { orderNo: number; lines: { qty: number }[] }, clinicName: string): Promise<void> {
  const ceo = env.CEO_LINE_USER_ID || env.CERES_CEO_LINE_USER_ID;
  if (!ceo) return;
  try {
    const units = o.lines.reduce((n, l) => n + l.qty, 0);
    const label = `WD-${String(o.orderNo).padStart(5, '0')}`;
    await sendLineText(ceo, `🛒 Diana ออเดอร์ใหม่ ${label} จาก ${clinicName}\n${o.lines.length} รายการ (รวม ${units} ชิ้น)\nเปิด Diana admin เพื่อยืนยัน`);
  } catch {
    // best-effort only — never let a LINE failure affect the order flow.
  }
}

// Unambiguous alphabet for staff-read temp passwords — excludes 0/O/1/l/I/o so a
// supervisor can read the code aloud over LINE without transcription mistakes.
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function randomPassword(len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += PW_ALPHABET[randomInt(PW_ALPHABET.length)];
  return out;
}

export async function dianaRoutes(app: FastifyInstance) {
  // ── PUBLIC catalog (no auth, no price, no stock) ──────────────────────────
  app.get('/api/diana/catalog', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const { q, brand, category, page, pageSize } = parsed.data;
    const where = await catalogWhere(q, brand, category);
    let { total, rows, em } = await loadPage(where, page, pageSize);
    if (q && rows.length < pageSize) {
      try {
        ({ total, rows, em } = await appendSemanticPage(q, brand, category, page, pageSize, total, rows, em));
      } catch {
        // Semantic search is optional: any Voyage/vector/enrichment failure is invisible
        // to the public storefront, which keeps the exact keyword-only result.
      }
    }
    return { page, pageSize, total, items: rows.map((p) => publicDto(p, em.get(p.sku))) };
  });

  app.get<{ Params: { sku: string } }>('/api/diana/product/:sku', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = await prisma.product.findUnique({ where: { sku: req.params.sku } });
    if (!p || p.status !== 'active') return reply.code(404).send({ error: 'not_found' });
    const e = await prisma.productEnrichment.findUnique({ where: { sku: p.sku } });
    return { product: publicDto(p, e ?? undefined) };
  });

  // Brand + category facets (with counts) for the public filter UI.
  app.get('/api/diana/facets', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async () => {
    const [brands, categories] = await Promise.all([
      prisma.productEnrichment.groupBy({ by: ['brand'], where: { brand: { not: '' } }, _count: { sku: true } }),
      prisma.productEnrichment.groupBy({ by: ['category'], where: { category: { not: '' } }, _count: { sku: true } }),
    ]);
    return {
      brands: brands.map((b) => ({ name: b.brand, count: b._count.sku })).sort((a, b) => b.count - a.count),
      categories: categories.map((c) => ({ name: c.category, count: c._count.sku })).sort((a, b) => b.count - a.count),
    };
  });

  // ── Clinic registration + login ───────────────────────────────────────────
  app.post('/api/diana/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = registerBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { email, password, clinicName, contactName, phone } = parsed.data;

    const existing = await prisma.clinicAccount.findUnique({ where: { email } });
    if (existing) return reply.code(409).send({ error: 'email_taken' });

    await prisma.clinicAccount.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        clinicName,
        contactName,
        phone,
        status: 'pending',
        pdpaConsentAt: new Date(),
      },
    });
    return reply.code(201).send({ ok: true, status: 'pending' });
  });

  app.post(
    '/api/diana/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const { email, password } = parsed.data;

      const clinic = await prisma.clinicAccount.findUnique({ where: { email } });
      const ok = await verifyPassword(password, clinic?.passwordHash ?? DUMMY_HASH);
      if (!clinic || !ok) return reply.code(401).send({ error: 'invalid_credentials' });

      await prisma.clinicAccount.update({ where: { id: clinic.id }, data: { lastLoginAt: new Date() } });
      const identity = { id: clinic.id, email: clinic.email, clinicName: clinic.clinicName, status: clinic.status };
      return { token: signClinicToken(identity), clinic: identity };
    },
  );

  app.get('/api/diana/me', { preHandler: requireClinic }, async (req) => {
    return { clinic: req.clinic };
  });

  // ── APPROVED-clinic: priced catalog + live stock ──────────────────────────
  app.get('/api/diana/priced/catalog', { preHandler: requireApprovedClinic }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const { q, brand, category, page, pageSize } = parsed.data;
    const where = await catalogWhere(q, brand, category);
    const { total, rows, em } = await loadPage(where, page, pageSize);
    return { page, pageSize, total, items: rows.map((p) => pricedDto(p, em.get(p.sku))) };
  });

  app.get<{ Params: { sku: string } }>(
    '/api/diana/priced/product/:sku',
    { preHandler: requireApprovedClinic },
    async (req, reply) => {
      const p = await prisma.product.findUnique({ where: { sku: req.params.sku } });
      if (!p || p.status !== 'active') return reply.code(404).send({ error: 'not_found' });
      const e = await prisma.productEnrichment.findUnique({ where: { sku: p.sku } });
      return { product: pricedDto(p, e ?? undefined) };
    },
  );

  // ── APPROVED-clinic: order-request flow ───────────────────────────────────
  app.post('/api/diana/orders', { preHandler: requireApprovedClinic, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = orderBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const clinic = req.clinic!;
    const { note, tax } = parsed.data;

    const qtyBySku = new Map<string, number>();
    for (const it of parsed.data.items) qtyBySku.set(it.sku, (qtyBySku.get(it.sku) ?? 0) + it.qty);
    const skus = [...qtyBySku.keys()];

    const products = await prisma.product.findMany({ where: { sku: { in: skus }, status: 'active' } });
    const bySku = new Map(products.map((p) => [p.sku, p]));
    const missing = skus.filter((s) => !bySku.has(s));
    if (missing.length) return reply.code(400).send({ error: 'unknown_sku', skus: missing });

    const order = await prisma.webOrder.create({
      data: {
        clinicAccountId: clinic.id,
        status: 'submitted',
        note,
        taxName: tax?.name ?? '',
        taxAddress: tax?.address ?? '',
        taxId: tax?.id ?? '',
        lines: {
          create: skus.map((sku) => {
            const p = bySku.get(sku)!;
            return { sku, nameSnapshot: p.nameTh || p.nameEn || sku, qty: qtyBySku.get(sku)!, unitPrice: p.price };
          }),
        },
      },
      include: { lines: true },
    });
    void notifyNewOrder(order, clinic.clinicName);
    return reply.code(201).send({ order });
  });

  app.get('/api/diana/orders', { preHandler: requireApprovedClinic }, async (req) => {
    const orders = await prisma.webOrder.findMany({
      where: { clinicAccountId: req.clinic!.id },
      orderBy: { createdAt: 'desc' },
      include: { lines: true },
    });
    return { orders };
  });

  app.get<{ Params: { id: string } }>(
    '/api/diana/orders/:id',
    { preHandler: requireApprovedClinic },
    async (req, reply) => {
      const order = await prisma.webOrder.findUnique({ where: { id: req.params.id }, include: { lines: true } });
      if (!order || order.clinicAccountId !== req.clinic!.id) return reply.code(404).send({ error: 'not_found' });
      return { order };
    },
  );

  // ── STAFF admin: clinic approval (SUPERVISOR only — approval unlocks pricing,
  //    and the list carries clinic PII; mirrors the supervisor gate on stock.ts) ──
  const adminClinicsQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() });
  app.get('/api/diana/admin/clinics', { preHandler: [requireAuth, requireRole('supervisor')] }, async (req, reply) => {
    const parsed = adminClinicsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const clinics = await prisma.clinicAccount.findMany({
      where: parsed.data.status ? { status: parsed.data.status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true, email: true, clinicName: true, contactName: true, phone: true, status: true,
        customerCode: true, approvedAt: true, approvedBy: true, rejectNote: true,
        pdpaConsentAt: true, createdAt: true, lastLoginAt: true,
      },
    });
    return { clinics };
  });

  const approveBody = z.object({ customerCode: z.string().trim().max(40).optional() });
  app.post<{ Params: { id: string } }>(
    '/api/diana/admin/clinics/:id/approve',
    { preHandler: [requireAuth, requireRole('supervisor')] },
    async (req, reply) => {
      const parsed = approveBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const exists = await prisma.clinicAccount.findUnique({ where: { id: req.params.id } });
      if (!exists) return reply.code(404).send({ error: 'not_found' });
      const clinic = await prisma.clinicAccount.update({
        where: { id: req.params.id },
        data: {
          status: 'approved', approvedAt: new Date(), approvedBy: req.agent!.id, rejectNote: '',
          ...(parsed.data.customerCode ? { customerCode: parsed.data.customerCode } : {}),
        },
      });
      return { ok: true, status: clinic.status };
    },
  );

  const rejectBody = z.object({ note: z.string().trim().max(500).default('') });
  app.post<{ Params: { id: string } }>(
    '/api/diana/admin/clinics/:id/reject',
    { preHandler: [requireAuth, requireRole('supervisor')] },
    async (req, reply) => {
      const parsed = rejectBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const exists = await prisma.clinicAccount.findUnique({ where: { id: req.params.id } });
      if (!exists) return reply.code(404).send({ error: 'not_found' });
      await prisma.clinicAccount.update({
        where: { id: req.params.id },
        data: { status: 'rejected', rejectNote: parsed.data.note, approvedBy: req.agent!.id, approvedAt: new Date() },
      });
      return { ok: true, status: 'rejected' };
    },
  );

  // SUPERVISOR only: permanently delete a clinic account and all its orders.
  // Intended for clearing test accounts. WebOrderLine cascades from WebOrder, so we
  // delete the clinic's orders first (WebOrder has onDelete: Restrict to ClinicAccount),
  // then the account — both in one transaction.
  app.delete<{ Params: { id: string } }>(
    '/api/diana/admin/clinics/:id',
    { preHandler: [requireAuth, requireRole('supervisor')] },
    async (req, reply) => {
      const exists = await prisma.clinicAccount.findUnique({ where: { id: req.params.id } });
      if (!exists) return reply.code(404).send({ error: 'not_found' });
      await prisma.$transaction([
        prisma.webOrder.deleteMany({ where: { clinicAccountId: req.params.id } }),
        prisma.clinicAccount.delete({ where: { id: req.params.id } }),
      ]);
      return { ok: true };
    },
  );

  // SUPERVISOR only: reset a clinic's password to a random temp value. No email/reset-link
  // infra exists — staff verify the caller over LINE, then read this one-time password to them.
  app.post<{ Params: { id: string } }>(
    '/api/diana/admin/clinics/:id/reset-password',
    { preHandler: [requireAuth, requireRole('supervisor')] },
    async (req, reply) => {
      const clinic = await prisma.clinicAccount.findUnique({ where: { id: req.params.id } });
      if (!clinic) return reply.code(404).send({ error: 'not_found' });
      const tempPassword = randomPassword(10);
      await prisma.clinicAccount.update({ where: { id: clinic.id }, data: { passwordHash: await hashPassword(tempPassword) } });
      return { ok: true, tempPassword }; // returned exactly once — never logged.
    },
  );

  // ── STAFF admin: order queue ──────────────────────────────────────────────
  const adminOrdersQuery = z.object({ status: z.enum(['submitted', 'confirmed', 'invoiced', 'cancelled']).optional() });
  app.get('/api/diana/admin/orders', { preHandler: [requireAuth, requireApp('diana')] }, async (req, reply) => {
    const parsed = adminOrdersQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const orders = await prisma.webOrder.findMany({
      where: parsed.data.status ? { status: parsed.data.status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        lines: true,
        clinicAccount: { select: { id: true, clinicName: true, email: true, customerCode: true } },
      },
    });
    return { orders };
  });

  async function transition(
    id: string,
    from: string[],
    data: Record<string, unknown>,
    reply: import('fastify').FastifyReply,
  ) {
    // Compare-and-swap: only flip when the row is still in an expected `from` state, so two
    // staff acting at once can't double-transition (no read-then-write TOCTOU window).
    const r = await prisma.webOrder.updateMany({ where: { id, status: { in: from } }, data });
    if (r.count === 0) {
      const current = await prisma.webOrder.findUnique({ where: { id } });
      if (!current) return reply.code(404).send({ error: 'not_found' });
      return reply.code(409).send({ error: 'bad_state', status: current.status });
    }
    return { ok: true, status: data.status };
  }

  app.post<{ Params: { id: string } }>(
    '/api/diana/admin/orders/:id/confirm',
    { preHandler: [requireAuth, requireApp('diana')] },
    async (req, reply) =>
      transition(req.params.id, ['submitted'], { status: 'confirmed', confirmedAt: new Date(), confirmedBy: req.agent!.id }, reply),
  );
  app.post<{ Params: { id: string } }>(
    '/api/diana/admin/orders/:id/invoice',
    { preHandler: [requireAuth, requireApp('diana')] },
    async (req, reply) => transition(req.params.id, ['confirmed'], { status: 'invoiced', invoicedAt: new Date() }, reply),
  );
  app.post<{ Params: { id: string } }>(
    '/api/diana/admin/orders/:id/cancel',
    { preHandler: [requireAuth, requireApp('diana')] },
    async (req, reply) => transition(req.params.id, ['submitted', 'confirmed'], { status: 'cancelled' }, reply),
  );

  // ── STAFF admin: catalog enrichment (brand/category/description editor) ────
  // Search products WITH their current enrichment so staff can fill brand/category/
  // descriptions. Reuses the shared catalog; returns price too (staff-only view).
  app.get('/api/diana/admin/enrichment', { preHandler: [requireAuth, requireApp('diana')] }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const { q, brand, category, page, pageSize } = parsed.data;
    const where = await catalogWhere(q, brand, category);
    const { total, rows, em } = await loadPage(where, page, pageSize);
    const items = rows.map((p) => {
      const e = em.get(p.sku);
      return {
        sku: p.sku, nameEn: p.nameEn, nameTh: p.nameTh, price: p.price, photo: photoPath(p),
        brand: e?.brand ?? '', category: e?.category ?? '', categoryEn: e?.categoryEn ?? '',
        descriptionTh: e?.descriptionTh ?? '', descriptionEn: e?.descriptionEn ?? '',
        specs: e?.specs ?? [], source: e?.source ?? null,
      };
    });
    return { page, pageSize, total, items };
  });

  const enrichBody = z.object({
    brand: z.string().trim().max(80).default(''),
    category: z.string().trim().max(80).default(''),
    categoryEn: z.string().trim().max(80).default(''),
    descriptionTh: z.string().trim().max(4000).default(''),
    descriptionEn: z.string().trim().max(4000).default(''),
    specs: z.array(z.string().trim().max(200)).max(40).default([]),
  });
  app.put<{ Params: { sku: string } }>(
    '/api/diana/admin/enrichment/:sku',
    { preHandler: [requireAuth, requireApp('diana')] },
    async (req, reply) => {
      const parsed = enrichBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const product = await prisma.product.findUnique({ where: { sku: req.params.sku } });
      if (!product) return reply.code(404).send({ error: 'not_found' });
      // A staff edit is authoritative — mark it 'manual' so a future bulk re-derive skips it.
      const data = { ...parsed.data, source: 'manual', updatedBy: req.agent!.id };
      const e = await prisma.productEnrichment.upsert({
        where: { sku: req.params.sku },
        update: data,
        create: { sku: req.params.sku, ...data },
      });
      return { ok: true, enrichment: e };
    },
  );
}
