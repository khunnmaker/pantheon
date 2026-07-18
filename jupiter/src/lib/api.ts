// Typed API client for the Jupiter accounting app. Talks to the shared Minerva backend.
//   POST /api/auth/login       — the suite's single login (Phase 1: localStorage-JWT, no SSO)
//   GET  /api/jupiter/acct/*   — the accounting cockpit's supervisor-only endpoints

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Mirrors the backend's Role vocabulary post unified-auth (api/src/auth/jwt.ts): three live
// tiers. Which apps a person may open is NO LONGER derived from role alone — it's a per-person
// grant (`apps`), exactly as the server gates it (see hasAppAccess in apps.ts). supervisor →
// everything; gm → Ceres + Minerva + Juno + Apollo; agm/employee → their own `apps` list.
export type Role = 'supervisor' | 'gm' | 'agm' | 'employee';
import { fetchWithSessionRenewal, renewSuiteSessionOnce, type AppName } from '@pantheon/ui';
export type { AppName };
export interface Agent {
  id: string;
  email: string;
  name: string;
  role: Role;
  apps: string[];   // per-person app grants (from the login response). Absent/empty ⇒ none.
}

// The badges payload: a key per app the CALLER may enter (the server never returns a key
// for an app this role can't open). Each value is optional so a missing app is just absent.
export interface LoginCard {
  email: string;
  name: string;
  kind: 'password' | 'pin';
  group: string;
  gender: 'male' | 'female';
}

export function hasAppAccess(agent: Agent, app: AppName): boolean {
  if (agent.role === 'supervisor') return true;
  if (agent.role === 'gm') return app === 'ceres' || app === 'minerva' || app === 'juno' || app === 'apollo';
  return (agent.apps ?? []).includes(app);
}

const TOKEN_KEY = 'jupiter_token';
const AGENT_KEY = 'jupiter_agent';

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

// Notified on a 401 (JWT expiry) so App can drop back to Login instead of a blank portal.
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(fn: (() => void) | null): void { onUnauthorized = fn; }

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

export async function getLogins(): Promise<LoginCard[]> {
  const res = await fetch(`${API_URL}/api/auth/logins?app=jupiter`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<LoginCard[]>;
}

// ─── Jupiter accounting (Phase 1 cockpit) — supervisor-only endpoints under /api/jupiter/acct ──
// All calls carry the bearer token and clear the session + notify on a 401 (same as getBadges).

export type Direction = 'income' | 'expense';

export interface AcctCompany {
  code: string;
  name: string;
  nameTh: string;
  kind: string;
  color: string;
  // Phase-2 ledger settings, returned by GET /api/jupiter/acct/companies since the route's
  // select gained them (api/src/routes/jupiterAccounting.ts). ledgerMode drives the UI's
  // company-mode routing (Accounting.tsx modeOf — which keeps a defensive 'cockpit' fallback).
  // The dates arrive as Fastify-serialized ISO timestamps (DateTime @db.Date) or null.
  ledgerMode: LedgerMode;
  ledgerCutoverDate: string | null;
  ledgerLockDate: string | null;
}

export interface AcctSummaryCompany {
  code: string;
  name: string;
  nameTh: string;
  color: string;
  revenue: number;
  expense: number;
  profit: number;
}
export interface AcctSummary {
  month: string;
  companies: AcctSummaryCompany[];
  total: { revenue: number; expense: number; profit: number };
}

export interface AcctTxn {
  id: string;
  companyCode: string;
  direction: Direction;
  date: string;
  party: string;
  category: string;
  amount: string;
  vatAmount: string;
  whtAmount: string;
  note: string;
  source: string;
  sourceRef: string;
  createdById: string | null;
  createdByName: string;
  createdAt: string;
}

export interface AcctRegisterRow {
  code: string;
  name: string;
  nameTh: string;
  color: string;
  sales: number;
  outputVat: number;
  purchases: number;
  inputVat: number;
  wht: number;
  vatNet: number;
}
export interface AcctRegisters {
  month: string;
  companies: AcctRegisterRow[];
}

// A proposed txn from POST /parse (before the user confirms + saves it).
export interface ProposedTxn {
  direction: Direction;
  companyCode: string;
  category: string;
  party: string;
  amount: string;
  vatAmount: string;
  whtAmount: string;
  note: string;
}

// Shared authed-fetch: attaches the bearer token, handles 401 → logout, parses JSON.
async function acctFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithSessionRenewal<Agent>(
    `${API_URL}${path}`,
    {
      ...init,
      headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    },
    { apiUrl: API_URL, getToken, setSession },
  );
  if (res.status === 401) {
    clearSession();
    onUnauthorized?.();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export function acctCompanies(): Promise<AcctCompany[]> {
  return acctFetch<AcctCompany[]>('/api/jupiter/acct/companies');
}
export function acctSummary(month?: string): Promise<AcctSummary> {
  return acctFetch<AcctSummary>(`/api/jupiter/acct/summary${month ? `?month=${month}` : ''}`);
}
export function acctTxns(params: { company?: string; month?: string; direction?: Direction; limit?: number } = {}): Promise<AcctTxn[]> {
  const qs = new URLSearchParams();
  if (params.company) qs.set('company', params.company);
  if (params.month) qs.set('month', params.month);
  if (params.direction) qs.set('direction', params.direction);
  if (params.limit) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return acctFetch<AcctTxn[]>(`/api/jupiter/acct/txns${q ? `?${q}` : ''}`);
}
export function acctCreateTxn(body: {
  companyCode: string;
  direction: Direction;
  date?: string;
  party?: string;
  category?: string;
  amount: string;
  vatAmount?: string;
  whtAmount?: string;
  note?: string;
}): Promise<AcctTxn> {
  return acctFetch<AcctTxn>('/api/jupiter/acct/txns', { method: 'POST', body: JSON.stringify(body) });
}
export function acctDeleteTxn(id: string): Promise<{ ok: boolean }> {
  return acctFetch<{ ok: boolean }>(`/api/jupiter/acct/txns/${id}`, { method: 'DELETE' });
}
export function acctRegisters(month?: string): Promise<AcctRegisters> {
  return acctFetch<AcctRegisters>(`/api/jupiter/acct/registers${month ? `?month=${month}` : ''}`);
}
export function acctParse(text: string): Promise<{ ok: boolean; via?: 'ai' | 'heuristic'; proposed?: ProposedTxn }> {
  return acctFetch('/api/jupiter/acct/parse', { method: 'POST', body: JSON.stringify({ text }) });
}
// Phase-1b: pull every recorded Juno payment into the books as PROM income (idempotent).
export function acctSyncJuno(): Promise<{ ok: boolean; synced: number; removed: number }> {
  return acctFetch('/api/jupiter/acct/sync/juno', { method: 'POST' });
}

// ─── Punch #9: Party identity backfill (supervisor-only) ─────────────────────────────
// Populate the canonical Party + PartyIdentity spine from the deity source tables, runnable
// from the cockpit. Dry-run computes the plan (writes nothing); apply kicks off the writes in
// the background; status polls the live counts + whether an apply is still running.

// Mirror of the api Summary (api/src/scripts/backfillParties.ts).
export interface BackfillSummary {
  parties: number; // parties to create (dry) / created (apply)
  identities: Record<string, number>; // by channel
  conflicts: number;
  sampleConflicts: string[]; // ≤20 "channel key → partyA vs partyB"
}
export interface BackfillStatus {
  parties: number;
  identities: number;
  running: boolean;
}

// Dry-run: synchronous, returns the full Summary (writes nothing).
export function acctPartyBackfillDry(): Promise<BackfillSummary> {
  return acctFetch<BackfillSummary>('/api/jupiter/acct/parties/backfill/dry', { method: 'POST' });
}
// Apply: fire-and-forget on the server; returns immediately. busy:true ⇒ a run is already going.
export function acctPartyBackfillApply(): Promise<{ started: boolean; busy?: boolean }> {
  return acctFetch('/api/jupiter/acct/parties/backfill/apply', { method: 'POST' });
}
// Status: live spine counts + whether an apply is in flight (poll while running).
export function acctPartyStatus(): Promise<BackfillStatus> {
  return acctFetch<BackfillStatus>('/api/jupiter/acct/parties/status');
}

// ─── AI cost (token usage) — supervisor-only, GET /api/jupiter/token-usage ───────────
// Suite-wide king's-eye view of AI spend: how much, and what for. Mirrors the API's shape
// exactly (api/src/routes/tokenUsage.ts) — one summary + four independent groupings.

export interface TokenUsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
}
// byApp / byFeature / byModel all share this shape — `key` is the app code, feature slug,
// or model id depending on which list it's in.
export interface TokenUsageGroup {
  key: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}
export interface TokenUsageDay {
  date: string; // YYYY-MM-DD
  calls: number;
  estCostUsd: number;
}
export interface TokenUsageResponse {
  window: { from: string; to: string };
  summary: TokenUsageSummary;
  byApp: TokenUsageGroup[];
  byFeature: TokenUsageGroup[];
  byModel: TokenUsageGroup[];
  byDay: TokenUsageDay[];
}
export function tokenUsage(params: { from?: string; to?: string } = {}): Promise<TokenUsageResponse> {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const q = qs.toString();
  return acctFetch<TokenUsageResponse>(`/api/jupiter/token-usage${q ? `?${q}` : ''}`);
}

// ─── Jupiter accounting (Phase 2 double-entry ledger) — /api/jupiter/acct/* ──────────────────
// Mirrors api/src/routes/jupiterLedger.ts exactly (see docs/JUPITER_P2_PLAN.md §6). Money is
// ALWAYS a fixed two-decimal String on the wire (api/src/jupiter/ledger/money.ts) — this client
// never runs it through parseFloat/Number. All arithmetic on these strings must go through
// ./accounting/money.ts's BigInt-satang helpers, never JS floats.

export type LedgerMode = 'cockpit' | 'shadow' | 'book_of_record' | 'paper_only';
export type JournalEntryState = 'draft' | 'posted' | 'void';

export interface LedgerAccount {
  id: string;
  companyCode: string;
  code: string;
  name: string;
  accountType: string;
  accountClass: string;
  normalBalance: string;
  reconcile: boolean;
  active: boolean;
  currencyCode: string | null;
  source: string;
  sourceRef: string | null;
}

export interface LedgerJournal {
  id: string;
  companyCode: string;
  code: string;
  name: string;
  journalType: string;
  active: boolean;
  defaultAccountId: string | null;
  source: string;
  sourceRef: string | null;
}

export interface LedgerPartner {
  id: string;
  displayName: string;
  legalName: string;
  taxId: string;
  partnerType: string;
  address: string;
  partyId: string | null;
  source: string;
  sourceRef: string | null;
}

export interface LedgerTax {
  id: string;
  companyCode: string;
  name: string;
  description: string;
  taxKind: string;
  usage: string;
  amountType: string;
  rate: string; // toFixed(6) on the wire
  priceIncluded: boolean;
  active: boolean;
  source: string;
  sourceRef: string | null;
}

export interface LedgerLineTax {
  id: string;
  lineId: string;
  taxId: string;
  role: 'applied' | 'tax_line';
  baseAmount: string | null;
  taxAmount: string | null;
  tax?: LedgerTax;
}

export interface LedgerLine {
  id: string;
  entryId: string;
  lineNo: number;
  accountId: string;
  partnerId: string | null;
  label: string;
  debit: string;
  credit: string;
  amountCurrency: string | null;
  currencyCode: string | null;
  maturityDate: string | null;
  reconciled: boolean;
  externalReconcileRef: string | null;
  sourceRef: string | null;
  account: LedgerAccount;
  partner: LedgerPartner | null;
  taxes: LedgerLineTax[];
}

export interface JournalEntryRef {
  id: string;
  entryNo: string | null;
}

export interface JournalEntry {
  id: string;
  companyCode: string;
  journalId: string;
  entryNo: string | null;
  entryDate: string; // YYYY-MM-DD
  state: JournalEntryState;
  entryType: string;
  ref: string;
  memo: string;
  partnerId: string | null;
  documentNo: string;
  documentDate: string | null;
  dueDate: string | null;
  paymentReference: string;
  paymentState: string;
  taxInvoiceNo: string;
  taxInvoiceDate: string | null;
  whtCertificateNo: string;
  currencyCode: string;
  version: number;
  source: string;
  sourceRef: string | null;
  sourceSnapshotRef: string | null;
  originTxnId: string | null;
  reversalOfId: string | null;
  createdById: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  postedById: string | null;
  postedByName: string;
  postedAt: string | null;
  voidedAt: string | null;
  journal: LedgerJournal;
  partner: LedgerPartner | null;
  reversalOf: JournalEntryRef | null;
  reversedBy: JournalEntryRef | null;
  lines: LedgerLine[];
}

export interface JournalLineTaxInput {
  taxId: string;
  role?: 'applied' | 'tax_line';
  baseAmount?: string | null;
  taxAmount?: string | null;
}
export interface JournalLineInput {
  lineNo: number;
  accountId: string;
  partnerId?: string | null;
  label?: string;
  debit: string; // two-decimal String, non-negative
  credit: string; // two-decimal String, non-negative
  taxes?: JournalLineTaxInput[];
}
export interface JournalEntryInput {
  companyCode: string;
  journalId: string;
  entryDate: string;
  ref?: string;
  memo?: string;
  partnerId?: string | null;
  documentNo?: string;
  documentDate?: string | null;
  dueDate?: string | null;
  paymentReference?: string;
  taxInvoiceNo?: string;
  taxInvoiceDate?: string | null;
  whtCertificateNo?: string;
  lines: JournalLineInput[];
}

// Ledger-route errors surface a machine `code` (the LedgerPostingError/LedgerMoneyError code
// from the API, e.g. "unbalanced_entry", "stale_version") plus its message, so callers can show
// a translated Thai sentence instead of "HTTP 409".
export class LedgerApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, code?: string, message?: string) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function ledgerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithSessionRenewal<Agent>(
    `${API_URL}${path}`,
    { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) } },
    { apiUrl: API_URL, getToken, setSession },
  );
  if (res.status === 401) {
    clearSession();
    onUnauthorized?.();
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    let code: string | undefined;
    let message: string | undefined;
    try {
      const body = await res.clone().json() as { error?: string; message?: string };
      code = body.error;
      message = body.message;
    } catch {
      // non-JSON error body — fall through to the generic HTTP status
    }
    throw new LedgerApiError(res.status, code, message);
  }
  return res.json() as Promise<T>;
}

export function ledgerAccounts(company: string, active?: boolean): Promise<LedgerAccount[]> {
  const qs = new URLSearchParams({ company });
  if (active !== undefined) qs.set('active', String(active));
  return ledgerFetch(`/api/jupiter/acct/accounts?${qs}`);
}
export function ledgerJournals(company: string, active?: boolean): Promise<LedgerJournal[]> {
  const qs = new URLSearchParams({ company });
  if (active !== undefined) qs.set('active', String(active));
  return ledgerFetch(`/api/jupiter/acct/journals?${qs}`);
}
export function ledgerPartners(params: { search?: string; limit?: number } = {}): Promise<LedgerPartner[]> {
  const qs = new URLSearchParams();
  if (params.search) qs.set('search', params.search);
  if (params.limit) qs.set('limit', String(params.limit));
  const q = qs.toString();
  return ledgerFetch(`/api/jupiter/acct/partners${q ? `?${q}` : ''}`);
}
export function ledgerTaxes(company: string, active?: boolean): Promise<LedgerTax[]> {
  const qs = new URLSearchParams({ company });
  if (active !== undefined) qs.set('active', String(active));
  return ledgerFetch(`/api/jupiter/acct/taxes?${qs}`);
}

export interface LedgerEntryListParams {
  company?: string;
  from?: string;
  to?: string;
  state?: JournalEntryState;
  journal?: string;
  account?: string;
  limit?: number;
  cursor?: string;
}
export interface LedgerEntryPage {
  items: JournalEntry[];
  nextCursor: string | null;
}
export function ledgerEntries(params: LedgerEntryListParams = {}): Promise<LedgerEntryPage> {
  const qs = new URLSearchParams();
  if (params.company) qs.set('company', params.company);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.state) qs.set('state', params.state);
  if (params.journal) qs.set('journal', params.journal);
  if (params.account) qs.set('account', params.account);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.cursor) qs.set('cursor', params.cursor);
  const q = qs.toString();
  return ledgerFetch(`/api/jupiter/acct/entries${q ? `?${q}` : ''}`);
}
export function ledgerEntry(id: string): Promise<JournalEntry> {
  return ledgerFetch(`/api/jupiter/acct/entries/${id}`);
}
export function ledgerCreateEntry(body: JournalEntryInput): Promise<JournalEntry> {
  return ledgerFetch('/api/jupiter/acct/entries', { method: 'POST', body: JSON.stringify(body) });
}
export function ledgerUpdateEntry(id: string, body: JournalEntryInput & { version: number }): Promise<JournalEntry> {
  return ledgerFetch(`/api/jupiter/acct/entries/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}
export function ledgerPostEntry(id: string, version: number): Promise<JournalEntry> {
  return ledgerFetch(`/api/jupiter/acct/entries/${id}/post`, { method: 'POST', body: JSON.stringify({ version }) });
}
export function ledgerReverseEntry(id: string, body: { version: number; reversalDate: string; reason: string }): Promise<JournalEntry> {
  return ledgerFetch(`/api/jupiter/acct/entries/${id}/reverse`, { method: 'POST', body: JSON.stringify(body) });
}
export function ledgerVoidEntry(id: string, body: { version: number; reason?: string }): Promise<JournalEntry> {
  return ledgerFetch(`/api/jupiter/acct/entries/${id}/void`, { method: 'POST', body: JSON.stringify(body) });
}

export interface LedgerSettingsResult { code: string; mode: LedgerMode; cutoverDate: string | null; lockDate: string | null }
export function ledgerUpdateCompanySettings(
  code: string,
  body: { mode?: LedgerMode; cutoverDate?: string | null; lockDate?: string | null; reason?: string },
): Promise<LedgerSettingsResult> {
  return ledgerFetch(`/api/jupiter/acct/companies/${code}/ledger-settings`, { method: 'PATCH', body: JSON.stringify(body) });
}

// ─── CPA-facing reports (GL / trial balance / partner ledger) ───────────────────────────────
export interface GlRow {
  date: string; entryId: string; entryNo: string | null; journalCode: string; ref: string;
  lineNo: number; lineId: string; accountId: string; rescueAccountId: string; accountCode: string; accountName: string;
  partnerId: string | null; rescuePartnerId: string | null; partnerName: string; label: string;
  debit: string; credit: string; parentState: string; rescueMoveId: string; rescueLineId: string;
}
export interface TrialBalanceRow {
  accountId: string; accountCode: string; accountName: string; rescueAccountId: string;
  openingBalance: string; periodDebit: string; periodCredit: string; closingBalance: string; lineCount: number;
}
export interface PartnerLedgerRow {
  rowType: string; partnerId: string | null; rescuePartnerId: string | null; partnerName: string; date: string;
  moveId: string; rescueMoveId: string; moveName: string | null; moveRef: string; accountId: string;
  rescueAccountId: string; accountCode: string; accountName: string; lineName: string;
  debit: string; credit: string; openingBalance: string; balance: string; lineId: string; rescueLineId: string; parentState: string;
}
export interface LedgerReportParams { company: string; from?: string; to?: string }

function reportQs(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  return qs.toString();
}
export function ledgerReportGl(params: LedgerReportParams & { state?: JournalEntryState }): Promise<{ company: string; rows: GlRow[] }> {
  return ledgerFetch(`/api/jupiter/acct/reports/gl?${reportQs({ ...params, format: 'json' })}`);
}
export function ledgerReportTrialBalance(params: LedgerReportParams): Promise<{ company: string; rows: TrialBalanceRow[] }> {
  return ledgerFetch(`/api/jupiter/acct/reports/trial-balance?${reportQs({ ...params, format: 'json' })}`);
}
export function ledgerReportPartnerLedger(params: LedgerReportParams & { partnerId?: string }): Promise<{ company: string; rows: PartnerLedgerRow[] }> {
  return ledgerFetch(`/api/jupiter/acct/reports/partner-ledger?${reportQs({ ...params, format: 'json' })}`);
}

export type LedgerReportKind = 'gl' | 'trial-balance' | 'partner-ledger';
// One-click CSV export (same convention as juno's downloadCsv): fetch with auth, then download
// client-side as a Blob so the bearer token never rides in a plain <a href>.
export async function ledgerDownloadReportCsv(
  kind: LedgerReportKind,
  params: Record<string, string | undefined>,
  filename: string,
): Promise<void> {
  const res = await fetchWithSessionRenewal<Agent>(
    `${API_URL}/api/jupiter/acct/reports/${kind}?${reportQs({ ...params, format: 'csv' })}`,
    undefined,
    { apiUrl: API_URL, getToken, setSession },
  );
  if (res.status === 401) {
    clearSession();
    onUnauthorized?.();
    throw new Error('unauthorized');
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
