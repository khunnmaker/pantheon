// Typed API client for the Juno finance UI. Talks to the SHARED Minerva Fastify
// backend (the /api/juno/* routes), which reads the Payment table Minerva writes on
// /to-finance. All Juno routes are gated to the 'supervisor' role server-side (v1).

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export type Role = 'agent' | 'supervisor';
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export type PaymentStatus = 'received' | 'verified' | 'recorded' | 'void';
export type TaxStatus = 'none' | 'requested' | 'issued';

export interface Payment {
  id: string;
  customerId: string | null;
  customerCode: string;
  customerName: string;
  senderName: string;
  amount: string;
  amountNum: number;
  ocrAmount: string;
  bank: string;
  transferAt: string;
  ref: string;
  slipMessageId: string | null;
  slipUrl: string;
  taxInvoice: string;
  taxInvoiceStatus: TaxStatus;
  salesName: string;
  note: string;
  status: PaymentStatus;
  flagged: boolean;
  verifiedById: string | null;
  verifiedAt: string | null;
  createdAt: string;
  mismatch: boolean;
}

export interface Summary {
  total: number;
  received: number;
  verified: number;
  recorded: number;
  flagged: number;
  taxRequested: number;
}

export interface ReportGroup {
  key: string;
  label: string;
  count: number;
  total: number;
}
export interface Report {
  groupBy: 'day' | 'rep' | 'bank' | 'customer';
  count: number;
  grandTotal: number;
  groups: ReportGroup[];
}

export interface PaymentFilter {
  q?: string;
  status?: 'all' | PaymentStatus;
  flagged?: boolean;
  tax?: 'all' | TaxStatus;
  from?: string;
  to?: string;
  excludeVoid?: boolean; // Reports CSV: match the on-screen report, which excludes voids
}

const TOKEN_KEY = 'juno_token';
const AGENT_KEY = 'juno_agent';

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

// Notified on a 401 (daily JWT expiry) so the app can drop back to Login instead of sitting
// as a dead husk of failed fetches. Set by App.tsx.
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

export async function login(email: string, password: string): Promise<{ token: string; agent: Agent }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('invalid_credentials');
  return res.json() as Promise<{ token: string; agent: Agent }>;
}

function filterQuery(f: PaymentFilter): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.status && f.status !== 'all') p.set('status', f.status);
  if (f.flagged) p.set('flagged', '1');
  if (f.tax && f.tax !== 'all') p.set('tax', f.tax);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.excludeVoid) p.set('noVoid', '1');
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const getSummary = () => authed<Summary>('/api/juno/summary');

export const getPayments = (f: PaymentFilter) =>
  authed<{ payments: Payment[] }>(`/api/juno/payments${filterQuery(f)}`);

export const setStatus = (id: string, status: PaymentStatus) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });

export const setFlag = (id: string, flagged: boolean, note?: string) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/flag`, {
    method: 'POST',
    body: JSON.stringify({ flagged, note }),
  });

export const setTaxInvoice = (id: string, status: TaxStatus) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/tax-invoice`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });

export const getReport = (groupBy: Report['groupBy'], from?: string, to?: string) => {
  const p = new URLSearchParams({ groupBy });
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  return authed<Report>(`/api/juno/reports?${p.toString()}`);
};

// One-click CSV export (same filters as the inbox). Fetched with auth, then downloaded
// client-side as a Blob so the bearer token never rides in a plain <a href>.
export async function downloadCsv(f: PaymentFilter): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_URL}/api/juno/export.csv${filterQuery(f)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'juno-payments.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Baht formatting for display (from the parsed amountNum).
export const baht = (n: number): string =>
  `฿${n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
