import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Landmark, LogOut, Search, Download, Flag, FileText, Inbox, BarChart3, Scale,
  Loader2, AlertTriangle, CheckCircle2, X, RefreshCw, ExternalLink, Ban, Printer,
  Undo2, ClipboardCheck, CheckCheck,
} from 'lucide-react';
import {
  getSummary, getPayments, setStatus, setFlag, verifyPayment, getReport, downloadCsv, baht,
  clearSession, getBankSummary,
  type Agent, type Payment, type PaymentStatus, type Summary,
  type Report, type PaymentFilter, type CustomerType,
} from './lib/api';
import PrintCovers from './PrintCovers';
import Recon from './Recon';

// No ใบกำกับภาษี tab: Prominent issues a tax invoice on EVERY sale (in Express, as part of
// recording), so a "requested" queue would contain everything and filter nothing. The invoice
// details captured off the slip flow (name/address/tax-ID) still show in the drawer.
type View = 'inbox' | 'flags' | 'reports' | 'recon';

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

export default function Juno({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const [view, setView] = useState<View>('inbox');
  const [summary, setSummary] = useState<Summary | null>(null);
  // unmatched-in bank txn count — the badge on the กระทบยอด tab (phase B)
  const [bankUnmatched, setBankUnmatched] = useState<number | undefined>(undefined);

  const refreshSummary = useCallback(() => {
    getSummary().then(setSummary).catch(() => setSummary(null));
    getBankSummary().then((s) => setBankUnmatched(s.unmatchedIn.count)).catch(() => setBankUnmatched(undefined));
  }, []);
  useEffect(() => { refreshSummary(); }, [refreshSummary]);

  const tabs: { key: View; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: 'inbox', label: 'รายการรับเงิน', icon: <Inbox size={16} />, count: summary?.total },
    { key: 'flags', label: 'ตรวจสอบยอด', icon: <Flag size={16} />, count: summary?.flagged },
    { key: 'recon', label: 'กระทบยอด', icon: <Scale size={16} />, count: bankUnmatched },
    { key: 'reports', label: 'รายงาน', icon: <BarChart3 size={16} /> },
  ];

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 text-emerald-700">
            <Landmark size={22} />
            <span className="font-bold text-lg">Juno</span>
            <span className="text-slate-400 text-sm hidden sm:inline">· ระบบการเงิน</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-500 hidden sm:inline">{agent.name}</span>
            <button onClick={() => { clearSession(); onLogout(); }} className="flex items-center gap-1 text-slate-500 hover:text-rose-600">
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
                <span className={`ml-1 px-1.5 rounded-full text-xs ${t.key === 'flags' || t.key === 'recon' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600'}`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4">
        {view === 'reports' ? (
          <Reports />
        ) : view === 'recon' ? (
          <Recon />
        ) : (
          <PaymentsView view={view} onChanged={refreshSummary} />
        )}
      </main>
    </div>
  );
}

// ── Payments list + detail (inbox / flags share this) ──────────────────────
function PaymentsView({ view, onChanged }: { view: Exclude<View, 'reports' | 'recon'>; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [status, setStatusFilter] = useState<'all' | PaymentStatus>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Payment | null>(null);
  // non-null → render the print overlay (see PrintCovers) instead of the inbox
  const [printQueue, setPrintQueue] = useState<Payment[] | null>(null);

  const filter: PaymentFilter = {
    q: q.trim() || undefined,
    from: from || undefined,
    to: to || undefined,
    // the flags tab is a pre-filtered queue; the inbox honours the status dropdown
    ...(view === 'flags' ? { flagged: true } : {}),
    ...(view === 'inbox' ? { status } : {}),
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
  }, [view, q, status, from, to]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce the search box
    return () => clearTimeout(t);
  }, [load]);

  // Close the drawer on tab switch — otherwise a foreign payment stays open beside the wrong queue.
  useEffect(() => setSelected(null), [view]);

  // Reflect a drawer action back into the list + selected row without a full reload.
  function applyUpdate(p: Payment) {
    setSelected(p);
    // a row may drop out of the pre-filtered flag queue (unflagged) → refetch it
    if (view === 'flags' && !p.flagged) {
      load();
    } else {
      setRows((prev) => prev.map((r) => (r.id === p.id ? p : r)));
    }
    onChanged();
  }

  // The daily flow: filter today + ตรวจแล้ว → one click prints the whole stack.
  const verifiedInView = rows.filter((r) => r.status === 'verified');

  if (printQueue) {
    return <PrintCovers payments={printQueue} onDone={() => setPrintQueue(null)} />;
  }

  return (
    <div className="flex gap-4">
      <div className="flex-1 min-w-0">
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
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="px-2 py-2 rounded-lg border border-slate-300 text-sm" title="ตั้งแต่วันที่" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="px-2 py-2 rounded-lg border border-slate-300 text-sm" title="ถึงวันที่" />
          <button onClick={load} className="p-2 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50" title="รีเฟรช">
            <RefreshCw size={15} />
          </button>
          {view === 'inbox' && verifiedInView.length > 0 && (
            <button
              onClick={() => setPrintQueue(verifiedInView)}
              className="flex items-center gap-1 px-3 py-2 rounded-lg bg-sky-600 text-white text-sm hover:bg-sky-700"
              title="พิมพ์ใบปะหน้าทุกรายการที่ตรวจแล้วในรายการที่กรองอยู่นี้"
            >
              <Printer size={15} /> พิมพ์ใบปะหน้า ({verifiedInView.length})
            </button>
          )}
          <button
            onClick={() => downloadCsv(filter).catch(() => setError('ดาวน์โหลดไม่สำเร็จ'))}
            className="flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-800 text-white text-sm hover:bg-slate-700"
          >
            <Download size={15} /> CSV
          </button>
        </div>

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
                  <th className="text-left font-medium px-3 py-2">วันที่</th>
                  <th className="text-left font-medium px-3 py-2">ลูกค้า</th>
                  <th className="text-right font-medium px-3 py-2">ยอด</th>
                  <th className="text-left font-medium px-3 py-2 hidden md:table-cell">ธนาคาร</th>
                  <th className="text-left font-medium px-3 py-2 hidden lg:table-cell">ขาย</th>
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
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{fmtDate(p.createdAt)}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{p.customerName || <span className="text-slate-400">—</span>}</div>
                      <div className="text-xs text-slate-400">{p.customerCode}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">
                      {baht(p.amountNum)}
                      {p.mismatch && <AlertTriangle size={13} className="inline ml-1 text-rose-500" />}
                    </td>
                    <td className="px-3 py-2 text-slate-500 hidden md:table-cell">{p.bank}</td>
                    <td className="px-3 py-2 text-slate-500 hidden lg:table-cell">{p.salesName}</td>
                    <td className="px-3 py-2 text-slate-500 hidden md:table-cell whitespace-nowrap">
                      {p.reNumber || <span className="text-slate-300">—</span>}
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
          onPrint={(p) => setPrintQueue([p])}
        />
      )}
    </div>
  );
}

// ── Slip verifier + action drawer ──────────────────────────────────────────
function Detail({ payment, onClose, onUpdate, onPrint }: {
  payment: Payment; onClose: () => void; onUpdate: (p: Payment) => void; onPrint: (p: Payment) => void;
}) {
  const [busy, setBusy] = useState('');
  const [flagNote, setFlagNote] = useState('');
  const [flagOpen, setFlagOpen] = useState(false);
  const [error, setError] = useState('');
  const [checkOpen, setCheckOpen] = useState(false);
  // informational only — cleared whenever the drawer moves to a different payment
  const [reDuplicates, setReDuplicates] = useState(0);
  useEffect(() => {
    setFlagOpen(false); setFlagNote(''); setReDuplicates(0); setError('');
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
    <div className="fixed inset-0 z-30 bg-slate-900/40 md:static md:z-auto md:bg-transparent md:w-[380px] md:shrink-0">
      <div className="absolute inset-x-0 bottom-0 top-10 md:static bg-white rounded-t-2xl md:rounded-xl border border-slate-200 overflow-y-auto md:sticky md:top-[104px] md:max-h-[calc(100vh-120px)]">
        {/* Sticky header = status + RE on the left, EVERY action as an icon on the right
            (owner request 2026-07-03: actions reachable at any scroll position, add/remove
            any time). Hover an icon for its Thai name. */}
        <div className="sticky top-0 z-10 bg-white px-3 py-2 border-b border-slate-100 rounded-t-2xl md:rounded-t-xl">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <Badge cls={STATUS_META[p.status].cls}>{STATUS_META[p.status].label}</Badge>
              {p.reNumber && <span className="text-xs font-bold text-slate-700 whitespace-nowrap truncate">RE {p.reNumber}</span>}
              {p.flagged && <Flag size={13} className="text-rose-500 shrink-0" />}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {rail('received', STATUS_META.received.label, <Undo2 size={16} />, () => run('received', () => setStatus(p.id, 'received')), {
                disabled: p.status === 'received',
              })}
              {/* 'verified' only via the check dialog — the one path that supplies the RE */}
              {rail('check', p.reNumber ? 'แก้ไขข้อมูลใบเสร็จ' : STATUS_META.verified.label, <ClipboardCheck size={16} />, () => setCheckOpen(true), {
                disabled: p.status === 'void',
                active: p.status === 'verified',
              })}
              {rail('recorded', STATUS_META.recorded.label, <CheckCheck size={16} />, () => run('recorded', () => setStatus(p.id, 'recorded')), {
                disabled: p.status === 'recorded' || p.status === 'void',
                active: p.status === 'recorded',
              })}
              {rail('print', p.reNumber ? 'พิมพ์ใบปะหน้า' : 'พิมพ์ใบปะหน้า (ต้องมีเลข RE ก่อน)', <Printer size={16} />, () => onPrint(p), {
                disabled: !p.reNumber,
              })}
              {rail('flag', p.flagged ? 'เคลียร์ธงตรวจสอบ' : 'ติดธงตรวจสอบยอด', <Flag size={16} />, () => {
                if (p.flagged) void run('flag', () => setFlag(p.id, false));
                else setFlagOpen((v) => !v);
              }, { active: p.flagged })}
              {rail('void', 'ยกเลิก (ตัดออกจากรายงาน)', <Ban size={16} />, () => run('void', () => setStatus(p.id, 'void')), {
                disabled: p.status === 'void',
                danger: true,
              })}
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
        </div>

        {error && <div className="mx-4 mt-2 p-2 rounded-lg bg-rose-50 text-rose-700 text-xs flex items-center gap-1"><AlertTriangle size={13} /> {error}</div>}
        {reDuplicates > 0 && (
          <div className="mx-4 mt-2 px-2 py-1 rounded-lg bg-amber-50 text-amber-700 text-xs flex items-center gap-1">
            <AlertTriangle size={13} /> เลข RE นี้ซ้ำกับรายการอื่น ({reDuplicates})
          </div>
        )}

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
          {p.reNumber && field('ชื่อบนใบเสร็จ', p.receiptName)}
          {p.reNumber && field('ประเภทลูกค้า', p.customerType)}
        </div>

        {p.mismatch && (
          <div className="mx-4 mt-3 p-2 rounded-lg bg-rose-50 text-rose-700 text-xs flex items-start gap-1">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            ยอดที่พนักงานกรอกไม่ตรงกับที่ AI อ่านจากสลิป — ควรตรวจสอบ
          </div>
        )}

        {p.note && (
          <div className="mx-4 mt-3 p-2 rounded-lg bg-slate-50 text-slate-600 text-xs whitespace-pre-wrap">{p.note}</div>
        )}

        {checkOpen && (
          <CheckDialog
            payment={p}
            onClose={() => setCheckOpen(false)}
            onSaved={(updated, dup) => {
              onUpdate(updated);
              setReDuplicates(dup);
              setCheckOpen(false);
            }}
          />
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
      </div>
    </div>
  );
}

// ── Check dialog (the RE check FIN performs when the receipt is issued in Express) ─────────
// Small modal, NOT a browser prompt: this is the one place a payment can become 'verified'.
function CheckDialog({ payment, onClose, onSaved }: {
  payment: Payment;
  onClose: () => void;
  onSaved: (p: Payment, reDuplicates: number) => void;
}) {
  const reRef = useRef<HTMLInputElement>(null);
  const [reNumber, setReNumber] = useState(payment.reNumber);
  const [receiptName, setReceiptName] = useState(
    payment.receiptName || payment.taxInvoice.split('\n')[0]?.trim() || payment.customerName,
  );
  const [customerType, setCustomerType] = useState<CustomerType>(payment.customerType);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { reRef.current?.focus(); }, []);

  // live-strip a typed "RE"/"re" prefix as FIN types (they naturally write "RE6900123")
  function onReChange(v: string) {
    setReNumber(v.replace(/^re/i, ''));
  }

  const digits = reNumber.trim();
  const valid = /^\d{7}$/.test(digits);

  async function save() {
    if (!valid || saving) return;
    setSaving(true);
    setErr('');
    try {
      const res = await verifyPayment(payment.id, {
        reNumber: digits,
        receiptName: receiptName.trim(),
        customerType,
      });
      onSaved(res.payment, res.reDuplicates);
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
          <span className="text-xs text-slate-500">เลขที่ใบเสร็จ (RE)</span>
          <input
            ref={reRef}
            value={reNumber}
            onChange={(e) => onReChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && valid) save(); }}
            placeholder="เช่น 6900123"
            className={`w-full mt-0.5 px-2.5 py-1.5 rounded-lg border text-sm focus:outline-none focus:ring-2 ${
              reNumber && !valid ? 'border-rose-300 focus:ring-rose-300' : 'border-slate-300 focus:ring-emerald-400'
            }`}
          />
          {reNumber && !valid && <span className="text-[11px] text-rose-600">ต้องเป็นตัวเลข 7 หลัก</span>}
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
