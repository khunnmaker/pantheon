// Typed API client for the Vulcan stock UI. Talks to the SHARED Minerva Fastify
// backend (the /api/stock/* routes), which writes Product.stock/stockAt that
// Minerva reads. All stock routes are gated to the 'supervisor' role server-side.

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Display product codes bare (no dashes) for easy typing/reading — "07-10-09" → "071009".
// The stored key keeps its dashes; this is presentation only. Search is dash-insensitive.
export const flatSku = (sku: string): string => sku.replace(/-/g, '');

export type Role = 'agent' | 'supervisor';
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface StockRow {
  sku: string;
  nameEn: string;
  nameTh: string;
  price: number;
  photoSku: string | null;
  stock: number | null;
  stockAt: string | null; // ISO; null = unknown
  reorderPoint: number | null;
  low: boolean;
  alias?: string | null; // short human code (e.g. "TR34")
}

export interface StockSummary {
  total: number;
  withStock: number;
  outOfStock: number;
  unknown: number;
  low: number;
  lastImport: StockImportRow | null;
}

export interface StockImportRow {
  id: string;
  importedAt: string;
  importedBy: string | null;
  fileName: string;
  rowsParsed: number;
  skusUpdated: number;
  skusUnmatched: number;
  note: string;
}

export interface StockAdjustmentRow {
  id: string;
  sku: string;
  fromQty: number | null;
  toQty: number | null;
  reason: string;
  byAgentId: string | null;
  at: string;
}

// ── Import preview/apply (CSV) ──────────────────────────────────────────
// One parsed CSV line resolved against the catalog.
export interface ImportPreviewRow {
  sku: string;
  name: string; // clean catalog name (falls back to the raw Express text if unmatched)
  photoSku: string | null; // catalog photo key (matched only); null = no photo
  csvName: string; // raw name as it appears in the Express report
  qty: number;
  matched: boolean; // sku exists in Product
  currentStock: number | null; // current Product.stock (matched only)
  willChange: boolean; // matched && qty !== currentStock
}
export interface ImportPreview {
  token: string; // opaque handle to apply this exact parsed set
  fileName: string;
  encoding: string; // detected source encoding (e.g. "windows-874")
  rowsParsed: number;
  matched: number;
  unmatched: number;
  willChange: number;
  unresolved: number; // SKU lines the parser couldn't extract a qty from (skipped, not applied)
  unresolvedSamples: string[]; // up to 5 raw offending lines, for human review
  rows: ImportPreviewRow[];
}
export interface ImportApplyResult {
  ok: boolean;
  skusUpdated: number;
  skusUnmatched: number;
  importId: string;
}

const TOKEN_KEY = 'vulcan_token';
const AGENT_KEY = 'vulcan_agent';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function getStoredAgent(): Agent | null {
  const s = localStorage.getItem(AGENT_KEY);
  if (!s) return null;
  try {
    return JSON.parse(s) as Agent;
  } catch {
    clearSession();
    return null;
  }
}
export function setSession(token: string, agent: Agent): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(AGENT_KEY, JSON.stringify(agent));
}
export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(AGENT_KEY);
}

async function authed<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    clearSession();
    throw new Error('unauthorized');
  }
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function login(email: string, password: string): Promise<{ token: string; agent: Agent }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('invalid_credentials');
  return res.json() as Promise<{ token: string; agent: Agent }>;
}

export const getSummary = () => authed<StockSummary>('/api/stock/summary');

export const getStockList = (q: string, filter: 'all' | 'low' | 'out' | 'unknown') =>
  authed<{ products: StockRow[] }>(
    `/api/stock/list?q=${encodeURIComponent(q)}&filter=${filter}`,
  );

export const adjustStock = (sku: string, toQty: number | null, reason: string) =>
  authed<{ ok: boolean; product: StockRow; unchanged?: boolean }>('/api/stock/adjust', {
    method: 'POST',
    body: JSON.stringify({ sku, toQty, reason }),
  });

export const setReorderPoint = (sku: string, reorderPoint: number | null) =>
  authed<{ ok: boolean; product: StockRow }>('/api/stock/reorder-point', {
    method: 'POST',
    body: JSON.stringify({ sku, reorderPoint }),
  });

export const getImports = () => authed<{ imports: StockImportRow[] }>('/api/stock/imports');

export const getAdjustments = (sku?: string) =>
  authed<{ adjustments: StockAdjustmentRow[] }>(
    `/api/stock/adjustments${sku ? `?sku=${encodeURIComponent(sku)}` : ''}`,
  );

// Upload a CSV (base64) → server parses + previews against the catalog (no writes).
export const previewImport = (dataB64: string, fileName: string) =>
  authed<ImportPreview>('/api/stock/import/preview', {
    method: 'POST',
    body: JSON.stringify({ dataB64, fileName }),
  });

// Apply a previously previewed import (by its token) → writes Product.stock/stockAt.
export const applyImport = (token: string, note?: string) =>
  authed<ImportApplyResult>('/api/stock/import/apply', {
    method: 'POST',
    body: JSON.stringify({ token, note }),
  });

// ── Product codes (group-based human codes, e.g. "IM01", "EN12") ─────────
// (Re)build codes from the groups. Only grouped products get a code. regenerate=false keeps
// existing codes + appends new items; true renumbers every group. ungrouped = products with
// no group yet (assign a group first before they can get a code).
export const generateAliases = (regenerate: boolean) =>
  authed<{ ok: boolean; mode: string; coded: number; written: number; ungrouped: number }>('/api/stock/aliases/generate', {
    method: 'POST',
    body: JSON.stringify({ regenerate }),
  });

// Set/clear one product's code by hand (alias='' clears). Throws on HTTP 409 (duplicate).
export const setAlias = (sku: string, alias: string) =>
  authed<{ ok: boolean; sku: string; alias: string | null }>('/api/stock/aliases/set', {
    method: 'POST',
    body: JSON.stringify({ sku, alias }),
  });

// ── Catalog groups (merchandising taxonomy) ─────────────────────────────
export type Pillar = 'lab' | 'digital' | 'clinical' | 'equipment';
export interface CatalogGroupInfo {
  key: string;
  code: string; // 2-letter product-code prefix (e.g. "IM" → IM01)
  nameTh: string;
  nameEn: string;
  pillar: Pillar;
  count: number;
}
export interface GroupProduct {
  sku: string;
  nameEn: string;
  nameTh: string;
  photoSku: string | null;
  catalogGroup: string | null;
  alias: string | null;
}

export const getGroups = () =>
  authed<{ groups: CatalogGroupInfo[]; total: number; unassigned: number }>('/api/stock/groups');

export const getGroupProducts = (opts: { group?: string; filter?: 'all' | 'unassigned'; q?: string }) => {
  const p = new URLSearchParams();
  if (opts.group) p.set('group', opts.group);
  if (opts.filter) p.set('filter', opts.filter);
  if (opts.q) p.set('q', opts.q);
  return authed<{ products: GroupProduct[] }>(`/api/stock/groups/products?${p.toString()}`);
};

// Auto-assign products to groups by keyword/category rules. onlyUnassigned=true keeps
// manual assignments; false re-runs on everything.
export const autoAssignGroups = (onlyUnassigned: boolean) =>
  authed<{ ok: boolean; assigned: number; unassigned: number; scanned: number }>('/api/stock/groups/auto-assign', {
    method: 'POST',
    body: JSON.stringify({ onlyUnassigned }),
  });

export const setProductGroup = (sku: string, group: string | null) =>
  authed<{ ok: boolean; sku: string; group: string | null }>('/api/stock/groups/set-product', {
    method: 'POST',
    body: JSON.stringify({ sku, group }),
  });

export const setFamilyGroup = (family: string, group: string | null) =>
  authed<{ ok: boolean; family: string; group: string | null; updated: number }>('/api/stock/groups/set-family', {
    method: 'POST',
    body: JSON.stringify({ family, group }),
  });
