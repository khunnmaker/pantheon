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
import {
  loadConnection,
  saveConnection,
  clearConnection,
  toStatus,
} from './connection.js';
import { cloudLogin, CloudError, fixturePath } from './cloud.js';
import { syncPending, resolveShadow, buildPosFromPending, generatePoPdf, receiveSecret } from './po.js';
import { smtpStatus, MailError, SMTP_CONFIG_FILE } from './mail.js';
import { composePoEmail, dryRunPoEmail, sendPoEmail } from './poEmail.js';

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

// ── Cloud connection (owner-only auth: reuse the suite supervisor login) ────
// GET /api/connection — redacted status (never returns the token).
app.get(
  '/api/connection',
  h(async (_req, res) => {
    res.json({ status: toStatus(loadConnection()), usingFixture: !!fixturePath() });
  }),
);

// POST /api/connection — { baseUrl, email, password }. Reuses the suite login → JWT, stores
// baseUrl + token in the gitignored .mercury-connection.json. Password is NEVER stored.
app.post(
  '/api/connection',
  h(async (req, res) => {
    const b = req.body ?? {};
    const baseUrl = String(b.baseUrl ?? '').trim();
    const email = String(b.email ?? '').trim();
    const password = String(b.password ?? '');
    if (!baseUrl) return res.status(400).json({ error: 'baseUrl required' });
    if (!/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'baseUrl must be http(s)://…' });
    if (!email || !password) return res.status(400).json({ error: 'email + password required' });
    try {
      const { token, agentName, agentEmail } = await cloudLogin(baseUrl, email, password);
      saveConnection({
        baseUrl,
        token,
        agentName,
        agentEmail,
        connectedAt: new Date().toISOString(),
      });
      res.json({ ok: true, status: toStatus(loadConnection()) });
    } catch (e) {
      if (e instanceof CloudError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  }),
);

// DELETE /api/connection — forget the stored base URL + token.
app.delete(
  '/api/connection',
  h(async (_req, res) => {
    clearConnection();
    res.json({ ok: true });
  }),
);

// POST /api/sync — pull pending requests + items from cloud (or the fixture), refresh the shadow.
app.post(
  '/api/sync',
  h(async (_req, res) => {
    const conn = loadConnection();
    // Fixture mode works even with no connection (offline proof); otherwise require a connection.
    if (!conn && !fixturePath())
      return res.status(409).json({ error: 'not connected — set up the cloud connection first' });
    try {
      const result = await syncPending(conn?.baseUrl ?? '', conn?.token ?? '');
      res.json({ ok: true, ...result, usingFixture: !!fixturePath() });
    } catch (e) {
      if (e instanceof CloudError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  }),
);

// GET /api/pending — the local shadow of pending requests (non-secret cloud fields).
app.get(
  '/api/pending',
  h(async (_req, res) => {
    const pending = await prisma.pendingRequest.findMany({ orderBy: { syncedAt: 'desc' } });
    res.json({ pending });
  }),
);

// POST /api/pending/:cloudRequestId/receive-secret { qty } — SECRET goods-receipt (Phase 3).
// Resolves the real SKU from the LOCAL SecretMap → bumps Vesta stock on the cloud (realSku only
// as a transient adjust call) → marks the cloud MercuryRequest 'received' (STATUS ONLY). The real
// SKU is NEVER written onto any cloud row. Ordinary items are received on the CLOUD side instead.
app.post(
  '/api/pending/:cloudRequestId/receive-secret',
  h(async (req, res) => {
    const qty = Number((req.body ?? {}).qty);
    if (!Number.isInteger(qty) || qty <= 0)
      return res.status(400).json({ error: 'qty must be a positive integer' });
    try {
      const outcome = await receiveSecret(req.params.cloudRequestId, qty);
      res.json({ ok: true, ...outcome });
    } catch (e) {
      if (e instanceof CloudError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  }),
);

// GET /api/resolve-preview — resolve the shadow against the SecretMap WITHOUT creating POs.
// Returns resolved lines (grouped-friendly) + the unresolved/unmapped list (surfaced, not dropped).
app.get(
  '/api/resolve-preview',
  h(async (_req, res) => {
    const { resolved, unresolved } = await resolveShadow();
    res.json({ resolved, unresolved });
  }),
);

// POST /api/build-pos — resolve → group by vendor → create draft POs; returns created + unresolved.
app.post(
  '/api/build-pos',
  h(async (_req, res) => {
    const result = await buildPosFromPending();
    res.json({ ok: true, ...result });
  }),
);

// ── Purchase orders ─────────────────────────────────────────────────────────
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

// POST /api/purchase-orders/:id/pdf — generate the PO PDF (English, Taiwan split, per-line images).
app.post(
  '/api/purchase-orders/:id/pdf',
  h(async (req, res) => {
    try {
      const path = await generatePoPdf(req.params.id);
      res.json({ ok: true, pdfPath: path, url: `/api/purchase-orders/${req.params.id}/pdf` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'pdf_failed';
      if (msg === 'po_not_found') return res.status(404).json({ error: 'po not found' });
      if (msg === 'po_has_no_vendor') return res.status(409).json({ error: 'po has no vendor' });
      throw e;
    }
  }),
);

// GET /api/purchase-orders/:id/pdf — serve the generated PDF inline (link/preview in the UI).
app.get(
  '/api/purchase-orders/:id/pdf',
  h(async (req, res) => {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
    if (!po?.pdfPath || !existsSync(po.pdfPath))
      return res.status(404).json({ error: 'pdf not generated yet' });
    res.setHeader('content-type', 'application/pdf');
    res.sendFile(po.pdfPath);
  }),
);

// ── Mail (SMTP) status — Phase 2c ────────────────────────────────────────────
// GET /api/mail — redacted SMTP status (configured? host/port/user + From). NEVER returns the App
// Password. There is no "connect" flow: the owner pastes the App Password into the gitignored
// .mercury-smtp.json config file and restarts. `configFile` lets the UI point at the exact path.
app.get(
  '/api/mail',
  h(async (_req, res) => {
    res.json({ status: smtpStatus(), configFile: SMTP_CONFIG_FILE });
  }),
);

// ── PO email: compose → dry-run → review-then-send (NEVER auto-send) ──────────
// GET /api/purchase-orders/:id/email — the prefilled, editable email defaults (To/CC/subject/body
// + attachment name/size). No send.
app.get(
  '/api/purchase-orders/:id/email',
  h(async (req, res) => {
    try {
      const composed = await composePoEmail(req.params.id);
      res.json({ composed, mail: smtpStatus() });
    } catch (e) {
      if (e instanceof MailError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  }),
);

// POST /api/purchase-orders/:id/email/dry-run — render the EXACT outgoing message WITHOUT sending.
app.post(
  '/api/purchase-orders/:id/email/dry-run',
  h(async (req, res) => {
    const b = req.body ?? {};
    try {
      const rendered = await dryRunPoEmail(req.params.id, {
        to: b.to !== undefined ? String(b.to) : undefined,
        cc: Array.isArray(b.cc) ? b.cc.map((x: unknown) => String(x)) : undefined,
        subject: b.subject !== undefined ? String(b.subject) : undefined,
        body: b.body !== undefined ? String(b.body) : undefined,
      });
      res.json({ rendered });
    } catch (e) {
      if (e instanceof MailError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  }),
);

// POST /api/purchase-orders/:id/email/send — SEND via SMTP (explicit owner action only). On
// success: PO → sent, emailedAt stamped, underlying local PendingRequests → ordered.
app.post(
  '/api/purchase-orders/:id/email/send',
  h(async (req, res) => {
    const b = req.body ?? {};
    try {
      const outcome = await sendPoEmail(req.params.id, {
        to: b.to !== undefined ? String(b.to) : undefined,
        cc: Array.isArray(b.cc) ? b.cc.map((x: unknown) => String(x)) : undefined,
        subject: b.subject !== undefined ? String(b.subject) : undefined,
        body: b.body !== undefined ? String(b.body) : undefined,
      });
      res.json({ ok: true, ...outcome });
    } catch (e) {
      if (e instanceof MailError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
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
