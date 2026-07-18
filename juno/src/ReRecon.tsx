import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileCheck, Upload, Loader2, AlertTriangle, CheckCircle2, RefreshCw, Search,
  ChevronDown, ChevronRight, Ban,
} from 'lucide-react';
import {
  baht, fileToBase64, importReReceipts, getReReconciliation,
  type ReReconRow, type ReReconSummary, type ReReconStatusFilter, type ReImportResult,
} from './lib/api';

// กระทบยอด RE tab. Imports Express's periodic ARRCPDAT.TXT (AR-receipt report) and
// cross-checks every RE against the Juno Payment(s) carrying it — the "future RE-import"
// the WHT feature's grossOf() was built for (see JUNO_BRIEF.md). Match status is computed
// LIVE server-side on every load (never stored), so it's always current. The import
// (CEO-only) is a separate concern from viewing the list (every Juno user).

const fmtReceiptDate = (dd: string): string => {
  const m = dd.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) return dd;
  const greg = 2500 + Number(m[3]) - 543;
  return new Date(Date.UTC(greg, Number(m[2]) - 1, Number(m[1]))).toLocaleDateString('th-TH', {
    day: '2-digit', month: 'short', year: '2-digit',
  });
};

const STATUS_FILTERS: { key: ReReconStatusFilter; label: string }[] = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'matched', label: 'จับ RE แล้ว' },
  { key: 'mismatch', label: 'ยอดไม่ตรง' },
  { key: 'unpaid', label: 'ยังไม่จ่าย' },
  { key: 'closed', label: 'ปิดใน Express' },
];

function StatusBadge({ status }: { status: ReReconRow['status'] }) {
  if (status === 'matched') {
    return <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-700 whitespace-nowrap">✅ จับ RE แล้ว</span>;
  }
  if (status === 'mismatch') {
    return <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-amber-100 text-amber-700 whitespace-nowrap">⚠️ ยอดไม่ตรง</span>;
  }
  if (status === 'closed') {
    return <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-500 whitespace-nowrap">✔ ปิดใน Express</span>;
  }
  return <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-rose-100 text-rose-700 whitespace-nowrap">⏳ ยังไม่จ่าย</span>;
}

export default function ReRecon({ isCeo }: { isCeo: boolean }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-emerald-700">
        <FileCheck size={20} />
        <h1 className="text-lg font-bold text-slate-800">กระทบยอด RE</h1>
      </div>

      {/* The RE FILE import (uploading ARRCPDAT.TXT) is CEO-only — server 403s
          POST /api/juno/re/import for non-supervisor. The list below (viewing/searching/
          filtering every imported RE and its live match status) stays visible to everyone. */}
      {isCeo && <ImportPanel onImported={bump} />}
      <ReList refreshKey={refreshKey} />
    </div>
  );
}

// ── Import panel (CEO-only) ─────────────────────────────────────────────────
function ImportPanel({ onImported }: { onImported: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReImportResult | null>(null);

  async function handleFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const dataB64 = await fileToBase64(file);
      const r = await importReReceipts(dataB64, file.name);
      setResult(r);
      onImported();
    } catch (e) {
      setError((e as Error).message === 'unauthorized' ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : `อ่านไฟล์ไม่สำเร็จ: ${file.name}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-slate-800">นำเข้าไฟล์ RE</div>
        <div className="text-xs text-slate-400">ARRCPDAT.TXT — รายงานการรับชำระหนี้จาก Express</div>
      </div>
      <div className="flex items-center gap-2">
        <input ref={inputRef} type="file" accept=".txt" className="hidden" onChange={(e) => handleFile(e.target.files)} />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} เลือกไฟล์ ARRCPDAT.TXT
        </button>
      </div>

      {error && (
        <div className="mt-3 p-2 rounded-lg bg-rose-50 text-rose-700 text-xs flex items-center gap-1">
          <AlertTriangle size={13} /> {error}
        </div>
      )}

      {result && (
        <div className="mt-3 p-3 rounded-lg bg-emerald-50 text-emerald-700 text-xs space-y-1">
          <div className="flex items-center gap-1 font-medium">
            <CheckCircle2 size={13} /> นำเข้าแล้ว {result.parsed} รายการ — ใหม่ {result.imported} / อัปเดต {result.updated}
            {result.cancelledSkipped > 0 && ` / ข้ามใบยกเลิก ${result.cancelledSkipped}`}
          </div>
          {!result.totalsMatch && (
            <div className="flex items-center gap-1 text-amber-700">
              <AlertTriangle size={12} />
              ⚠️ ยอดรวมที่แยกได้ ({baht(result.totalAmount)}) ไม่ตรงกับยอดรวมท้ายไฟล์
              {result.fileTotal !== null && ` (${baht(result.fileTotal)})`} — ตรวจสอบไฟล์อีกครั้ง
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Totals bar + RE list ─────────────────────────────────────────────────────
function ReList({ refreshKey }: { refreshKey: number }) {
  const [status, setStatus] = useState<ReReconStatusFilter>('all');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<ReReconRow[]>([]);
  const [summary, setSummary] = useState<ReReconSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getReReconciliation({ status, q: q.trim() || undefined, from: from || undefined, to: to || undefined })
      .then((r) => { setRows(r.rows); setSummary(r.summary); })
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, q, from, to, refreshKey]);

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce the search box
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="space-y-3">
      <SummaryCards summary={summary} />

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="p-3 border-b border-slate-100 flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-slate-300 overflow-hidden">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setStatus(f.key)}
                className={`px-2.5 py-1.5 text-xs ${status === f.key ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="relative flex-1 min-w-[160px]">
            <Search size={14} className="absolute left-2.5 top-2 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="ค้นหา RE / ชื่อลูกค้า"
              className="w-full pl-7 pr-2 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-1.5 rounded-lg border border-slate-300 text-xs" title="ตั้งแต่วันที่" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-1.5 rounded-lg border border-slate-300 text-xs" title="ถึงวันที่" />
          <button onClick={load} className="p-1.5 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50" title="รีเฟรช">
            <RefreshCw size={14} />
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-slate-400"><Loader2 className="animate-spin inline" size={20} /></div>
        ) : error ? (
          <div className="p-6 text-center text-rose-600 text-sm flex items-center justify-center gap-1"><AlertTriangle size={15} /> {error}</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-sm">ไม่มีรายการ RE</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {rows.map((r) => (
              <ReRow key={r.id} row={r} expanded={expanded === r.id} onToggle={() => setExpanded((e) => (e === r.id ? null : r.id))} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCards({ summary }: { summary: ReReconSummary | null }) {
  if (!summary) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6 text-center text-slate-400">
        <Loader2 className="animate-spin inline" size={18} />
      </div>
    );
  }
  const cards = [
    { label: '✅ จับ RE แล้ว', count: summary.matched, tone: 'text-emerald-600' },
    { label: '⚠️ ยอดไม่ตรง', count: summary.mismatch, tone: 'text-amber-600' },
    { label: '⏳ ยังไม่จ่าย', count: summary.unpaid, tone: 'text-rose-600' },
    { label: '✔ ปิดใน Express', count: summary.closed, tone: 'text-slate-500' },
    { label: 'ยอดรวมทั้งหมด', count: summary.total, sum: summary.totalAmount, tone: 'text-slate-700' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-xs text-slate-400">{c.label}</div>
          <div className={`text-2xl font-bold ${c.tone}`}>{c.count}</div>
          {c.sum !== undefined && <div className="text-sm text-slate-500">{baht(c.sum)}</div>}
        </div>
      ))}
    </div>
  );
}

function ReRow({ row, expanded, onToggle }: { row: ReReconRow; expanded: boolean; onToggle: () => void }) {
  return (
    <div>
      <div onClick={onToggle} className="px-3 py-2.5 flex items-center gap-2 cursor-pointer hover:bg-emerald-50/40 text-sm">
        {expanded ? <ChevronDown size={15} className="text-slate-400 shrink-0" /> : <ChevronRight size={15} className="text-slate-400 shrink-0" />}
        <div className="w-24 shrink-0 font-semibold text-emerald-700 whitespace-nowrap">RE{row.reNumber}</div>
        <div className="w-20 shrink-0 text-slate-500 whitespace-nowrap">{fmtReceiptDate(row.receiptDate)}</div>
        <div className="flex-1 min-w-0 truncate text-slate-600">
          {row.customerName}
          {row.notPosted && <span className="ml-1.5 text-[11px] text-amber-500" title="*** ในไฟล์ Express = ยังไม่ได้รับเงิน / รายการยังไม่จบ">*** ไม่เรียบร้อย</span>}
        </div>
        <div className="w-28 shrink-0 text-right font-semibold whitespace-nowrap">{baht(row.amount)}</div>
        <div className="shrink-0 flex items-center gap-1.5 flex-wrap justify-end max-w-[38%]">
          {row.status === 'mismatch' && (
            <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-600 whitespace-nowrap">
              รับจริง {baht(row.paidGross)} ({row.diff > 0 ? '+' : ''}{row.diff.toFixed(2)})
            </span>
          )}
          {row.paymentCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-500 whitespace-nowrap">{row.paymentCount} รายการรับเงิน</span>
          )}
          <StatusBadge status={row.status} />
        </div>
      </div>
      {expanded && <ReDetail row={row} />}
    </div>
  );
}

function ReDetail({ row }: { row: ReReconRow }) {
  return (
    <div className="px-4 pb-4 pt-1 bg-slate-50 border-t border-slate-100 text-sm">
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>พนักงานขาย: <span className="text-slate-700">{row.salesName || '—'}</span></span>
        <span>ยอดตามใบกำกับ: <span className="text-slate-700 font-medium">{baht(row.amount)}</span></span>
        {row.paymentCount > 0 && (
          <span>รับเงินจริง (gross): <span className="text-slate-700 font-medium">{baht(row.paidGross)}</span></span>
        )}
        {row.paymentCount > 0 && (
          <span>ผลต่าง: <span className={`font-medium ${Math.abs(row.diff) < 0.01 ? 'text-emerald-600' : 'text-amber-600'}`}>{row.diff > 0 ? '+' : ''}{row.diff.toFixed(2)}</span></span>
        )}
      </div>
      {row.invoices.length === 0 ? (
        <div className="text-xs text-slate-400 flex items-center gap-1"><Ban size={12} /> ไม่มีรายละเอียดใบแจ้งหนี้</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-slate-400">
            <tr>
              <th className="text-left font-medium py-1">เลขที่</th>
              <th className="text-left font-medium py-1">วันที่</th>
              <th className="text-right font-medium py-1">จำนวนเงิน</th>
            </tr>
          </thead>
          <tbody>
            {row.invoices.map((iv, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="py-1">{iv.docNo}</td>
                <td className="py-1 text-slate-500">{fmtReceiptDate(iv.date)}</td>
                <td className={`py-1 text-right ${iv.amount < 0 ? 'text-rose-500' : ''}`}>{baht(iv.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
