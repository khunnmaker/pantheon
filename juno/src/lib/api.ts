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

// Suite apps the switcher can link to. Keep in sync with AppName in api/src/auth/jwt.ts.
export type AppName = 'minerva' | 'vulcan' | 'juno' | 'ceres';

// Mirror of the server's hasAppAccess (api/src/auth/jwt.ts): supervisor → everything;
// md → Ceres + Minerva + Juno; employee → their own per-person grant list. A stored agent from
// before this field existed has no apps → treated as no grants (empty list), which is safe.
export function hasAppAccess(agent: Agent, app: AppName): boolean {
  if (agent.role === 'supervisor') return true;
  if (agent.role === 'md') return app === 'ceres' || app === 'minerva' || app === 'juno';
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

export interface Payment {
  id: string;
  customerId: string | null;
  customerCode: string;
  customerName: string;
  senderName: string;
  amount: string;
  amountNum: number;
  ocrAmount: string;
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
  verifiedById: string | null;
  verifiedAt: string | null;
  createdAt: string;
  mismatch: boolean;
  // FIN's check data (RE receipt(s) issued in Express) — see verifyPayment. reNumber is the
  // DEPRECATED join mirror (reNumbers.join('/')); reNumbers is the real (list) source of truth.
  reNumber: string;
  reNumbers: string[];
  receiptName: string;
  customerType: CustomerType;
  // how this row was created + cash/cheque banking state (see settlePayment)
  source: PaymentSource;
  settleState: SettleState;
  settledAt: string | null;
  chequeNo: string;
  chequeBank: string;
  chequeDueDate: string;
}

export interface Summary {
  total: number;
  received: number;
  verified: number;
  recorded: number;
  flagged: number;
  taxRequested: number;
  cashChequePending: number;
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
  });
  if (!res.ok) throw new Error('invalid_credentials');
  return res.json() as Promise<{ token: string; agent: Agent }>;
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

// cash/cheque settle control (the เงินสด/เช็ค tab's drawer section) — '' reverts (ยกเลิก).
export const settlePayment = (id: string, state: SettleState) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/settle`, {
    method: 'POST',
    body: JSON.stringify({ state }),
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

// The check dialog: FIN types the RE number(s) issued in Express (plus the receipt name /
// customer type) — the only route that can advance a payment to 'verified'.
export const verifyPayment = (
  id: string,
  data: { reNumbers: string[]; receiptName?: string; customerType?: CustomerType },
) =>
  authed<{ ok: boolean; payment: Payment }>(`/api/juno/payments/${id}/verify`, {
    method: 'POST',
    body: JSON.stringify(data),
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
  autoCleared: number; // cheque payments auto-set settleState='cleared' by the cheque pass
}

export interface BankSuggestion {
  paymentId: string;
  reNumber: string;
  receiptName: string;
  customerName: string;
  senderName: string;
  amount: string;
  dayDistance: number;
  exactAmount: boolean;
  nameScore: number;
}

export interface BankSummary {
  unmatchedIn: { count: number; sum: number };
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
  authed<{ ok: boolean; autoMatched: number; autoCleared: number }>('/api/juno/bank/automatch', { method: 'POST' });

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
