// Typed API client for the Vesta stock UI. Talks to the SHARED Minerva Fastify
// backend (the /api/stock/* routes), which writes Product.stock/stockAt that
// Minerva reads. All stock routes are gated to the 'supervisor' role server-side.

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Display product codes bare (no dashes) for easy typing/reading — "07-10-09" → "071009".
// The stored key keeps its dashes; this is presentation only. Search is dash-insensitive.
export const flatSku = (sku: string): string => sku.replace(/-/g, '');

// Live roles (mirror of api/src/auth/jwt.ts). The old 'agent' type was stale — the runtime
// sends supervisor/md/employee. Vesta's routes stay supervisor-gated server-side (v1).
export type Role = 'supervisor' | 'md' | 'employee';
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
  // Per-person app grants (from the login response). Drives the suite app switcher —
  // see hasAppAccess, which mirrors the SERVER logic in api/src/auth/jwt.ts exactly.
  apps: string[];
}

// Suite apps the switcher can link to. The canonical list now lives in the shared package
// (@pantheon/ui, mirroring the server SSOT api/src/auth/jwt.ts APP_NAMES). Imported for local
// use below AND re-exported so existing consumers that import AppName from './lib/api' keep
// working unchanged.
import type { AppName } from '@pantheon/ui';
export type { AppName };

// Mirror of the server's hasAppAccess (api/src/auth/jwt.ts): supervisor → everything;
// md → Ceres only; employee → their own per-person grant list. A stored agent from before
// this field existed has no apps → treated as no grants (empty list), which is safe.
export function hasAppAccess(agent: Agent, app: AppName): boolean {
  if (agent.role === 'supervisor') return true;
  if (agent.role === 'md') return app === 'ceres';
  return (agent.apps ?? []).includes(app);
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
  stockOnly: boolean; // created from the Express import, not merchandised yet (hidden from web/AI)
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
  asOf: string | null; // ISO date from the report's own "ณ วันที่" header (stockAt stamps this)
  asOfText: string; // the date as printed in the report, '' when not found
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
  created?: number; // new 'stock_only' products created (when createNew was set)
  importId: string;
}

const TOKEN_KEY = 'vesta_token';
const AGENT_KEY = 'vesta_agent';

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
    // Session expired/invalid. Clear it and reload so App re-boots into the Login screen —
    // without this the UI stays "logged in" and every action fails with a generic error
    // (e.g. an import upload showing "อ่านไฟล์ไม่สำเร็จ" when the file was fine all along).
    clearSession();
    window.location.reload();
    throw new Error('unauthorized');
  }
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) {
    // Surface the server's own `detail`/`error` (e.g. why an import apply failed) instead of a
    // bare "HTTP 500" — callers can show it to the supervisor. Falls back to the status code.
    const body = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null;
    throw new Error(body?.detail || body?.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function login(email: string, password: string): Promise<{ token: string; agent: Agent }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    // Suite SSO: let the browser STORE the parent-domain httpOnly cookie the server sets
    // on this response. Only login/bootstrap/logout use credentials — never state-changing calls.
    credentials: 'include',
  });
  if (!res.ok) throw new Error('invalid_credentials');
  return res.json() as Promise<{ token: string; agent: Agent }>;
}

// Suite SSO bootstrap: with NO stored token, ask /me using ONLY the shared parent-domain
// cookie (credentials:'include', no Authorization header). If the cookie authenticates,
// the server returns a fresh bearer token + agent; we store the session and return the agent.
// Never throws — a missing/invalid cookie just yields null (→ show Login).
export async function bootstrap(): Promise<Agent | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/me`, { credentials: 'include' });
    if (!res.ok) return null;
    const { agent, token } = (await res.json()) as { agent: Agent; token: string };
    setSession(token, agent);
    return agent;
  } catch {
    return null;
  }
}

// Suite-wide logout: clear the shared cookie server-side (best-effort), THEN clear this
// app's local session. Used by the user-facing "log out" action so logging out here
// propagates across the suite.
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {
    // Network failure clearing the cookie shouldn't block local logout.
  }
  clearSession();
}

export interface LoginCard {
  email: string;
  name: string;
  kind: 'password' | 'pin';
  // DISPLAY metadata for the role-grouped, avatar login screen (additive; server-provided).
  group: string;                 // ceo | md | sales | finance | messengers | stores | others
  gender: 'male' | 'female';     // drives the cute (DiceBear) avatar
}
// PUBLIC — no auth required. Ordered: supervisor first, then employees granted this app.
export async function getLogins(): Promise<LoginCard[]> {
  const res = await fetch(`${API_URL}/api/auth/logins?app=vesta`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<LoginCard[]>;
}

export const getSummary = () => authed<StockSummary>('/api/stock/summary');

export const getStockList = (q: string, filter: 'all' | 'low' | 'out' | 'unknown' | 'noname') =>
  authed<{ products: StockRow[] }>(
    `/api/stock/list?q=${encodeURIComponent(q)}&filter=${filter}`,
  );

// Rename a product (Thai + English). Merges the name into keywords for search.
export const renameProduct = (sku: string, nameEn: string, nameTh: string) =>
  authed<{ ok: boolean; product: StockRow }>('/api/stock/catalog/name', {
    method: 'POST',
    body: JSON.stringify({ sku, nameEn, nameTh }),
  });

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
// createNew=true also creates SKUs not in the catalog as hidden 'stock_only' products.
export const applyImport = (token: string, note?: string, createNew?: boolean) =>
  authed<ImportApplyResult>('/api/stock/import/apply', {
    method: 'POST',
    body: JSON.stringify({ token, note, createNew }),
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
export type Pillar = 'lab' | 'digital' | 'clinical' | 'equipment' | 'review';
export interface SubGroupInfo {
  code: string; // 2-letter, within its group (e.g. "AL" → IMAL01)
  nameTh: string;
  nameEn: string;
  custom?: boolean; // staff-created (deletable) vs built-in
}
export interface CatalogGroupInfo {
  key: string;
  code: string; // 2-letter product-code prefix (e.g. "IM" → IM01)
  nameTh: string;
  nameEn: string;
  pillar: Pillar;
  count: number;
  subgroups: SubGroupInfo[];
  custom?: boolean; // staff-created (deletable) vs built-in
}
export interface GroupProduct {
  sku: string;
  nameEn: string;
  nameTh: string;
  photoSku: string | null;
  catalogGroup: string | null;
  catalogSubgroup: string | null;
  alias: string | null;
  stock: number | null; // remaining qty (null = unknown)
  reorderPoint: number | null;
  stockOnly?: boolean; // from the Express import, not merchandised yet (hidden from web/AI)
}

export const getGroups = () =>
  authed<{ groups: CatalogGroupInfo[]; total: number; unassigned: number }>('/api/stock/groups');

export const getGroupProducts = (opts: { group?: string; filter?: 'all' | 'unassigned'; q?: string; sort?: 'sku' | 'sub' | 'name' }) => {
  const p = new URLSearchParams();
  if (opts.group) p.set('group', opts.group);
  if (opts.filter) p.set('filter', opts.filter);
  if (opts.q) p.set('q', opts.q);
  if (opts.sort) p.set('sort', opts.sort);
  return authed<{ products: GroupProduct[] }>(`/api/stock/groups/products?${p.toString()}`);
};

// Auto-assign products to groups + sub-groups by keyword/category rules. onlyUnassigned=true
// keeps manual assignments; false re-runs on everything.
export const autoAssignGroups = (onlyUnassigned: boolean) =>
  authed<{ ok: boolean; assigned: number; subAssigned: number; unassigned: number; scanned: number }>('/api/stock/groups/auto-assign', {
    method: 'POST',
    body: JSON.stringify({ onlyUnassigned }),
  });

export const setProductGroup = (sku: string, group: string | null) =>
  authed<{ ok: boolean; sku: string; group: string | null }>('/api/stock/groups/set-product', {
    method: 'POST',
    body: JSON.stringify({ sku, group }),
  });

// Set/clear one product's sub-group (2-letter code valid for its group).
export const setSubgroup = (sku: string, subgroup: string | null) =>
  authed<{ ok: boolean; sku: string; subgroup: string | null }>('/api/stock/groups/set-subgroup', {
    method: 'POST',
    body: JSON.stringify({ sku, subgroup }),
  });

export const setFamilyGroup = (family: string, group: string | null) =>
  authed<{ ok: boolean; family: string; group: string | null; updated: number }>('/api/stock/groups/set-family', {
    method: 'POST',
    body: JSON.stringify({ family, group }),
  });

// Batch set/clear the group for many products at once (group=null clears → ยังไม่จัด).
export const setProductsGroup = (skus: string[], group: string | null) =>
  authed<{ ok: boolean; group: string | null; updated: number }>('/api/stock/groups/set-products', {
    method: 'POST',
    body: JSON.stringify({ skus, group }),
  });

// Batch set/clear the sub-group for many products (subgroup=null clears). On set, only products
// whose current group defines that sub-code are changed; skipped counts the rest.
export const setSubgroups = (skus: string[], subgroup: string | null) =>
  authed<{ ok: boolean; subgroup: string | null; updated: number; skipped: number }>('/api/stock/groups/set-subgroups', {
    method: 'POST',
    body: JSON.stringify({ skus, subgroup }),
  });

// ── Create / delete staff-defined groups + sub-groups ────────────────────
// code = 2 uppercase letters (product-code prefix). Throws 'HTTP 409' on a duplicate code.
export const createGroup = (nameTh: string, nameEn: string, code: string, pillar: Pillar) =>
  authed<{ ok: boolean; group: CatalogGroupInfo }>('/api/stock/groups/create', {
    method: 'POST',
    body: JSON.stringify({ nameTh, nameEn, code, pillar }),
  });

export const createSubgroup = (groupKey: string, nameTh: string, nameEn: string, code: string) =>
  authed<{ ok: boolean; groupKey: string; subgroup: SubGroupInfo }>('/api/stock/groups/create-subgroup', {
    method: 'POST',
    body: JSON.stringify({ groupKey, nameTh, nameEn, code }),
  });

// Delete a staff-created group (its products become ungrouped). Built-ins return HTTP 404.
export const deleteGroup = (key: string) =>
  authed<{ ok: boolean; key: string; ungrouped: number }>('/api/stock/groups/delete', {
    method: 'POST',
    body: JSON.stringify({ key }),
  });

export const deleteSubgroup = (groupKey: string, code: string) =>
  authed<{ ok: boolean; groupKey: string; code: string }>('/api/stock/groups/delete-subgroup', {
    method: 'POST',
    body: JSON.stringify({ groupKey, code }),
  });

// Archive every product in the ถังขยะ (trash) group → hidden from Vesta + web + AI; won't
// resurrect on re-import. Reversible (status only), not a hard delete.
export const emptyTrash = () =>
  authed<{ ok: boolean; archived: number }>('/api/stock/groups/empty-trash', { method: 'POST' });

// ── Name-normalization review (ตรวจทาน tab) ─────────────────────────────
// A staged proposed English name awaiting review. The live nameEn is untouched until the
// proposal is APPROVED. status: pending (awaiting) | approved (now live) | rejected (dropped).
export type ProposalStatus = 'pending' | 'approved' | 'rejected';
export interface NameProposalRow {
  sku: string;
  nameEn: string; // the LIVE (current) English name
  nameTh: string;
  photoSku: string | null;
  proposedNameEn: string | null; // the normalized candidate
  status: ProposalStatus;
  needsReview: boolean; // flagged for team review (ambiguous shade/variant)
  catalogGroup: string | null;
  catalogSubgroup: string | null;
  stock: number | null;
  reorderPoint: number | null;
  alias: string | null;
  // RAW name from the Express accounting report ('' = SKU not in the report). Often carries
  // variant details (shade codes, colors) the catalog names lost — key reference when reviewing.
  expressName: string;
}
export interface ProposalSummary {
  pending: number;
  review: number; // pending AND flagged (ต้องตรวจสอบ)
  approved: number;
  rejected: number;
  total: number; // every product carrying a proposal
}
export type ProposalFilter = 'pending' | 'review' | 'approved' | 'rejected' | 'all';

export const getProposalSummary = () => authed<ProposalSummary>('/api/stock/proposals/summary');

export const getProposals = (filter: ProposalFilter, q: string) =>
  authed<{ products: NameProposalRow[] }>(
    `/api/stock/proposals?filter=${filter}&q=${encodeURIComponent(q)}`,
  );

// Seed the staging column from the committed proposals file. Idempotent (only fills rows with
// no proposal yet). Returns how many were newly loaded. Never changes a live name.
export const loadProposals = () =>
  authed<{ ok: boolean; loaded: number; skipped: number; available: number; total: number }>('/api/stock/proposals/load', {
    method: 'POST',
  });

// Approve (→ writes the live name), reject, or edit-and-keep-pending one proposal.
// nameEn overrides the stored candidate (edit-then-approve, or edit-and-keep in one call).
export const decideProposal = (sku: string, action: 'approve' | 'reject' | 'edit', nameEn?: string) =>
  authed<{ ok: boolean; product: NameProposalRow }>('/api/stock/proposals/decide', {
    method: 'POST',
    body: JSON.stringify({ sku, action, ...(nameEn !== undefined ? { nameEn } : {}) }),
  });

// Approve every pending, NON-flagged proposal at once. Flagged (ต้องตรวจสอบ) ones are never touched.
export const bulkApproveSafe = () =>
  authed<{ ok: boolean; approved: number }>('/api/stock/proposals/decide-bulk', {
    method: 'POST',
    body: JSON.stringify({ scope: 'safe' }),
  });
