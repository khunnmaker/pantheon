import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LogOut, Search, Download, Flag, FileText, Inbox, BarChart3, Scale,
  Loader2, AlertTriangle, CheckCircle2, X, RefreshCw, ExternalLink, Ban, Crown, Printer,
  Undo2, ClipboardCheck, CheckCheck, Banknote, Plus, Paperclip, Check, Trash2, HandCoins, Percent,
  PenLine, FileCheck,
} from 'lucide-react';

// Portal-back link (Jupiter). URL from build-time env; the link is hidden when unset, so it
// is completely inert until VITE_PORTAL_URL is configured (Phase 1 go-live / Phase 2 domains).
const PORTAL_URL: string | undefined = import.meta.env.VITE_PORTAL_URL;
import {
  getSummary, getPayments, setStatus, setFlag, verifyPayment, getReport, downloadCsv, baht,
  logout, getBankSummary, createPayment, settlePayment, uploadSlip, fileToBase64, readManualSlip,
  deletePayment, confirmReceived, getWhtSummary, updatePayment,
  type Agent, type Payment, type PaymentStatus, type Summary,
  type Report, type PaymentFilter, type CustomerType, type PaymentSource, type SettleState,
  type WhtRate, type WhtSummary, type EditPaymentBody,
} from './lib/api';
import PrintCovers from './PrintCovers';
import Recon from './Recon';
import ReRecon from './ReRecon';
import AppSwitcher from './AppSwitcher';

// No ใบกำกับภาษี tab: Prominent issues a tax invoice on EVERY sale (in Express, as part of
// recording), so a "requested" queue would contain everything and filter nothing. The invoice
// details captured off the slip flow (name/address/tax-ID) still show in the drawer.
// 'receive' = CEO-only "รอยืนยันรับเงิน" (task 1): unconfirmed cash/cheque awaiting the CEO's
// physical receipt confirmation — separate from เงินสด/เช็ค settle state, folded into inbox/flags.
// 'wht' = หัก ณ ที่จ่าย (WHT, task 2): every withheld payment — visible to ALL Juno users
// (not CEO-only, unlike 'reports'/'receive').
// 'reRecon' = กระทบยอด RE: the Express ARRCPDAT.TXT (AR-receipt) import + live RE-vs-Payment
// cross-check — visible to ALL Juno users (only the นำเข้าไฟล์ RE upload inside it is CEO-only,
// same isCeo-gated-control-within-an-open-tab pattern as 'recon's ImportPanel).
type View = 'inbox' | 'flags' | 'reports' | 'recon' | 'receive' | 'wht' | 'reRecon';

// Withholding tax (task 2) rate options — 0 (ไม่มี) plus the Thai statutory rates FIN picks
// from in the ตรวจแล้ว dialog. Mirrors the server's WHT_RATES (api/src/routes/juno.ts).
const WHT_RATES: WhtRate[] = [0, 1, 2, 3, 5];
const DEFAULT_WHT_RATE: WhtRate = 3; // owner spec: default to 3% once WHT is turned on
// 2dp round to the nearest satang — matches the house `amountsEqual` convention server-side.
const round2 = (n: number): number => Math.round(n * 100) / 100;

// Thai-locale date/time display for the inbox + drawer (house pattern, vulcan/src/Stock.tsx).
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' });
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });

// บันทึกแล้ว → ยืนยันใน Express: the real last step is the owner confirming the RE as paid
// in Express over the weekend, not merely "recorded" — the label now matches that step.
const STATUS_META: Record<PaymentStatus, { label: string; cls: string }> = {
  received: { label: 'รอตรวจ', cls: 'bg-slate-100 text-slate-600' },
  verified: { label: 'ตรวจแล้ว', cls: 'bg-sky-100 text-sky-700' },
  recorded: { label: 'ยืนยันใน Express', cls: 'bg-emerald-100 text-emerald-700' },
  void: { label: 'ยกเลิก', cls: 'bg-slate-200 text-slate-500 line-through' },
};
const CUSTOMER_TYPES: CustomerType[] = ['โอนก่อนส่ง', 'เครดิต', 'เก็บปลายทาง'];
function Badge({ children, cls }: { children: React.ReactNode; cls: string }) {
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>{children}</span>;
}

// ช่องทาง (payment-method) list cell — transfer shows the bank name (unchanged from before);
// cash/cheque show their method label plus, until the CEO confirms receipt, a รอยืนยัน badge.
// The badge tracks the RECEIPT gate (task 1), not the ฝาก/เคลียร์ deposit state — under owner
// decision A (2026-07-06) the deposit is optional and lives in the drawer, so the list surfaces
// the one thing that actually blocks "done": the CEO's ได้รับแล้ว confirm.
function MethodCell({ p }: { p: Payment }) {
  const awaitingReceive = !p.receivedAt && p.status !== 'void';
  if (p.source === 'cash') {
    return (
      <div className="flex items-center gap-1 max-w-[120px]">
        <span className="truncate">เงินสด</span>
        {awaitingReceive && <Badge cls="bg-amber-100 text-amber-700">รอยืนยัน</Badge>}
      </div>
    );
  }
  if (p.source === 'cheque') {
    return (
      <div className="flex items-center gap-1 max-w-[120px]">
        <span className="truncate" title={p.chequeBank ? `เช็ค · ${p.chequeBank}` : 'เช็ค'}>
          {p.chequeBank ? `เช็ค · ${p.chequeBank}` : 'เช็ค'}
        </span>
        {awaitingReceive && <Badge cls="bg-amber-100 text-amber-700">รอยืนยัน</Badge>}
      </div>
    );
  }
  // line / manual_transfer — unchanged bank-name treatment
  return <div className="max-w-[110px] truncate" title={p.bank}>{p.bank}</div>;
}

export default function Juno({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const [view, setView] = useState<View>('inbox');
  const [summary, setSummary] = useState<Summary | null>(null);
  // CEO-only actions (mirrors the server's supervisor gate in api/src/routes/juno.ts): reports,
  // CSV export, bank-file import, clearing a flag, and hard delete. Finance (employee) + MD get
  // everything else — slip work, reconciliation, void, raising a flag. Hidden here so those
  // controls never appear rather than 403ing on click.
  const isCeo = agent.role === 'supervisor';
  // ลบถาวร (permanent delete) is the CEO-only override — even md, who can now open Juno,
  // cannot delete. Mirrors the server's `req.agent?.role !== 'supervisor'` gate exactly.
  const canDelete = isCeo;
  // unmatched-in bank txn count — the badge on the กระทบยอด tab (phase B)
  const [bankUnmatched, setBankUnmatched] = useState<number | undefined>(undefined);

  const refreshSummary = useCallback(() => {
    getSummary().then(setSummary).catch(() => setSummary(null));
    getBankSummary().then((s) => setBankUnmatched(s.unmatchedIn.count)).catch(() => setBankUnmatched(undefined));
  }, []);
  useEffect(() => { refreshSummary(); }, [refreshSummary]);

  const tabs: { key: View; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: 'inbox', label: 'รายการรับเงิน', icon: <Inbox size={16} />, count: summary?.total },
    // หัก ณ ที่จ่าย (WHT, task 2) — visible to EVERY Juno user (not CEO-gated, unlike รอยืนยัน
    // รับเงิน/รายงาน below): list + period totals only, no certificate tracking. Its own totals
    // bar (fetched inside PaymentsView) covers the count, so no badge here.
    { key: 'wht', label: 'หัก ณ ที่จ่าย', icon: <Percent size={16} /> },
    // รอยืนยันรับเงิน is CEO-only (server 403s POST /receive for non-supervisor; the confirm
    // action itself mirrors the delete gate) — omit the tab for finance/MD so it's never shown.
    ...(isCeo ? [{ key: 'receive' as const, label: 'รอยืนยันรับเงิน', icon: <HandCoins size={16} />, count: summary?.awaitingReceive }] : []),
    { key: 'flags', label: 'ปักธง', icon: <Flag size={16} />, count: summary?.flagged },
    { key: 'recon', label: 'กระทบยอด', icon: <Scale size={16} />, count: bankUnmatched },
    // กระทบยอด RE — visible to EVERY Juno user (only the นำเข้าไฟล์ RE upload inside it is
    // CEO-only, same as 'recon's ImportPanel). Match status is computed live, so no badge
    // count here (its own totals bar inside ReRecon covers the summary).
    { key: 'reRecon', label: 'กระทบยอด RE', icon: <FileCheck size={16} /> },
    // รายงาน is CEO-only (server 403s /reports + /export.csv for non-supervisor) — omit the tab
    // for finance/MD so it's never shown. Their default tab (inbox) is one they can use.
    ...(isCeo ? [{ key: 'reports' as const, label: 'รายงาน', icon: <BarChart3 size={16} /> }] : []),
  ];

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 text-emerald-700">
            <AppSwitcher agent={agent} />
            <span className="text-slate-400 text-sm hidden sm:inline">· ระบบการเงิน</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {PORTAL_URL && (
              <a href={PORTAL_URL} title="กลับพอร์ทัล Jupiter" className="flex items-center gap-1 text-slate-500 hover:text-violet-600">
                <Crown size={15} /> <span className="hidden sm:inline">พอร์ทัล</span>
              </a>
            )}
            <span className="text-slate-500 hidden sm:inline">{agent.name}</span>
            <button onClick={() => { void logout(); onLogout(); }} className="flex items-center gap-1 text-slate-500 hover:text-rose-600">
              <LogOut size={15} /> ออก
            </button>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-4 flex gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setView(t.key)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap ${
                view === t.key ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {t.icon} {t.label}
              {typeof t.count === 'number' && t.count > 0 && (
                <span className={`ml-1 px-1.5 rounded-full text-xs ${t.key === 'flags' || t.key === 'recon' || t.key === 'receive' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600'}`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4">
        {view === 'reports' && isCeo ? (
          <Reports />
        ) : view === 'recon' ? (
          <Recon isCeo={isCeo} />
        ) : view === 'reRecon' ? (
          <ReRecon isCeo={isCeo} />
        ) : (
          <PaymentsView view={view === 'reports' ? 'inbox' : view} onChanged={refreshSummary} canDelete={canDelete} isCeo={isCeo} />
        )}
      </main>
    </div>
  );
}

// ── Payments list + detail (inbox / flags share this) ──────────────────────
function PaymentsView({ view, onChanged, canDelete, isCeo }: { view: Exclude<View, 'reports' | 'recon' | 'reRecon'>; onChanged: () => void; canDelete: boolean; isCeo: boolean }) {
  const [q, setQ] = useState('');
  const [status, setStatusFilter] = useState<'all' | PaymentStatus>('all');
  // วิธีรับเงิน (payment-method) filter — inbox only, folds the old separate เงินสด/เช็ค tab
  // into this one list (owner decision 2026-07-06): ทุกวิธี / ธนาคาร (transfer) / เงินสด / เช็ค.
  const [method, setMethod] = useState<'all' | 'transfer' | 'cash' | 'cheque'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Payment | null>(null);
  // non-null → render the print overlay (see PrintCovers) instead of the inbox
  const [printQueue, setPrintQueue] = useState<Payment[] | null>(null);
  // + เพิ่มรายการ modal (inbox only — hand-add a โอนเงิน/เงินสด/เช็คธนาคาร payment)
  const [addOpen, setAddOpen] = useState(false);
  // row multi-select (checkbox column): a Set of payment ids, cleared on reload/filter/tab switch
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  // non-null → render the batch-check queue (see BatchCheckDialog) instead of the list
  const [batchQueue, setBatchQueue] = useState<Payment[] | null>(null);
  // bulk-action bar: running state + a brief result line ("สำเร็จ X/N")
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState('');
  // inline "ยืนยันการยกเลิก N รายการ?" confirm before batch-void runs
  const [bulkVoidConfirm, setBulkVoidConfirm] = useState(false);
  // inline "ลบถาวร N รายการ — กู้คืนไม่ได้" confirm before batch-delete runs (CEO-only)
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  // หัก ณ ที่จ่าย (WHT, task 2) totals bar — fetched alongside the list on the wht tab only.
  const [whtSummary, setWhtSummary] = useState<WhtSummary | null>(null);

  const filter: PaymentFilter = {
    q: q.trim() || undefined,
    from: from || undefined,
    to: to || undefined,
    // the flags tab is a pre-filtered queue; the inbox honours the status + วิธีรับเงิน dropdowns
    ...(view === 'flags' ? { flagged: true } : {}),
    ...(view === 'inbox' ? { status } : {}),
    ...(view === 'inbox' && method !== 'all' ? { source: method } : {}),
    // รอยืนยันรับเงิน tab (task 1): a fixed queue — no extra filters, just the pending list.
    ...(view === 'receive' ? { pendingReceive: true } : {}),
    // หัก ณ ที่จ่าย tab (task 2): every withheld payment, still honouring the from/to date pickers.
    ...(view === 'wht' ? { wht: true } : {}),
  };

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getPayments(filter)
      .then((r) => {
        setRows(r.payments);
        // keep the open drawer's data in sync with the freshly fetched row (a refresh
        // shouldn't leave `selected` showing stale status/flag/tax state)
        setSelected((prev) => (prev ? r.payments.find((x) => x.id === prev.id) ?? prev : null));
      })
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, q, status, method, from, to]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce the search box
    return () => clearTimeout(t);
  }, [load]);

  // หัก ณ ที่จ่าย (WHT, task 2) totals bar — only fetched on the wht tab, refreshed with the
  // same from/to date pickers as the list (independent of q/status/method, which the summary
  // endpoint doesn't take).
  useEffect(() => {
    if (view !== 'wht') { setWhtSummary(null); return; }
    let cancelled = false;
    getWhtSummary(from || undefined, to || undefined)
      .then((s) => { if (!cancelled) setWhtSummary(s); })
      .catch(() => { if (!cancelled) setWhtSummary(null); });
    return () => { cancelled = true; };
  }, [view, from, to]);

  // Close the drawer on tab switch — otherwise a foreign payment stays open beside the wrong queue.
  useEffect(() => setSelected(null), [view]);

  // Row checkboxes are cleared whenever the list reloads/filters change or the tab switches —
  // a stale selection referring to rows no longer on screen would be confusing/dangerous for
  // bulk actions (owner requirement).
  useEffect(() => { setCheckedIds(new Set()); setBulkResult(''); setBulkVoidConfirm(false); setBulkDeleteConfirm(false); }, [view, q, status, method, from, to]);

  // Reflect a drawer action back into the list + selected row without a full reload.
  function applyUpdate(p: Payment) {
    setSelected(p);
    // a row may drop out of the pre-filtered flag queue (unflagged) or the รอยืนยันรับเงิน
    // queue (just confirmed received) → refetch it rather than leave a stale row showing
    if ((view === 'flags' && !p.flagged) || (view === 'receive' && !!p.receivedAt)) {
      load();
    } else {
      setRows((prev) => prev.map((r) => (r.id === p.id ? p : r)));
    }
    onChanged();
  }

  // Reflect a drawer ลบถาวร back into the list: unlike applyUpdate, the row is GONE — drop it
  // from `rows`, drop it from any bulk selection, and close the drawer (there's no updated
  // payment to show anymore).
  function applyDelete(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setCheckedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setSelected(null);
    onChanged();
  }

  // The daily flow: filter today + ตรวจแล้ว → one click prints the whole stack. One cover per
  // RECEIPT now — a receipt paying several RE prints a single sheet listing them all (owner
  // decision 2026-07-06, see PrintCovers) — so the toolbar count is just the printable-row count.
  const verifiedInView = rows.filter((r) => r.status === 'verified' && r.reNumbers.length > 0);
  const coverCountInView = verifiedInView.length;

  // ── Row multi-select + bulk actions ───────────────────────────────────────
  const checkedRows = rows.filter((r) => checkedIds.has(r.id));
  const checkableRows = checkedRows.filter((r) => r.status !== 'void' && r.status !== 'recorded');
  const printableRows = checkedRows.filter((r) => r.reNumbers.length > 0);
  const allVisibleChecked = rows.length > 0 && rows.every((r) => checkedIds.has(r.id));

  // Note: the checkbox's own onClick (below, at the call site) stops propagation so checking
  // a row never opens its drawer — this toggle is purely the Set update.
  function toggleRow(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllVisible() {
    setCheckedIds((prev) => {
      if (rows.length > 0 && rows.every((r) => prev.has(r.id))) return new Set();
      return new Set(rows.map((r) => r.id));
    });
  }
  function clearSelection() {
    setCheckedIds(new Set());
    setBulkVoidConfirm(false);
    setBulkDeleteConfirm(false);
    setBulkResult('');
  }

  // Runs `fn` over every selected row with Promise.allSettled, then reloads + clears selection.
  // Shared by bulk flag/clear-flag and bulk void.
  async function runBulk(targets: Payment[], fn: (p: Payment) => Promise<unknown>) {
    if (targets.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkResult('');
    const results = await Promise.allSettled(targets.map((p) => fn(p)));
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    setBulkResult(`สำเร็จ ${okCount}/${targets.length}`);
    setBulkBusy(false);
    setBulkVoidConfirm(false);
    setBulkDeleteConfirm(false);
    setCheckedIds(new Set());
    load();
    onChanged();
  }

  function bulkPrint() {
    if (printableRows.length === 0) return;
    setPrintQueue(printableRows);
  }
  function bulkFlagToggle() {
    const flaggingOff = view === 'flags';
    void runBulk(checkedRows, (p) => setFlag(p.id, !flaggingOff));
  }
  function bulkVoid() {
    if (!bulkVoidConfirm) {
      setBulkVoidConfirm(true);
      return;
    }
    void runBulk(checkedRows, (p) => setStatus(p.id, 'void'));
  }
  // CEO-only: true hard delete (contrast with bulkVoid, a soft-delete). Server 403s anyone
  // but supervisor, but the button itself is hidden below unless canDelete anyway.
  function bulkDelete() {
    if (!bulkDeleteConfirm) {
      setBulkDeleteConfirm(true);
      return;
    }
    void runBulk(checkedRows, (p) => deletePayment(p.id));
  }

  if (printQueue) {
    return <PrintCovers payments={printQueue} onDone={() => setPrintQueue(null)} />;
  }

  if (batchQueue) {
    return (
      <BatchCheckDialog
        payments={batchQueue}
        onDone={() => {
          setBatchQueue(null);
          setCheckedIds(new Set());
          load();
          onChanged();
        }}
      />
    );
  }

  return (
    <>
      {/* Toolbar spans the full width ABOVE the list+detail row, so opening a receipt
          (which narrows the list column) never shrinks or shifts the search/filter bar. */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 mb-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="ค้นหา ชื่อ / รหัส / อ้างอิง / ธนาคาร"
              className="w-full pl-8 pr-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          {view === 'inbox' && (
            <select
              value={status}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | PaymentStatus)}
              className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white"
            >
              <option value="all">ทุกสถานะ</option>
              {(['received', 'verified', 'recorded', 'void'] as PaymentStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>
          )}
          {view === 'inbox' && (
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as 'all' | 'transfer' | 'cash' | 'cheque')}
              className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white"
              title="วิธีรับเงิน"
            >
              <option value="all">ทุกวิธี</option>
              <option value="transfer">ธนาคาร</option>
              <option value="cash">เงินสด</option>
              <option value="cheque">เช็ค</option>
            </select>
          )}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="px-2 py-2 rounded-lg border border-slate-300 text-sm" title="ตั้งแต่วันที่" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="px-2 py-2 rounded-lg border border-slate-300 text-sm" title="ถึงวันที่" />
          <button onClick={load} className="p-2 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50" title="รีเฟรช">
            <RefreshCw size={15} />
          </button>
          {/* Stays visible on the inbox regardless of the วิธีรับเงิน filter — it just disables
              (greys out) when the current filter has nothing verified-with-RE to print, so it
              never silently disappears when you switch method (owner report 2026-07-06). */}
          {view === 'inbox' && (
            <button
              onClick={() => setPrintQueue(verifiedInView)}
              disabled={verifiedInView.length === 0}
              className="flex items-center gap-1 px-3 py-2 rounded-lg bg-sky-600 text-white text-sm hover:bg-sky-700 disabled:opacity-40 disabled:hover:bg-sky-600 disabled:cursor-not-allowed"
              title={verifiedInView.length === 0
                ? 'ยังไม่มีรายการที่ตรวจแล้ว (มีเลข RE) ในตัวกรองนี้ — ตรวจรายการก่อนจึงจะพิมพ์ใบปะหน้าได้'
                : 'พิมพ์ใบปะหน้าทุกรายการที่ตรวจแล้วในรายการที่กรองอยู่นี้ (ใบละ 1 ใบเสร็จ)'}
            >
              <Printer size={15} /> พิมพ์ใบปะหน้า ({coverCountInView})
            </button>
          )}
          {/* CSV export is CEO-only (server 403s /export.csv for non-supervisor) — hidden for finance/MD */}
          {isCeo && (
            <button
              onClick={() => downloadCsv(filter).catch(() => setError('ดาวน์โหลดไม่สำเร็จ'))}
              className="flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-800 text-white text-sm hover:bg-slate-700"
            >
              <Download size={15} /> CSV
            </button>
          )}
          {view === 'inbox' && (
            <button
              onClick={() => setAddOpen(true)}
              className="flex items-center gap-1 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700"
            >
              <Plus size={15} /> เพิ่มรายการ
            </button>
          )}
      </div>

      {/* หัก ณ ที่จ่าย (WHT, task 2) period totals bar — list + totals only, no certificate
          tracking. Mirrors the Reports view's card style; honours the same from/to filters
          as the list above it. */}
      {view === 'wht' && whtSummary && (
        <div className="bg-white rounded-xl border border-slate-200 p-3 mb-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <div className="text-xs text-slate-400">จำนวนรายการ</div>
            <div className="text-lg font-bold">{whtSummary.count}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">รวมยอดเต็ม</div>
            <div className="text-lg font-bold text-slate-700">{baht(whtSummary.gross)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">รวมหัก ณ ที่จ่าย</div>
            <div className="text-lg font-bold text-amber-700">{baht(whtSummary.wht)}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">รวมสุทธิ</div>
            <div className="text-lg font-bold text-emerald-700">{baht(whtSummary.net)}</div>
          </div>
        </div>
      )}

      {/* Bulk-action bar — appears only when ≥1 row is checked. Sticky just below the app's own
          sticky header (title bar + tabs, ~104px — same offset Detail's drawer already uses)
          so it stays visible without overlapping the tabs row. */}
      {checkedIds.size > 0 && (
        <div className="sticky top-[104px] z-10 bg-emerald-700 text-white rounded-xl px-3 py-2 mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold whitespace-nowrap">เลือก {checkedIds.size} รายการ</span>
          <button
            onClick={bulkPrint}
            disabled={bulkBusy || printableRows.length === 0}
            title={printableRows.length === 0 ? 'ไม่มีรายการที่เลือกซึ่งมีเลข RE' : undefined}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-40 disabled:hover:bg-white/10"
          >
            <Printer size={14} /> พิมพ์ใบปะหน้า
          </button>
          {checkableRows.length > 0 && (
            <button
              onClick={() => setBatchQueue(checkableRows)}
              disabled={bulkBusy}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-40"
            >
              <ClipboardCheck size={14} /> ตรวจแล้ว
            </button>
          )}
          {/* Bulk flag: on the flags tab this CLEARS (เคลียร์ธง) — CEO-only, mirrors the server's
              flagged===false supervisor gate. Elsewhere it RAISES (ปักธง), which finance may do.
              So the button is hidden on the flags tab for non-CEO, kept on the others. */}
          {(view !== 'flags' || isCeo) && (
            <button
              onClick={bulkFlagToggle}
              disabled={bulkBusy}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-40"
            >
              <Flag size={14} /> {view === 'flags' ? 'เคลียร์ธง' : 'ปักธง'}
            </button>
          )}
          {bulkVoidConfirm ? (
            <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-rose-900/40">
              <AlertTriangle size={14} /> ยืนยันการยกเลิก {checkedIds.size} รายการ?
              <button
                onClick={bulkVoid}
                disabled={bulkBusy}
                className="px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-500 font-semibold disabled:opacity-40"
              >
                ยืนยัน
              </button>
              <button
                onClick={() => setBulkVoidConfirm(false)}
                disabled={bulkBusy}
                className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40"
              >
                ไม่
              </button>
            </span>
          ) : (
            <button
              onClick={bulkVoid}
              disabled={bulkBusy}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-40"
            >
              <Ban size={14} /> ยกเลิก
            </button>
          )}
          {/* ลบถาวร — CEO-only, permanent, additional to (not instead of) ยกเลิก above */}
          {canDelete && (
            bulkDeleteConfirm ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-rose-900/40">
                <AlertTriangle size={14} /> ลบถาวร {checkedIds.size} รายการ — กู้คืนไม่ได้
                <button
                  onClick={bulkDelete}
                  disabled={bulkBusy}
                  className="px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-500 font-semibold disabled:opacity-40"
                >
                  ยืนยันลบ
                </button>
                <button
                  onClick={() => setBulkDeleteConfirm(false)}
                  disabled={bulkBusy}
                  className="px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40"
                >
                  ยกเลิก
                </button>
              </span>
            ) : (
              <button
                onClick={bulkDelete}
                disabled={bulkBusy}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-600/90 hover:bg-rose-600 disabled:opacity-40"
              >
                <Trash2 size={14} /> ลบถาวร
              </button>
            )
          )}
          {bulkBusy && <Loader2 size={15} className="animate-spin" />}
          {bulkResult && <span className="text-xs bg-white/10 px-2 py-1 rounded-lg">{bulkResult}</span>}
          <button
            onClick={clearSelection}
            disabled={bulkBusy}
            title="ล้างการเลือก"
            className="ml-auto p-1.5 rounded-lg hover:bg-white/20 disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>
      )}

      <div className="flex gap-4">
        <div className="flex-1 min-w-0">
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {loading ? (
            <div className="p-8 text-center text-slate-400"><Loader2 className="animate-spin inline" size={20} /></div>
          ) : error ? (
            <div className="p-6 text-center text-rose-600 text-sm flex items-center justify-center gap-1">
              <AlertTriangle size={15} /> {error}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">ไม่มีรายการ</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="px-3 py-2 w-[36px]">
                    <input
                      type="checkbox"
                      checked={allVisibleChecked}
                      onChange={toggleAllVisible}
                      onClick={(e) => e.stopPropagation()}
                      title="เลือกทั้งหมดที่แสดงอยู่"
                      className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-400"
                    />
                  </th>
                  <th className="text-left font-medium px-3 py-2">วันที่</th>
                  <th className="text-left font-medium px-3 py-2">ลูกค้า</th>
                  <th className="text-right font-medium px-3 py-2">ยอด</th>
                  <th className="text-left font-medium px-3 py-2 hidden md:table-cell w-[120px]">ช่องทาง</th>
                  <th className="text-left font-medium px-3 py-2 hidden md:table-cell">RE</th>
                  <th className="text-left font-medium px-3 py-2">สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => setSelected(p)}
                    className={`border-t border-slate-100 cursor-pointer hover:bg-emerald-50/40 ${selected?.id === p.id ? 'bg-emerald-50' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={checkedIds.has(p.id)}
                        onChange={() => toggleRow(p.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-400"
                      />
                    </td>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{fmtDate(p.createdAt)}</td>
                    <td className="px-3 py-2">
                      <div className="font-bold text-[15px] text-slate-800 leading-tight">{p.customerCode || <span className="text-slate-300 font-normal">—</span>}</div>
                      <div className="text-xs text-slate-500 leading-tight">{p.customerName}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                      {baht(p.amountNum)}
                      {p.mismatch && <AlertTriangle size={13} className="inline ml-1 text-rose-500" />}
                    </td>
                    <td className="px-3 py-2 text-slate-500 hidden md:table-cell"><MethodCell p={p} /></td>
                    <td className="px-3 py-2 text-slate-500 hidden md:table-cell whitespace-nowrap">
                      {p.reNumbers.length > 0 ? (
                        <span className="max-w-[130px] truncate inline-block align-bottom" title={p.reNumbers.join(' / ')}>
                          {p.reNumbers.join(' / ')}
                        </span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <Badge cls={STATUS_META[p.status].cls}>{STATUS_META[p.status].label}</Badge>
                        {p.flagged && <Flag size={13} className="text-rose-500" />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

        {selected && (
          <Detail
            payment={selected}
            onClose={() => setSelected(null)}
            onUpdate={applyUpdate}
            onDelete={applyDelete}
            onPrint={(p) => setPrintQueue([p])}
            canDelete={canDelete}
            isCeo={isCeo}
          />
        )}
      </div>

      {addOpen && (
        <AddPaymentModal
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            load();
            onChanged();
          }}
        />
      )}
    </>
  );
}

// ── Add-payment modal (โอนเงิน / เงินสด / เช็คธนาคาร — decision 2) ───────────────
// FIN/CEO hand-add a Payment that didn't arrive via Minerva's LINE hook. Same modal style as
// CheckDialog (fixed overlay, white rounded card, click-outside to close). After save the row
// goes through the SAME RE flow as any other payment (ตรวจแล้ว / print / ยืนยันใน Express).
const METHODS: { key: Exclude<PaymentSource, 'line'>; label: string }[] = [
  { key: 'manual_transfer', label: 'โอนเงิน' },
  { key: 'cash', label: 'เงินสด' },
  { key: 'cheque', label: 'เช็คธนาคาร' },
];
function AddPaymentModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [method, setMethod] = useState<Exclude<PaymentSource, 'line'>>('manual_transfer');
  const [customerCode, setCustomerCode] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [taxInvoice, setTaxInvoice] = useState(''); // shared (all methods) — every sale gets one
  // โอนเงิน-only
  const [bank, setBank] = useState('');
  const [transferAt, setTransferAt] = useState('');
  const [ref, setRef] = useState('');
  const [senderName, setSenderName] = useState('');
  const [slipUrl, setSlipUrl] = useState('');
  const [slipName, setSlipName] = useState('');
  const [uploadingSlip, setUploadingSlip] = useState(false);
  const [readingSlip, setReadingSlip] = useState(false);
  // เช็คธนาคาร-only
  const [chequeNo, setChequeNo] = useState('');
  const [chequeBank, setChequeBank] = useState('');
  const [chequeDueDate, setChequeDueDate] = useState('');

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Flipped false on unmount (modal closed) so a slow OCR response from a stale request can't
  // clobber state after the user has already dismissed the modal.
  const liveRef = useRef(true);
  useEffect(() => () => { liveRef.current = false; }, []);

  const amountNum = parseFloat(amount.replace(/[^\d.-]/g, ''));
  const valid = Number.isFinite(amountNum) && amountNum > 0 && customerName.trim() !== '';

  async function pickSlip(file: File | undefined) {
    if (!file) return;
    setUploadingSlip(true);
    setErr('');
    try {
      const b64 = await fileToBase64(file);
      const { uploadId, url } = await uploadSlip(b64, file.name);
      setSlipUrl(url);
      setSlipName(file.name);
      setUploadingSlip(false);

      // Best-effort OCR to prefill the empty fields below — never overwrite anything the
      // user already typed, and silently do nothing on failure (staff just fills manually).
      setReadingSlip(true);
      try {
        const fields = await readManualSlip(uploadId);
        if (!liveRef.current) return; // modal closed while OCR was in flight
        setAmount((v) => v || fields.amount);
        setBank((v) => v || fields.bank);
        setTransferAt((v) => v || fields.transferAt);
        setRef((v) => v || fields.ref);
        setSenderName((v) => v || fields.senderName);
      } catch {
        // silent — OCR is a convenience, not a requirement
      } finally {
        if (liveRef.current) setReadingSlip(false);
      }
    } catch {
      if (liveRef.current) {
        setErr('แนบสลิปไม่สำเร็จ — ลองใหม่อีกครั้ง');
        setUploadingSlip(false);
      }
    }
  }

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    setErr('');
    try {
      await createPayment({
        source: method,
        customerCode: customerCode.trim(),
        customerName: customerName.trim(),
        amount: amount.trim(),
        note: note.trim() || undefined,
        taxInvoice: taxInvoice.trim() || undefined,
        ...(method === 'manual_transfer'
          ? {
              bank: bank.trim() || undefined,
              transferAt: transferAt.trim() || undefined,
              ref: ref.trim() || undefined,
              senderName: senderName.trim() || undefined,
              slipUrl: slipUrl || undefined,
            }
          : {}),
        ...(method === 'cheque'
          ? {
              chequeNo: chequeNo.trim() || undefined,
              chequeBank: chequeBank.trim() || undefined,
              chequeDueDate: chequeDueDate.trim() || undefined,
            }
          : {}),
      });
      onSaved();
    } catch (e) {
      setErr((e as Error).message === 'unauthorized' ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : 'บันทึกไม่สำเร็จ — ลองใหม่อีกครั้ง');
    } finally {
      setSaving(false);
    }
  }

  const input = 'w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400';
  const label = 'text-xs text-slate-500';

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-4 w-full max-w-md space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold text-slate-800 flex items-center gap-1.5">
          <Plus size={16} className="text-emerald-700" /> เพิ่มรายการรับเงิน
        </div>

        {/* 3-way method picker */}
        <div className="flex rounded-lg border border-slate-300 overflow-hidden">
          {METHODS.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMethod(m.key)}
              className={`flex-1 px-2 py-1.5 text-xs font-medium ${method === m.key ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {method === 'manual_transfer' ? (
          <>
            {/* โอนเงิน: led by ONE attach-slip button (Minerva's แจ้งการเงิน pattern) — pick a
                file, it uploads + best-effort OCRs into whichever fields below are still empty.
                Fields stay editable throughout (unlike Minerva, which locks OCR'd fields): a
                manual Juno entry may have no slip at all, so locking would block hand entry. */}
            <label className="flex items-center justify-center gap-2 w-full px-3 py-2.5 rounded-lg border-2 border-dashed border-emerald-300 bg-emerald-50/50 text-sm font-medium text-emerald-700 hover:bg-emerald-50 cursor-pointer disabled:opacity-50">
              {readingSlip ? (
                <><Loader2 size={16} className="animate-spin" /> กำลังอ่านสลิป…</>
              ) : uploadingSlip ? (
                <><Loader2 size={16} className="animate-spin" /> กำลังอัปโหลด…</>
              ) : slipUrl ? (
                <><Check size={16} /> แนบแล้ว: {slipName || 'สลิป'} — แตะเพื่อแนบใหม่</>
              ) : (
                <><Paperclip size={16} /> แนบสลิป</>
              )}
              <input type="file" accept="image/*" className="hidden" disabled={uploadingSlip || readingSlip}
                onChange={(e) => void pickSlip(e.target.files?.[0])} />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={label}>รหัสลูกค้า</span>
                <input value={customerCode} onChange={(e) => setCustomerCode(e.target.value)} placeholder="เช่น ร103" className={input} />
              </label>
              <label className="block">
                <span className={label}>ชื่อ</span>
                <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="ชื่อลูกค้า" className={input} />
              </label>
            </div>
            <label className="block">
              <span className={label}>ชื่อผู้โอน</span>
              <input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="ชื่อผู้โอน" className={input} />
            </label>
            <label className="block">
              <span className={label}>จำนวนเงิน</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="เช่น 1500"
                inputMode="decimal"
                className={`${input} ${amount && !(Number.isFinite(amountNum) && amountNum > 0) ? 'border-rose-300 focus:ring-rose-300' : ''}`}
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={label}>บัญชีที่รับเงิน</span>
                <input value={bank} onChange={(e) => setBank(e.target.value)} placeholder="กสิกร / ไทยพาณิชย์" className={input} />
              </label>
              <label className="block">
                <span className={label}>วันเวลาโอน</span>
                <input value={transferAt} onChange={(e) => setTransferAt(e.target.value)} placeholder="27/06/2026 14:30" className={input} />
              </label>
            </div>
            <label className="block">
              <span className={label}>เลขอ้างอิง</span>
              <input value={ref} onChange={(e) => setRef(e.target.value)} className={input} />
            </label>
          </>
        ) : (
          <>
            {/* common fields (เงินสด / เช็คธนาคาร — unchanged from before) */}
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={label}>รหัสลูกค้า</span>
                <input value={customerCode} onChange={(e) => setCustomerCode(e.target.value)} placeholder="เช่น ร103" className={input} />
              </label>
              <label className="block">
                <span className={label}>ชื่อลูกค้า</span>
                <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="ชื่อลูกค้า" className={input} />
              </label>
            </div>
            <label className="block">
              <span className={label}>จำนวนเงิน</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                className={`${input} ${amount && !(Number.isFinite(amountNum) && amountNum > 0) ? 'border-rose-300 focus:ring-rose-300' : ''}`}
              />
            </label>

            {method === 'cheque' && (
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className={label}>เลขที่เช็ค</span>
                  <input value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} className={input} />
                </label>
                <label className="block">
                  <span className={label}>ธนาคาร</span>
                  <input value={chequeBank} onChange={(e) => setChequeBank(e.target.value)} className={input} />
                </label>
                <label className="block col-span-2">
                  <span className={label}>วันที่บนเช็ค</span>
                  <input value={chequeDueDate} onChange={(e) => setChequeDueDate(e.target.value)} placeholder="เช่น 04/07/26" className={input} />
                </label>
              </div>
            )}
          </>
        )}

        {/* shared (all methods) — every sale gets a tax invoice */}
        <label className="block">
          <span className={label}>ใบกำกับภาษี</span>
          <textarea value={taxInvoice} onChange={(e) => setTaxInvoice(e.target.value)} rows={3}
            placeholder="ชื่อ / ที่อยู่ / เลขประจำตัวผู้เสียภาษี 13 หลัก (ถ้าลูกค้าขอ)"
            className={`${input} resize-none`} />
        </label>
        <label className="block">
          <span className={label}>หมายเหตุ</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)" className={input} />
        </label>

        {err && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">{err}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm">ยกเลิก</button>
          <button
            type="button"
            onClick={save}
            disabled={!valid || saving || uploadingSlip}
            className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center gap-1 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={13} />} บันทึก
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit-payment modal (แก้ไขรายละเอียด) ──────────────────────────────────────
// Fixes a typo'd DESCRIPTIVE field on an existing payment — same field set + styling as
// AddPaymentModal above, pre-filled from `payment` and PATCHing instead of POSTing. Deliberately
// excludes source/RE(check-data)/customerType/WHT/status/settle — those stay in their own
// dialogs/routes (CheckDialog, the rail buttons, CashChequeSection). Available to every Juno
// user (no isCeo/canDelete gate — see the rail button in Detail).
function EditPaymentModal({ payment, onClose, onSaved }: {
  payment: Payment; onClose: () => void; onSaved: (p: Payment) => void;
}) {
  const [customerCode, setCustomerCode] = useState(payment.customerCode);
  const [customerName, setCustomerName] = useState(payment.customerName);
  const [senderName, setSenderName] = useState(payment.senderName);
  const [amount, setAmount] = useState(payment.amount);
  const [bank, setBank] = useState(payment.bank);
  const [transferAt, setTransferAt] = useState(payment.transferAt);
  const [ref, setRef] = useState(payment.ref);
  const [salesName, setSalesName] = useState(payment.salesName);
  const [note, setNote] = useState(payment.note);
  const [taxInvoice, setTaxInvoice] = useState(payment.taxInvoice);
  // เช็คธนาคาร-only
  const [chequeNo, setChequeNo] = useState(payment.chequeNo);
  const [chequeBank, setChequeBank] = useState(payment.chequeBank);
  const [chequeDueDate, setChequeDueDate] = useState(payment.chequeDueDate);

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Flipped false on unmount so a slow save response after the modal is dismissed can't set
  // state on an unmounted component — mirrors AddPaymentModal's liveRef guard.
  const liveRef = useRef(true);
  useEffect(() => () => { liveRef.current = false; }, []);

  const amountNum = parseFloat(amount.replace(/[^\d.-]/g, ''));
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  const valid = amountValid && customerName.trim() !== '';
  const amountChanged = amount.trim() !== payment.amount;

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    setErr('');
    try {
      const patch: EditPaymentBody = {
        customerCode: customerCode.trim(),
        customerName: customerName.trim(),
        senderName: senderName.trim(),
        amount: amount.trim(),
        bank: bank.trim(),
        transferAt: transferAt.trim(),
        ref: ref.trim(),
        salesName: salesName.trim(),
        note: note.trim(),
        taxInvoice: taxInvoice.trim(),
        ...(payment.source === 'cheque'
          ? { chequeNo: chequeNo.trim(), chequeBank: chequeBank.trim(), chequeDueDate: chequeDueDate.trim() }
          : {}),
      };
      const { payment: updated } = await updatePayment(payment.id, patch);
      if (!liveRef.current) return;
      onSaved(updated);
    } catch (e) {
      if (!liveRef.current) return;
      setErr((e as Error).message === 'unauthorized' ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : 'บันทึกไม่สำเร็จ — ลองใหม่อีกครั้ง');
    } finally {
      if (liveRef.current) setSaving(false);
    }
  }

  const input = 'w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400';
  const label = 'text-xs text-slate-500';

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-4 w-full max-w-md space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold text-slate-800 flex items-center gap-1.5">
          <PenLine size={16} className="text-emerald-700" /> แก้ไขรายละเอียด
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={label}>รหัสลูกค้า</span>
            <input value={customerCode} onChange={(e) => setCustomerCode(e.target.value)} placeholder="เช่น ร103" className={input} />
          </label>
          <label className="block">
            <span className={label}>ชื่อลูกค้า</span>
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="ชื่อลูกค้า" className={input} />
          </label>
        </div>
        <label className="block">
          <span className={label}>ผู้โอน</span>
          <input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="ชื่อผู้โอน" className={input} />
        </label>
        <label className="block">
          <span className={label}>จำนวนเงิน</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            className={`${input} ${amount && !amountValid ? 'border-rose-300 focus:ring-rose-300' : ''}`}
          />
          {/* Reconciliation note: `reconciled` isn't in the client DTO, so this can't tell
              whether a bank match actually exists — shown whenever the amount changes at all.
              If one WAS linked against the old amount, the PATCH route detaches it server-side
              (see the route's comment) so a wrong figure can't leave a stale reconciliation
              behind; if none existed, this is a harmless heads-up. */}
          {amountChanged && (
            <div className="mt-1 text-xs text-amber-600">แก้ยอดแล้วต้องกระทบยอดใหม่ (ถ้าเคยจับคู่ธนาคารไว้ ระบบจะยกเลิกการจับคู่เดิมให้)</div>
          )}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className={label}>ธนาคาร</span>
            <input value={bank} onChange={(e) => setBank(e.target.value)} placeholder="กสิกร / ไทยพาณิชย์" className={input} />
          </label>
          <label className="block">
            <span className={label}>วันเวลาโอน</span>
            <input value={transferAt} onChange={(e) => setTransferAt(e.target.value)} placeholder="27/06/2026 14:30" className={input} />
          </label>
        </div>
        <label className="block">
          <span className={label}>เลขอ้างอิง</span>
          <input value={ref} onChange={(e) => setRef(e.target.value)} className={input} />
        </label>
        <label className="block">
          <span className={label}>พนักงานขาย</span>
          <input value={salesName} onChange={(e) => setSalesName(e.target.value)} placeholder="ชื่อพนักงานขาย" className={input} />
        </label>

        {payment.source === 'cheque' && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className={label}>เลขที่เช็ค</span>
              <input value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} className={input} />
            </label>
            <label className="block">
              <span className={label}>ธนาคาร (เช็ค)</span>
              <input value={chequeBank} onChange={(e) => setChequeBank(e.target.value)} className={input} />
            </label>
            <label className="block col-span-2">
              <span className={label}>วันที่บนเช็ค</span>
              <input value={chequeDueDate} onChange={(e) => setChequeDueDate(e.target.value)} placeholder="เช่น 04/07/26" className={input} />
            </label>
          </div>
        )}

        <label className="block">
          <span className={label}>ใบกำกับภาษี</span>
          <textarea value={taxInvoice} onChange={(e) => setTaxInvoice(e.target.value)} rows={3}
            placeholder="ชื่อ / ที่อยู่ / เลขประจำตัวผู้เสียภาษี 13 หลัก (ถ้าลูกค้าขอ)"
            className={`${input} resize-none`} />
        </label>
        <label className="block">
          <span className={label}>หมายเหตุ</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="หมายเหตุเพิ่มเติม (ถ้ามี)" className={input} />
        </label>

        {err && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">{err}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm">ยกเลิก</button>
          <button
            type="button"
            onClick={save}
            disabled={!valid || saving}
            className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center gap-1 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={13} />} บันทึก
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Slip verifier + action drawer ──────────────────────────────────────────
// showExpressConfirm: the ✓✓ ยืนยันใน Express icon shows for cash/cheque rows regardless of
// which queue they're viewed in (inbox/flags — the separate เงินสด/เช็ค tab is gone, folded
// into the one รายการรับเงิน list, owner decision 2026-07-06) — transfers reach 'recorded' via
// the CEO's bulk-confirm in กระทบยอด instead (owner decision 2026-07-05, JUNO bulk-actions
// brief §3). Cash/cheque have no bank reconciliation step, so they keep the per-row action here.
function Detail({ payment, onClose, onUpdate, onDelete, onPrint, canDelete, isCeo }: {
  payment: Payment; onClose: () => void; onUpdate: (p: Payment) => void; onDelete: (id: string) => void;
  onPrint: (p: Payment) => void; canDelete: boolean; isCeo: boolean;
}) {
  const showExpressConfirm = payment.source === 'cash' || payment.source === 'cheque';
  const [busy, setBusy] = useState('');
  const [flagNote, setFlagNote] = useState('');
  const [flagOpen, setFlagOpen] = useState(false);
  const [error, setError] = useState('');
  const [checkOpen, setCheckOpen] = useState(false);
  // แก้ไขรายละเอียด (typo-fix modal) — available to every Juno user, unlike checkOpen's dialog
  // (which is gated by nothing extra either, but this one edits plain descriptive fields only).
  const [editOpen, setEditOpen] = useState(false);
  // inline "ลบรายการนี้ถาวร? กู้คืนไม่ได้" confirm before ลบถาวร runs (CEO-only)
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  useEffect(() => {
    setFlagOpen(false); setFlagNote(''); setError(''); setDeleteConfirm(false);
  }, [payment.id]);

  async function run(key: string, fn: () => Promise<{ payment: Payment }>) {
    setBusy(key);
    setError('');
    try {
      const { payment: p } = await fn();
      onUpdate(p);
      setFlagNote('');
    } catch (e) {
      setError((e as Error).message === 'unauthorized' ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : 'บันทึกไม่สำเร็จ — ลองใหม่อีกครั้ง');
    } finally {
      setBusy('');
    }
  }

  // ลบถาวร (CEO-only permanent delete) — separate from `run` above: there's no updated
  // Payment to hand back (the row is gone), so this calls onDelete + onClose instead of
  // onUpdate. Server 403s anyone but supervisor; the button itself is hidden unless canDelete.
  async function runDelete() {
    setBusy('delete');
    setError('');
    try {
      await deletePayment(payment.id);
      onDelete(payment.id);
      onClose();
    } catch (e) {
      setError((e as Error).message === 'unauthorized' ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : 'ลบไม่สำเร็จ — ลองใหม่อีกครั้ง');
      setBusy('');
      setDeleteConfirm(false);
    }
  }

  const p = payment;
  const field = (label: string, value: React.ReactNode) => (
    <div>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-sm">{value || <span className="text-slate-300">—</span>}</div>
    </div>
  );

  // One compact icon in the sticky action rail. `active` tints it as the current state;
  // busy shows a spinner in place of the icon. Tooltips carry the Thai names.
  const rail = (
    key: string,
    title: string,
    icon: React.ReactNode,
    onClick: () => void,
    opts: { disabled?: boolean; active?: boolean; danger?: boolean } = {},
  ) => (
    <button
      disabled={busy !== '' || opts.disabled}
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded-lg border disabled:opacity-30 shrink-0 ${
        opts.active
          ? 'bg-emerald-600 text-white border-emerald-600'
          : opts.danger
            ? 'border-slate-200 text-slate-400 hover:bg-rose-50 hover:text-rose-600'
            : 'border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700'
      }`}
    >
      {busy === key ? <Loader2 size={16} className="animate-spin" /> : icon}
    </button>
  );

  return (
    <div className="fixed inset-0 z-30 bg-slate-900/40 md:static md:z-auto md:bg-transparent md:w-[380px] xl:w-[620px] md:shrink-0">
      <div className="absolute inset-x-0 bottom-0 top-10 md:static bg-white rounded-t-2xl md:rounded-xl border border-slate-200 overflow-y-auto md:sticky md:top-[104px] md:max-h-[calc(100vh-120px)]">
        {/* Sticky header = status + RE on the left, EVERY action as an icon on the right
            (owner request 2026-07-03: actions reachable at any scroll position, add/remove
            any time). Hover an icon for its Thai name. */}
        <div className="sticky top-0 z-10 bg-white px-3 py-2 border-b border-slate-100 rounded-t-2xl md:rounded-t-xl">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <Badge cls={STATUS_META[p.status].cls}>{STATUS_META[p.status].label}</Badge>
              {p.reNumbers.length > 0 && (
                <div className="flex items-center gap-1 min-w-0 overflow-hidden">
                  {p.reNumbers.length <= 2 ? (
                    p.reNumbers.map((re) => (
                      <span key={re} className="text-xs font-bold text-slate-700 whitespace-nowrap px-1.5 py-0.5 rounded bg-slate-100 shrink-0">
                        RE {re}
                      </span>
                    ))
                  ) : (
                    <span
                      className="text-xs font-bold text-slate-700 whitespace-nowrap truncate"
                      title={p.reNumbers.map((re) => `RE ${re}`).join(' / ')}
                    >
                      RE {p.reNumbers[0]} +{p.reNumbers.length - 1}
                    </span>
                  )}
                </div>
              )}
              {p.flagged && <Flag size={13} className="text-rose-500 shrink-0" />}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {rail('received', STATUS_META.received.label, <Undo2 size={16} />, () => run('received', () => setStatus(p.id, 'received')), {
                disabled: p.status === 'received',
              })}
              {/* 'verified' only via the check dialog — the one path that supplies the RE(s) */}
              {rail('check', p.reNumbers.length > 0 ? 'แก้ไขข้อมูลใบเสร็จ' : STATUS_META.verified.label, <ClipboardCheck size={16} />, () => setCheckOpen(true), {
                disabled: p.status === 'void',
                active: p.status === 'verified',
              })}
              {/* ✓✓ ยืนยันใน Express: cash/cheque rows only — see the showExpressConfirm note above.
                  Task 1 hard gate: also disabled until the CEO has confirmed physical receipt
                  (server 409s received_required the same way) — with a why-tooltip so it doesn't
                  read as broken. */}
              {showExpressConfirm && rail(
                'recorded',
                p.status !== 'recorded' && p.status !== 'void' && !p.receivedAt
                  ? 'ต้องให้ CEO ยืนยันรับเงินก่อนจึงจะยืนยันใน Express ได้'
                  : STATUS_META.recorded.label,
                <CheckCheck size={16} />,
                () => run('recorded', () => setStatus(p.id, 'recorded')),
                {
                  disabled: p.status === 'recorded' || p.status === 'void' || !p.receivedAt,
                  active: p.status === 'recorded',
                },
              )}
              {rail('print', p.reNumbers.length > 0 ? 'พิมพ์ใบปะหน้า' : 'พิมพ์ใบปะหน้า (ต้องมีเลข RE ก่อน)', <Printer size={16} />, () => onPrint(p), {
                disabled: p.reNumbers.length === 0,
              })}
              {/* แก้ไขรายละเอียด — fix a typo'd descriptive field (customer code/name, sender,
                  amount, bank, transfer date, ref, sales, note, tax invoice, cheque fields).
                  Open to every Juno user (no isCeo/canDelete gate — routine FIN work, contrast
                  with ลบถาวร below), same as the server route. No status guard — a typo-fix is
                  not a lifecycle action, so it's allowed even on a voided row (matches the
                  server, which has no status check either). */}
              {rail('edit', 'แก้ไขรายละเอียด', <PenLine size={16} />, () => setEditOpen(true))}
              {/* Flag toggle: raising (ติดธง) is finance-allowed; clearing (เคลียร์ธง) is CEO-only
                  (server 403s flagged===false for non-supervisor). So a flagged row shows the clear
                  button only for CEO; an unflagged row shows the raise button for everyone. */}
              {(!p.flagged || isCeo) && rail('flag', p.flagged ? 'เคลียร์ธงตรวจสอบ' : 'ติดธงตรวจสอบยอด', <Flag size={16} />, () => {
                if (p.flagged) void run('flag', () => setFlag(p.id, false));
                else setFlagOpen((v) => !v);
              }, { active: p.flagged })}
              {rail('void', 'ยกเลิก (ตัดออกจากรายงาน)', <Ban size={16} />, () => run('void', () => setStatus(p.id, 'void')), {
                disabled: p.status === 'void',
                danger: true,
              })}
              {/* ลบถาวร — CEO-only permanent delete. Visually separated (border + own red) from
                  ⊘ ยกเลิก above: that soft-deletes (row stays, restorable); this is forever. */}
              {canDelete && (
                <button
                  disabled={busy !== ''}
                  onClick={() => setDeleteConfirm((v) => !v)}
                  title="ลบถาวร (กู้คืนไม่ได้)"
                  className="p-1.5 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-30 shrink-0 ml-1 pl-2 border-l-2"
                >
                  {busy === 'delete' ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                </button>
              )}
              <button onClick={onClose} title="ปิด" className="p-1.5 text-slate-400 hover:text-slate-600 shrink-0"><X size={18} /></button>
            </div>
          </div>
          {/* transient flag-note row (setting a flag can carry a note for the audit trail) */}
          {flagOpen && !p.flagged && (
            <div className="mt-2 flex items-center gap-1.5">
              <input
                value={flagNote}
                onChange={(e) => setFlagNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void run('flag', () => setFlag(p.id, true, flagNote.trim() || undefined)).then(() => setFlagOpen(false)); }}
                placeholder="หมายเหตุ (ถ้ามี)"
                autoFocus
                className="flex-1 px-2 py-1.5 rounded-lg border border-slate-300 text-sm"
              />
              <button
                disabled={busy !== ''}
                onClick={() => void run('flag', () => setFlag(p.id, true, flagNote.trim() || undefined)).then(() => setFlagOpen(false))}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 disabled:opacity-40 whitespace-nowrap"
              >
                ติดธง
              </button>
            </div>
          )}
          {/* transient ลบถาวร confirm row — CEO-only, mirrors the flag-note row's inline style */}
          {canDelete && deleteConfirm && (
            <div className="mt-2 flex items-center gap-1.5 p-2 rounded-lg bg-rose-50 border border-rose-200">
              <AlertTriangle size={14} className="text-rose-600 shrink-0" />
              <span className="text-xs text-rose-700 flex-1">ลบรายการนี้ถาวร? กู้คืนไม่ได้</span>
              <button
                disabled={busy !== ''}
                onClick={() => void runDelete()}
                className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40 whitespace-nowrap"
              >
                ยืนยันลบ
              </button>
              <button
                disabled={busy !== ''}
                onClick={() => setDeleteConfirm(false)}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
              >
                ยกเลิก
              </button>
            </div>
          )}
        </div>

        {error && <div className="mx-4 mt-2 p-2 rounded-lg bg-rose-50 text-rose-700 text-xs flex items-center gap-1"><AlertTriangle size={13} /> {error}</div>}

        <div className="flex flex-col xl:flex-row xl:gap-2">
          <div className="xl:w-[45%] xl:shrink-0">
            {/* slip image */}
            <div className="p-4">
              {p.slipUrl ? (
                <a href={p.slipUrl} target="_blank" rel="noreferrer" className="block relative group">
                  <img src={p.slipUrl} alt="สลิป" className="w-full rounded-lg border border-slate-200 bg-slate-50" />
                  <span className="absolute top-2 right-2 bg-black/60 text-white rounded-md p-1 opacity-0 group-hover:opacity-100">
                    <ExternalLink size={14} />
                  </span>
                </a>
              ) : (
                <div className="text-center text-slate-400 text-sm py-6 border border-dashed border-slate-200 rounded-lg">ไม่มีสลิป</div>
              )}
            </div>
          </div>

          <div className="xl:flex-1 xl:min-w-0 xl:border-l xl:border-slate-100">
            {/* parsed fields */}
            <div className="px-4 grid grid-cols-2 gap-3">
              {field('ชื่อลูกค้า', p.customerName)}
              {field('รหัส', p.customerCode)}
              {field('ผู้โอน (บนสลิป)', p.senderName)}
              {field('ธนาคาร', p.bank)}
              {field('ยอดที่ยืนยัน', <span className="font-semibold">{baht(p.amountNum)}</span>)}
              {field('ยอดที่ AI อ่าน', p.mismatch
                ? <span className="text-rose-600 font-semibold">{p.ocrAmount || '—'}</span>
                : (p.ocrAmount || '—'))}
              {field('เวลาโอน', p.transferAt)}
              {field('อ้างอิง', p.ref)}
              {field('พนักงานขาย', p.salesName)}
              {field('วันที่ส่งเข้า', fmtDateTime(p.createdAt))}
              {p.reNumbers.length > 0 && field('ชื่อบนใบเสร็จ', p.receiptName)}
              {p.reNumbers.length > 0 && field('ประเภทลูกค้า', p.customerType)}
            </div>

            {p.mismatch && (
              <div className="mx-4 mt-3 p-2 rounded-lg bg-rose-50 text-rose-700 text-xs flex items-start gap-1">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                ยอดที่พนักงานกรอกไม่ตรงกับที่ AI อ่านจากสลิป — ควรตรวจสอบ
              </div>
            )}

            {/* หัก ณ ที่จ่าย (WHT, task 2) — only shown once FIN has entered a withheld amount in
                the ตรวจแล้ว dialog. amount/amountNum above is the NET the customer actually sent;
                this block makes the received → withheld → full-price breakdown legible on review.
                The withheld baht shown is grossAmount − amountNum (both server-computed off the
                SAME grossOf()), so it can never drift from the server's own arithmetic. */}
            {p.whtAmount !== '' && (
              <div className="mx-4 mt-3 p-2 rounded-lg bg-amber-50 text-amber-800 text-xs flex items-center justify-between gap-2">
                <Percent size={14} className="shrink-0" />
                <span className="flex-1">
                  รับจริง {baht(p.amountNum)} · หัก ณ ที่จ่าย {p.whtRate}% = {baht(p.grossAmount - p.amountNum)}
                </span>
                <span className="font-semibold whitespace-nowrap">เต็ม {baht(p.grossAmount)}</span>
              </div>
            )}

            {p.note && (
              <div className="mx-4 mt-3 p-2 rounded-lg bg-slate-50 text-slate-600 text-xs whitespace-pre-wrap">{p.note}</div>
            )}

            {/* tax-invoice DETAILS only (no status tracking): every sale gets a ใบกำกับภาษี,
                issued in Express as part of recording — but the name/address/tax-ID the customer
                supplied still matters when issuing, so show it whenever it was captured. */}
            {p.taxInvoice && (
              <div className="px-4 py-3 border-t border-slate-100">
                <div className="text-xs text-slate-400 mb-1.5 flex items-center gap-1">
                  <FileText size={13} /> ข้อมูลใบกำกับภาษีจากลูกค้า
                </div>
                <div className="p-2 rounded-lg bg-slate-50 text-slate-600 text-xs whitespace-pre-wrap">{p.taxInvoice}</div>
              </div>
            )}

            {/* cash/cheque: not a bank transfer, so it's verified HERE via a settle control
                instead of reconciling in กระทบยอด (decision 4). */}
            {(p.source === 'cash' || p.source === 'cheque') && (
              <CashChequeSection payment={p} busy={busy} run={run} isCeo={isCeo} />
            )}
          </div>
        </div>

        {checkOpen && (
          <CheckDialog
            payment={p}
            onClose={() => setCheckOpen(false)}
            onSaved={(updated) => {
              onUpdate(updated);
              setCheckOpen(false);
            }}
          />
        )}

        {editOpen && (
          <EditPaymentModal
            payment={p}
            onClose={() => setEditOpen(false)}
            onSaved={(updated) => {
              onUpdate(updated);
              setEditOpen(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ── Cash/cheque settle section (Detail drawer, decision 2/4) ───────────────────────────────
// Cash and cheque don't arrive as a bank transfer line, so they're never auto-matched in
// กระทบยอด — instead this section shows the method + (for cheque) its details, plus a settle
// control that toggles cash '' <-> 'deposited' or cheque '' <-> 'cleared'.
// future: a cheque could also auto-clear when a matching KBiz "Cheque Deposit … Cheque No. …"
// line imports — not built now (see JUNO_MANUAL_ENTRY_BRIEF.md decision 4).
const SETTLE_META: Record<'cash' | 'cheque', { pending: string; done: string; action: string; state: SettleState }> = {
  cash: { pending: 'รอฝาก', done: 'ฝากธนาคารแล้ว', action: 'ฝากธนาคารแล้ว', state: 'deposited' },
  cheque: { pending: 'รอเคลียร์', done: 'เคลียร์แล้ว', action: 'เคลียร์แล้ว', state: 'cleared' },
};
function CashChequeSection({ payment: p, busy, run, isCeo }: {
  payment: Payment;
  busy: string;
  run: (key: string, fn: () => Promise<{ payment: Payment }>) => Promise<void>;
  isCeo: boolean;
}) {
  const kind = p.source as 'cash' | 'cheque';
  const meta = SETTLE_META[kind];
  const settled = p.settleState !== '';
  const received = !!p.receivedAt;
  const field = (lbl: string, value: React.ReactNode) => (
    <div>
      <div className="text-xs text-slate-400">{lbl}</div>
      <div className="text-sm">{value || <span className="text-slate-300">—</span>}</div>
    </div>
  );

  return (
    <div className="px-4 py-3 border-t border-slate-100">
      <div className="text-xs text-slate-400 mb-1.5 flex items-center gap-1">
        <Banknote size={13} /> การรับเงิน (เงินสด/เช็ค)
      </div>
      <div className="grid grid-cols-2 gap-3 mb-2">
        {field('วิธีรับเงิน', kind === 'cash' ? 'เงินสด' : 'เช็คธนาคาร')}
        {kind === 'cheque' && field('เลขที่เช็ค', p.chequeNo)}
        {kind === 'cheque' && field('ธนาคาร', p.chequeBank)}
        {kind === 'cheque' && field('วันที่บนเช็ค', p.chequeDueDate)}
      </div>
      {/* Deposit/clear (settle) — CHEQUE ONLY. Cash is handed straight to the CEO, so there's no
          bank-deposit step for it (owner decision B for cash, 2026-07-06) — the ได้รับแล้ว confirm
          below is the whole story. Cheques still clear at the bank (auto from the KBiz import). */}
      {kind === 'cheque' && (
        <div className="flex items-center gap-2">
          <Badge cls={settled ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
            {settled ? meta.done : meta.pending}
          </Badge>
          {!settled ? (
            <button
              disabled={busy !== ''}
              onClick={() => void run('settle', () => settlePayment(p.id, meta.state))}
              className="px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-40 flex items-center gap-1"
            >
              {busy === 'settle' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {meta.action}
            </button>
          ) : (
            <button
              disabled={busy !== ''}
              onClick={() => void run('settle', () => settlePayment(p.id, ''))}
              className="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200 disabled:opacity-40 flex items-center gap-1"
            >
              {busy === 'settle' ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />} ยกเลิก
            </button>
          )}
        </div>
      )}

      {/* CEO receipt-verify gate (task 1) — SEPARATE from the settle control above (that's the
          banking deposit/clear state; a cheque's KBiz auto-clear does NOT satisfy this gate).
          This is a hard prerequisite for the ✓✓ ยืนยันใน Express rail action (see its disabled
          condition above). Non-CEO sees the status read-only — the confirm action is
          supervisor-only server-side, mirroring ลบถาวร's gate. */}
      <div className="mt-3 pt-3 border-t border-dashed border-slate-200">
        <div className="text-xs text-slate-400 mb-1.5">การรับเงินจริง (ยืนยันโดย CEO)</div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge cls={received ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
            {received ? `ได้รับแล้ว · ${fmtDate(p.receivedAt!)}` : 'รอ CEO ยืนยัน'}
          </Badge>
          {isCeo && (received ? (
            <button
              disabled={busy !== ''}
              onClick={() => void run('receive', () => confirmReceived(p.id, false))}
              className="px-2.5 py-1 rounded-lg text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200 disabled:opacity-40 flex items-center gap-1"
            >
              {busy === 'receive' ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />} ยกเลิกการยืนยัน
            </button>
          ) : (
            <button
              disabled={busy !== ''}
              onClick={() => void run('receive', () => confirmReceived(p.id, true))}
              className="px-2.5 py-1 rounded-lg text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-40 flex items-center gap-1"
            >
              {busy === 'receive' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} ยืนยันรับเงินแล้ว
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Splits on '/', ',', or any whitespace — FIN pastes/types REs separated by any of these
// (the owner's own example is "6900025/6900026/…").
const RE_SEPARATOR = /[/,\s]+/;
// Strip a leading "RE"/"re" and check the bare-digit shape (mirrors the server's normalization).
function normalizeReToken(raw: string): string {
  return raw.trim().replace(/^re/i, '');
}
function isValidRe(token: string): boolean {
  return /^\d{7}$/.test(token);
}

// Shared RE-chips input logic (used by both CheckDialog and BatchCheckDialog) — FIN can
// type/paste SEVERAL RE numbers as one text stream separated by '/', ',', or space, and each
// completes into a removable chip once it's a valid 7-digit token. Extracted as a hook (rather
// than duplicated per-dialog state) so both dialogs share exactly one parsing implementation.
function useReChipsInput(initial: string[]) {
  const [reNumbers, setReNumbers] = useState<string[]>(initial);
  const [reInput, setReInput] = useState('');

  function addChip(token: string) {
    if (!token) return;
    setReNumbers((prev) => (prev.includes(token) ? prev : [...prev, token]));
  }
  function removeChip(token: string) {
    setReNumbers((prev) => prev.filter((r) => r !== token));
  }

  // As FIN types, a separator (/, comma, or space) completes whatever came before it: strip a
  // leading RE/re, and if it's a valid 7-digit token, commit it as a chip. An invalid completed
  // token is DROPPED silently on the separator (the inline hint below covers the still-typing
  // case) rather than left stuck in the box, so the box stays ready for the next token.
  function onReInputChange(v: string) {
    if (RE_SEPARATOR.test(v.slice(-1)) && v.trim()) {
      const parts = v.split(RE_SEPARATOR);
      const remainder = parts.pop() ?? ''; // text after the last separator (should be '')
      for (const part of parts) {
        const token = normalizeReToken(part);
        if (isValidRe(token)) addChip(token);
      }
      setReInput(remainder);
    } else {
      setReInput(v);
    }
  }

  const pendingToken = normalizeReToken(reInput);
  const pendingValid = pendingToken !== '' && isValidRe(pendingToken);
  const pendingInvalid = pendingToken !== '' && !isValidRe(pendingToken);
  // at least one committed chip, OR exactly one valid not-yet-committed token in the box
  const valid = reNumbers.length > 0 || pendingValid;

  // The final RE list to submit: flushes a valid pending token so the user doesn't have to
  // press Enter/type a separator before clicking บันทึก.
  function finalize(): string[] {
    return pendingValid && !reNumbers.includes(pendingToken) ? [...reNumbers, pendingToken] : reNumbers;
  }

  function reset(next: string[]) {
    setReNumbers(next);
    setReInput('');
  }

  return {
    reNumbers, reInput, addChip, removeChip, onReInputChange,
    pendingToken, pendingValid, pendingInvalid, valid, finalize, reset,
  };
}

// The chips + input box UI (no label/hint — callers wrap those since the label text differs
// slightly between the single-row and batch dialogs).
function ReChipsBox({ state, onEnter, autoFocus }: {
  state: ReturnType<typeof useReChipsInput>;
  onEnter: () => void;
  autoFocus?: boolean;
}) {
  const reRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) reRef.current?.focus(); }, [autoFocus]);

  // Enter flushes the current pending token (if valid) into a chip; if there's no pending
  // token but the dialog is already valid (≥1 chip committed), Enter submits instead.
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    const token = normalizeReToken(state.reInput);
    if (isValidRe(token)) {
      state.addChip(token);
      state.onReInputChange('');
    } else if (state.valid) {
      onEnter();
    }
  }

  return (
    <div className="mt-0.5 flex flex-wrap gap-1.5 px-2 py-1.5 rounded-lg border border-slate-300 focus-within:ring-2 focus-within:ring-emerald-400">
      {state.reNumbers.map((re) => (
        <span key={re} className="flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-semibold">
          {re}
          <button type="button" onClick={() => state.removeChip(re)} className="p-0.5 rounded-full hover:bg-emerald-100 text-emerald-600" title="เอาออก">
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        ref={reRef}
        value={state.reInput}
        onChange={(e) => state.onReInputChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={state.reNumbers.length ? 'เพิ่มอีก…' : 'เช่น 6900025/6900026'}
        className="flex-1 min-w-[100px] text-sm focus:outline-none"
      />
    </div>
  );
}

// ── Shared WHT (หัก ณ ที่จ่าย, task 2) control logic — used by CheckDialog only (see the
// BatchCheckDialog note below for why the batch path leaves WHT out). Mirrors the
// useReChipsInput hook style: one implementation, reset() to re-seed from a different payment.
// The rate picker AUTO-COMPUTES the withheld baht from what the customer actually SENT (the net,
// payment.amountNum): wht = net × rate/(100−rate) — the slice a `rate`% withholding took off the
// full price to leave this net (e.g. net 97 @ 3% → 3, full price 100). Rounded to 2dp, but the
// baht stays user-editable afterward (to match the 50-ทวิ cert / rounding), only re-derived when
// the RATE changes so a manual edit is never clobbered on render.
function useWhtControl(payment: Payment) {
  const [on, setOn] = useState(payment.whtRate > 0);
  const [rate, setRate] = useState<WhtRate>(payment.whtRate > 0 ? (payment.whtRate as WhtRate) : DEFAULT_WHT_RATE);
  const [amountStr, setAmountStr] = useState(payment.whtAmount);

  // Turning WHT on (from off) seeds the baht from a fresh calc off the net; turning off just
  // hides the controls (state is zeroed at save-time in toBody(), not here, so flipping back on
  // mid-edit doesn't lose the figure the user already had).
  function toggleOn(next: boolean) {
    setOn(next);
    if (next && amountStr === '') setAmountStr(String(round2((payment.amountNum * rate) / (100 - rate))));
  }
  // Recompute the withheld baht off the net (payment.amountNum) whenever the rate changes — the
  // "auto-compute" the owner asked for; the resulting figure remains a normal editable input.
  function changeRate(next: WhtRate) {
    setRate(next);
    setAmountStr(String(round2((payment.amountNum * next) / (100 - next))));
  }

  // Full price / RE = what was received + what was withheld.
  const grossPreview = round2(payment.amountNum + (parseFloat(amountStr) || 0));

  // Re-seed every field from a (possibly different) payment — used by CheckDialog when it
  // re-opens on a different row, and would be used by a batch queue's goTo() if one existed.
  function reset(p: Payment) {
    setOn(p.whtRate > 0);
    setRate(p.whtRate > 0 ? (p.whtRate as WhtRate) : DEFAULT_WHT_RATE);
    setAmountStr(p.whtAmount);
  }

  // The exact { whtRate, whtAmount } pair verifyPayment expects — off always normalizes to
  // 0/'' regardless of whatever was typed while it was on, matching the server's own
  // whtRate===0-clears-whtAmount normalization (belt-and-suspenders, not load-bearing).
  function toBody(): { whtRate: WhtRate; whtAmount: string } {
    return on ? { whtRate: rate, whtAmount: amountStr.trim() } : { whtRate: 0, whtAmount: '' };
  }

  return { on, toggleOn, rate, changeRate, amountStr, setAmountStr, grossPreview, reset, toBody };
}

// The WHT section UI (checkbox + rate picker + editable baht + read-only full-price) shared by its
// one caller today (CheckDialog) — factored out so a future batch/other dialog can reuse it.
// Takes only the `wht` control state — everything it renders (rate/amount/full-price preview) is
// already derived off the payment inside useWhtControl, so no separate `payment` prop is needed.
function WhtSection({ wht }: { wht: ReturnType<typeof useWhtControl> }) {
  return (
    <div className="rounded-lg border border-slate-200 p-2.5 space-y-2">
      <label className="flex items-center gap-1.5 text-xs text-slate-600 font-medium">
        <input
          type="checkbox"
          checked={wht.on}
          onChange={(e) => wht.toggleOn(e.target.checked)}
          className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-400"
        />
        มีหัก ณ ที่จ่าย
      </label>
      {wht.on && (
        <div className="grid grid-cols-2 gap-2 pl-0.5">
          <label className="block">
            <span className="text-[11px] text-slate-400">อัตรา</span>
            <select
              value={wht.rate}
              onChange={(e) => wht.changeRate(Number(e.target.value) as WhtRate)}
              className="w-full mt-0.5 px-2 py-1.5 rounded-lg border border-slate-300 text-sm bg-white"
            >
              {WHT_RATES.filter((r) => r > 0).map((r) => (
                <option key={r} value={r}>{r}%</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] text-slate-400">จำนวนที่หัก (บาท)</span>
            <input
              value={wht.amountStr}
              onChange={(e) => wht.setAmountStr(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className="w-full mt-0.5 px-2 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </label>
          <div className="col-span-2 flex items-center justify-between text-xs bg-slate-50 rounded-lg px-2 py-1.5">
            <span className="text-slate-400">ยอดเต็ม/RE (ก่อนหัก)</span>
            <span className="font-semibold text-slate-700">{baht(wht.grossPreview)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Check dialog (the RE check FIN performs when the receipt is issued in Express) ─────────
// Small modal, NOT a browser prompt: this is the one place a payment can become 'verified'.
// FIN can now type/paste SEVERAL RE numbers (one payment may cover many receipts): they go in
// as one text stream separated by '/', ',', or space, and turn into removable chips as each
// 7-digit token completes.
function CheckDialog({ payment, onClose, onSaved }: {
  payment: Payment;
  onClose: () => void;
  onSaved: (p: Payment) => void;
}) {
  const re = useReChipsInput(payment.reNumbers);
  const [receiptName, setReceiptName] = useState(
    payment.receiptName || payment.taxInvoice.split('\n')[0]?.trim() || payment.customerName,
  );
  const [customerType, setCustomerType] = useState<CustomerType>(payment.customerType);
  // หัก ณ ที่จ่าย (WHT, task 2) — pre-filled from the payment when re-opening an already-checked
  // row (useWhtControl reads payment.whtRate/whtAmount on mount).
  const wht = useWhtControl(payment);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    if (!re.valid || saving) return;
    const finalRe = re.finalize();
    if (finalRe.length === 0) return;
    setSaving(true);
    setErr('');
    try {
      const res = await verifyPayment(payment.id, {
        reNumbers: finalRe,
        receiptName: receiptName.trim(),
        customerType,
        ...wht.toBody(),
      });
      onSaved(res.payment);
    } catch (e) {
      setErr((e as Error).message === 'unauthorized' ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : 'บันทึกไม่สำเร็จ — ลองใหม่อีกครั้ง');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl p-4 w-full max-w-sm space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold text-slate-800 flex items-center gap-1.5">
          <FileText size={16} className="text-emerald-700" /> ตรวจแล้ว — ออก RE ใน Express
        </div>

        <label className="block">
          <span className="text-xs text-slate-500">เลขที่ใบเสร็จ (RE) — พิมพ์ได้หลายเลข คั่นด้วย / , หรือเว้นวรรค</span>
          <ReChipsBox state={re} onEnter={save} autoFocus />
          {re.pendingInvalid && <span className="text-[11px] text-rose-600">ต้องเป็นตัวเลข 7 หลัก</span>}
          {!re.pendingInvalid && re.reNumbers.length === 0 && !re.pendingValid && (
            <span className="text-[11px] text-slate-400">ต้องมีอย่างน้อย 1 เลข RE</span>
          )}
        </label>

        <label className="block">
          <span className="text-xs text-slate-500">ชื่อบนใบเสร็จ</span>
          <input
            value={receiptName}
            onChange={(e) => setReceiptName(e.target.value)}
            placeholder="ชื่อบนใบเสร็จ"
            className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
        </label>

        <div>
          <span className="text-xs text-slate-500">ประเภทลูกค้า</span>
          <div className="mt-1 flex rounded-lg border border-slate-300 overflow-hidden">
            {CUSTOMER_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setCustomerType((prev) => (prev === t ? '' : t))}
                className={`flex-1 px-2 py-1.5 text-xs ${customerType === t ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <WhtSection wht={wht} />

        {err && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">{err}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm">ยกเลิก</button>
          <button
            type="button"
            onClick={save}
            disabled={!re.valid || saving}
            className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center gap-1 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={13} />} บันทึก
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Batch check dialog (the ตรวจแล้ว bulk action's guided queue) ──────────────────────────
// Each selected checkable payment needs its own RE(s), so this walks the queue one payment at
// a time reusing the same RE-chips input as CheckDialog. บันทึกและถัดไป verifies THIS row then
// advances; ใช้กับทุกใบที่เหลือ (M) applies the SAME entered RE(s)/receiptName/customerType to
// every remaining row in one pass (the "one RE shared across several payments" case) — per
// owner decision, not a new endpoint: it just loops verifyPayment like the rest of this queue.
// WHT (task 2) is deliberately left OUT of this dialog: every verifyPayment call below omits
// whtRate/whtAmount, which the route treats as "no WHT" (whtRate defaults to 0, clearing
// whtAmount too) — same as leaving the checkbox off in CheckDialog. This is intentional, not an
// oversight: WHT is a per-payment figure computed off EACH row's own gross, so "ใช้กับทุกใบที่
// เหลือ" copying one payment's withheld baht onto every remaining row (almost certainly a
// different gross each) would silently misstate the withheld amount on every row but the
// first. WHT rows must be verified one at a time in CheckDialog (still reachable per-row from
// the drawer even for a payment that was part of a batch selection).
function BatchCheckDialog({ payments, onDone }: {
  payments: Payment[];
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const current = payments[index];
  const re = useReChipsInput(current.reNumbers);
  const [receiptName, setReceiptName] = useState(
    current.receiptName || current.taxInvoice.split('\n')[0]?.trim() || current.customerName,
  );
  const [customerType, setCustomerType] = useState<CustomerType>(current.customerType);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Moving to a new row in the queue resets the chips/name/type from that row's own data —
  // each payment starts with its own (usually empty) RE, never leaking the previous row's input.
  function goTo(nextIndex: number, nextPayment: Payment) {
    setIndex(nextIndex);
    re.reset(nextPayment.reNumbers);
    setReceiptName(nextPayment.receiptName || nextPayment.taxInvoice.split('\n')[0]?.trim() || nextPayment.customerName);
    setCustomerType(nextPayment.customerType);
    setErr('');
  }

  async function saveAndNext() {
    if (!re.valid || saving) return;
    const finalRe = re.finalize();
    if (finalRe.length === 0) return;
    setSaving(true);
    setErr('');
    try {
      await verifyPayment(current.id, { reNumbers: finalRe, receiptName: receiptName.trim(), customerType });
      if (index + 1 < payments.length) {
        goTo(index + 1, payments[index + 1]);
      } else {
        onDone();
      }
    } catch (e) {
      setErr((e as Error).message === 'unauthorized' ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : 'บันทึกไม่สำเร็จ — ลองใหม่อีกครั้ง');
    } finally {
      setSaving(false);
    }
  }

  // ใช้กับทุกใบที่เหลือ: same RE(s)/receiptName/customerType applied to THIS row plus every
  // remaining row in the queue (one shared receipt across several payments).
  async function applyToRest() {
    if (!re.valid || saving) return;
    const finalRe = re.finalize();
    if (finalRe.length === 0) return;
    setSaving(true);
    setErr('');
    const remaining = payments.slice(index);
    const results = await Promise.allSettled(
      remaining.map((p) => verifyPayment(p.id, { reNumbers: finalRe, receiptName: receiptName.trim(), customerType })),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    setSaving(false);
    if (failed > 0) {
      setErr(`บันทึกไม่สำเร็จ ${failed}/${remaining.length} รายการ`);
      return;
    }
    onDone();
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-4 w-full max-w-sm space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="font-semibold text-slate-800 flex items-center gap-1.5">
            <FileText size={16} className="text-emerald-700" /> ตรวจแล้ว — รายการที่ {index + 1} / {payments.length}
          </div>
          <button onClick={onDone} title="ปิด" className="p-1 text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        {/* current row's customer + amount, so FIN knows which payment this dialog is for */}
        <div className="p-2 rounded-lg bg-slate-50 flex items-center justify-between gap-2 text-sm">
          <div className="min-w-0">
            <div className="font-semibold text-slate-800 truncate">{current.customerName}</div>
            {current.customerCode && <div className="text-xs text-slate-500">{current.customerCode}</div>}
          </div>
          <div className="font-bold text-slate-800 whitespace-nowrap">{baht(current.amountNum)}</div>
        </div>

        <label className="block">
          <span className="text-xs text-slate-500">เลขที่ใบเสร็จ (RE) — พิมพ์ได้หลายเลข คั่นด้วย / , หรือเว้นวรรค</span>
          <ReChipsBox state={re} onEnter={saveAndNext} autoFocus />
          {re.pendingInvalid && <span className="text-[11px] text-rose-600">ต้องเป็นตัวเลข 7 หลัก</span>}
          {!re.pendingInvalid && re.reNumbers.length === 0 && !re.pendingValid && (
            <span className="text-[11px] text-slate-400">ต้องมีอย่างน้อย 1 เลข RE</span>
          )}
        </label>

        <label className="block">
          <span className="text-xs text-slate-500">ชื่อบนใบเสร็จ</span>
          <input
            value={receiptName}
            onChange={(e) => setReceiptName(e.target.value)}
            placeholder="ชื่อบนใบเสร็จ"
            className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
        </label>

        <div>
          <span className="text-xs text-slate-500">ประเภทลูกค้า</span>
          <div className="mt-1 flex rounded-lg border border-slate-300 overflow-hidden">
            {CUSTOMER_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setCustomerType((prev) => (prev === t ? '' : t))}
                className={`flex-1 px-2 py-1.5 text-xs ${customerType === t ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {err && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg p-2">{err}</div>}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" onClick={onDone} disabled={saving} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm disabled:opacity-50">ปิด</button>
          {payments.length - index > 1 && (
            <button
              type="button"
              onClick={() => void applyToRest()}
              disabled={!re.valid || saving}
              title="ใช้เลข RE / ชื่อบนใบเสร็จ / ประเภทลูกค้าที่กรอกไว้กับทุกรายการที่เหลือในคิวนี้"
              className="px-3 py-1.5 rounded-lg bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 text-sm font-semibold disabled:opacity-50"
            >
              ใช้กับทุกใบที่เหลือ ({payments.length - index})
            </button>
          )}
          <button
            type="button"
            onClick={() => void saveAndNext()}
            disabled={!re.valid || saving}
            className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center gap-1 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={13} />} บันทึกและถัดไป
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Reports ────────────────────────────────────────────────────────────────
function Reports() {
  const [groupBy, setGroupBy] = useState<Report['groupBy']>('day');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    getReport(groupBy, from || undefined, to || undefined)
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false));
  }, [groupBy, from, to]);
  useEffect(() => { load(); }, [load]);

  const GROUPS: { key: Report['groupBy']; label: string }[] = [
    { key: 'day', label: 'ตามวัน' },
    { key: 'rep', label: 'ตามพนักงานขาย' },
    { key: 'bank', label: 'ตามธนาคาร' },
    { key: 'customer', label: 'ตามลูกค้า' },
  ];

  return (
    <div>
      <div className="bg-white rounded-xl border border-slate-200 p-3 mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-slate-300 overflow-hidden">
          {GROUPS.map((g) => (
            <button
              key={g.key}
              onClick={() => setGroupBy(g.key)}
              className={`px-3 py-2 text-sm ${groupBy === g.key ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {g.label}
            </button>
          ))}
        </div>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" title="ตั้งแต่วันที่" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" title="ถึงวันที่" />
        <button
          onClick={() => {
            setError('');
            // excludeVoid: the on-screen report already excludes voided payments — the CSV
            // must match, or totals won't reconcile.
            downloadCsv({ from: from || undefined, to: to || undefined, excludeVoid: true }).catch(() => setError('ดาวน์โหลดไม่สำเร็จ'));
          }}
          className="flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-800 text-white text-sm hover:bg-slate-700"
        >
          <Download size={15} /> CSV
        </button>
        {error && <span className="text-xs text-rose-600 flex items-center gap-1"><AlertTriangle size={13} /> {error}</span>}
      </div>

      {report && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-xs text-slate-400">ยอดรวม</div>
            <div className="text-2xl font-bold text-emerald-700">{baht(report.grandTotal)}</div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-xs text-slate-400">จำนวนรายการ</div>
            <div className="text-2xl font-bold">{report.count}</div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-400"><Loader2 className="animate-spin inline" size={20} /></div>
        ) : !report || report.groups.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-sm">ไม่มีข้อมูล</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs">
              <tr>
                <th className="text-left font-medium px-4 py-2">{GROUPS.find((g) => g.key === report.groupBy)?.label}</th>
                <th className="text-right font-medium px-4 py-2">รายการ</th>
                <th className="text-right font-medium px-4 py-2">ยอดรวม</th>
              </tr>
            </thead>
            <tbody>
              {report.groups.map((g) => (
                <tr key={g.key} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-medium">{g.label}</td>
                  <td className="px-4 py-2 text-right text-slate-500">{g.count}</td>
                  <td className="px-4 py-2 text-right font-semibold">{baht(g.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
