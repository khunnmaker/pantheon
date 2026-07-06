// Cloud-Mercury client. Local-Mercury's ONLY outbound contact for procurement data (SMTP mail send
// is the other outbound path). It consumes the shared api's mercury routes AS-IS (see
// api/src/routes/mercury/index.ts) — we do not modify the cloud app.
//
// Auth choice (v1): the cloud /api/mercury/* routes are gated by requireApp('mercury'), which the
// supervisor (Dr. M) passes implicitly. So local-Mercury just reuses the SUITE LOGIN — the owner's
// supervisor credentials → a JWT from POST /api/auth/login — and sends it as a Bearer token. No
// separate cloud-side service-token mechanism is needed for owner-only v1. (Documented in the
// runbook stub.)
//
// FIXTURE MODE: because the cloud node may not be deployed yet, when env MERCURY_CLOUD_FIXTURE
// points at a JSON file we read the two cloud responses from it INSTEAD of the network. This lets
// the whole pull→resolve→build pipeline be proven offline. The fixture file shape is:
//   { "requests": [ <MercuryRequest>… ], "items": [ <MercuryItem>… ] }
import './env.js';
import { readFileSync } from 'node:fs';

// ── Cloud response shapes (consumed as-is from api/src/routes/mercury/index.ts) ──────────────
// GET /api/mercury/requests → { requests: MercuryRequest[] } where each request is joined to .item
export interface CloudMercuryItem {
  id: string;
  displayName: string;
  isSecret: boolean;
  vulcanSku: string | null;
  active?: boolean;
  createdAt?: string;
}

export interface CloudMercuryRequest {
  id: string;
  itemId: string;
  qty: string;
  note: string;
  requestedById: string | null;
  status: string; // pending | ordered | received | cancelled
  createdAt: string;
  orderedAt?: string | null;
  receivedAt?: string | null;
  item?: CloudMercuryItem | null; // joined by the cloud route
}

export interface CloudPull {
  requests: CloudMercuryRequest[];
  items: CloudMercuryItem[];
}

const FIXTURE_ENV = 'MERCURY_CLOUD_FIXTURE';

export function fixturePath(): string | null {
  const p = process.env[FIXTURE_ENV];
  return p && p.trim() ? p.trim() : null;
}

// Read the two cloud responses from a local fixture file (offline proof / cloud-not-deployed).
export function readFixture(path: string): CloudPull {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    requests?: CloudMercuryRequest[];
    items?: CloudMercuryItem[];
  };
  return { requests: raw.requests ?? [], items: raw.items ?? [] };
}

// A tidy error carrying an http-ish status so the route can translate to a clear message.
export class CloudError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
    this.name = 'CloudError';
  }
}

async function cloudFetch(baseUrl: string, path: string, init: RequestInit): Promise<Response> {
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // Network-level failure: DNS, connection refused, cloud not deployed, offline.
    throw new CloudError(
      `Cannot reach cloud at ${baseUrl} (${e instanceof Error ? e.message : 'network error'})`,
      503,
    );
  }
  return res;
}

// POST /api/auth/login → { token, agent }. Reuses the suite login. Returns the JWT + identity.
export async function cloudLogin(
  baseUrl: string,
  email: string,
  password: string,
): Promise<{ token: string; agentName?: string; agentEmail?: string }> {
  const res = await cloudFetch(baseUrl, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 401) throw new CloudError('Invalid credentials', 401);
  if (res.status === 429) throw new CloudError('Too many login attempts — wait and retry', 429);
  if (!res.ok) throw new CloudError(`Login failed (HTTP ${res.status})`, 502);
  const body = (await res.json()) as { token?: string; agent?: { name?: string; email?: string } };
  if (!body.token) throw new CloudError('Login returned no token', 502);
  return { token: body.token, agentName: body.agent?.name, agentEmail: body.agent?.email };
}

// PATCH a cloud MercuryRequest's status (Phase 3 status push-back, e.g. → 'ordered' after a PO is
// emailed) via PATCH /api/mercury/requests/:id. Best-effort by design: the caller catches
// CloudError so a cloud-unreachable / expired-session never blocks the local send bookkeeping.
export async function cloudPatchStatus(
  baseUrl: string,
  token: string,
  requestId: string,
  status: string,
): Promise<void> {
  // No-op in fixture mode (offline proof) — there is no cloud to write to.
  if (fixturePath()) return;
  const res = await cloudFetch(baseUrl, `/api/mercury/requests/${encodeURIComponent(requestId)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (res.status === 401) throw new CloudError('Session expired — reconnect', 401);
  if (res.status === 403) throw new CloudError('Account lacks the mercury grant', 403);
  if (res.status === 404) throw new CloudError('Cloud request not found', 404);
  if (!res.ok) throw new CloudError(`Failed to update cloud status (HTTP ${res.status})`, 502);
}

// POST a goods-receipt for a cloud MercuryRequest (Phase 3, SECRET items) via
// POST /api/mercury/requests/:id/receive. The cloud marks the request 'received' (STATUS ONLY for a
// secret item — it holds no vulcanSku, so it performs no stock write). The real Vulcan stock bump
// for a secret item is done SEPARATELY by cloudAdjustStock below, keyed on the LOCAL realSku, which
// the cloud never sees. Best-effort: caller catches CloudError.
export async function cloudReceiveRequest(
  baseUrl: string,
  token: string,
  requestId: string,
  qty: string,
): Promise<void> {
  if (fixturePath()) return;
  const res = await cloudFetch(
    baseUrl,
    `/api/mercury/requests/${encodeURIComponent(requestId)}/receive`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ qty }),
    },
  );
  if (res.status === 401) throw new CloudError('Session expired — reconnect', 401);
  if (res.status === 403) throw new CloudError('Account lacks the mercury grant', 403);
  if (res.status === 404) throw new CloudError('Cloud request not found', 404);
  if (!res.ok) throw new CloudError(`Failed to mark cloud request received (HTTP ${res.status})`, 502);
}

// Bump Vulcan stock for a REAL SKU via the cloud's Vulcan stock-adjust endpoint
// (POST /api/stock/adjust, supervisor-gated — the owner's suite JWT passes). This is the ONLY way a
// secret item's realSku reaches the cloud: as a transient stock-adjustment CALL, never persisted on
// any MercuryItem/MercuryRequest row. The endpoint sets an ABSOLUTE quantity, so we read the current
// stock first and send current+delta (mirrors the shared adjustStock helper's relative semantics).
export async function cloudAdjustStock(
  baseUrl: string,
  token: string,
  realSku: string,
  delta: number,
  reason: string,
): Promise<{ toQty: number }> {
  if (fixturePath()) return { toQty: delta };
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  // Read the current stock (list search by SKU) so we can compute the new absolute value.
  const listRes = await cloudFetch(
    baseUrl,
    `/api/stock/list?q=${encodeURIComponent(realSku)}&limit=50`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (listRes.status === 401) throw new CloudError('Session expired — reconnect', 401);
  if (listRes.status === 403) throw new CloudError('Account lacks stock access', 403);
  if (!listRes.ok) throw new CloudError(`Failed to read stock (HTTP ${listRes.status})`, 502);
  const listBody = (await listRes.json()) as { products?: { sku: string; stock: number | null }[] };
  const row = (listBody.products ?? []).find((p) => p.sku === realSku);
  if (!row) throw new CloudError(`Unknown SKU on the cloud: ${realSku}`, 404);
  const toQty = (row.stock ?? 0) + delta;

  const res = await cloudFetch(baseUrl, '/api/stock/adjust', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ sku: realSku, toQty, reason }),
  });
  if (res.status === 401) throw new CloudError('Session expired — reconnect', 401);
  if (res.status === 403) throw new CloudError('Account lacks stock access', 403);
  if (res.status === 404) throw new CloudError(`Unknown SKU on the cloud: ${realSku}`, 404);
  if (!res.ok) throw new CloudError(`Failed to adjust stock (HTTP ${res.status})`, 502);
  return { toQty };
}

// Pull pending requests + items from the cloud (or the fixture). Filters requests to pending
// server-side via ?status=pending; items come from GET /api/mercury/items.
export async function cloudPull(baseUrl: string, token: string): Promise<CloudPull> {
  const fx = fixturePath();
  if (fx) return readFixture(fx);

  const auth = { authorization: `Bearer ${token}` };
  const [reqRes, itemRes] = await Promise.all([
    cloudFetch(baseUrl, '/api/mercury/requests?status=pending', { headers: auth }),
    cloudFetch(baseUrl, '/api/mercury/items', { headers: auth }),
  ]);
  for (const [label, res] of [
    ['requests', reqRes],
    ['items', itemRes],
  ] as const) {
    if (res.status === 401) throw new CloudError('Session expired — reconnect', 401);
    if (res.status === 403) throw new CloudError('Account lacks the mercury grant', 403);
    if (!res.ok) throw new CloudError(`Failed to fetch ${label} (HTTP ${res.status})`, 502);
  }
  const reqBody = (await reqRes.json()) as { requests?: CloudMercuryRequest[] };
  const itemBody = (await itemRes.json()) as { items?: CloudMercuryItem[] };
  return { requests: reqBody.requests ?? [], items: itemBody.items ?? [] };
}
