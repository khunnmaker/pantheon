// mercury-local Express server. Serves the built React client on localhost AND exposes the
// local CRUD API for Vendors, the Secret map (alias→real item), and Purchase Orders.
// LOCAL-ONLY: binds to 127.0.0.1, no cloud calls in this chunk. See docs/MERCURY_BRIEF.md §5/§8.
import './env.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { prisma } from './db.js';
import { PORT, PKG_ROOT } from './env.js';

const app = express();
app.use(express.json());
// Same-origin in prod (server serves the client). CORS only helps the Vite dev proxy.
app.use(cors({ origin: true }));

// Dash-insensitive SKU search: strip dashes from both needle and haystack (suite convention:
// store dashed "07-10-09", display/search bare "071009").
const bareSku = (s: string): string => s.replace(/-/g, '');

// Small async wrapper so route errors become 500s instead of unhandled rejections.
const h =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

// ── Health ────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'mercury-local' }));

// ── Vendors ─────────────────────────────────────────────────────────────
app.get(
  '/api/vendors',
  h(async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const vendors = await prisma.vendor.findMany({ orderBy: { name: 'asc' } });
    const filtered = q
      ? vendors.filter(
          (v) =>
            v.name.toLowerCase().includes(q) ||
            v.email.toLowerCase().includes(q) ||
            v.country.toLowerCase().includes(q) ||
            v.contactName.toLowerCase().includes(q),
        )
      : vendors;
    res.json({ vendors: filtered });
  }),
);

app.post(
  '/api/vendors',
  h(async (req, res) => {
    const b = req.body ?? {};
    const name = String(b.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const vendor = await prisma.vendor.create({
      data: {
        name,
        email: String(b.email ?? '').trim(),
        ccList: String(b.ccList ?? '').trim(),
        country: String(b.country ?? '').trim(),
        isTaiwan: Boolean(b.isTaiwan),
        contactName: String(b.contactName ?? '').trim(),
        terms: String(b.terms ?? '').trim(),
        notes: String(b.notes ?? '').trim(),
      },
    });
    res.json({ ok: true, vendor });
  }),
);

app.patch(
  '/api/vendors/:id',
  h(async (req, res) => {
    const b = req.body ?? {};
    const data: Record<string, unknown> = {};
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      data.name = name;
    }
    for (const k of ['email', 'ccList', 'country', 'contactName', 'terms', 'notes'] as const) {
      if (b[k] !== undefined) data[k] = String(b[k]).trim();
    }
    if (b.isTaiwan !== undefined) data.isTaiwan = Boolean(b.isTaiwan);
    const vendor = await prisma.vendor.update({ where: { id: req.params.id }, data });
    res.json({ ok: true, vendor });
  }),
);

app.delete(
  '/api/vendors/:id',
  h(async (req, res) => {
    const id = req.params.id;
    // Guard: block delete if the vendor is referenced (keeps the secret map / POs consistent).
    const [maps, pos] = await Promise.all([
      prisma.secretMap.count({ where: { vendorId: id } }),
      prisma.purchaseOrder.count({ where: { vendorId: id } }),
    ]);
    if (maps + pos > 0)
      return res
        .status(409)
        .json({ error: 'vendor in use', maps, pos });
    await prisma.vendor.delete({ where: { id } });
    res.json({ ok: true });
  }),
);

// ── Secret map (items) ────────────────────────────────────────────────────
app.get(
  '/api/items',
  h(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const items = await prisma.secretMap.findMany({
      orderBy: { createdAt: 'desc' },
      include: { vendor: true },
    });
    let filtered = items;
    if (q) {
      const ql = q.toLowerCase();
      const qsku = bareSku(q);
      filtered = items.filter(
        (it) =>
          it.realName.toLowerCase().includes(ql) ||
          it.cloudItemId.toLowerCase().includes(ql) ||
          (it.vendor?.name.toLowerCase().includes(ql) ?? false) ||
          (qsku !== '' && bareSku(it.realSku).includes(qsku)),
      );
    }
    res.json({ items: filtered });
  }),
);

app.post(
  '/api/items',
  h(async (req, res) => {
    const b = req.body ?? {};
    const cloudItemId = String(b.cloudItemId ?? '').trim();
    const realName = String(b.realName ?? '').trim();
    const vendorId = String(b.vendorId ?? '').trim();
    if (!cloudItemId) return res.status(400).json({ error: 'cloudItemId required' });
    if (!realName) return res.status(400).json({ error: 'realName required' });
    if (!vendorId) return res.status(400).json({ error: 'vendorId required' });
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) return res.status(400).json({ error: 'vendor not found' });
    const classification = b.classification === 'special' ? 'special' : 'normal';
    try {
      const item = await prisma.secretMap.create({
        data: {
          cloudItemId,
          realName,
          vendorId,
          realSku: String(b.realSku ?? '').trim(),
          unitCost: String(b.unitCost ?? '').trim(),
          currency: String(b.currency ?? 'THB').trim() || 'THB',
          leadTime: b.leadTime ? String(b.leadTime).trim() : null,
          moq: b.moq ? String(b.moq).trim() : null,
          classification,
          photoRef: b.photoRef ? String(b.photoRef).trim() : null,
        },
        include: { vendor: true },
      });
      res.json({ ok: true, item });
    } catch (e: unknown) {
      // Unique violation on cloudItemId
      if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'P2002')
        return res.status(409).json({ error: 'cloudItemId already mapped' });
      throw e;
    }
  }),
);

app.patch(
  '/api/items/:id',
  h(async (req, res) => {
    const b = req.body ?? {};
    const data: Record<string, unknown> = {};
    if (b.realName !== undefined) {
      const realName = String(b.realName).trim();
      if (!realName) return res.status(400).json({ error: 'realName required' });
      data.realName = realName;
    }
    if (b.vendorId !== undefined) {
      const vendorId = String(b.vendorId).trim();
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) return res.status(400).json({ error: 'vendor not found' });
      data.vendorId = vendorId;
    }
    for (const k of ['realSku', 'unitCost'] as const) {
      if (b[k] !== undefined) data[k] = String(b[k]).trim();
    }
    if (b.currency !== undefined) data.currency = String(b.currency).trim() || 'THB';
    for (const k of ['leadTime', 'moq', 'photoRef'] as const) {
      if (b[k] !== undefined) data[k] = b[k] ? String(b[k]).trim() : null;
    }
    if (b.classification !== undefined)
      data.classification = b.classification === 'special' ? 'special' : 'normal';
    const item = await prisma.secretMap.update({
      where: { id: req.params.id },
      data,
      include: { vendor: true },
    });
    res.json({ ok: true, item });
  }),
);

app.delete(
  '/api/items/:id',
  h(async (req, res) => {
    await prisma.secretMap.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

// ── Purchase orders (read-only scaffold; the builder comes next chunk) ──────
app.get(
  '/api/purchase-orders',
  h(async (_req, res) => {
    const orders = await prisma.purchaseOrder.findMany({
      orderBy: { createdAt: 'desc' },
      include: { vendor: true, lines: true },
    });
    res.json({ orders });
  }),
);

// ── Error handler ───────────────────────────────────────────────────────
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // Never log full secret payloads; a generic message is enough for a local app.
  console.error('[mercury-local] request error:', err instanceof Error ? err.message : err);
  res.status(500).json({ error: 'internal error' });
});

// ── Static client (built) ───────────────────────────────────────────────
// server/dist/index.js (built) or server/src/index.ts (tsx) → client/dist is ../../client/dist.
const here = dirname(fileURLToPath(import.meta.url));
const clientDist = resolve(PKG_ROOT, 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA fallback for non-API routes.
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(resolve(clientDist, 'index.html')));
} else {
  console.warn(
    `[mercury-local] client build not found at ${clientDist} — run "npm run build:client". (here=${here})`,
  );
}

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[mercury-local] listening on http://localhost:${PORT}`);
});

// Graceful shutdown for Ctrl+C so Prisma closes cleanly.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
  });
}
