import { useCallback, useEffect, useState } from 'react';
import {
  Landmark, LogOut, Search, Download, Flag, FileText, Inbox, BarChart3,
  Loader2, AlertTriangle, CheckCircle2, X, RefreshCw, ExternalLink, Ban,
} from 'lucide-react';
import {
  getSummary, getPayments, setStatus, setFlag, setTaxInvoice, getReport, downloadCsv, baht,
  clearSession,
  type Agent, type Payment, type PaymentStatus, type TaxStatus, type Summary,
  type Report, type PaymentFilter,
} from './lib/api';

type View = 'inbox' | 'flags' | 'tax' | 'reports';

// Thai-locale date/time display for the inbox + drawer (house pattern, vulcan/src/Stock.tsx).
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' });
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });

const STATUS_META: Record<PaymentStatus, { label: string; cls: string }> = {
  received: { label: 'รอตรวจ', cls: 'bg-slate-100 text-slate-600' },
  verified: { label: 'ตรวจแล้ว', cls: 'bg-sky-100 text-sky-700' },
  recorded: { label: 'บันทึกแล้ว', cls: 'bg-emerald-100 text-emerald-700' },
  void: { label: 'ยกเลิก', cls: 'bg-slate-200 text-slate-500 line-through' },
};
const TAX_META: Record<TaxStatus, { label: string; cls: string }> = {
  none: { label: '—', cls: 'text-slate-400' },
  requested: { label: 'ขอแล้ว', cls: 'bg-amber-100 text-amber-700' },
  issued: { label: 'ออกแล้ว', cls: 'bg-emerald-100 text-emerald-700' },
};

function Badge({ children, cls }: { children: React.ReactNode; cls: string }) {
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>{children}</span>;
}

export default function Juno({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const [view, setView] = useState<View>('inbox');
  const [summary, setSummary] = useState<Summary | null>(null);

  const refreshSummary = useCallback(() => {
    getSummary().then(setSummary).catch(() => setSummary(null));
  }, []);
  useEffect(() => { refreshSummary(); }, [refreshSummary]);

  const tabs: { key: View; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: 'inbox', label: 'รายการรับเงิน', icon: <Inbox size={16} />, count: summary?.total },
    { key: 'flags', label: 'ตรวจสอบยอด', icon: <Flag size={16} />, count: summary?.flagged },
    { key: 'tax', label: 'ใบกำกับภาษี', icon: <FileText size={16} />, count: summary?.taxRequested },
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
                <span className={`ml-1 px-1.5 rounded-full text-xs ${t.key === 'flags' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600'}`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4">
        {view === 'reports'
          ? <Reports />
          : <PaymentsView view={view} onChanged={refreshSummary} />}
      </main>
    </div>
  );
}

// ── Payments list + detail (inbox / flags / tax share this) ────────────────
function PaymentsView({ view, onChanged }: { view: Exclude<View, 'reports'>; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [status, setStatusFilter] = useState<'all' | PaymentStatus>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Payment | null>(null);

  const filter: PaymentFilter = {
    q: q.trim() || undefined,
    from: from || undefined,
    to: to || undefined,
    // the flag/tax tabs are pre-filtered queues; the inbox honours the status dropdown
    ...(view === 'flags' ? { flagged: true } : {}),
    ...(view === 'tax' ? { tax: 'requested' as const } : {}),
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
    // a row may drop out of a pre-filtered queue (unflagged / tax issued) → refetch those
    if ((view === 'flags' && !p.flagged) || (view === 'tax' && p.taxInvoiceStatus !== 'requested')) {
      load();
    } else {
      setRows((prev) => prev.map((r) => (r.id === p.id ? p : r)));
    }
    onChanged();
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
              <option value="received">รอตรวจ</option>
              <option value="verified">ตรวจแล้ว</option>
              <option value="recorded">บันทึกแล้ว</option>
              <option value="void">ยกเลิก</option>
            </select>
          )}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="px-2 py-2 rounded-lg border border-slate-300 text-sm" title="ตั้งแต่วันที่" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="px-2 py-2 rounded-lg border border-slate-300 text-sm" title="ถึงวันที่" />
          <button onClick={load} className="p-2 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50" title="รีเฟรช">
            <RefreshCw size={15} />
          </button>
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
        <Detail payment={selected} onClose={() => setSelected(null)} onUpdate={applyUpdate} />
      )}
    </div>
  );
}

// ── Slip verifier + action drawer ──────────────────────────────────────────
function Detail({ payment, onClose, onUpdate }: {
  payment: Payment; onClose: () => void; onUpdate: (p: Payment) => void;
}) {
  const [busy, setBusy] = useState('');
  const [flagNote, setFlagNote] = useState('');
  const [error, setError] = useState('');

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

  return (
    <div className="fixed inset-0 z-30 bg-slate-900/40 md:static md:z-auto md:bg-transparent md:w-[380px] md:shrink-0">
      <div className="absolute inset-x-0 bottom-0 top-10 md:static bg-white rounded-t-2xl md:rounded-xl border border-slate-200 overflow-y-auto md:sticky md:top-[104px] md:max-h-[calc(100vh-120px)]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
          <div className="font-semibold">รายละเอียดการรับเงิน</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        {error && <div className="mx-4 mt-2 p-2 rounded-lg bg-rose-50 text-rose-700 text-xs flex items-center gap-1"><AlertTriangle size={13} /> {error}</div>}

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

        {/* lifecycle actions */}
        <div className="px-4 py-3 mt-2 border-t border-slate-100">
          <div className="text-xs text-slate-400 mb-1.5">สถานะ · <Badge cls={STATUS_META[p.status].cls}>{STATUS_META[p.status].label}</Badge></div>
          <div className="flex flex-wrap gap-1.5">
            {(['received', 'verified', 'recorded'] as PaymentStatus[]).map((s) => (
              <button
                key={s}
                // a voided payment must be explicitly restored to 'received' before re-verifying
                // (server 409s verify/record while void; รอตรวจ stays enabled as the un-void path)
                disabled={busy !== '' || p.status === s || (p.status === 'void' && s !== 'received')}
                onClick={() => run(s, () => setStatus(p.id, s))}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-40 ${
                  p.status === s ? 'bg-emerald-600 text-white border-emerald-600' : 'border-slate-300 hover:bg-slate-50'
                }`}
              >
                {busy === s ? <Loader2 size={13} className="animate-spin" /> : STATUS_META[s].label}
              </button>
            ))}
            <button
              disabled={busy !== '' || p.status === 'void'}
              onClick={() => run('void', () => setStatus(p.id, 'void'))}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-300 text-slate-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 flex items-center gap-1"
            >
              <Ban size={13} /> ยกเลิก
            </button>
          </div>
        </div>

        {/* flag */}
        <div className="px-4 py-3 border-t border-slate-100">
          <div className="text-xs text-slate-400 mb-1.5">
            {p.flagged ? <span className="text-rose-600 font-semibold flex items-center gap-1"><Flag size={13} /> ติดธงตรวจสอบ</span> : 'ตรวจสอบยอด'}
          </div>
          {!p.flagged && (
            <input
              value={flagNote}
              onChange={(e) => setFlagNote(e.target.value)}
              placeholder="หมายเหตุ (ถ้ามี)"
              className="w-full px-2 py-1.5 mb-1.5 rounded-lg border border-slate-300 text-sm"
            />
          )}
          <button
            disabled={busy !== ''}
            onClick={() => run('flag', () => setFlag(p.id, !p.flagged, flagNote.trim() || undefined))}
            className={`w-full px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-1 ${
              p.flagged ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                        : 'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100'
            }`}
          >
            {busy === 'flag' ? <Loader2 size={14} className="animate-spin" /> : p.flagged ? <><CheckCircle2 size={14} /> เคลียร์ธง</> : <><Flag size={14} /> ติดธง</>}
          </button>
        </div>

        {/* tax invoice — always shown: the common case is the customer asking for it days
            after the slip was forwarded, not just at forward time */}
        <div className="px-4 py-3 border-t border-slate-100">
          <div className="text-xs text-slate-400 mb-1.5 flex items-center gap-1">
            <FileText size={13} /> ใบกำกับภาษี · <Badge cls={TAX_META[p.taxInvoiceStatus].cls}>{TAX_META[p.taxInvoiceStatus].label}</Badge>
          </div>
          {p.taxInvoice && (
            <div className="p-2 mb-2 rounded-lg bg-slate-50 text-slate-600 text-xs whitespace-pre-wrap">{p.taxInvoice}</div>
          )}
          {p.taxInvoiceStatus === 'none' ? (
            <button
              disabled={busy !== ''}
              onClick={() => run('taxreq', () => setTaxInvoice(p.id, 'requested'))}
              className="w-full px-3 py-1.5 rounded-lg text-sm font-medium border border-slate-300 hover:bg-slate-50 disabled:opacity-40 flex items-center justify-center gap-1"
            >
              {busy === 'taxreq' ? <Loader2 size={14} className="animate-spin" /> : 'ขอใบกำกับภาษี'}
            </button>
          ) : (
            <div className="flex gap-1.5 items-center">
              {(['requested', 'issued'] as TaxStatus[]).map((s) => (
                <button
                  key={s}
                  disabled={busy !== '' || p.taxInvoiceStatus === s}
                  onClick={() => run('tax' + s, () => setTaxInvoice(p.id, s))}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border disabled:opacity-40 ${
                    p.taxInvoiceStatus === s ? 'bg-emerald-600 text-white border-emerald-600' : 'border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {busy === 'tax' + s ? <Loader2 size={13} className="animate-spin" /> : TAX_META[s].label}
                </button>
              ))}
              {p.taxInvoiceStatus === 'requested' && (
                <button
                  disabled={busy !== ''}
                  onClick={() => run('taxnone', () => setTaxInvoice(p.id, 'none'))}
                  className="px-2 py-1 text-xs text-slate-400 hover:text-rose-600 underline disabled:opacity-40"
                >
                  ยกเลิกคำขอ
                </button>
              )}
            </div>
          )}
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
