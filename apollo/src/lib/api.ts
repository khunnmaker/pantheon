import type { AppName } from '@pantheon/ui';
import type { Agent, ApolloEvent, Attachment, CalendarEvent, CalendarTask, Comment, EventInput, Person, Project, Task, TaskInput } from '../types';
export type { AppName };

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
const TOKEN_KEY = 'apollo_token';
const AGENT_KEY = 'apollo_agent';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
export function getStoredAgent(): Agent | null { const value = localStorage.getItem(AGENT_KEY); if (!value) return null; try { return JSON.parse(value) as Agent; } catch { clearSession(); return null; } }
export function setSession(token: string, agent: Agent) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(AGENT_KEY, JSON.stringify(agent)); }
export function clearSession() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(AGENT_KEY); }
export function hasAppAccess(agent: Agent, app: AppName) { if (agent.role === 'supervisor') return true; if (agent.role === 'gm') return ['ceres', 'minerva', 'juno', 'apollo'].includes(app); return (agent.apps ?? []).includes(app); }

async function authed<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) } });
  if (res.status === 401) { clearSession(); location.reload(); throw new Error('unauthorized'); }
  const body = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function login(email: string, password: string) { const res = await fetch(`${API_URL}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), credentials: 'include' }); if (!res.ok) throw new Error('invalid_credentials'); return res.json() as Promise<{ token: string; agent: Agent }>; }
export async function bootstrap(): Promise<Agent | null> { try { const res = await fetch(`${API_URL}/api/auth/me`, { credentials: 'include' }); if (!res.ok) return null; const out = await res.json() as { token: string; agent: Agent }; setSession(out.token, out.agent); return out.agent; } catch { return null; } }
export async function logout() { try { await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' }); } catch { /* best effort */ } clearSession(); }
export async function getLogins() { const res = await fetch(`${API_URL}/api/auth/logins?app=apollo`); if (!res.ok) throw new Error('load_failed'); return res.json() as Promise<{ email: string; name: string; kind: 'password' | 'pin'; group: string; gender: 'male' | 'female' }[]>; }

export const getAgents = () => authed<{ agents: Person[] }>('/api/apollo/agents');
export const getProjects = () => authed<{ projects: Project[] }>('/api/apollo/projects');
export const getProject = (id: string) => authed<Project>(`/api/apollo/projects/${id}`);
export const createProject = (body: { name: string; color?: string; memberIds?: string[] }) => authed<Project>('/api/apollo/projects', { method: 'POST', body: JSON.stringify(body) });
export const updateProject = (id: string, body: Partial<Pick<Project, 'name' | 'color' | 'archived'>>) => authed<Project>(`/api/apollo/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const updateColumns = (id: string, columns: string[], renames: Record<string, string>) => authed(`/api/apollo/projects/${id}/columns`, { method: 'PUT', body: JSON.stringify({ columns, renames }) });
export const updateMembers = (id: string, memberIds: string[]) => authed(`/api/apollo/projects/${id}/members`, { method: 'PUT', body: JSON.stringify({ memberIds }) });
export const getTask = (id: string) => authed<Task>(`/api/apollo/tasks/${id}`);
export const createTask = (body: TaskInput & { projectId: string }) => authed<Task>('/api/apollo/tasks', { method: 'POST', body: JSON.stringify(body) });
export const updateTask = (id: string, body: Partial<TaskInput>) => authed<Task>(`/api/apollo/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deleteTask = (id: string) => authed(`/api/apollo/tasks/${id}`, { method: 'DELETE' });
export const moveTask = (id: string, status: string, orderedTaskIds: string[]) => authed(`/api/apollo/tasks/${id}/move`, { method: 'POST', body: JSON.stringify({ status, orderedTaskIds }) });
export const completeTask = (id: string) => authed<{ task: Task; nextTask: Task | null }>(`/api/apollo/tasks/${id}/complete`, { method: 'POST' });
export const addComment = (id: string, body: string) => authed<Comment>(`/api/apollo/tasks/${id}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
export const deleteComment = (id: string) => authed(`/api/apollo/comments/${id}`, { method: 'DELETE' });
export const uploadAttachment = (id: string, body: { dataB64: string; fileName: string; contentType: string }) => authed<Attachment>(`/api/apollo/tasks/${id}/attachments`, { method: 'POST', body: JSON.stringify(body) });
export const deleteAttachment = (id: string) => authed(`/api/apollo/attachments/${id}`, { method: 'DELETE' });
export async function downloadAttachment(a: Attachment) { const res = await fetch(`${API_URL}/api/apollo/attachments/${a.id}/content`, { headers: { authorization: `Bearer ${getToken()}` } }); if (!res.ok) throw new Error('download_failed'); const url = URL.createObjectURL(await res.blob()); const link = document.createElement('a'); link.href = url; link.download = a.fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export const getMyTasks = () => authed<{ overdue: Task[]; today: Task[]; upcoming: Task[] }>('/api/apollo/my-tasks');
export const getCalendar = (from: string, to: string, assignee?: string) => authed<{ tasks: CalendarTask[]; events: CalendarEvent[] }>(`/api/apollo/calendar?${new URLSearchParams({ from, to, ...(assignee ? { assignee } : {}) }).toString()}`);
export const addEvent = (body: EventInput) => authed<ApolloEvent>('/api/apollo/events', { method: 'POST', body: JSON.stringify(body) });
export const updateEvent = (id: string, body: EventInput) => authed<ApolloEvent>(`/api/apollo/events/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const deleteEvent = (id: string) => authed(`/api/apollo/events/${id}`, { method: 'DELETE' });
export const getDashboard = () => authed<{ people: (Person & { open: number; overdue: number })[]; projects: (Pick<Project, 'id' | 'name' | 'color' | 'columns'> & { statuses: Record<string, number> })[] }>('/api/apollo/dashboard');
export const getLineBind = () => authed<{ bound: boolean; code: string | null }>('/api/apollo/line-bind');
export const generateLineBind = () => authed<{ bound: boolean; code: string }>('/api/apollo/line-bind', { method: 'POST' });
export function fileToBase64(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }
