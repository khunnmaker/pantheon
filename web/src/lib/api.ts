// Tiny typed API client for the Minerva console. Talks to the Fastify backend;
// never calls the LLM directly (that moves server-side in M2).

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export type Role = 'agent' | 'supervisor';
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
}
export interface Message {
  id: string;
  customerId: string;
  sessionId: string | null;
  role: 'customer' | 'agent';
  text: string;
  agentId: string | null;
  kbIds: string[];
  channelMsgId: string | null;
  createdAt: string;
}
export interface CustomerLite {
  id: string;
  lineUserId: string;
  displayName: string | null;
  firstSeen?: string;
  lastSeen: string;
}
export interface QueueItem {
  customer: CustomerLite;
  lastMessage: Message;
}
export interface CustomerDetail {
  customer: CustomerLite & { firstSeen: string };
  messages: Message[];
  stats: { questions: number; replies: number; lastSeen: string };
}

const TOKEN_KEY = 'minerva_token';
const AGENT_KEY = 'minerva_agent';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function getStoredAgent(): Agent | null {
  const s = localStorage.getItem(AGENT_KEY);
  if (!s) return null;
  try {
    return JSON.parse(s) as Agent;
  } catch {
    // Corrupt/tampered value — clear it so the app falls back to Login instead
    // of throwing during the initial render (blank screen).
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

export const getQueue = () => authed<{ queue: QueueItem[] }>('/api/queue');
export const getCustomers = () => authed<{ customers: CustomerLite[] }>('/api/customers');
export const getCustomer = (id: string) => authed<CustomerDetail>(`/api/customers/${id}`);
