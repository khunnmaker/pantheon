// Tiny typed API client for the Minerva console. Talks to the Fastify backend;
// never calls the LLM directly (that moves server-side in M2).

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Display product codes bare (no dashes) for easy reading/typing — "07-10-09" → "071009".
// Presentation only; the stored key keeps its dashes and search is dash-insensitive.
export const flatSku = (sku: string): string => sku.replace(/-/g, '');

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
  attachmentType: string | null; // image | sticker | video | audio | file | location | product
  attachmentRef: string | null;
  attachmentName: string | null; // original filename for received files
  financeSentAt: string | null; // when a slip was forwarded to finance
  createdAt: string;
}
export interface CustomerLite {
  id: string;
  lineUserId: string;
  displayName: string | null;
  nickname: string | null;
  code: string | null;
  category: string | null;
  stage: string | null;
  suggestedStage: string | null;
  firstSeen?: string;
  lastSeen: string;
}

// Sales-pipeline stages (mirror of api/src/stages.ts). AI suggests, staff confirm.
export const STAGES = ['ถาม', 'สั่งซื้อ', 'ส่ง', 'ดูแล', 'เสร็จ', 'ยกเลิก'];
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
  productSku?: string | null;
  createdAt: string;
}
export interface PendingProduct {
  sku: string;
  nameEn: string;
  nameTh: string;
  price: number;
  photoSku: string | null;
  stock: number | null; // remaining qty from the latest snapshot (null = unknown)
  stockAt: string | null; // ISO date the stock figure is as-of
  reorderPoint?: number | null; // Vulcan low-stock threshold (staff-only)
  low?: boolean; // stock <= reorderPoint (staff-only; never shown to customers)
}
export interface CustomerDetail {
  customer: CustomerLite & { firstSeen: string };
  messages: Message[];
  pendingDraft: Draft | null;
  pendingProduct: PendingProduct | null;
  productCandidates: PendingProduct[];
  crossSellCandidates: PendingProduct[]; // AI cross-sell suggestions
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

export const setNickname = (customerId: string, nickname: string, code?: string) =>
  authed<{ ok: boolean; nickname: string | null; code: string | null }>(`/api/customers/${customerId}/nickname`, {
    method: 'POST',
    body: JSON.stringify({ nickname, code }),
  });

export const setCategory = (customerId: string, category: string) =>
  authed<{ ok: boolean; category: string | null }>(`/api/customers/${customerId}/category`, {
    method: 'POST',
    body: JSON.stringify({ category }),
  });

// Set/clear the sales-pipeline stage (also clears the AI's pending suggestion). '' clears.
export const setStage = (customerId: string, stage: string) =>
  authed<{ ok: boolean; stage: string | null }>(`/api/customers/${customerId}/stage`, {
    method: 'POST',
    body: JSON.stringify({ stage }),
  });

export const regenerateDraft = (messageId: string, suggestSkus?: string[], mainSkus?: string[], agentText?: string) =>
  authed<{ draft: Draft }>(`/api/messages/${messageId}/draft`, {
    method: 'POST',
    body: JSON.stringify({ suggestSkus, mainSkus, agentText }),
  });

// Manual catalog search by NAME or SKU — for the "add product yourself" picker.
export const searchCatalog = (q: string) =>
  authed<{ products: PendingProduct[] }>(`/api/catalog/search?q=${encodeURIComponent(q)}`);

// Add a searched product to the draft as a main candidate or cross-sell (+ learns the link).
export const addProductToDraft = (messageId: string, sku: string, role: 'main' | 'cross') =>
  authed<{ ok: boolean; sku: string; role: string }>(`/api/messages/${messageId}/add-product`, {
    method: 'POST',
    body: JSON.stringify({ sku, role }),
  });

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
  attachProductSkus?: string[],
  uploadId?: string,
): Promise<ReplyResult | { needsConfirm: true }> {
  const token = getToken();
  const res = await fetch(`${API_URL}/api/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ finalText, confirmNumbers, attachProductSkus, uploadId }),
  });
  if (res.status === 409) return { needsConfirm: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<ReplyResult>;
}

export interface UploadResult {
  uploadId: string;
  kind: 'image' | 'file';
  fileName: string;
}
// Upload a staff photo/file (base64) to attach to a reply → returns an uploadId.
export const uploadAttachment = (dataB64: string, fileName: string, contentType: string) =>
  authed<UploadResult>('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ dataB64, fileName, contentType }),
  });

export const endSession = (customerId: string) =>
  authed<{ ok: boolean; summary: string | null }>(`/api/customers/${customerId}/end-session`, { method: 'POST' });

export interface QuickReply {
  id: string;
  label: string;
  body: string;
  sortOrder: number;
  createdAt: string;
}
export const getQuickReplies = () => authed<{ items: QuickReply[] }>('/api/quick-replies');
export const addQuickReply = (label: string, body: string) =>
  authed<{ item: QuickReply }>('/api/quick-replies', { method: 'POST', body: JSON.stringify({ label, body }) });
export const deleteQuickReply = (id: string) =>
  authed<{ ok: boolean }>(`/api/quick-replies/${id}`, { method: 'DELETE' });
// Send a quick-reply template to the customer as a standalone message (does not
// touch the pending question or the draft composer).
export const sendQuickReply = (customerId: string, quickReplyId: string) =>
  authed<{ ok: boolean; message: Message; dryRun: boolean }>(`/api/customers/${customerId}/quick-reply`, {
    method: 'POST',
    body: JSON.stringify({ quickReplyId }),
  });

// Send a staff photo to the customer IMMEDIATELY (camera) — standalone image message.
export const sendPhotoNow = (customerId: string, uploadId: string) =>
  authed<{ ok: boolean; message: Message; dryRun: boolean }>(`/api/customers/${customerId}/photo`, {
    method: 'POST',
    body: JSON.stringify({ uploadId }),
  });

// Send a free-form message to the customer (correction/addition after answering).
// Optional uploadId attaches a staff photo/file to that standalone message.
export async function sendMessage(
  customerId: string,
  text: string,
  uploadId?: string,
): Promise<{ message: Message; dryRun: boolean }> {
  const token = getToken();
  const res = await fetch(`${API_URL}/api/customers/${customerId}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ text, uploadId }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ message: Message; dryRun: boolean }>;
}

export interface SlipReadResult { nickname: string; realName: string; amount: string; bank: string; transferAt: string; ref: string }
// OCR a customer's payment slip → pre-fill fields (best-effort; blanks if no LLM credits).
export const readSlip = (messageId: string) =>
  authed<SlipReadResult>(`/api/messages/${messageId}/read-slip`, { method: 'POST' });

// Forward the confirmed slip details to the finance Google Sheet + mark it sent.
export async function sendToFinance(
  messageId: string,
  fields: { amount: string; bank: string; transferAt: string; ref: string; nickname: string; realName: string; taxInvoice?: string; note?: string },
): Promise<{ ok: boolean; error?: string; financeSentAt?: string; corrected?: boolean }> {
  const token = getToken();
  const res = await fetch(`${API_URL}/api/messages/${messageId}/to-finance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
    return { ok: false, error: e.detail || e.error || `HTTP ${res.status}` };
  }
  return res.json() as Promise<{ ok: boolean; financeSentAt?: string }>;
}

export interface FinanceAudit {
  id: string;
  messageId: string;
  customerId: string;
  nickname: string;
  senderName: string;
  ocrAmount: string;
  amount: string;
  diff: string;
  salesName: string;
  resolvedAt: string | null;
  createdAt: string;
  slipUrl: string;
}
// Supervisor-only: corrected-amount audit log + resolve.
export const getFinanceAudits = (status = 'open') =>
  authed<{ audits: FinanceAudit[] }>(`/api/finance/audits?status=${encodeURIComponent(status)}`);
export const resolveFinanceAudit = (id: string) =>
  authed<{ ok: boolean }>(`/api/finance/audits/${id}/resolve`, { method: 'POST' });

export const getLearned = (status = 'pending') =>
  authed<{ learned: LearnedAnswer[] }>(`/api/learned?status=${status}`);
export const promoteLearned = (id: string) =>
  authed<{ ok: boolean; kb?: { answer: string } | null; skipped?: boolean; reason?: string }>(
    `/api/learned/${id}/promote`,
    { method: 'POST' },
  );
export const rejectLearned = (id: string) =>
  authed<{ ok: boolean }>(`/api/learned/${id}/reject`, { method: 'POST' });

// AI-accuracy metrics (supervisor only) — Stage-1 learning dashboard.
export interface MetricsBucket {
  accepted: number;
  edited: number;
  escalated: number;
  total: number;
  acceptRate: number | null; // accepted / (accepted + edited); null when none attempted
}
export interface LearnedMetrics {
  overall: MetricsBucket;
  byCategory: (MetricsBucket & { category: string })[];
  byWeek: (MetricsBucket & { week: string })[];
}
export const getLearnedMetrics = () => authed<LearnedMetrics>('/api/learned/metrics');
