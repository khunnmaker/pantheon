import { fetchWithSessionRenewal, renewSuiteSessionOnce, type AppName } from '@pantheon/ui';
import type {
  Agent, GoalInput, GoalPatchInput, HabitInput, HabitPatchInput, HestiaCheckIn,
  HestiaCheckInDeleteResult, HestiaCheckInPutResult, HestiaGoal, HestiaHabit, HestiaHabitWithGoal,
  HestiaJournalEntry, HestiaJournalPage, HestiaOverview, JournalInput, JournalPatchInput,
} from '../types';
export type { AppName };

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
const TOKEN_KEY = 'olympus_token';
const AGENT_KEY = 'olympus_agent';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function getStoredAgent(): Agent | null { const value = localStorage.getItem(AGENT_KEY); if (!value) return null; try { return JSON.parse(value) as Agent; } catch { clearSession(); return null; } }
export function setSession(token: string, agent: Agent) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(AGENT_KEY, JSON.stringify(agent)); }
export function clearSession() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(AGENT_KEY); }

// UX-only convenience — the API's own requireRole('supervisor') hook (applied to the whole
// hestia plugin) is the authoritative gate and never consults this or Agent.apps.
export function isSupervisor(agent: Agent): boolean { return agent.role === 'supervisor'; }

async function authed<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithSessionRenewal<Agent>(`${API_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } }, { apiUrl: API_URL, getToken, setSession });
  if (res.status === 401) { clearSession(); location.reload(); throw new Error('unauthorized'); }
  const body = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function login(email: string, password: string) { const res = await fetch(`${API_URL}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), credentials: 'include' }); if (!res.ok) throw new Error('invalid_credentials'); return res.json() as Promise<{ token: string; agent: Agent }>; }
export async function bootstrap(): Promise<Agent | null> { try { const session = await renewSuiteSessionOnce<Agent>(API_URL); if (!session) return null; setSession(session.token, session.agent); return session.agent; } catch { return null; } }
export async function logout() { const token = getToken(); try { await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include', headers: token ? { authorization: `Bearer ${token}` } : {} }); } catch { /* best effort */ } clearSession(); }
export async function getLogins() { const res = await fetch(`${API_URL}/api/auth/logins?app=olympus`); if (!res.ok) throw new Error('load_failed'); return res.json() as Promise<{ email: string; name: string; kind: 'password' | 'pin'; group: string; gender: 'male' | 'female' }[]>; }

// ---- Hestia ----------------------------------------------------------------------------------

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
  const value = search.toString();
  return value ? `?${value}` : '';
}

export const getOverview = (date?: string, year?: number) => authed<HestiaOverview>(`/api/hestia/overview${qs({ date, year })}`);

export const getGoals = (year: number, includeArchived = false) => authed<HestiaGoal[]>(`/api/hestia/goals${qs({ year, includeArchived: includeArchived ? '1' : '0' })}`);
export const createGoal = (body: GoalInput) => authed<HestiaGoal>('/api/hestia/goals', { method: 'POST', body: JSON.stringify(body) });
export const updateGoal = (id: string, body: GoalPatchInput) => authed<HestiaGoal>(`/api/hestia/goals/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

export const getHabits = (params: { goalId?: string; active?: boolean } = {}) => authed<HestiaHabitWithGoal[]>(`/api/hestia/habits${qs({ goalId: params.goalId, active: params.active === undefined ? undefined : (params.active ? '1' : '0') })}`);
export const createHabit = (body: HabitInput) => authed<HestiaHabit>('/api/hestia/habits', { method: 'POST', body: JSON.stringify(body) });
export const updateHabit = (id: string, body: HabitPatchInput) => authed<HestiaHabit>(`/api/hestia/habits/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

export const getCheckIns = (from: string, to: string, habitId?: string) => authed<HestiaCheckIn[]>(`/api/hestia/check-ins${qs({ from, to, habitId })}`);
export const putCheckIn = (habitId: string, date: string, body: { count: number; note?: string }) => authed<HestiaCheckInPutResult>(`/api/hestia/habits/${habitId}/check-ins/${date}`, { method: 'PUT', body: JSON.stringify(body) });
export const deleteCheckIn = (habitId: string, date: string) => authed<HestiaCheckInDeleteResult>(`/api/hestia/habits/${habitId}/check-ins/${date}`, { method: 'DELETE' });

export const getJournal = (params: { from?: string; to?: string; cursor?: string; limit?: number } = {}) => authed<HestiaJournalPage>(`/api/hestia/journal${qs(params)}`);
export const getJournalEntry = (id: string) => authed<HestiaJournalEntry>(`/api/hestia/journal/${id}`);
export const createJournalEntry = (body: JournalInput) => authed<HestiaJournalEntry>('/api/hestia/journal', { method: 'POST', body: JSON.stringify(body) });
export const updateJournalEntry = (id: string, body: JournalPatchInput) => authed<HestiaJournalEntry>(`/api/hestia/journal/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deleteJournalEntry = (id: string) => authed<{ ok: true }>(`/api/hestia/journal/${id}`, { method: 'DELETE' });
