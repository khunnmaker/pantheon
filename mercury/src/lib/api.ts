// Typed API client for the Mercury procurement UI. Talks to the SHARED Minerva Fastify
// backend (the /api/mercury/* routes). Cloud-Mercury is the buy-side reorder board: it reads
// Vesta low-stock (the single source of stock truth) and creates purchase requests. All
// /api/mercury/* routes are gated by requireApp('mercury') server-side (owner-only for now).
// SECRETS-FREE: no vendor/cost/real-name/real-SKU is ever fetched here (those live only in
// local-Mercury, Phase 2).

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Display product codes bare (no dashes) for easy typing/reading — "07-10-09" → "071009".
// The stored key keeps its dashes; this is presentation only. Search is dash-insensitive.
export const flatSku = (sku: string): string => sku.replace(/-/g, '');

// Live roles (mirror of api/src/auth/jwt.ts): four tiers. Which apps a person may open is a
// per-person grant, not derived from role — see hasAppAccess, which mirrors the SERVER logic.
export type Role = 'supervisor' | 'gm' | 'agm' | 'employee';
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
  // Per-person app grants (from the login response). Drives the suite app switcher + the login
  // gate — see hasAppAccess.
  apps: string[];
}

// Suite apps the switcher can link to. The canonical list now lives in the shared package
// (@pantheon/ui, mirroring the server SSOT api/src/auth/jwt.ts APP_NAMES). Imported for local
// use below AND re-exported so existing consumers that import AppName from './lib/api' keep
// working unchanged.
import type { AppName } from '@pantheon/ui';
export type { AppName };

// Mirror of the server's hasAppAccess (api/src/auth/jwt.ts): supervisor → everything;
// gm → Ceres + Minerva + Juno + Apollo; agm/employee → their own per-person grant list. Mercury is owner-only
// (only supervisor passes today), so a granted employee is the future path. A stored agent from
// before the `apps` field existed has no apps → treated as no grants (empty list), which is safe.
export function hasAppAccess(agent: Agent, app: AppName): boolean {
  if (agent.role === 'supervisor') return true;
  if (agent.role === 'gm') return app === 'ceres' || app === 'minerva' || app === 'juno' || app === 'apollo';
  return (agent.apps ?? []).includes(app);
}

// ── Domain types ────────────────────────────────────────────────────────
export interface MercuryItem {
  id: string;
  displayName: string;
  isSecret: boolean;
  vestaSku: string | null;
  active: boolean;
  createdAt: string;
}

export type RequestStatus = 'pending' | 'ordered' | 'received' | 'cancelled';

export interface MercuryRequest {
  id: string;
  itemId: string;
  qty: string;
  requestedById: string | null;
  note: string;
  status: RequestStatus;
  createdAt: string;
  orderedAt: string | null;
  receivedAt: string | null;
  item: MercuryItem | null; // joined for the board
}

// A low-stock product from Vesta's feed (the reorder queue). mercuryItemId is set if an
// active MercuryItem already tracks this SKU.
export interface ReorderRow {
  sku: string;
  nameEn: string;
  nameTh: string;
  photoSku: string | null;
  stock: number | null;
  reorderPoint: number | null;
  mercuryItemId: string | null;
}

// ── Session ─────────────────────────────────────────────────────────────
const TOKEN_KEY = 'mercury_token';
const AGENT_KEY = 'mercury_agent';

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
    credentials: 'include',
  });
  if (!res.ok) throw new Error('invalid_credentials');
  return res.json() as Promise<{ token: string; agent: Agent }>;
}

export async function bootstrap(): Promise<Agent | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/me`, { credentials: 'include' });
    if (!res.ok) return null;
    const { agent, token } = await res.json() as { agent: Agent; token: string };
    setSession(token, agent);
    return agent;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {
    // Best-effort server logout; local cleanup must always happen.
  } finally {
    clearSession();
  }
}

export interface LoginCard {
  email: string;
  name: string;
  kind: 'password' | 'pin';
  // DISPLAY metadata for the role-grouped, avatar login screen (additive; server-provided).
  group: string;                 // ceo | gm | agm | sales | finance | messengers | stores | others
  gender: 'male' | 'female';     // drives the cute (DiceBear) avatar
}
// PUBLIC — no auth required. Ordered: supervisor first, then employees granted this app.
export async function getLogins(): Promise<LoginCard[]> {
  const res = await fetch(`${API_URL}/api/auth/logins?app=mercury`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<LoginCard[]>;
}

// ── Reorder queue (Vesta low-stock) ────────────────────────────────────
export const getReorderQueue = () =>
  authed<{ products: ReorderRow[] }>('/api/mercury/reorder-queue');

// ── Items ───────────────────────────────────────────────────────────────
export const getItems = (q = '') =>
  authed<{ items: MercuryItem[] }>(`/api/mercury/items?q=${encodeURIComponent(q)}`);

export const createItem = (input: { displayName: string; vestaSku?: string; isSecret?: boolean }) =>
  authed<{ ok: boolean; item: MercuryItem }>('/api/mercury/items', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const patchItem = (
  id: string,
  input: { displayName?: string; vestaSku?: string | null; active?: boolean },
) =>
  authed<{ ok: boolean; item: MercuryItem }>(`/api/mercury/items/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });

// ── Requests ────────────────────────────────────────────────────────────
export const getRequests = (status?: RequestStatus) =>
  authed<{ requests: MercuryRequest[] }>(
    `/api/mercury/requests${status ? `?status=${status}` : ''}`,
  );

// Create a request from either an existing item (itemId) or a Vesta product ref (vestaSku).
export const createRequest = (input: {
  itemId?: string;
  vestaSku?: string;
  displayName?: string;
  qty?: string;
  note?: string;
}) =>
  authed<{ ok: boolean; request: MercuryRequest }>('/api/mercury/requests', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const setRequestStatus = (id: string, status: RequestStatus) =>
  authed<{ ok: boolean; request: MercuryRequest }>(`/api/mercury/requests/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });

// Goods-receipt (Phase 3, buy→stock loop). Marks the request 'received' and, for ORDINARY items
// (item.vestaSku set), bumps Vesta stock by qty via the shared adjust path. For SECRET items the
// cloud records status only — receive them via local-Mercury (which alone knows the real SKU), so
// this is only called from the UI for ordinary items.
export const receiveRequest = (id: string, qty: number) =>
  authed<{
    ok: boolean;
    request: MercuryRequest;
    stockUpdated: boolean;
    secret: boolean;
    detail?: string;
  }>(`/api/mercury/requests/${id}/receive`, {
    method: 'POST',
    body: JSON.stringify({ qty }),
  });
