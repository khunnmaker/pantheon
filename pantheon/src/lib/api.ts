import { fetchWithSessionRenewal, renewSuiteSessionOnce, type AppName } from '@pantheon/ui';
export type { AppName };

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export type Role = 'supervisor' | 'gm' | 'agm' | 'employee';
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
  apps: string[];
}
export interface LoginCard {
  email: string;
  name: string;
  kind: 'password' | 'pin';
  group: string;
  gender: 'male' | 'female';
}
export interface Badges {
  minerva?: { pending: number };
  juno?: { toVerify: number };
  vesta?: { lowStock: number };
  ceres?: { awaitingAction: number };
  mercury?: { pending: number };
}

const TOKEN_KEY = 'pantheon_token';
const AGENT_KEY = 'pantheon_agent';

export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export function getStoredAgent(): Agent | null {
  const stored = localStorage.getItem(AGENT_KEY);
  if (!stored) return null;
  try { return JSON.parse(stored) as Agent; } catch { clearSession(); return null; }
}
export function setSession(token: string, agent: Agent): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(AGENT_KEY, JSON.stringify(agent));
}
export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(AGENT_KEY);
}

let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: (() => void) | null): void { onUnauthorized = fn; }

export function hasAppAccess(agent: Agent, app: AppName): boolean {
  if (agent.role === 'supervisor') return true;
  if (agent.role === 'gm') return app === 'ceres' || app === 'minerva' || app === 'juno' || app === 'apollo';
  return (agent.apps ?? []).includes(app);
}

export async function login(email: string, password: string): Promise<{ token: string; agent: Agent }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }), credentials: 'include',
  });
  if (!res.ok) throw new Error('invalid_credentials');
  return res.json() as Promise<{ token: string; agent: Agent }>;
}
export async function bootstrap(): Promise<Agent | null> {
  try {
    const session = await renewSuiteSessionOnce<Agent>(API_URL);
    if (!session) return null;
    setSession(session.token, session.agent);
    return session.agent;
  } catch { return null; }
}
export async function logout(): Promise<void> {
  const token = getToken();
  try {
    await fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST', credentials: 'include', headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch { /* best effort */ }
  clearSession();
}
export async function getBadges(): Promise<Badges> {
  const res = await fetchWithSessionRenewal<Agent>(
    `${API_URL}/api/pantheon/badges`,
    undefined,
    { apiUrl: API_URL, getToken, setSession },
  );
  if (res.status === 401) { clearSession(); onUnauthorized?.(); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Badges>;
}
