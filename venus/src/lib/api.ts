// Typed API client for the Venus CRM UI. Talks to the SHARED Minerva Fastify backend
// (the /api/venus/* routes) — see api/src/routes/venus.ts + docs/VENUS_BRIEF.md.
// Venus is track-and-tell only; Stage C (this app) wires login + the customer-master
// screens Stage A+B already built. Sales/analytics are not wired yet (Phase 1/2).

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Access to Venus is per-grant, enforced server-side via requireApp('venus') (see
// api/src/routes/venus.ts): supervisor always has access; employees need the explicit
// 'venus' grant (Agent.apps); md is excluded. The login screen does not hard-block by
// role — an ungranted employee logs in fine and gets a friendly 403 state instead (App.tsx).
export type Role = 'supervisor' | 'md' | 'employee';
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
}

// Mirrors the VenusCustomer Prisma model (api/prisma/schema.prisma) field-for-field.
export interface VenusCustomer {
  code: string;
  searchKey: string;
  name: string;
  nameEn: string | null;
  custType: string | null;
  repCode: string | null;
  zone: string | null;
  priceType: string | null;
  discount: string | null;
  address: string | null;
  contact: string | null;
  phone: string | null;
  acctNo: string | null;
  shipBy: string | null;
  creditDays: number | null;
  creditLimit: string | null;
  creditTerms: string | null;
  creditTermsNorm: 'CASH' | 'PREPAY' | 'CREDIT' | 'OTHER' | null;
  note: string | null;
  importedAt: string;
}

const TOKEN_KEY = 'venus_token';
const AGENT_KEY = 'venus_agent';

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

// Notified on a 401 (daily JWT expiry, or an account demoted/removed) so the app can drop
// back to Login instead of sitting as a dead husk of failed fetches. Set by App.tsx.
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: (() => void) | null): void { onUnauthorized = fn; }

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
    onUnauthorized?.();
    throw new Error('unauthorized');
  }
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// Same shared login endpoint every service uses — any live account may authenticate here;
// per-app access is enforced server-side by requireApp('venus') on the app's own routes
// (api/src/routes/venus.ts): supervisor always has access, employees need the explicit
// 'venus' grant, md is excluded.
export async function login(email: string, password: string): Promise<{ token: string; agent: Agent }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('invalid_credentials');
  return res.json() as Promise<{ token: string; agent: Agent }>;
}

export interface LoginName {
  email: string;
  name: string;
  kind: 'password' | 'pin';
}
// PUBLIC — no auth required. Ordered: supervisor first (kind 'password'), then any
// granted MD/employee cards. Uses the GENERAL suite endpoint (not an app-owned one like
// Ceres's /api/ceres/logins) since Venus access is grant-based, not role-based.
export const getLogins = () =>
  fetch(`${API_URL}/api/auth/logins?app=venus`).then((r) => {
    if (!r.ok) throw new Error('logins_failed');
    return r.json() as Promise<LoginName[]>;
  });

export const canImport = (agent: Agent | null): boolean => agent?.role === 'supervisor';

// ── Customers ────────────────────────────────────────────────────────────

export interface CustomerListResult {
  total: number;
  customers: VenusCustomer[];
}

export const getCustomers = (params: { q?: string; limit?: number; offset?: number }) => {
  const p = new URLSearchParams();
  if (params.q) p.set('q', params.q);
  p.set('limit', String(params.limit ?? 50));
  p.set('offset', String(params.offset ?? 0));
  return authed<CustomerListResult>(`/api/venus/customers?${p.toString()}`);
};

export const getCustomer = (code: string) =>
  authed<{ customer: VenusCustomer }>(`/api/venus/customers/${encodeURIComponent(code)}`);

// ── Import (supervisor only) — Express ARMAST customer-master preview→apply ─────

export interface ImportPreview {
  token: string;
  fileName: string;
  encoding: string;
  pageCount: number;
  parsedCount: number;
  matched: number;
  unmatched: number;
  typeBreakdown: Record<string, number>;
  creditBreakdown: Record<string, number>;
  unresolved: number;
  unresolvedSamples: string[];
}

export interface ImportApplyResult {
  ok: boolean;
  created: number;
  updated: number;
  unresolved: number;
  unresolvedSamples: string[];
}

// Reads a File as raw bytes, base64-encoded (no data: prefix) — the server sniffs the
// Thai text encoding itself (see decodeExpressBytes), so we must NOT let the browser
// decode it as text first.
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result as ArrayBuffer;
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      resolve(btoa(binary));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsArrayBuffer(file);
  });
}

export const previewCustomerImport = (dataB64: string, fileName: string) =>
  authed<ImportPreview>('/api/venus/import/customers', {
    method: 'POST',
    body: JSON.stringify({ mode: 'preview', dataB64, fileName }),
  });

export const applyCustomerImport = (token: string) =>
  authed<ImportApplyResult>('/api/venus/import/customers', {
    method: 'POST',
    body: JSON.stringify({ mode: 'apply', token }),
  });

// ── Display helpers ──────────────────────────────────────────────────────

// Dash-insensitive convention (see SKU display convention doc): store as-is, display bare
// where it helps scanning. Venus codes are shown as-is (they're not purely numeric SKUs),
// so no stripping here — kept for parity/documentation only.
export const creditLabel = (norm: VenusCustomer['creditTermsNorm']): string => {
  switch (norm) {
    case 'CASH': return 'เงินสด';
    case 'PREPAY': return 'โอนก่อนส่ง';
    case 'CREDIT': return 'เครดิต';
    case 'OTHER': return 'อื่นๆ';
    default: return '—';
  }
};
