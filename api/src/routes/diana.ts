import type { FastifyInstance } from 'fastify';
import type { Product, ProductEnrichment } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../auth/password.js';
import { requireAuth } from '../auth/middleware.js';
import {
  signClinicToken,
  requireClinic,
  requireApprovedClinic,
} from '../auth/clinicAuth.js';

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
  email: z.string().email(),
  password: z.string().min(8).max(200),
  clinicName: z.string().trim().min(1).max(200),
  contactName: z.string().trim().max(200).default(''),
  phone: z.string().trim().max(40).default(''),
  pdpaConsent: z.literal(true),
});

const loginBody = z.object({
  email: z.string().email(),
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
  const where: Record<string, unknown> = { status: 'active' };
  const raw = (q ?? '').trim();
  if (raw) {
    const skuLike = raw.replace(/\s+/g, '');
    where.OR = [
      { sku: { contains: skuLike, mode: 'insensitive' as const } },
      { nameEn: { contains: raw, mode: 'insensitive' as const } },
      { nameTh: { contains: raw, mode: 'insensitive' as const } },
      { keywords: { hasSome: raw.toLowerCase().split(/\s+/).filter(Boolean) } },
    ];
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
async function loadPage(where: Record<string, unknown>, page: number, pageSize: number) {
  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({ where, orderBy: { sku: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  const enrich = await prisma.productEnrichment.findMany({ where: { sku: { in: rows.map((r) => r.sku) } } });
  const em: EnrichMap = new Map(enrich.map((e) => [e.sku, e]));
  return { total, rows, em };
}

export async function dianaRoutes(app: FastifyInstance) {
  // ── PUBLIC catalog (no auth, no price, no stock) ──────────────────────────
  app.get('/api/diana/catalog', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const { q, brand, category, page, pageSize } = parsed.data;
    const where = await catalogWhere(q, brand, category);
    const { total, rows, em } = await loadPage(where, page, pageSize);
    return { page, pageSize, total, items: rows.map((p) => publicDto(p, em.get(p.sku))) };
  });

  app.get<{ Params: { sku: string } }>('/api/diana/product/:sku', async (req, reply) => {
    const p = await prisma.product.findUnique({ where: { sku: req.params.sku } });
    if (!p || p.status !== 'active') return reply.code(404).send({ error: 'not_found' });
    const e = await prisma.productEnrichment.findUnique({ where: { sku: p.sku } });
    return { product: publicDto(p, e ?? undefined) };
  });

  // Brand + category facets (with counts) for the public filter UI.
  app.get('/api/diana/facets', async () => {
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
  app.post('/api/diana/register', async (req, reply) => {
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
  app.post('/api/diana/orders', { preHandler: requireApprovedClinic }, async (req, reply) => {
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

  // ── STAFF admin: clinic approval ──────────────────────────────────────────
  const adminClinicsQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() });
  app.get('/api/diana/admin/clinics', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = adminClinicsQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const clinics = await prisma.clinicAccount.findMany({
      where: parsed.data.status ? { status: parsed.data.status } : undefined,
      orderBy: { createdAt: 'desc' },
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
    { preHandler: requireAuth },
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
    { preHandler: requireAuth },
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

  // ── STAFF admin: order queue ──────────────────────────────────────────────
  const adminOrdersQuery = z.object({ status: z.enum(['submitted', 'confirmed', 'invoiced', 'cancelled']).optional() });
  app.get('/api/diana/admin/orders', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = adminOrdersQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const orders = await prisma.webOrder.findMany({
      where: parsed.data.status ? { status: parsed.data.status } : undefined,
      orderBy: { createdAt: 'desc' },
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
    const order = await prisma.webOrder.findUnique({ where: { id } });
    if (!order) return reply.code(404).send({ error: 'not_found' });
    if (!from.includes(order.status)) return reply.code(409).send({ error: 'bad_state', status: order.status });
    const updated = await prisma.webOrder.update({ where: { id }, data });
    return { ok: true, status: updated.status };
  }

  app.post<{ Params: { id: string } }>(
    '/api/diana/admin/orders/:id/confirm',
    { preHandler: requireAuth },
    async (req, reply) =>
      transition(req.params.id, ['submitted'], { status: 'confirmed', confirmedAt: new Date(), confirmedBy: req.agent!.id }, reply),
  );
  app.post<{ Params: { id: string } }>(
    '/api/diana/admin/orders/:id/invoice',
    { preHandler: requireAuth },
    async (req, reply) => transition(req.params.id, ['confirmed'], { status: 'invoiced', invoicedAt: new Date() }, reply),
  );
  app.post<{ Params: { id: string } }>(
    '/api/diana/admin/orders/:id/cancel',
    { preHandler: requireAuth },
    async (req, reply) => transition(req.params.id, ['submitted', 'confirmed'], { status: 'cancelled' }, reply),
  );

  // ── STAFF admin: catalog enrichment (brand/category/description editor) ────
  // Search products WITH their current enrichment so staff can fill brand/category/
  // descriptions. Reuses the shared catalog; returns price too (staff-only view).
  app.get('/api/diana/admin/enrichment', { preHandler: requireAuth }, async (req, reply) => {
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
    { preHandler: requireAuth },
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
