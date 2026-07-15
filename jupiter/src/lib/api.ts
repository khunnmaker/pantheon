// Typed API client for the Jupiter accounting app. Talks to the shared Minerva backend.
//   POST /api/auth/login       — the suite's single login (Phase 1: localStorage-JWT, no SSO)
//   GET  /api/jupiter/acct/*   — the accounting cockpit's supervisor-only endpoints

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Mirrors the backend's Role vocabulary post unified-auth (api/src/auth/jwt.ts): three live
// tiers. Which apps a person may open is NO LONGER derived from role alone — it's a per-person
// grant (`apps`), exactly as the server gates it (see hasAppAccess in apps.ts). supervisor →
// everything; gm → Ceres + Minerva + Juno + Apollo; agm/employee → their own `apps` list.
export type Role = 'supervisor' | 'gm' | 'agm' | 'employee';
import type { AppName } from '@pantheon/ui';
export type { AppName };
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
  apps: string[];   // per-person app grants (from the login response). Absent/empty ⇒ none.
}

// The badges payload: a key per app the CALLER may enter (the server never returns a key
// for an app this role can't open). Each value is optional so a missing app is just absent.
export interface LoginCard {
  email: string;
  name: string;
  kind: 'password' | 'pin';
  group: string;
  gender: 'male' | 'female';
}

export function hasAppAccess(agent: Agent, app: AppName): boolean {
  if (agent.role === 'supervisor') return true;
  if (agent.role === 'gm') return app === 'ceres' || app === 'minerva' || app === 'juno' || app === 'apollo';
  return (agent.apps ?? []).includes(app);
}

const TOKEN_KEY = 'jupiter_token';
const AGENT_KEY = 'jupiter_agent';

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

// Notified on a 401 (JWT expiry) so App can drop back to Login instead of a blank portal.
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: (() => void) | null): void { onUnauthorized = fn; }

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

export async function getLogins(): Promise<LoginCard[]> {
  const res = await fetch(`${API_URL}/api/auth/logins?app=jupiter`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<LoginCard[]>;
}

// ─── Jupiter accounting (Phase 1 cockpit) — supervisor-only endpoints under /api/jupiter/acct ──
// All calls carry the bearer token and clear the session + notify on a 401 (same as getBadges).

export type Direction = 'income' | 'expense';

export interface AcctCompany {
  code: string;
  name: string;
  nameTh: string;
  kind: string;
  color: string;
}

export interface AcctSummaryCompany {
  code: string;
  name: string;
  nameTh: string;
  color: string;
  revenue: number;
  expense: number;
  profit: number;
}
export interface AcctSummary {
  month: string;
  companies: AcctSummaryCompany[];
  total: { revenue: number; expense: number; profit: number };
}

export interface AcctTxn {
  id: string;
  companyCode: string;
  direction: Direction;
  date: string;
  party: string;
  category: string;
  amount: string;
  vatAmount: string;
  whtAmount: string;
  note: string;
  source: string;
  sourceRef: string;
  createdById: string | null;
  createdByName: string;
  createdAt: string;
}

export interface AcctRegisterRow {
  code: string;
  name: string;
  nameTh: string;
  color: string;
  sales: number;
  outputVat: number;
  purchases: number;
  inputVat: number;
  wht: number;
  vatNet: number;
}
export interface AcctRegisters {
  month: string;
  companies: AcctRegisterRow[];
}

// A proposed txn from POST /parse (before the user confirms + saves it).
export interface ProposedTxn {
  direction: Direction;
  companyCode: string;
  category: string;
  party: string;
  amount: string;
  vatAmount: string;
  whtAmount: string;
  note: string;
}

// Shared authed-fetch: attaches the bearer token, handles 401 → logout, parses JSON.
async function acctFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    clearSession();
    onUnauthorized?.();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export function acctCompanies(): Promise<AcctCompany[]> {
  return acctFetch<AcctCompany[]>('/api/jupiter/acct/companies');
}
export function acctSummary(month?: string): Promise<AcctSummary> {
  return acctFetch<AcctSummary>(`/api/jupiter/acct/summary${month ? `?month=${month}` : ''}`);
}
export function acctTxns(params: { company?: string; month?: string; direction?: Direction; limit?: number } = {}): Promise<AcctTxn[]> {
  const qs = new URLSearchParams();
  if (params.company) qs.set('company', params.company);
  if (params.month) qs.set('month', params.month);
  if (params.direction) qs.set('direction', params.direction);
  if (params.limit) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return acctFetch<AcctTxn[]>(`/api/jupiter/acct/txns${q ? `?${q}` : ''}`);
}
export function acctCreateTxn(body: {
  companyCode: string;
  direction: Direction;
  date?: string;
  party?: string;
  category?: string;
  amount: string;
  vatAmount?: string;
  whtAmount?: string;
  note?: string;
}): Promise<AcctTxn> {
  return acctFetch<AcctTxn>('/api/jupiter/acct/txns', { method: 'POST', body: JSON.stringify(body) });
}
export function acctDeleteTxn(id: string): Promise<{ ok: boolean }> {
  return acctFetch<{ ok: boolean }>(`/api/jupiter/acct/txns/${id}`, { method: 'DELETE' });
}
export function acctRegisters(month?: string): Promise<AcctRegisters> {
  return acctFetch<AcctRegisters>(`/api/jupiter/acct/registers${month ? `?month=${month}` : ''}`);
}
export function acctParse(text: string): Promise<{ ok: boolean; via?: 'ai' | 'heuristic'; proposed?: ProposedTxn }> {
  return acctFetch('/api/jupiter/acct/parse', { method: 'POST', body: JSON.stringify({ text }) });
}
// Phase-1b: pull every recorded Juno payment into the books as PROM income (idempotent).
export function acctSyncJuno(): Promise<{ ok: boolean; synced: number; removed: number }> {
  return acctFetch('/api/jupiter/acct/sync/juno', { method: 'POST' });
}

// ─── Punch #9: Party identity backfill (supervisor-only) ─────────────────────────────
// Populate the canonical Party + PartyIdentity spine from the deity source tables, runnable
// from the cockpit. Dry-run computes the plan (writes nothing); apply kicks off the writes in
// the background; status polls the live counts + whether an apply is still running.

// Mirror of the api Summary (api/src/scripts/backfillParties.ts).
export interface BackfillSummary {
  parties: number; // parties to create (dry) / created (apply)
  identities: Record<string, number>; // by channel
  conflicts: number;
  sampleConflicts: string[]; // ≤20 "channel key → partyA vs partyB"
}
export interface BackfillStatus {
  parties: number;
  identities: number;
  running: boolean;
}

// Dry-run: synchronous, returns the full Summary (writes nothing).
export function acctPartyBackfillDry(): Promise<BackfillSummary> {
  return acctFetch<BackfillSummary>('/api/jupiter/acct/parties/backfill/dry', { method: 'POST' });
}
// Apply: fire-and-forget on the server; returns immediately. busy:true ⇒ a run is already going.
export function acctPartyBackfillApply(): Promise<{ started: boolean; busy?: boolean }> {
  return acctFetch('/api/jupiter/acct/parties/backfill/apply', { method: 'POST' });
}
// Status: live spine counts + whether an apply is in flight (poll while running).
export function acctPartyStatus(): Promise<BackfillStatus> {
  return acctFetch<BackfillStatus>('/api/jupiter/acct/parties/status');
}
