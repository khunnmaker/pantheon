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
  attachmentType: string | null; // image | sticker | video | audio | file | location
  attachmentRef: string | null;
  createdAt: string;
}
export interface CustomerLite {
  id: string;
  lineUserId: string;
  displayName: string | null;
  nickname: string | null;
  firstSeen?: string;
  lastSeen: string;
}
export interface QueueItem {
  customer: CustomerLite;
  lastMessage: Message;
}
export type DraftType = 'draft' | 'needs_human' | 'out_of_scope';
export interface Draft {
  id: string;
  messageId: string;
  type: DraftType;
  draftText: string;
  usedKb: string[];
  note: string | null;
  createdAt: string;
}
export interface CustomerDetail {
  customer: CustomerLite & { firstSeen: string };
  messages: Message[];
  pendingDraft: Draft | null;
  pendingMessageId: string | null;
  memory: { summary: string; updatedAt: string } | null;
  stats: { questions: number; replies: number; lastSeen: string };
}
export interface LearnedAnswer {
  id: string;
  customerQuestion: string;
  aiDraft: string;
  finalAnswer: string;
  agentId: string;
  status: 'pending' | 'approved' | 'rejected';
  promotedKbId: string | null;
  createdAt: string;
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

export const searchCustomers = (q: string) =>
  authed<{ customers: CustomerLite[] }>(`/api/customers/search?q=${encodeURIComponent(q)}`);

export const setNickname = (customerId: string, nickname: string) =>
  authed<{ ok: boolean; nickname: string | null }>(`/api/customers/${customerId}/nickname`, {
    method: 'POST',
    body: JSON.stringify({ nickname }),
  });

export const regenerateDraft = (messageId: string) =>
  authed<{ draft: Draft }>(`/api/messages/${messageId}/draft`, { method: 'POST' });

// Polish an agent's drafted reply (grammar/wording) without changing meaning/numbers.
export const rewriteText = (text: string) =>
  authed<{ text: string; note: string | null }>('/api/rewrite', { method: 'POST', body: JSON.stringify({ text }) });

export interface ReplyResult {
  ok: boolean;
  sent: boolean;
  dryRun: boolean;
  learnedCaptured: boolean;
}
// Returns { needsConfirm: true } when the reply has numbers and confirm wasn't set.
export async function sendReply(
  messageId: string,
  finalText: string,
  confirmNumbers?: boolean,
): Promise<ReplyResult | { needsConfirm: true }> {
  const token = getToken();
  const res = await fetch(`${API_URL}/api/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ finalText, confirmNumbers }),
  });
  if (res.status === 409) return { needsConfirm: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<ReplyResult>;
}

export const endSession = (customerId: string) =>
  authed<{ ok: boolean; summary: string | null }>(`/api/customers/${customerId}/end-session`, { method: 'POST' });

export const getLearned = (status = 'pending') =>
  authed<{ learned: LearnedAnswer[] }>(`/api/learned?status=${status}`);
export const promoteLearned = (id: string) =>
  authed<{ ok: boolean }>(`/api/learned/${id}/promote`, { method: 'POST' });
export const rejectLearned = (id: string) =>
  authed<{ ok: boolean }>(`/api/learned/${id}/reject`, { method: 'POST' });
