// Typed API client for the Ceres petty-cash UI. Talks to the SHARED Minerva Fastify
// backend (the /api/ceres/* routes — see api/src/routes/ceres/p1.ts, common.ts, index.ts).
// Raw auth roles: 'supervisor' | 'gm' | 'agm' | 'employee'. GET /api/ceres/bootstrap
// normalizes that into the Ceres vocabulary 'messenger' | 'gm' | 'ceo'
// ('agm'/'employee' -> 'messenger', 'supervisor' -> 'ceo') — always trust the bootstrap role
// for UI routing/branching, never the raw login role.

import { fetchWithSessionRenewal, renewSuiteSessionOnce } from '@pantheon/ui';

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Raw Agent-table role as returned by POST /api/auth/login.
export type Role = 'supervisor' | 'gm' | 'agm' | 'employee';
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
}

const TOKEN_KEY = 'ceres_token';
const AGENT_KEY = 'ceres_agent';

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

// Thrown by authed() on a non-2xx response. Carries the parsed JSON error body (when
// the response was JSON) so call sites that need to branch on {error, ...} — e.g.
// POST /close's 409 {error:'already_closed_today'} / {error:'pending_exist', pendingCount}
// — don't have to re-fetch or guess. Falls back to `null` body for non-JSON responses.
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function authed<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithSessionRenewal<Agent>(
    `${API_URL}${path}`,
    { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } },
    { apiUrl: API_URL, getToken, setSession },
  );
  if (res.status === 401) {
    clearSession();
    onUnauthorized?.();
    throw new ApiError('unauthorized', 401, null);
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const code = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new ApiError(code, res.status, body);
  }
  return res.json() as Promise<T>;
}

export async function login(email: string, password: string): Promise<{ token: string; agent: Agent }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
    // Suite SSO: let the browser STORE the parent-domain httpOnly cookie the server sets
    // on this response. Only login/bootstrap/logout use credentials — never state-changing calls.
    credentials: 'include',
  });
  if (!res.ok) throw new ApiError('invalid_credentials', res.status, null);
  return res.json() as Promise<{ token: string; agent: Agent }>;
}

// Suite SSO bootstrap: with NO stored token, ask /me using ONLY the shared parent-domain
// cookie (credentials:'include', no Authorization header). If the cookie authenticates,
// the server returns a fresh bearer token + agent; we store the session and return the agent.
// Never throws — a missing/invalid cookie just yields null (→ show Login).
export async function bootstrap(): Promise<Agent | null> {
  try {
    const session = await renewSuiteSessionOnce<Agent>(API_URL);
    if (!session) return null;
    setSession(session.token, session.agent);
    return session.agent;
  } catch {
    return null;
  }
}

// Suite-wide logout: clear the shared cookie server-side (best-effort), THEN clear this
// app's local session. Used by the user-facing "log out" action so logging out here
// propagates across the suite.
export async function logout(): Promise<void> {
  const token = getToken();
  try {
    await fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch {
    // Network failure clearing the cookie shouldn't block local logout.
  }
  clearSession();
}

function queryString(q: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface Category {
  id: string;
  name: string;
  kind: string;
  ceiling: number | null;
  needsCustomerNote: boolean;
  active: boolean;
  sortOrder: number;
}
export interface Party {
  id: string;
  name: string;
  kind: string;
  agentEmail: string | null;
  active: boolean;
  sortOrder: number;
}
export interface Bootstrap {
  role: 'messenger' | 'gm' | 'ceo';
  agent: { id: string; name: string };
  party: { id: string; name: string } | null;
  categories: Category[];
  parties: Party[];
  entities: string[]; // ['PROM','DENL']
  floor: number;
  ceoThreshold: number;
}
export const getBootstrap = () => authed<Bootstrap>('/api/ceres/bootstrap');

export interface LoginName {
  email: string;
  name: string;
  kind: 'password' | 'pin';
  // DISPLAY metadata for the role-grouped, avatar login screen (additive; server-provided).
  group: string;                 // ceo | gm | agm | sales | finance | messengers | stores | others
  gender: 'male' | 'female';     // drives the cute (DiceBear) avatar
}
// PUBLIC — no auth required. Ordered: supervisor, GM, AGM, then other employee cards.
export const getLogins = () => fetch(`${API_URL}/api/ceres/logins`).then((r) => r.json() as Promise<LoginName[]>);

export interface OcrResult {
  amount: string;
  vendor: string;
  dateText: string;
}
// Backend flags a receipt photo that hash-matches one already used on another expense.
// Surfaced as a non-blocking warning in ExpenseSheet and, via Expense.duplicateReceipt,
// as a badge in the GM/CEO review screens (MdApproval/MdExpenses).
export interface DuplicateReceipt {
  partyName: string;
  amount: string;
  spentAt: string;
}
export const uploadReceipt = (dataB64: string, contentType: string) =>
  authed<{ uploadId: string; url: string; ocr: OcrResult; duplicate: DuplicateReceipt | null }>('/api/ceres/receipts', {
    method: 'POST',
    body: JSON.stringify({ dataB64, contentType }),
  });

export type ExpenseStatus = 'pending' | 'approved' | 'settled' | 'rejected' | 'void';
export interface Expense {
  id: string;
  partyId: string | null;
  partyName: string;
  enteredById: string | null;
  enteredByName: string;
  entity: string;
  category: string;
  customerNote: string;
  amount: string;
  amountNum: number;
  spentAt: string;
  receiptUploadId: string | null;
  receiptUrl: string | null;
  ocrAmount: string;
  ocrVendor: string;
  ocrDate: string;
  duplicateReceipt: boolean;
  status: ExpenseStatus;
  approvedById: string | null;
  approvedAt: string | null;
  rejectReason: string;
  voidedById: string | null;
  voidedAt: string | null;
  voidReason: string;
  settlementId: string | null;
  aiVerdict: string;
  note: string;
  createdAt: string;
}

export const createExpense = (body: {
  entity: string;
  category: string;
  customerNote?: string;
  amount: string;
  receiptUploadId?: string;
  note?: string;
  partyId?: string;
}) => authed<{ expense: Expense }>('/api/ceres/expenses', { method: 'POST', body: JSON.stringify(body) });

export const listExpenses = (q: {
  scope?: 'mine' | 'all';
  status?: ExpenseStatus;
  from?: string;
  to?: string;
  partyId?: string;
}) => authed<{ expenses: Expense[] }>(`/api/ceres/expenses${queryString(q)}`);

export const updateExpense = (
  id: string,
  body: Partial<{
    entity: string;
    category: string;
    customerNote: string;
    amount: string;
    receiptUploadId: string;
    note: string;
    reason: string;
  }>,
) => authed<{ expense: Expense }>(`/api/ceres/expenses/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

export const deleteExpense = (id: string) => authed<{ ok: boolean }>(`/api/ceres/expenses/${id}`, { method: 'DELETE' });
export const voidExpense = (id: string, reason: string) =>
  authed<{ expense: Expense }>(`/api/ceres/expenses/${id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
export const approveExpense = (id: string) => authed<{ expense: Expense }>(`/api/ceres/expenses/${id}/approve`, { method: 'POST' });
export const rejectExpense = (id: string, reason: string) =>
  authed<{ expense: Expense }>(`/api/ceres/expenses/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });

export interface Movement {
  id: string;
  accountId: string;
  type: string;
  partyId: string | null;
  partyName: string | null;
  entity: string;
  amount: string;
  note: string;
  createdById: string;
  createdByName: string;
  createdAt: string;
}

export const createAdvance = (body: { partyId: string; amount: string; entity?: string; note?: string }) =>
  authed<{ movement: Movement }>('/api/ceres/advances', { method: 'POST', body: JSON.stringify(body) });
export const createRefund = (body: { partyId: string; amount: string; note?: string }) =>
  authed<{ movement: Movement }>('/api/ceres/refunds', { method: 'POST', body: JSON.stringify(body) });
export const createMovement = (body: { type: 'deposit' | 'topup'; amount: string; note?: string }) =>
  authed<{ movement: Movement }>('/api/ceres/movements', { method: 'POST', body: JSON.stringify(body) });

export const listMovements = (q: { from?: string; to?: string; type?: string }) =>
  authed<{ movements: Movement[] }>(`/api/ceres/movements${queryString(q)}`);

export interface PartyBoard {
  partyId: string;
  partyName: string;
  active: boolean;
  outstandingBefore: number;
  advancesSince: number;
  refundsSince: number;
  approvedSince: number;
  pendingCount: number;
  pendingSum: number;
  expectedChange: number;
}
export interface Board {
  dayKey: string;
  box: { balance: number; floor: number; belowFloor: boolean; suggestedTopup: number };
  sinceSettlementId: string | null;
  parties: PartyBoard[];
}
export const getBoard = () => authed<Board>('/api/ceres/board');

// closeDay surfaces its 409 body via ApiError.body (see authed()'s error handling above)
// so callers can branch on {error:'already_closed_today'} vs {error:'pending_exist', pendingCount}.
export const closeDay = (note?: string) =>
  authed<{ settlement: Settlement }>('/api/ceres/close', { method: 'POST', body: JSON.stringify({ note }) });

export interface SettlementLine {
  partyName: string;
  advances: string;
  expenses: string;
  refunds: string;
  outstanding: string;
}
export interface Settlement {
  id: string;
  dayKey: string;
  closedByName: string;
  boxBefore: string;
  boxAfter: string;
  note: string;
  createdAt: string;
  lines: SettlementLine[];
}
export const listSettlements = (limit?: number) =>
  authed<{ settlements: Settlement[] }>(`/api/ceres/settlements${limit ? `?limit=${limit}` : ''}`);

// ---------------------------------------------------------------------------
// P2/P3 — payment requests + recurring templates
// ---------------------------------------------------------------------------

export type RequestStatus =
  | 'requested'
  | 'ai_approved'
  | 'escalated'
  | 'ceo_approved'
  | 'rejected'
  | 'cancelled'
  | 'paid';

export interface AIReviewBrief {
  verdict: string;
  reasoning: string;
  createdAt: string;
}

export interface PaymentRequest {
  id: string;
  requestedById: string;
  requestedByName: string;
  entity: string;
  payee: string;
  category: string;
  amount: string;
  amountNum: number;
  detail: string;
  recurringTemplateId: string | null;
  billPeriod: string;
  status: RequestStatus;
  aiReviewId: string | null;
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string;
  paidById: string | null;
  paidAt: string | null;
  paidRef: string;
  createdAt: string;
  aiReview: AIReviewBrief | null;
}

export const createRequest = (body: {
  entity: string;
  payee: string;
  category: string;
  amount: string;
  detail?: string;
  recurringTemplateId?: string;
  billPeriod?: string;
}) => authed<{ request: PaymentRequest }>('/api/ceres/requests', { method: 'POST', body: JSON.stringify(body) });

export const listRequests = (q: { status?: RequestStatus; from?: string; to?: string; q?: string; limit?: number }) =>
  authed<{ requests: PaymentRequest[] }>(`/api/ceres/requests${queryString(q)}`);

export const decideRequest = (id: string, decision: 'approve' | 'reject', note?: string) =>
  authed<{ request: PaymentRequest }>(`/api/ceres/requests/${id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision, note }),
  });

export const markRequestPaid = (id: string, paidRef?: string) =>
  authed<{ request: PaymentRequest }>(`/api/ceres/requests/${id}/paid`, {
    method: 'POST',
    body: JSON.stringify({ paidRef }),
  });

export const cancelRequest = (id: string) =>
  authed<{ request: PaymentRequest }>(`/api/ceres/requests/${id}/cancel`, { method: 'POST' });

export type TemplatePeriod = 'monthly' | 'quarterly' | 'yearly';

export interface RecurringTemplate {
  id: string;
  payee: string;
  entity: string;
  category: string;
  expectedAmount: string;
  tolerancePct: number;
  period: TemplatePeriod;
  dueDay: number;
  graceDays: number;
  active: boolean;
  note: string;
  createdAt: string;
}

export const listTemplates = () => authed<{ templates: RecurringTemplate[] }>('/api/ceres/templates');

export const createTemplate = (body: {
  payee: string;
  entity: string;
  category: string;
  expectedAmount: string;
  tolerancePct: number;
  period: TemplatePeriod;
  dueDay: number;
  graceDays: number;
  active?: boolean;
  note?: string;
}) => authed<{ template: RecurringTemplate }>('/api/ceres/templates', { method: 'POST', body: JSON.stringify(body) });

export const updateTemplate = (
  id: string,
  body: Partial<{
    payee: string;
    entity: string;
    category: string;
    expectedAmount: string;
    tolerancePct: number;
    period: TemplatePeriod;
    dueDay: number;
    graceDays: number;
    active: boolean;
    note: string;
  }>,
) => authed<{ template: RecurringTemplate }>(`/api/ceres/templates/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

export type DueState = 'paid' | 'pending' | 'missing' | 'overdue';
export interface TemplateDue {
  template: RecurringTemplate;
  periodKey: string;
  dueDate: string;
  state: DueState;
}
export const listTemplatesDue = () => authed<{ due: TemplateDue[] }>('/api/ceres/templates/due');

// ---------------------------------------------------------------------------
// P4 — CEO nightly overview + revisions
// ---------------------------------------------------------------------------

export interface AIReviewRow {
  id: string;
  subjectType: 'expense' | 'paymentRequest';
  subjectId: string;
  verdict: string;
  reasoning: string;
  policyVersion: string;
  model: string;
  createdAt: string;
  subject: { partyName?: string; payee?: string; amount: string; category?: string; status?: string } | null;
}

export interface CeoOverview {
  dayKey: string;
  escalations: PaymentRequest[];
  aiReviews: AIReviewRow[];
  flaggedExpenses: Expense[];
  cash: { box: { balance: number; floor: number; belowFloor: boolean; suggestedTopup: number }; outstandingTotal: number };
  missedBills: TemplateDue[];
  settlementToday: Settlement | null;
  requestCounts: Record<string, number>;
}

export const getCeoOverview = (date?: string) => authed<CeoOverview>(`/api/ceres/ceo/overview${queryString({ date })}`);

export interface Revision {
  id: string;
  subjectType: string;
  subjectId: string;
  changedByName: string;
  before: unknown;
  after: unknown;
  reason: string;
  createdAt: string;
}
export const listRevisions = (q: { subjectType?: string; subjectId?: string; limit?: number }) =>
  authed<{ revisions: Revision[] }>(`/api/ceres/revisions${queryString(q)}`);

// ---------------------------------------------------------------------------
// P5 — bank statement import + reconciliation
// ---------------------------------------------------------------------------

export interface StatementPreviewRow {
  txnAt: string;
  amount: string;
  direction: 'in' | 'out';
  channel: string;
  payerName: string;
  details: string;
  isNew: boolean;
}
export interface StatementPreview {
  token: string;
  fileName: string;
  periodFrom: string;
  periodTo: string;
  counts: { parsed: number; new: number; dup: number; excluded: number };
  rows: StatementPreviewRow[];
}
export const previewStatement = (dataB64: string, fileName: string) =>
  authed<StatementPreview>('/api/ceres/statements/preview', { method: 'POST', body: JSON.stringify({ dataB64, fileName }) });

export const applyStatement = (token: string) =>
  authed<{ importId: string; inserted: number; dup: number; excluded: number; autoMatched: number }>(
    '/api/ceres/statements/apply',
    { method: 'POST', body: JSON.stringify({ token }) },
  );

export const runAutomatch = () =>
  authed<{ autoMatched: number }>('/api/ceres/statements/automatch', { method: 'POST' });

export interface StatementImport {
  id: string;
  fileName: string;
  sha256: string;
  periodFrom: string;
  periodTo: string;
  rowsParsed: number;
  linesNew: number;
  linesDup: number;
  excluded: number;
  importedAt: string;
}
export const listStatementImports = () => authed<{ imports: StatementImport[] }>('/api/ceres/statements');

export type MatchStatus = 'unmatched' | 'matched';
export interface StatementLine {
  id: string;
  txnAt: string;
  amount: string;
  direction: 'in' | 'out';
  channel: string;
  description: string;
  details: string;
  payerName: string;
  payerBank: string;
  matchStatus: MatchStatus;
  matchedType: string | null;
  matchedId: string | null;
  refText: string;
  matched: { type: string; summary: string } | null;
}
export const listStatementLines = (q: { status?: MatchStatus; dir?: 'in' | 'out'; from?: string; to?: string; q?: string; limit?: number }) =>
  authed<{ lines: StatementLine[] }>(`/api/ceres/statements/lines${queryString(q)}`);

export const matchStatementLine = (id: string, type: 'paymentRequest' | 'cashMovement', targetId: string) =>
  authed<{ line: StatementLine }>(`/api/ceres/statements/lines/${id}/match`, {
    method: 'POST',
    body: JSON.stringify({ type, id: targetId }),
  });

export const unmatchStatementLine = (id: string) =>
  authed<{ line: StatementLine }>(`/api/ceres/statements/lines/${id}/unmatch`, { method: 'POST' });

export const setStatementLineRef = (id: string, refText: string) =>
  authed<{ line: StatementLine }>(`/api/ceres/statements/lines/${id}/ref`, {
    method: 'POST',
    body: JSON.stringify({ refText }),
  });

export interface StatementSummary {
  unmatchedOut: { count: number; sum: number };
  unmatchedIn: { count: number; sum: number };
  paidRequestsUnreconciled: { count: number; sum: number; oldestDays: number };
  lastImport: { importedAt: string; fileName: string } | null;
}
export const getStatementSummary = () => authed<StatementSummary>('/api/ceres/statements/summary');

// ---------------------------------------------------------------------------
// Weekly export pack — CSV blob downloads (same pattern as Juno's downloadCsv).
// ---------------------------------------------------------------------------

async function downloadCsv(path: string, filename: string): Promise<void> {
  const res = await fetchWithSessionRenewal<Agent>(
    `${API_URL}${path}`,
    undefined,
    { apiUrl: API_URL, getToken, setSession },
  );
  if (res.status === 401) {
    clearSession();
    onUnauthorized?.();
    throw new ApiError('unauthorized', 401, null);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const downloadExpensesCsv = (from: string, to: string) =>
  downloadCsv(`/api/ceres/export/expenses.csv${queryString({ from, to })}`, 'ceres-expenses.csv');
export const downloadMovementsCsv = (from: string, to: string) =>
  downloadCsv(`/api/ceres/export/movements.csv${queryString({ from, to })}`, 'ceres-movements.csv');
export const downloadRequestsCsv = (from: string, to: string) =>
  downloadCsv(`/api/ceres/export/requests.csv${queryString({ from, to })}`, 'ceres-requests.csv');
export const downloadReviewsCsv = (from: string, to: string) =>
  downloadCsv(`/api/ceres/export/reviews.csv${queryString({ from, to })}`, 'ceres-reviews.csv');
export const downloadStatementLinesCsv = (from: string, to: string) =>
  downloadCsv(`/api/ceres/export/statement-lines.csv${queryString({ from, to })}`, 'ceres-statement-lines.csv');

// Baht formatting for display.
export const baht = (n: number): string =>
  `฿${n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
