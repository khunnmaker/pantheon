// Typed API client for the LOCAL Mercury app. Talks to the local Express server on the same
// origin (server serves this built client), so paths are relative. NO auth (single-user local
// app on 127.0.0.1). NO cloud calls. All data here — vendors, costs, real names — is SECRET and
// never leaves the machine.

// Display product codes bare (no dashes) for easy typing — "07-10-09" → "071009". Stored key
// keeps its dashes; this is presentation only. Search is dash-insensitive (server-side too).
export const flatSku = (sku: string): string => sku.replace(/-/g, '');

// ── Domain types ────────────────────────────────────────────────────────
export interface Vendor {
  id: string;
  name: string;
  email: string;
  ccList: string;
  country: string;
  isTaiwan: boolean;
  contactName: string;
  terms: string;
  notes: string;
  createdAt: string;
}

export type Classification = 'normal' | 'special';

export interface SecretItem {
  id: string;
  cloudItemId: string;
  realName: string;
  vendorId: string;
  vendor: Vendor | null;
  realSku: string;
  unitCost: string;
  currency: string;
  leadTime: string | null;
  moq: string | null;
  classification: Classification;
  photoRef: string | null;
  createdAt: string;
}

export interface PurchaseOrderLine {
  id: string;
  poId: string;
  cloudItemId: string;
  realName: string;
  realSku: string;
  qty: string;
  unit: string;
  unitCost: string;
  currency: string;
  classification: Classification;
  photoRef: string | null;
}

export interface PurchaseOrder {
  id: string;
  vendorId: string;
  vendor: Vendor | null;
  poNumber: string | null;
  status: 'draft' | 'sent';
  emailedAt: string | null;
  pdfPath: string | null;
  createdAt: string;
  lines: PurchaseOrderLine[];
}

// ── Cloud connection + sync ─────────────────────────────────────────────────
export interface ConnectionStatus {
  connected: boolean;
  baseUrl: string;
  agentName?: string;
  agentEmail?: string;
  connectedAt?: string;
}

export interface PendingRequest {
  id: string;
  cloudRequestId: string;
  itemId: string;
  qty: string;
  note: string;
  requestedById: string | null;
  status: string;
  itemDisplayName: string;
  itemIsSecret: boolean;
  itemVulcanSku: string | null;
  cloudCreatedAt: string;
  syncedAt: string;
}

export interface ResolvedLine {
  cloudItemId: string;
  cloudRequestId: string;
  realName: string;
  realSku: string;
  qty: string;
  unitCost: string;
  currency: string;
  classification: Classification;
  photoRef: string | null;
  vendorId: string;
  vendorName: string;
}

export type UnresolvedReason = 'needs_mapping' | 'unmapped_secret' | 'unknown';

export interface UnresolvedLine {
  cloudItemId: string;
  cloudRequestId: string;
  reason: UnresolvedReason;
  displayName: string;
  qty: string;
  vulcanSku: string | null;
}

// ── Fetch helper ─────────────────────────────────────────────────────────
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

// ── Vendors ───────────────────────────────────────────────────────────────
export const getVendors = (q = '') =>
  req<{ vendors: Vendor[] }>(`/vendors?q=${encodeURIComponent(q)}`);

export type VendorInput = {
  name: string;
  email?: string;
  ccList?: string;
  country?: string;
  isTaiwan?: boolean;
  contactName?: string;
  terms?: string;
  notes?: string;
};

export const createVendor = (input: VendorInput) =>
  req<{ ok: boolean; vendor: Vendor }>('/vendors', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const patchVendor = (id: string, input: Partial<VendorInput>) =>
  req<{ ok: boolean; vendor: Vendor }>(`/vendors/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });

export const deleteVendor = (id: string) =>
  req<{ ok: boolean }>(`/vendors/${id}`, { method: 'DELETE' });

// ── Items (secret map) ─────────────────────────────────────────────────────
export const getItems = (q = '') =>
  req<{ items: SecretItem[] }>(`/items?q=${encodeURIComponent(q)}`);

export type ItemInput = {
  cloudItemId: string;
  realName: string;
  vendorId: string;
  realSku?: string;
  unitCost?: string;
  currency?: string;
  leadTime?: string | null;
  moq?: string | null;
  classification?: Classification;
  photoRef?: string | null;
};

export const createItem = (input: ItemInput) =>
  req<{ ok: boolean; item: SecretItem }>('/items', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const patchItem = (id: string, input: Partial<ItemInput>) =>
  req<{ ok: boolean; item: SecretItem }>(`/items/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });

export const deleteItem = (id: string) =>
  req<{ ok: boolean }>(`/items/${id}`, { method: 'DELETE' });

// ── Cloud connection ────────────────────────────────────────────────────────
export const getConnection = () =>
  req<{ status: ConnectionStatus; usingFixture: boolean }>('/connection');

export const connect = (input: { baseUrl: string; email: string; password: string }) =>
  req<{ ok: boolean; status: ConnectionStatus }>('/connection', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const disconnect = () => req<{ ok: boolean }>('/connection', { method: 'DELETE' });

// ── Sync + resolve + build ──────────────────────────────────────────────────
export const sync = () =>
  req<{ ok: boolean; synced: number; pruned: number; usingFixture: boolean }>('/sync', {
    method: 'POST',
  });

export const getPending = () => req<{ pending: PendingRequest[] }>('/pending');

export const getResolvePreview = () =>
  req<{ resolved: ResolvedLine[]; unresolved: UnresolvedLine[] }>('/resolve-preview');

export const buildPos = () =>
  req<{
    ok: boolean;
    created: { id: string; vendorId: string; vendorName: string; poNumber: string; lineCount: number }[];
    unresolvedCount: number;
  }>('/build-pos', { method: 'POST' });

// ── Purchase orders ─────────────────────────────────────────────────────────
export const getPurchaseOrders = () =>
  req<{ orders: PurchaseOrder[] }>('/purchase-orders');

export const generatePoPdf = (id: string) =>
  req<{ ok: boolean; pdfPath: string; url: string }>(`/purchase-orders/${id}/pdf`, {
    method: 'POST',
  });

// The URL to view a generated PDF (served inline by the local server).
export const poPdfUrl = (id: string) => `/api${`/purchase-orders/${id}/pdf`}`;
