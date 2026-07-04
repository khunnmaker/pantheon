// Typed API client for the Jupiter portal. Talks to the shared Minerva Fastify backend:
//   POST /api/auth/login       — the suite's single login (Phase 1: localStorage-JWT, no SSO)
//   GET  /api/jupiter/badges   — pending-work counts, gated to the apps this role can enter
// Phase 1 reuses today's auth exactly; SSO (cookies, /api/auth/me bootstrap) is Phase 3.

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Mirrors the backend's Role vocabulary (api/src/auth/jwt.ts). messenger + md are the
// Ceres-facing roles; a supervisor is the CEO/owner. Every role that can enter at least
// one app must appear here (and in apps.ts ORDER) or the portal shows them no tiles.
export type Role = 'agent' | 'supervisor' | 'messenger' | 'md';
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
}

// The badges payload: a key per app the CALLER may enter (the server never returns a key
// for an app this role can't open). Each value is optional so a missing app is just absent.
export interface Badges {
  minerva?: { pending: number };
  juno?: { toVerify: number };
  vulcan?: { lowStock: number };
  ceres?: { awaitingAction: number };
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
  });
  if (!res.ok) throw new Error('invalid_credentials');
  return res.json() as Promise<{ token: string; agent: Agent }>;
}

export async function getBadges(): Promise<Badges> {
  const token = getToken();
  const res = await fetch(`${API_URL}/api/jupiter/badges`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    clearSession();
    onUnauthorized?.();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Badges>;
}
