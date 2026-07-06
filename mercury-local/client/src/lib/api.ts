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
  unitCost: string;
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

// ── Purchase orders (read-only scaffold) ────────────────────────────────────
export const getPurchaseOrders = () =>
  req<{ orders: PurchaseOrder[] }>('/purchase-orders');
