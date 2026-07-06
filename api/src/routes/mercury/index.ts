import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { requireAuth, requireApp } from '../../auth/middleware.js';
import { buildLoginCards } from '../../auth/loginCards.js';
import { adjustStock } from '../../stock/adjust.js';

// Cloud-Mercury (procurement / buy-side) API — the team/phone-facing reorder board, a mirror
// of Vulcan on the buy side. Everything here is SECRETS-FREE: MercuryItem/MercuryRequest carry
// no vendor, cost, real name, or real SKU (those live only in local-Mercury, Phase 2). See
// docs/MERCURY_BRIEF.md §3/§5/§8.
//
// Auth: one PUBLIC route (the name-card login picker, alias of GET /api/auth/logins?app=mercury)
// plus a scoped sub-plugin gated by requireApp('mercury') for everything else. This mirrors the
// ceres route shape (public logins + a requireApp gate) and the juno gate (whole-plugin
// requireApp). While Mercury is owner-only, requireApp('mercury') resolves to just the
// supervisor (Dr. M) — granting an employee later is a one-line Agent.apps edit, no code change.

const MERCURY_STATUSES = ['pending', 'ordered', 'received', 'cancelled'] as const;
type MercuryStatus = (typeof MERCURY_STATUSES)[number];

// Dash-insensitive SKU/name search (suite convention: dashed key stored, bare displayed).
// Normalise both the query and the stored value by stripping dashes/spaces before comparing.
const flatten = (s: string): string => s.replace(/[-\s]/g, '').toLowerCase();

const createItemBody = z.object({
  displayName: z.string().trim().min(1).max(200),
  vulcanSku: z.string().trim().max(64).optional(),
  isSecret: z.boolean().optional(),
  active: z.boolean().optional(),
});

const patchItemBody = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  vulcanSku: z.string().trim().max(64).nullable().optional(),
  active: z.boolean().optional(),
});

const createRequestBody = z.object({
  // Either an existing MercuryItem id, OR a Vulcan product ref (sku + displayName) to
  // resolve/create the item from. Exactly one path is used per call.
  itemId: z.string().trim().min(1).optional(),
  vulcanSku: z.string().trim().max(64).optional(),
  displayName: z.string().trim().max(200).optional(),
  qty: z.union([z.string(), z.number()]).optional(),
  note: z.string().trim().max(500).optional(),
});

const patchRequestBody = z.object({
  status: z.enum(MERCURY_STATUSES),
});

// Goods-receipt: a positive integer received quantity. For ORDINARY items this qty is bumped into
// Vulcan stock (via the shared adjustStock helper); for SECRET items the cloud only records status
// (the stock bump happens from local-Mercury, which alone knows the real SKU).
const receiveBody = z.object({
  qty: z.union([z.string(), z.number()]),
});

export async function mercuryRoutes(app: FastifyInstance) {
  // PUBLIC — the name-card login list (alias of GET /api/auth/logins?app=mercury). While
  // owner-only, this resolves to just Dr. M.
  app.get('/api/mercury/logins', async () => buildLoginCards('mercury'));

  // Everything else requires a live login AND the 'mercury' grant.
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', requireAuth);
    scoped.addHook('preHandler', requireApp('mercury'));

    // ── Items (ordinary reorderable items) ──────────────────────────────
    // GET /api/mercury/items?q= — active items, dash-insensitive search over name + vulcanSku.
    scoped.get('/api/mercury/items', async (req) => {
      const q = String((req.query as { q?: string }).q ?? '').trim();
      const items = await prisma.mercuryItem.findMany({
        where: { active: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      if (!q) return { items };
      const needle = flatten(q);
      const filtered = items.filter(
        (it) =>
          flatten(it.displayName).includes(needle) ||
          (it.vulcanSku ? flatten(it.vulcanSku).includes(needle) : false),
      );
      return { items: filtered };
    });

    // POST /api/mercury/items — create an ordinary item (displayName, optional vulcanSku).
    // isSecret is a simple flag for now (full secret resolution is Phase 2). A secret item
    // never stores a vulcanSku on the cloud row.
    scoped.post('/api/mercury/items', async (req, reply) => {
      const parsed = createItemBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const { displayName, isSecret, active } = parsed.data;
      const secret = isSecret === true;
      const vulcanSku = secret ? null : (parsed.data.vulcanSku || null);
      const item = await prisma.mercuryItem.create({
        data: { displayName, isSecret: secret, vulcanSku, active: active ?? true },
      });
      return { ok: true, item };
    });

    // PATCH /api/mercury/items/:id — edit displayName / vulcanSku / active.
    scoped.patch<{ Params: { id: string } }>('/api/mercury/items/:id', async (req, reply) => {
      const parsed = patchItemBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const existing = await prisma.mercuryItem.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      const data: { displayName?: string; vulcanSku?: string | null; active?: boolean } = {};
      if (parsed.data.displayName !== undefined) data.displayName = parsed.data.displayName;
      if (parsed.data.active !== undefined) data.active = parsed.data.active;
      // Never let a secret item carry a vulcanSku on the cloud row.
      if (parsed.data.vulcanSku !== undefined) {
        data.vulcanSku = existing.isSecret ? null : (parsed.data.vulcanSku || null);
      }
      const item = await prisma.mercuryItem.update({ where: { id: req.params.id }, data });
      return { ok: true, item };
    });

    // ── Reorder queue (Vulcan low-stock feed) ───────────────────────────
    // GET /api/mercury/reorder-queue — the EXACT low-stock query from stock.ts (stock <=
    // reorderPoint). Reuses Vulcan's single source of stock truth — no second stock source.
    // Returns each low product plus whether a MercuryItem already tracks its SKU (so the UI
    // can show "requested"/one-click request).
    scoped.get('/api/mercury/reorder-queue', async (req) => {
      const take = Math.min(Math.max(Number((req.query as { limit?: string }).limit) || 200, 1), 500);
      const lowSkus = await prisma.$queryRaw<{ sku: string }[]>`
        SELECT sku FROM "Product"
        WHERE status = 'active' AND stock IS NOT NULL AND "reorderPoint" IS NOT NULL
          AND stock <= "reorderPoint"
        ORDER BY (stock::float / NULLIF("reorderPoint", 0)) ASC NULLS FIRST, stock ASC
        LIMIT ${take}`;
      const skus = lowSkus.map((r) => r.sku);
      if (!skus.length) return { products: [] };
      const [products, items] = await Promise.all([
        prisma.product.findMany({
          where: { sku: { in: skus } },
          select: { sku: true, nameEn: true, nameTh: true, photoSku: true, stock: true, reorderPoint: true },
        }),
        prisma.mercuryItem.findMany({ where: { vulcanSku: { in: skus }, active: true } }),
      ]);
      const bySku = new Map(products.map((p) => [p.sku, p]));
      const itemBySku = new Map(items.map((it) => [it.vulcanSku!, it]));
      // Preserve the low-stock ordering (how far below reorder).
      const rows = skus
        .map((sku) => bySku.get(sku))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map((p) => {
          const item = itemBySku.get(p.sku);
          return {
            sku: p.sku,
            nameEn: p.nameEn,
            nameTh: p.nameTh,
            photoSku: p.photoSku,
            stock: p.stock,
            reorderPoint: p.reorderPoint,
            mercuryItemId: item?.id ?? null,
          };
        });
      return { products: rows };
    });

    // ── Requests ────────────────────────────────────────────────────────
    // POST /api/mercury/requests — create a request. Either targets an existing MercuryItem
    // (itemId) or resolves/creates one from a Vulcan product ref (vulcanSku [+ displayName]).
    scoped.post('/api/mercury/requests', async (req, reply) => {
      const parsed = createRequestBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const { itemId, vulcanSku, displayName, qty, note } = parsed.data;

      let resolvedItemId: string;
      if (itemId) {
        const item = await prisma.mercuryItem.findUnique({ where: { id: itemId } });
        if (!item) return reply.code(404).send({ error: 'unknown_item' });
        resolvedItemId = item.id;
      } else if (vulcanSku) {
        // Resolve to (or create) the ordinary MercuryItem for this Vulcan SKU.
        const sku = vulcanSku.trim();
        const product = await prisma.product.findUnique({ where: { sku }, select: { sku: true, nameTh: true, nameEn: true } });
        if (!product) return reply.code(404).send({ error: 'unknown_sku' });
        const existing = await prisma.mercuryItem.findFirst({ where: { vulcanSku: sku, active: true } });
        if (existing) {
          resolvedItemId = existing.id;
        } else {
          const name = (displayName?.trim() || product.nameTh || product.nameEn || sku);
          const created = await prisma.mercuryItem.create({
            data: { displayName: name, vulcanSku: sku, isSecret: false, active: true },
          });
          resolvedItemId = created.id;
        }
      } else {
        return reply.code(400).send({ error: 'missing_item_ref' });
      }

      const request = await prisma.mercuryRequest.create({
        data: {
          itemId: resolvedItemId,
          qty: qty === undefined ? '' : String(qty),
          note: note ?? '',
          requestedById: req.agent?.id ?? null,
          status: 'pending',
        },
      });
      return { ok: true, request };
    });

    // GET /api/mercury/requests?status= — list requests (optionally filtered by status),
    // each joined to its item's displayName for the board.
    scoped.get('/api/mercury/requests', async (req) => {
      const statusRaw = String((req.query as { status?: string }).status ?? '').trim();
      const status = (MERCURY_STATUSES as readonly string[]).includes(statusRaw)
        ? (statusRaw as MercuryStatus)
        : undefined;
      const requests = await prisma.mercuryRequest.findMany({
        where: status ? { status } : {},
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      const itemIds = [...new Set(requests.map((r) => r.itemId))];
      const items = itemIds.length
        ? await prisma.mercuryItem.findMany({ where: { id: { in: itemIds } } })
        : [];
      const byId = new Map(items.map((it) => [it.id, it]));
      return {
        requests: requests.map((r) => ({
          ...r,
          item: byId.get(r.itemId) ?? null,
        })),
      };
    });

    // PATCH /api/mercury/requests/:id — update status. Accepts every status; sets the matching
    // timestamp for ordered/received. (Phase 3 wires the full order/receipt flow; this endpoint
    // is the single status-transition point and at minimum supports cancel.)
    scoped.patch<{ Params: { id: string } }>('/api/mercury/requests/:id', async (req, reply) => {
      const parsed = patchRequestBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const existing = await prisma.mercuryRequest.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      const status = parsed.data.status;
      const data: { status: string; orderedAt?: Date; receivedAt?: Date } = { status };
      if (status === 'ordered' && !existing.orderedAt) data.orderedAt = new Date();
      if (status === 'received' && !existing.receivedAt) data.receivedAt = new Date();
      const request = await prisma.mercuryRequest.update({ where: { id: req.params.id }, data });
      return { ok: true, request };
    });

    // POST /api/mercury/requests/:id/receive { qty } — goods-receipt (Phase 3, the buy→stock loop).
    // Marks the request 'received' (+ receivedAt) and, for ORDINARY items only, bumps Vulcan stock
    // by qty through the SHARED adjustStock helper (the same Product.stock write + StockAdjustment
    // audit row Vulcan's /adjust uses — one stock source of truth, Vulcan owns it).
    //
    //   ORDINARY item (MercuryItem.vulcanSku is set) → status 'received' + adjustStock(+qty).
    //   SECRET item (no vulcanSku on the cloud row)   → status 'received' ONLY, NO stock write.
    //     The cloud cannot resolve a secret item's real SKU BY DESIGN (it lives only in the local
    //     SecretMap), so the stock bump for a secret item happens from local-Mercury. This keeps
    //     the invariant: a secret item's real SKU never reaches any cloud row.
    scoped.post<{ Params: { id: string } }>('/api/mercury/requests/:id/receive', async (req, reply) => {
      const parsed = receiveBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      // A received quantity must be a positive integer.
      const qty = Number(parsed.data.qty);
      if (!Number.isInteger(qty) || qty <= 0) return reply.code(400).send({ error: 'bad_qty' });

      const existing = await prisma.mercuryRequest.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.status === 'cancelled') return reply.code(409).send({ error: 'cancelled' });

      const item = await prisma.mercuryItem.findUnique({ where: { id: existing.itemId } });
      if (!item) return reply.code(404).send({ error: 'unknown_item' });

      // SECRET branch: cloud records status only — no stock write here (local-Mercury does it).
      if (item.isSecret || !item.vulcanSku) {
        const request = await prisma.mercuryRequest.update({
          where: { id: existing.id },
          data: { status: 'received', receivedAt: existing.receivedAt ?? new Date() },
        });
        return {
          ok: true,
          request,
          stockUpdated: false,
          secret: true,
          detail: 'secret item — receive its stock via local-Mercury',
        };
      }

      // ORDINARY branch: bump Vulcan stock by qty through the shared write path, THEN mark received.
      const adj = await adjustStock({
        sku: item.vulcanSku,
        delta: qty,
        reason: `Mercury goods-receipt: request ${existing.id}`,
        agentId: req.agent?.id,
      });
      if (!adj.ok) {
        // Don't flip status if the stock write couldn't happen (e.g. the SKU vanished) — surface it.
        const code = adj.error === 'unknown_sku' ? 404 : 400;
        return reply.code(code).send({ error: adj.error });
      }
      const request = await prisma.mercuryRequest.update({
        where: { id: existing.id },
        data: { status: 'received', receivedAt: existing.receivedAt ?? new Date() },
      });
      return { ok: true, request, stockUpdated: true, secret: false, product: adj.product };
    });
  });
}
