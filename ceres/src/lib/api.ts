// Typed API client for the Ceres petty-cash UI. Talks to the SHARED Minerva Fastify
// backend (the /api/ceres/* routes — see api/src/routes/ceres/p1.ts, common.ts, index.ts).
// Raw auth roles: 'supervisor' | 'gm' | 'central' | 'employee'. GET /api/ceres/bootstrap
// normalizes that into the Ceres vocabulary 'messenger' | 'gm' | 'ceo'
// ('central'/'employee' -> 'messenger', 'supervisor' -> 'ceo') — always trust the bootstrap role
// for UI routing/branching, never the raw login role.

import { fetchWithSessionRenewal, renewSuiteSessionOnce } from '@pantheon/ui';

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Raw Agent-table role as returned by POST /api/auth/login.
export type Role = 'supervisor' | 'gm' | 'central' | 'employee';
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
  // Per-person app grants (from the login response) — always present on the wire (see
  // api/src/routes/auth.ts), just unused by Ceres until the desktop app switcher (2026-07-18).
  // Drives hasAppAccess below, mirroring juno/vesta/apollo's own copy of this same pattern.
  apps: string[];
}

// Suite apps the switcher can link to. The canonical list lives in the shared package
// (@pantheon/ui, mirroring the server SSOT api/src/auth/jwt.ts APP_NAMES). Imported for local
// use below AND re-exported so consumers can `import type { AppName } from './lib/api'`.
import type { AppName } from '@pantheon/ui';
export type { AppName };

// Mirror of the server's hasAppAccess (api/src/auth/jwt.ts): supervisor → everything;
// gm → Ceres + Minerva + Juno + Apollo (GM_APPS); central/employee → their own per-person
// Agent.apps grant list. Same copy every suite app's AppSwitcher.tsx carries locally.
export function hasAppAccess(agent: Agent, app: AppName): boolean {
  if (agent.role === 'supervisor') return true;
  if (agent.role === 'gm') return app === 'ceres' || app === 'minerva' || app === 'juno' || app === 'apollo';
  return (agent.apps ?? []).includes(app);
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
  group: string;
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

// ---------------------------------------------------------------------------
// Category admin (GM/CEO only) — see api/src/routes/ceres/categories.ts. Full
// Prisma rows on the wire (incl. inactive, incl. the raw string `ceiling`) — a
// different shape from the bootstrap-trimmed `Category` above, so it gets its
// own type rather than overloading `Category`.
// ---------------------------------------------------------------------------

export interface AdminCategory {
  id: string;
  name: string;
  group: string;
  kind: string;
  ceiling: string;
  needsCustomerNote: boolean;
  active: boolean;
  sortOrder: number;
}

export const adminListCategories = () =>
  authed<{ categories: AdminCategory[] }>('/api/ceres/admin/categories');

export const adminCreateCategory = (body: {
  name: string;
  group: string;
  ceiling?: string;
  needsCustomerNote?: boolean;
}) => authed<{ category: AdminCategory }>('/api/ceres/admin/categories', { method: 'POST', body: JSON.stringify(body) });

export const adminUpdateCategory = (
  id: string,
  body: Partial<{ name: string; group: string; ceiling: string; needsCustomerNote: boolean; active: boolean }>,
) => authed<{ category: AdminCategory }>(`/api/ceres/admin/categories/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

export const adminMoveCategory = (id: string, direction: 'up' | 'down') =>
  authed<{ category: AdminCategory }>(`/api/ceres/admin/categories/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ direction }),
  });

const CATEGORY_ERROR_TH: Record<string, string> = {
  duplicate_name: 'ชื่อหมวดหมู่นี้มีอยู่แล้ว',
  invalid_body: 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง',
  invalid_ceiling: 'เพดานต่อรายการไม่ถูกต้อง',
  last_active_category: 'ต้องมีหมวดหมู่ที่เปิดใช้งานอย่างน้อย 1 รายการ',
  not_found: 'ไม่พบหมวดหมู่นี้',
};
export function describeCategoryError(err: unknown): string {
  if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'error' in err.body) {
    const code = String((err.body as { error: unknown }).error);
    return CATEGORY_ERROR_TH[code] ?? 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง';
  }
  return 'บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง';
}

export interface LoginName {
  email: string;
  name: string;
  kind: 'password' | 'pin';
  // DISPLAY metadata for the role-grouped, avatar login screen (additive; server-provided).
  group: string;                 // ceo | gm | central | sales | finance | messengers | stores | others
  gender: 'male' | 'female';     // drives the cute (DiceBear) avatar
}
// PUBLIC — no auth required. Ordered: supervisor, GM, Central Office, then other employee cards.
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
  advanceRequestId: string | null;
  fundingLane: string; // cash | transfer | self_funded
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
  advanceRequestId?: string;
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
// A snapshot row of one cash-lane request money event (payment/purchase/refund/reversal)
// captured at close time — see CeresSettlementRequestLine / POST /api/ceres/close.
// Old UI versions that don't read this field simply ignore it (additive).
export interface SettlementRequestLine {
  id: string;
  requestId: string;
  moneyEventId: string;
  kind: string; // payment | purchase | refund | reversal
  partyName: string;
  amount: string;
  createdAt: string;
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
  requestLines: SettlementRequestLine[];
}
export const listSettlements = (limit?: number) =>
  authed<{ settlements: Settlement[] }>(`/api/ceres/settlements${limit ? `?limit=${limit}` : ''}`);

// ---------------------------------------------------------------------------
// P2/P3 — recurring templates (v1 payment-request CRUD purged 2026-07-19 —
// see docs/CERES_V1_PURGE_PLAN.md; the v2 staff-request client further below
// is the only creation/decision/list path left).
// ---------------------------------------------------------------------------

export interface AIReviewBrief {
  verdict: string;
  reasoning: string;
  createdAt: string;
}

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

// One lane×requestType bucket of today's request-money outflow (P4 CEO home "daily
// outflow by lane/type" — see api/src/ceres/nightlyDigest.ts's dailyOutflowSummary).
export interface DailyOutflowBucket {
  lane: string; // cash | transfer
  requestType: string; // advance | reimbursement | purchase | unknown
  count: number;
  amount: string;
}

export interface CeoOverview {
  dayKey: string;
  // v2-only since the v1 purge (2026-07-19) — the server only ever escalates
  // workflowVersion-2 StaffRequest rows to pending_ceo now.
  escalations: StaffRequest[];
  aiReviews: AIReviewRow[];
  flaggedExpenses: Expense[];
  cash: { box: { balance: number; floor: number; belowFloor: boolean; suggestedTopup: number }; outstandingTotal: number };
  missedBills: TemplateDue[];
  settlementToday: Settlement | null;
  v2RequestCounts: Record<string, number>;
  transferReconciliation: { unmatched: number; reversalExceptions: number };
  dailyOutflow: DailyOutflowBucket[];
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

export const matchStatementLine = (
  id: string,
  type: 'paymentRequest' | 'cashMovement' | 'requestMoneyEvent',
  targetId: string,
) =>
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

// ---------------------------------------------------------------------------
// P2 v2 — staff request front door (advance / reimbursement / purchase) +
// unified Nee/CEO approval queue. See api/src/ceres/requestService.ts and
// api/src/routes/ceres/requests.ts for the server-side contract.
// ---------------------------------------------------------------------------

export type MediaPurpose =
  | 'legacy_receipt'
  | 'request_photo'
  | 'reimbursement_receipt'
  | 'purchase_receipt'
  | 'transfer_slip'
  | 'refund_slip';

// Generic authenticated media upload (declares its purpose up front) — the v2
// counterpart of uploadReceipt(), which stays as the legacy_receipt-only alias.
export const uploadMedia = (dataB64: string, contentType: string, purpose: MediaPurpose) =>
  authed<{ uploadId: string; url: string; ocr: OcrResult; duplicate: DuplicateReceipt | null }>('/api/ceres/media', {
    method: 'POST',
    body: JSON.stringify({ dataB64, contentType, purpose }),
  });

// Short-lived signed URL for an already-uploaded media id — use as an <img>/<a> target
// only; never render the URL string itself (media links must stay non-user-visible text).
export const getMediaUrl = (id: string) => authed<{ url: string; expiresAt: string }>(`/api/ceres/media/${id}/url`);

export type V2RequestType = 'advance' | 'reimbursement' | 'purchase';
export type ApprovalStatus =
  | 'legacy'
  | 'pending_nee'
  | 'pending_ceo'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'void';
export type FulfillmentStatus = 'legacy' | 'unfulfilled' | 'paid' | 'bought' | 'settling' | 'settled' | 'reversed';
export type AiScreenStatus = 'legacy' | 'pending' | 'clear' | 'escalate';

export interface StaffRequest {
  id: string;
  workflowVersion: 2;
  requestType: V2RequestType;
  requestedById: string | null;
  requestedByName: string;
  requesterPartyId: string | null;
  entity: string;
  payee: string;
  // For advances with a group-based selection, this is the server-joined label
  // (groups joined with " · ") — see requestCategoryLabel() in
  // api/src/routes/ceres/common.ts. Old advances keep their single category name.
  category: string;
  // Raw group list (advance only; empty for reimbursement/purchase and for pre-migration
  // advances that still carry a single `category`). Prefer `category` for display — this
  // is only needed where the UI must distinguish "group-based advance" from "has a real
  // category name" (e.g. RequestDetail's liquidation defaultCategory).
  categoryGroups: string[];
  amount: string;
  amountNum: number;
  reason: string;
  requestPhotoUploadId: string | null;
  ocr: { amount: string; vendor: string; date: string };
  aiScreenStatus: AiScreenStatus;
  aiReviewId: string | null;
  aiReview: AIReviewBrief | null;
  approvalStatus: ApprovalStatus;
  fulfillmentStatus: FulfillmentStatus;
  neeDecision: { byId: string | null; byName: string; at: string; note: string } | null;
  ceoDecision: { byId: string | null; at: string; note: string } | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface RequestEvent {
  id: string;
  requestId: string;
  kind: string;
  actorId: string | null;
  actorName: string;
  note: string;
  payload: unknown;
  createdAt: string;
}

export const createStaffRequest = (body: {
  requestType: V2RequestType;
  entity: string;
  // advance: omit/empty (categoryGroups carries the selection instead).
  // reimbursement/purchase: required, categoryGroups stays absent — see
  // api/src/routes/ceres/requests.ts's v2CreateBody discriminated union.
  category?: string;
  categoryGroups?: string[];
  amount: string;
  reason?: string;
  requestPhotoUploadId?: string | null;
}) => authed<{ request: StaffRequest }>('/api/ceres/requests', { method: 'POST', body: JSON.stringify(body) });

export type StaffRequestScope = 'mine' | 'queue' | 'all';

export const listStaffRequests = (scope: StaffRequestScope, limit?: number) =>
  authed<{ requests: StaffRequest[] }>(`/api/ceres/requests${queryString({ workflow: 2, scope, limit })}`);

export const getStaffRequest = (id: string) =>
  authed<{ request: StaffRequest; events: RequestEvent[]; revisions: Revision[]; moneyEvents: RequestMoneyEvent[] }>(
    `/api/ceres/requests/${id}`,
  );

export const editStaffRequest = (
  id: string,
  patch: Partial<{
    requestType: V2RequestType;
    entity: string;
    category: string;
    categoryGroups: string[];
    amount: string;
    reason: string;
    requestPhotoUploadId: string | null;
  }>,
) => authed<{ request: StaffRequest }>(`/api/ceres/requests/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const cancelStaffRequest = (id: string, note?: string) =>
  authed<{ request: StaffRequest }>(`/api/ceres/requests/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  });

export const neeDecision = (id: string, decision: 'approve' | 'reject', note?: string) =>
  authed<{ request: StaffRequest }>(`/api/ceres/requests/${id}/nee-decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, note }),
  });

export const ceoDecisionV2 = (id: string, decision: 'approve' | 'reject', note?: string) =>
  authed<{ request: StaffRequest }>(`/api/ceres/requests/${id}/ceo-decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, note }),
  });

// ---------------------------------------------------------------------------
// P3 — cash/transfer fulfillment, advance liquidation, transfer reconciliation.
// See api/src/ceres/requestMoney.ts + api/src/routes/ceres/requests.ts,statements.ts.
// ---------------------------------------------------------------------------

export type RequestMoneyLane = 'cash' | 'transfer';
export type RequestMoneyKind = 'payment' | 'purchase' | 'refund' | 'reversal';

export interface RequestMoneyEvent {
  id: string;
  requestId: string;
  kind: RequestMoneyKind;
  lane: RequestMoneyLane;
  amount: string;
  transferSlipUploadId: string | null;
  purchaseReceiptUploadId: string | null;
  cashMovementId: string | null;
  reversesEventId: string | null;
  createdById: string | null;
  createdByName: string;
  note: string;
  createdAt: string;
}

// A small helper for generating client-side idempotency keys on money-moving actions
// (fulfill/refund/reverse) — a retried tap after a flaky network response replays the
// SAME event instead of creating a second one (see requestMoney.ts's idempotencyKey).
export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export const fulfillStaffRequest = (
  id: string,
  body: {
    lane: RequestMoneyLane;
    transferSlipUploadId?: string;
    purchaseReceiptUploadId?: string;
    note?: string;
    idempotencyKey?: string;
  },
) =>
  authed<{ request: StaffRequest; moneyEvent: RequestMoneyEvent }>(`/api/ceres/requests/${id}/fulfill`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export interface LiquidationExpense {
  id: string;
  partyId: string | null;
  partyName: string;
  entity: string;
  category: string;
  customerNote: string;
  amount: string;
  status: ExpenseStatus;
  receiptUploadId: string | null;
  note: string;
  spentAt: string;
  createdAt: string;
}

// The raw request snapshot returned inside getAdvanceLiquidation() — NOT run through
// toStaffRequestRow (see api/src/ceres/requestMoney.ts's getAdvanceLiquidation), so it
// carries the DB column names directly. Only the fields the UI actually reads are typed.
export interface LiquidationRequestSummary {
  id: string;
  amount: string;
  entity: string;
  category: string;
  detail: string;
  requestType: V2RequestType;
  requestedById: string | null;
  requestedByName: string;
  requesterPartyId: string | null;
  fulfillmentStatus: FulfillmentStatus;
  approvalStatus: ApprovalStatus;
  createdAt: string;
}

export interface AdvanceLiquidation {
  request: LiquidationRequestSummary;
  fundingLane: RequestMoneyLane;
  advanceAmount: string;
  approvedExpenses: LiquidationExpense[];
  returns: RequestMoneyEvent[];
  totals: {
    approvedExpenses: string;
    returned: string;
    remainingOutstanding: string;
    settled: boolean;
  };
}

export const refundAdvance = (
  id: string,
  body: { lane: RequestMoneyLane; amount: string; transferSlipUploadId?: string; note?: string; idempotencyKey?: string },
) =>
  authed<{ moneyEvent: RequestMoneyEvent; liquidation: AdvanceLiquidation }>(`/api/ceres/requests/${id}/refund`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const reverseRequestMoneyEvent = (eventId: string, reason: string, idempotencyKey?: string) =>
  authed<{ moneyEvent: RequestMoneyEvent }>(`/api/ceres/request-money-events/${eventId}/reverse`, {
    method: 'POST',
    body: JSON.stringify({ reason, idempotencyKey }),
  });

export const getRequestLiquidation = (id: string) =>
  authed<{ liquidation: AdvanceLiquidation }>(`/api/ceres/requests/${id}/liquidation`);

export interface TransferReconciliationEvent {
  id: string;
  requestId: string;
  requestType: string;
  requester: string;
  entity: string;
  kind: RequestMoneyKind;
  direction: 'in' | 'out' | null;
  amount: string;
  createdAt: string;
  slipRequired: boolean;
  slipPresent: boolean;
  purchaseReceiptPresent: boolean;
  reversesEventId: string | null;
  reversedByEventId: string | null;
  reconciliationState: 'matched' | 'unmatched';
  reversalException: boolean;
  bankLine: {
    id: string;
    txnAt: string;
    direction: 'in' | 'out';
    amount: string;
    details: string;
    reconciledById: string | null;
    reconciledAt: string | null;
  } | null;
}
export interface TransferReconciliationBankLine {
  id: string;
  txnAt: string;
  direction: 'in' | 'out';
  amount: string;
  channel: string;
  description: string;
  details: string;
  payerName: string;
}
export const getTransferReconciliation = () =>
  authed<{ transferEvents: TransferReconciliationEvent[]; unmatchedBankLines: TransferReconciliationBankLine[] }>(
    '/api/ceres/transfers/reconciliation',
  );

// Thai-language mapping for the money-movement error codes (see RequestMoneyError /
// CashLedgerError in api/src/ceres/requestMoney.ts) — shared by every fulfill/refund/
// reverse call site so the same code always reads the same way to Nee/CEO.
const MONEY_ERROR_TH: Record<string, string> = {
  not_found: 'ไม่พบรายการ',
  not_approved: 'คำขอนี้ยังไม่อนุมัติ ทำรายการไม่ได้',
  already_fulfilled: 'คำขอนี้จ่าย/ซื้อไปแล้ว',
  invalid_evidence: 'ต้องแนบหลักฐาน (สลิปโอน/ใบเสร็จซื้อ) ก่อนบันทึก',
  invalid_request_type: 'ประเภทคำขอไม่ตรงกับการทำรายการนี้',
  not_paid_advance: 'ยังไม่มีการจ่ายเงินเบิกล่วงหน้าของคำขอนี้',
  refund_exceeds_outstanding: 'จำนวนคืนเกินยอดค้างชำระ',
  insufficient_cash: 'เงินสดในกล่องไม่พอ',
  invalid_amount: 'จำนวนเงินไม่ถูกต้อง',
  media_not_owned: 'ไฟล์แนบใช้ไม่ได้ ลองอัปโหลดใหม่',
};
export function describeMoneyError(err: unknown): string {
  if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'error' in err.body) {
    const code = String((err.body as { error: unknown }).error);
    return MONEY_ERROR_TH[code] ?? 'ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง';
  }
  return 'ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง';
}

// ---------------------------------------------------------------------------
// P4 — shared Agent LINE binding (suite-wide; see api/src/line/staffBind.ts,
// api/src/routes/staffLine.ts). Apollo's existing /api/apollo/line-bind writes the
// same Agent.lineUserId/lineBindCode fields — a code generated here or in Apollo both
// work, and the OA accepts either an "APOLLO-XXXXXXXX" or "CERES-XXXXXXXX" message.
// ---------------------------------------------------------------------------

export interface LineBindState {
  bound: boolean;
  code: string | null;
}
export const getLineBind = () => authed<LineBindState>('/api/staff/line-bind');
export const generateLineBind = () => authed<{ bound: false; code: string }>('/api/staff/line-bind', { method: 'POST' });
