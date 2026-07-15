// Typed API client for the Juno finance UI. Talks to the SHARED Minerva Fastify
// backend (the /api/juno/* routes), which reads the Payment table Minerva writes on
// /to-finance. All Juno routes are gated to the 'supervisor' role server-side (v1).

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Live roles (mirror of api/src/auth/jwt.ts). The old 'agent' type was stale — the runtime
// sends supervisor/md/employee. Juno's routes stay supervisor-gated server-side (v1).
export type Role = 'supervisor' | 'md' | 'employee';
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
  // Per-person app grants (from the login response). Drives the suite app switcher —
  // see hasAppAccess, which mirrors the SERVER logic in api/src/auth/jwt.ts exactly.
  apps: string[];
}

// Suite apps the switcher can link to. The canonical list now lives in the shared package
// (@pantheon/ui, mirroring the server SSOT api/src/auth/jwt.ts APP_NAMES). Imported for local
// use below AND re-exported so existing consumers that import AppName from './lib/api' keep
// working unchanged.
import type { AppName } from '@pantheon/ui';
export type { AppName };

// Mirror of the server's hasAppAccess (api/src/auth/jwt.ts): supervisor → everything;
// md → Ceres + Minerva + Juno; employee → their own per-person grant list. A stored agent from
// before this field existed has no apps → treated as no grants (empty list), which is safe.
export function hasAppAccess(agent: Agent, app: AppName): boolean {
  if (agent.role === 'supervisor') return true;
  if (agent.role === 'md') return app === 'ceres' || app === 'minerva' || app === 'juno' || app === 'apollo';
  return (agent.apps ?? []).includes(app);
}

export type PaymentStatus = 'received' | 'verified' | 'recorded' | 'void';
export type TaxStatus = 'none' | 'requested' | 'issued';
export type CustomerType = 'โอนก่อนส่ง' | 'เครดิต' | 'เก็บปลายทาง' | '';
// how a Payment entered Juno: 'line' = Minerva LINE-slip hook (default); the rest are
// hand-added in Juno (see JUNO_MANUAL_ENTRY_BRIEF.md).
export type PaymentSource = 'line' | 'manual_transfer' | 'cash' | 'cheque';
// cash/cheque banking state: '' (รอ) -> cash 'deposited' (ฝากธนาคารแล้ว) / cheque 'cleared' (เคลียร์แล้ว)
export type SettleState = '' | 'deposited' | 'cleared';
export type DiscResolution = '' | 'refund' | 'credit' | 'chase' | 'writeoff';

export interface Payment {
  id: string;
  customerId: string | null;
  customerCode: string;
  customerName: string;
  senderName: string;
  amount: string;
  amountNum: number;
  ocrAmount: string;
  // withholding tax (หัก ณ ที่จ่าย, task 2) — `amount`/`amountNum` above is the NET the customer
  // actually sent (what the slip/bank shows, and what reconciles directly). whtRate/whtAmount
  // track the withheld slice, and grossAmount (server-computed) is the full price / RE =
  // amountNum + parsed whtAmount. whtRate 0 / whtAmount '' = no WHT (every pre-task-2 row, and any
  // ordinary payment) → grossAmount === amountNum. See verifyPayment.
  whtRate: number;
  whtAmount: string;
  grossAmount: number;
  bank: string;
  transferAt: string;
  ref: string;
  slipMessageId: string | null;
  slipUrl: string;
  taxInvoice: string;
  taxInvoiceStatus: TaxStatus;
  salesName: string;
  note: string;
  status: PaymentStatus;
  flagged: boolean;
  // stage-3 signal for TRANSFERS (จับคู่แล้ว): true once a bank line is linked in กระทบยอด.
  // Cash/cheque ignore this and use receivedAt (ได้รับเงินแล้ว) instead — see stageOf().
  reconciled: boolean;
  verifiedById: string | null;
  verifiedAt: string | null;
  createdAt: string;
  mismatch: boolean;
  // FIN's check data (RE receipt(s) issued in Express) — see verifyPayment. reNumber is the
  // DEPRECATED join mirror (reNumbers.join('/')); reNumbers is the real (list) source of truth.
  reNumber: string;
  reNumbers: string[];
  billNos: string[];
  receiptName: string;
  customerType: CustomerType;
  // how this row was created + legacy read-only cash/cheque banking state
  source: PaymentSource;
  settleState: SettleState;
  settledAt: string | null;
  // CEO receipt-verify gate (task 1). null = the CEO hasn't yet confirmed physical receipt.
  // See confirmReceived; bank matching does not set these.
  receivedAt: string | null;
  receivedBy: string | null;
  chequeNo: string;
  chequeBank: string;
  chequeDueDate: string;
  discExpected: string;
  discResolution: DiscResolution;
  discNote: string;
  discResolvedAt: string | null;
  discResolvedBy: string;
  discConfirmedAt: string | null;
  discConfirmedBy: string;
}

export interface Summary {
  total: number;
  received: number;
  verified: number;
  recorded: number;
  flagged: number;
  taxRequested: number;
  // รอยืนยันรับเงิน tab badge (task 1): cash/cheque awaiting the CEO's receipt confirmation.
  awaitingReceive: number;
  discrepancyOpen: number;
}

export interface ReportGroup {
  key: string;
  label: string;
  count: number;
  total: number;
}
export interface Report {
  groupBy: 'day' | 'rep' | 'bank' | 'customer';
  count: number;
  grandTotal: number;
  groups: ReportGroup[];
}

export type SourceFilter = 'all' | 'transfer' | 'cashcheque' | PaymentSource;
export interface PaymentFilter {
  q?: string;
  status?: 'all' | PaymentStatus;
  flagged?: boolean;
  tax?: 'all' | TaxStatus;
  from?: string;
  to?: string;
  excludeVoid?: boolean; // Reports CSV: match the on-screen report, which excludes voids
  // 'transfer' = line + manual_transfer (inbox/flags); 'cashcheque' = cash + cheque (new tab)
  source?: SourceFilter;
  // รอยืนยันรับเงิน tab (task 1): unconfirmed cash/cheque — server ignores status/source when set.
  pendingReceive?: boolean;
  // หัก ณ ที่จ่าย tab (task 2): every withheld payment (any status except void).
  wht?: boolean;
}

const TOKEN_KEY = 'juno_token';
const AGENT_KEY = 'juno_agent';

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
    onUnauthorized?.();
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
    // Suite SSO: let the browser STORE the parent-domain httpOnly cookie the server sets
    // on this response. Only login/bootstrap/logout use credentials — never state-changing calls.
    credentials: 'include',
  });
  if (!res.ok) throw new Error('invalid_credentials');
  return res.json() as Promise<{ token: string; agent: Agent }>;
}

// Suite SSO bootstrap: with NO stored token, ask /me using ONLY the shared parent-domain
// cookie (credentials:'include', no Authorization header). If the cookie authenticates,
// the server returns a fresh bearer token + agent; we store the session and return the agent.
// Never throws — a missing/invalid cookie just yields null (→ show Login).
export async function bootstrap(): Promise<Agent | null> {
  try {
    const res = await fetch(`${API_URL}/api/auth/me`, { credentials: 'include' });
    if (!res.ok) return null;
    const { agent, token } = (await res.json()) as { agent: Agent; token: string };
    setSession(token, agent);
    return agent;
  } catch {
    return null;
  }
}

// Suite-wide logout: clear the shared cookie server-side (best-effort), THEN clear this
// app's local session. Used by the user-facing "log out" action so logging out here
// propagates across the suite.
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {
    // Network failure clearing the cookie shouldn't block local logout.
  }
  clearSession();
}

export interface LoginCard {
  email: string;
  name: string;
  kind: 'password' | 'pin';
  // DISPLAY metadata for the role-grouped, avatar login screen (additive; server-provided).
  group: string;                 // ceo | md | sales | finance | messengers | stores | others
  gender: 'male' | 'female';     // drives the cute (DiceBear) avatar
}
// PUBLIC — no auth required. Ordered: supervisor first, then employees granted this app.
export async function getLogins(): Promise<LoginCard[]> {
  const res = await fetch(`${API_URL}/api/auth/logins?app=juno`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<LoginCard[]>;
}

function filterQuery(f: PaymentFilter): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.status && f.status !== 'all') p.set('status', f.status);
  if (f.flagged) p.set('flagged', '1');
  if (f.tax && f.tax !== 'all') p.set('tax', f.tax);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.excludeVoid) p.set('noVoid', '1');
  if (f.source && f.source !== 'all') p.set('source', f.source);
  if (f.pendingReceive) p.set('pendingReceive', 'true');
  if (f.wht) p.set('wht', 'true');
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const getSummary = () => authed<Summary>('/api/juno/summary');

export const getPayments = (f: PaymentFilter) =>
  authed<{ payments: Payment[] }>(`/api/juno/payments${filterQuery(f)}`);

// Hand-add a payment that didn't arrive via the LINE hook (โอนเงิน / เงินสด / เช็คธนาคาร —
// see AddPaymentModal). 'line' is never sent from here — that source is Minerva-only.
export interface CreatePaymentBody {
  source: Exclude<PaymentSource, 'line'>;
  customerCode?: string;
  customerName?: string;
  amount: string;
  note?: string;
  senderName?: string;
  bank?: string;
  transferAt?: string;
  ref?: string;
  slipUrl?: string;
  chequeNo?: string;
  chequeBank?: string;
  chequeDueDate?: string;
  taxInvoice?: string;
}
export const createPayment = (body: CreatePaymentBody) =>
  authed<{ ok: boolean; payment: Payment }>('/api/juno/payments', {
    method: 'POST',
    body: JSON.stringify(body),
  });

// แก้ไขรายละเอียด (see EditPaymentModal): correct a typo'd descriptive field on an EXISTING
// payment — customer code/name, sender, amount, bank, transfer date, ref, sales, note, tax
// invoice, and (cheque only) the cheque fields. Every field optional — send only what changed.
// Available to any Juno user (server gates this the same as the rest of the file, NOT
// supervisor-only — contrast with deletePayment below). Deliberately excludes source/status/
// flagged/RE-check/WHT/legacy banking fields — those have their own dedicated routes.
export interface EditPaymentBody {
  customerCode?: string;
  customerName?: string;
  senderName?: string;
  amount?: string;
  bank?: string;
  transferAt?: string;
  ref?: string;
  salesName?: string;
  note?: string;
  taxInvoice?: string;
  chequeNo?: string;
  chequeBank?: string;
  chequeDueDate?: string;
}
export const updatePayment = (id: string, patch: EditPaymentBody) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

export const setStatus = (id: string, status: PaymentStatus) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });

// CEO-only permanent delete (contrast with setStatus(id, 'void'), which only soft-deletes —
// the row stays and can be un-voided). Server 403s anyone but supervisor. Any status is
// deletable; there is no "too far along" guard here, matching the server.
export const deletePayment = (id: string) =>
  authed<{ ok: boolean }>(`/api/juno/payments/${id}`, { method: 'DELETE' });

// CEO-only receipt-verify gate (task 1): confirms physical receipt of cash/cheque — a hard
// prerequisite for ยืนยันใน Express (see STATUS_META.recorded's rail gate in Juno.tsx). Server
// 403s anyone but supervisor. received=false is the undo (ยกเลิกการยืนยัน), clearing the stamp.
export const confirmReceived = (id: string, received: boolean) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/receive`, {
    method: 'POST',
    body: JSON.stringify({ received }),
  });

// Reuses Minerva's staff-upload endpoint (see api/src/routes/messages.ts POST /api/uploads)
// for the optional transfer slip photo. Returns the public URL to store on Payment.slipUrl.
export async function uploadSlip(dataB64: string, fileName?: string): Promise<{ uploadId: string; url: string }> {
  const { uploadId } = await authed<{ uploadId: string }>('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ dataB64, fileName }),
  });
  return { uploadId, url: `${API_URL}/content/upload/${uploadId}` };
}

// OCR the just-uploaded slip (see POST /api/juno/read-slip) to prefill the โอนเงิน add-payment
// form. Best-effort — fields come back '' when the LLM can't read something; the caller
// should only fill EMPTY inputs from this (never clobber what the user already typed).
export interface ManualSlipFields {
  amount: string;
  bank: string;
  transferAt: string;
  ref: string;
  senderName: string;
}
export const readManualSlip = (uploadId: string) =>
  authed<ManualSlipFields>('/api/juno/read-slip', {
    method: 'POST',
    body: JSON.stringify({ uploadId }),
  });

export interface ManualChequeFields {
  chequeNo: string;
  chequeBank: string;
  chequeDueDate: string;
  amount: string;
}
export const readManualCheque = (uploadId: string) =>
  authed<ManualChequeFields>('/api/juno/read-cheque', {
    method: 'POST',
    body: JSON.stringify({ uploadId }),
  });

// Withholding tax (หัก ณ ที่จ่าย, task 2) rate options — mirrors the server's WHT_RATES
// (api/src/routes/juno.ts). 0 = ไม่มี (no WHT).
export type WhtRate = 0 | 1 | 2 | 3 | 5;

// The check dialog: FIN types the RE number(s) issued in Express (plus the receipt name /
// customer type / WHT) — the only route that can advance a payment to 'verified'. whtRate 0
// (or omitted) clears whtAmount server-side too — see the route's normalization.
export const verifyPayment = (
  id: string,
  data: {
    reNumbers: string[];
    billNos?: string[];
    receiptName?: string;
    customerType?: CustomerType;
    whtRate?: WhtRate;
    whtAmount?: string;
    discExpected?: string;
  },
) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/verify`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

// ── Payment discrepancy ledger (ยอดเกิน/ขาด) ───────────────────────────────
export type DiscrepancyDirection = 'over' | 'under' | 'balanced';
export interface DiscrepancyRow {
  id: string;
  transferAt: string;
  createdAt: string;
  customerCode: string;
  customerName: string;
  receiptName: string;
  source: PaymentSource;
  hasSlip: boolean;
  reNumbers: string[];
  status: PaymentStatus;
  expected: number;
  expectedSource: 'typed' | 're';
  gross: number;
  diff: number;
  direction: DiscrepancyDirection;
  discExpected: string;
  discResolution: DiscResolution;
  discNote: string;
  discResolvedAt: string | null;
  discResolvedBy: string;
  discConfirmedAt: string | null;
  discConfirmedBy: string;
}

export interface DiscrepancyResponse {
  rows: DiscrepancyRow[];
  totals: {
    over: { count: number; sum: number };
    under: { count: number; sum: number };
    pendingConfirm: number;
  };
  groupHints: number;
}

export const getDiscrepancies = () => authed<DiscrepancyResponse>('/api/juno/discrepancies');

export const setDiscrepancyExpected = (id: string, expected: string) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/discrepancy`, {
    method: 'POST', body: JSON.stringify({ expected }),
  });

export const resolveDiscrepancy = (id: string, resolution: DiscResolution, note?: string) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/disc-resolve`, {
    method: 'POST', body: JSON.stringify({ resolution, note }),
  });

export const confirmDiscrepancy = (id: string, confirmed: boolean) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/disc-confirm`, {
    method: 'POST', body: JSON.stringify({ confirmed }),
  });

export const setFlag = (id: string, flagged: boolean, note?: string) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/flag`, {
    method: 'POST',
    body: JSON.stringify({ flagged, note }),
  });

export const setTaxInvoice = (id: string, status: TaxStatus) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/tax-invoice`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });

export const getReport = (groupBy: Report['groupBy'], from?: string, to?: string) => {
  const p = new URLSearchParams({ groupBy });
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  return authed<Report>(`/api/juno/reports?${p.toString()}`);
};

// หัก ณ ที่จ่าย (WHT, task 2) tab totals bar over the given range: count, net (what was actually
// received = Σ amount), wht (withheld), gross (full price/RE = net + wht).
// Visible to every Juno user (no CEO gate, unlike getReport above).
export interface WhtSummary {
  count: number;
  gross: number;
  wht: number;
  net: number;
}
export const getWhtSummary = (from?: string, to?: string) => {
  const p = new URLSearchParams();
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  const s = p.toString();
  return authed<WhtSummary>(`/api/juno/wht/summary${s ? `?${s}` : ''}`);
};

// One-click CSV export (same filters as the inbox). Fetched with auth, then downloaded
// client-side as a Blob so the bearer token never rides in a plain <a href>.
export async function downloadCsv(f: PaymentFilter): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_URL}/api/juno/export.csv${filterQuery(f)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'juno-payments.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Baht formatting for display (from the parsed amountNum).
export const baht = (n: number): string =>
  `฿${n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Phase B: bank import + reconciliation (กระทบยอด) ────────────────────────
// See JUNO_PROCESS_BRIEF.md PHASE B. The owner downloads KBIZ + K SHOP every Wed/Sat;
// Juno reconciles their credit lines against checked (RE-carrying) Payments.

export type BankSource = 'kbiz' | 'kshop';
export type BankDirection = 'in' | 'out';
export type BankMatchStatus = 'unmatched' | 'matched';
export type BankTxnStatusFilter = 'all' | 'unmatched' | 'matched' | 'confirmed';

export interface BankTxnLink {
  paymentId: string;
  reNumber: string;
  chequeNo: string;
  receiptName: string;
  customerName: string;
  amount: string;
}

export interface BankTxn {
  id: string;
  source: BankSource;
  txnAt: string;
  amount: string;
  amountNum: number;
  direction: BankDirection;
  channel: string;
  description: string;
  details: string;
  payerName: string;
  payerBank: string;
  matchStatus: BankMatchStatus;
  refText: string;
  expressConfirmedAt: string | null;
  expressConfirmedById: string | null;
  links: BankTxnLink[];
  linkedSum: number;
  sumDelta: number | null;
}

export interface BankImportPreviewRow {
  txnAt: string;
  amount: string;
  direction: BankDirection;
  channel: string;
  payerName: string;
  details: string;
  isNew: boolean;
}

export interface BankImportPreview {
  token: string;
  source: BankSource;
  fileName: string;
  periodFrom: string | null;
  periodTo: string | null;
  rows: BankImportPreviewRow[];
  counts: { parsed: number; new: number; dup: number; excluded: number };
}

export interface BankImportApplyResult {
  ok: boolean;
  importId: string;
  source: BankSource;
  counts: { parsed: number; new: number; dup: number; excluded: number };
  autoMatched: number;
  chequeMatched: number; // cheque number + amount links created by the cheque pass
}

export interface BankSuggestion {
  paymentId: string;
  reNumber: string;
  chequeNo: string;
  receiptName: string;
  customerName: string;
  senderName: string;
  amount: string;
  dayDistance: number;
  exactAmount: boolean;
  nameScore: number;
}

// Mirrors the ตามเงินเข้า ledger states (ทั้งหมด/ยังไม่จับคู่/จับคู่แล้ว/ยืนยันแล้ว) on the
// receipt side: confirmed = linked + recorded; all = the full recon universe.
export type PaymentReconState = 'pending' | 'matched' | 'confirmed' | 'all';

export interface PaymentReconLinkedTxn {
  bankTxnId: string;
  txnAt: string;
  amount: string;
  channel: string;
  payerName: string;
  expressConfirmedAt: string | null;
}

export type PaymentReconRow = Payment & { linkedTxns: PaymentReconLinkedTxn[] };

export interface TxnSuggestion {
  bankTxnId: string;
  txnAt: string;
  amount: string;
  channel: string;
  payerName: string;
  details: string;
  matchStatus: BankMatchStatus;
  linkedCount: number;
  exactAmount: boolean;
  dayDistance: number;
  nameScore: number;
}

export interface BankSummary {
  unmatchedIn: { count: number; sum: number };
  // unmatched "in" lines from the last ~31 days — the tab badge's attention signal (the
  // full-history count above stays for the กระทบยอด cards). Optional: absent on a stale api.
  unmatchedInRecent?: { count: number };
  matchedUnconfirmed: { count: number; sum: number };
  verifiedUnreconciled: { count: number; sum: number; oldestDays: number };
  lastImports: {
    kbiz: { id: string; fileName: string; importedAt: string; txnsNew: number } | null;
    kshop: { id: string; fileName: string; importedAt: string; txnsNew: number } | null;
  };
}

// Reads a File as base64 (no data: prefix) for the import preview upload.
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsDataURL(file);
  });
}

export const previewBankImport = (dataB64: string, fileName: string) =>
  authed<BankImportPreview>('/api/juno/bank/import/preview', {
    method: 'POST',
    body: JSON.stringify({ dataB64, fileName }),
  });

export const applyBankImport = (token: string) =>
  authed<BankImportApplyResult>('/api/juno/bank/import/apply', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });

export const runBankAutomatch = () =>
  authed<{ ok: boolean; autoMatched: number; chequeMatched: number }>('/api/juno/bank/automatch', { method: 'POST' });

export interface BankTxnFilter {
  status?: BankTxnStatusFilter;
  dir?: BankDirection | 'all';
  from?: string;
  to?: string;
  q?: string;
}
function bankTxnFilterQuery(f: BankTxnFilter): string {
  const p = new URLSearchParams();
  if (f.status && f.status !== 'all') p.set('status', f.status);
  if (f.dir && f.dir !== 'all') p.set('dir', f.dir);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.q) p.set('q', f.q);
  const s = p.toString();
  return s ? `?${s}` : '';
}
export const getBankTxns = (f: BankTxnFilter) =>
  authed<{ txns: BankTxn[] }>(`/api/juno/bank/txns${bankTxnFilterQuery(f)}`);

export const getBankSuggestions = (txnId: string) =>
  authed<{ suggestions: BankSuggestion[] }>(`/api/juno/bank/txns/${txnId}/suggestions`);

export const getPaymentsRecon = (state: PaymentReconState = 'pending', q?: string, limit?: number, from?: string, to?: string) => {
  const p = new URLSearchParams({ state });
  if (q) p.set('q', q);
  if (limit) p.set('limit', String(limit));
  if (from) p.set('from', from);
  if (to) p.set('to', to);
  return authed<{ payments: PaymentReconRow[] }>(`/api/juno/payments-recon?${p.toString()}`);
};

export const getPaymentTxnSuggestions = (paymentId: string) =>
  authed<{ suggestions: TxnSuggestion[] }>(`/api/juno/payments/${paymentId}/txn-suggestions`);

export const matchPaymentTxns = (paymentId: string, bankTxnIds: string[]) =>
  authed<{ ok: boolean; linkedSum: number; sumDelta: number }>(`/api/juno/payments/${paymentId}/match`, {
    method: 'POST',
    body: JSON.stringify({ bankTxnIds }),
  });

export const matchBankTxn = (txnId: string, paymentIds: string[]) =>
  authed<{ ok: boolean; sumDelta: number }>(`/api/juno/bank/txns/${txnId}/match`, {
    method: 'POST',
    body: JSON.stringify({ paymentIds }),
  });

export const unmatchBankTxn = (txnId: string, paymentId: string) =>
  authed<{ ok: boolean }>(`/api/juno/bank/txns/${txnId}/unmatch`, {
    method: 'POST',
    body: JSON.stringify({ paymentId }),
  });

export const setBankTxnRef = (txnId: string, refText: string) =>
  authed<{ ok: boolean; txn: BankTxn }>(`/api/juno/bank/txns/${txnId}/ref`, {
    method: 'POST',
    body: JSON.stringify({ refText }),
  });

export const confirmBankTxn = (txnId: string) =>
  authed<{ ok: boolean }>(`/api/juno/bank/txns/${txnId}/confirm`, { method: 'POST' });

export const confirmAllMatched = (to?: string) =>
  authed<{ ok: boolean; txnsConfirmed: number; paymentsAdvanced: number }>('/api/juno/bank/confirm-matched', {
    method: 'POST',
    body: JSON.stringify({ to }),
  });

export const getBankSummary = () => authed<BankSummary>('/api/juno/bank/summary');

export const getBankWatchlist = (limit?: number) =>
  authed<{ payments: Payment[] }>(`/api/juno/bank/watchlist${limit ? `?limit=${limit}` : ''}`);

// ── RE reconciliation (กระทบยอด RE) ─────────────────────────────────────────
// Imports Express's periodic ARRCPDAT.TXT (AR-receipt report) and cross-checks every RE
// against the Juno Payment(s) carrying it — the "future RE-import" the WHT feature's
// grossOf() was built for. Import is CEO-only; the list is visible to every Juno user.

export type ReReconStatus = 'matched' | 'mismatch' | 'unpaid';
export type ReReconStatusFilter = 'all' | ReReconStatus;

export interface ReReceiptInvoice {
  docNo: string;
  date: string;
  amount: number;
}

export interface ReReconRow {
  id: string;
  reNumber: string;
  receiptDate: string;
  customerName: string;
  salesName: string;
  amount: number; // ยอดตามใบกำกับ
  notPosted: boolean;
  invoices: ReReceiptInvoice[];
  status: ReReconStatus;
  paidGross: number; // this RE's apportioned share of the covering transfer(s) — its own receipt amount when the transfer ties out, NOT the whole payment
  diff: number; // paidGross - amount (≈0 when matched)
  paymentCount: number;
}

export interface ReReconSummary {
  total: number;
  matched: number;
  mismatch: number;
  unpaid: number;
  totalAmount: number;
  matchedAmount: number;
}

export interface ReImportResult {
  parsed: number;
  imported: number;
  updated: number;
  cancelledSkipped: number;
  totalAmount: number;
  fileTotal: number | null;
  totalsMatch: boolean;
}

export const importReReceipts = (dataB64: string, fileName: string) =>
  authed<ReImportResult>('/api/juno/re/import', {
    method: 'POST',
    body: JSON.stringify({ dataB64, fileName }),
  });

export interface ReReconFilter {
  status?: ReReconStatusFilter;
  q?: string;
  from?: string;
  to?: string;
}
function reReconFilterQuery(f: ReReconFilter): string {
  const p = new URLSearchParams();
  if (f.status && f.status !== 'all') p.set('status', f.status);
  if (f.q) p.set('q', f.q);
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  const s = p.toString();
  return s ? `?${s}` : '';
}
export const getReReconciliation = (f: ReReconFilter) =>
  authed<{ rows: ReReconRow[]; summary: ReReconSummary }>(`/api/juno/re${reReconFilterQuery(f)}`);

// The imported Express receipt's customer name per RE core (only cores that are imported come
// back). The ใบปะหน้า cover uses this so ชื่อบนใบเสร็จ shows the name on the actual RE, not the
// LINE display name. Returns {} when nothing's imported yet → the cover falls back to receiptName.
export const getReNames = (reNumbers: string[]) =>
  authed<Record<string, string>>(`/api/juno/re/names?res=${encodeURIComponent([...new Set(reNumbers)].join(','))}`);

// ── บิลมือ (manual bills) ──────────────────────────────────────────────────
export type ManualBillStatus = 'paid' | 'mismatch' | 'unpaid' | 'void';
export type ManualBillStatusFilter = 'all' | ManualBillStatus;

export interface ManualBillItem {
  productId?: string;
  sku?: string;
  name: string;
  qty: number;
  unitPrice: string;
  amount: string;
}

export interface ManualBillLinkedPayment {
  id: string;
  amount: string;
  whtAmount: string;
  status: PaymentStatus;
  source: PaymentSource;
  createdAt: string;
  customerName: string;
}

export interface ManualBill {
  id: string;
  billNo: string;
  billedAt: string;
  customerCode: string;
  buyerName: string;
  buyerPhone: string;
  buyerAddress: string;
  items: ManualBillItem[];
  amount: string;
  note: string;
  status: 'open' | 'void';
  voidedAt: string | null;
  voidedById: string | null;
  createdAt: string;
  createdById: string | null;
  createdByName: string;
  updatedAt: string;
  linkedPayments: ManualBillLinkedPayment[];
  billStatus: ManualBillStatus;
  paidGross: number;
}

export interface ManualBillBody {
  billNo?: string;
  billedAt: string;
  customerCode: string;
  buyerName: string;
  buyerPhone: string;
  buyerAddress: string;
  items: ManualBillItem[];
  amount: string;
  note: string;
}

export interface ManualBillCounts { unpaid: number; mismatch: number }

export const getManualBills = (f: { q?: string; status?: ManualBillStatusFilter } = {}) => {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.status && f.status !== 'all') p.set('status', f.status);
  const query = p.toString();
  return authed<{ bills: ManualBill[]; counts: ManualBillCounts }>(`/api/juno/bills${query ? `?${query}` : ''}`);
};

export const createManualBill = (body: ManualBillBody) =>
  authed<{ ok: boolean; bill: ManualBill }>('/api/juno/bills', {
    method: 'POST', body: JSON.stringify(body),
  });

export const updateManualBill = (id: string, body: Omit<ManualBillBody, 'billNo'>) =>
  authed<{ ok: boolean; bill: ManualBill }>(`/api/juno/bills/${id}`, {
    method: 'PATCH', body: JSON.stringify(body),
  });

export const setManualBillVoid = (id: string, value: boolean) =>
  authed<{ ok: boolean; bill: ManualBill }>(`/api/juno/bills/${id}/void`, {
    method: 'POST', body: JSON.stringify({ void: value }),
  });

// CEO-only hard delete (ลบถาวร) — server 403s anyone but supervisor, and 409s (bill_linked)
// while any payment still carries the bill number in its billNos chips. Contrast with
// setManualBillVoid above, the everyday reversible ยกเลิก.
export const deleteManualBill = (id: string) =>
  authed<{ ok: boolean }>(`/api/juno/bills/${id}`, { method: 'DELETE' });

export interface ManualBillProduct {
  id: string;
  sku: string;
  name: string;
  price: number;
  stock: number | null;
  stockAt: string | null;
}

export const getManualBillProducts = (q: string) =>
  authed<{ products: ManualBillProduct[] }>(`/api/juno/products?q=${encodeURIComponent(q)}`);

// ── ตรวจสอบยอด (FinanceAudit mis-read trail) ─────────────────────────────────
// Every time staff submit a slip amount that differs from what the AI read (OCR), Minerva logs
// a FinanceAudit row. It lives on Juno now (api/src/routes/finance.ts, requireApp('juno')): any
// Juno user can READ the open flags on payments they process; only a supervisor can RESOLVE.
// Shape mirrors web/src/lib/api.ts (the Minerva console's supervisor-only view).
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
export const getFinanceAudits = (status = 'open') =>
  authed<{ audits: FinanceAudit[] }>(`/api/finance/audits?status=${encodeURIComponent(status)}`);
// Supervisor-only server-side (403 otherwise) — the Juno UI hides the button for non-supervisors.
export const resolveFinanceAudit = (id: string) =>
  authed<{ ok: boolean }>(`/api/finance/audits/${id}/resolve`, { method: 'POST' });
