import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileCheck, Upload, Loader2, AlertTriangle, CheckCircle2, RefreshCw, Search,
  ChevronDown, ChevronRight, Ban, FileText,
} from 'lucide-react';
import {
  baht, fileToBase64, importReReceipts, importXsDocs, getReReconciliation, getRePayments, closeDoc,
  type ReReconRow, type ReReconSummary, type ReReconStatusFilter, type ReImportResult,
  type XsImportResult, type Payment, type DocReconType,
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
  { key: 'matched', label: 'จับเอกสารแล้ว' },
  { key: 'mismatch', label: 'ยอดไม่ตรง' },
  { key: 'unpaid', label: 'ยังไม่จ่าย' },
  { key: 'closed', label: 'ปิดแล้ว' },
];

const TYPE_FILTERS: { key: DocReconType | 'all'; label: string }[] = [
  { key: 'all', label: 'ทุกประเภท' },
  { key: 're', label: 'RE' },
  { key: 'mb', label: 'MB' },
  { key: 'xs', label: 'XS' },
];

// Document-number display + accent per family: RE emerald (Express receipts), MB sky (matches
// the MB chips elsewhere), XS amber (ex-"external" chip colour).
const docLabel = (r: ReReconRow): string =>
  r.docType === 'mb' ? (r.reNumber.startsWith('MB') ? r.reNumber : `MB ${r.reNumber}`)
  : r.docType === 'xs' ? r.reNumber
  : `RE${r.reNumber}`;
const docTone = (t: DocReconType): string =>
  t === 'mb' ? 'text-sky-700' : t === 'xs' ? 'text-amber-700' : 'text-emerald-700';

function StatusBadge({ status, docType }: { status: ReReconRow['status']; docType: DocReconType }) {
  if (status === 'matched') {
    return <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-700 whitespace-nowrap">✅ {docType === 're' ? 'จับ RE แล้ว' : 'จับเอกสารแล้ว'}</span>;
  }
  if (status === 'mismatch') {
    return <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-amber-100 text-amber-700 whitespace-nowrap">⚠️ ยอดไม่ตรง</span>;
  }
  if (status === 'closed') {
    return <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-500 whitespace-nowrap">✔ {docType === 're' ? 'ปิดใน Express' : 'ปิดแล้ว'}</span>;
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
        <h1 className="text-lg font-bold text-slate-800">กระทบยอดเอกสาร (RE · MB · XS)</h1>
      </div>

      {/* FILE imports (ARRCPDAT.TXT = RE, STTRNR6.TXT = XS) are CEO-only — server 403s the
          import routes for non-supervisor. The list below (viewing/searching/filtering every
          document and its live match status) stays visible to everyone. */}
      {isCeo && <ImportPanel onImported={bump} />}
      <ReList refreshKey={refreshKey} isCeo={isCeo} />
    </div>
  );
}

// ── Import panel (CEO-only): RE + XS files side by side ─────────────────────
function ImportPanel({ onImported }: { onImported: () => void }) {
  const reInputRef = useRef<HTMLInputElement>(null);
  const xsInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'' | 're' | 'xs'>('');
  const [error, setError] = useState('');
  const [reResult, setReResult] = useState<ReImportResult | null>(null);
  const [xsResult, setXsResult] = useState<XsImportResult | null>(null);

  async function handleFile(kind: 're' | 'xs', files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy(kind);
    setError('');
    try {
      const dataB64 = await fileToBase64(file);
      if (kind === 're') setReResult(await importReReceipts(dataB64, file.name));
      else setXsResult(await importXsDocs(dataB64, file.name));
      onImported();
    } catch (e) {
      setError((e as Error).message === 'unauthorized' ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : `อ่านไฟล์ไม่สำเร็จ: ${file.name}`);
    } finally {
      setBusy('');
      if (reInputRef.current) reInputRef.current.value = '';
      if (xsInputRef.current) xsInputRef.current.value = '';
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-slate-800">นำเข้าไฟล์จาก Express</div>
        <div className="text-xs text-slate-400">RE = ARRCPDAT.TXT (รับชำระหนี้) · XS = STTRNR6.TXT (จ่ายสินค้าภายใน)</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={reInputRef} type="file" accept=".txt" className="hidden" onChange={(e) => handleFile('re', e.target.files)} />
        <input ref={xsInputRef} type="file" accept=".txt" className="hidden" onChange={(e) => handleFile('xs', e.target.files)} />
        <button
          onClick={() => reInputRef.current?.click()}
          disabled={busy !== ''}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50"
        >
          {busy === 're' ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} ไฟล์ RE (ARRCPDAT.TXT)
        </button>
        <button
          onClick={() => xsInputRef.current?.click()}
          disabled={busy !== ''}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700 disabled:opacity-50"
        >
          {busy === 'xs' ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} ไฟล์ XS (STTRNR6.TXT)
        </button>
      </div>

      {error && (
        <div className="mt-3 p-2 rounded-lg bg-rose-50 text-rose-700 text-xs flex items-center gap-1">
          <AlertTriangle size={13} /> {error}
        </div>
      )}

      {reResult && (
        <div className="mt-3 p-3 rounded-lg bg-emerald-50 text-emerald-700 text-xs space-y-1">
          <div className="flex items-center gap-1 font-medium">
            <CheckCircle2 size={13} /> RE: นำเข้าแล้ว {reResult.parsed} รายการ — ใหม่ {reResult.imported} / อัปเดต {reResult.updated}
            {reResult.cancelledSkipped > 0 && ` / ข้ามใบยกเลิก ${reResult.cancelledSkipped}`}
          </div>
          {!reResult.totalsMatch && (
            <div className="flex items-center gap-1 text-amber-700">
              <AlertTriangle size={12} />
              ⚠️ ยอดรวมที่แยกได้ ({baht(reResult.totalAmount)}) ไม่ตรงกับยอดรวมท้ายไฟล์
              {reResult.fileTotal !== null && ` (${baht(reResult.fileTotal)})`} — ตรวจสอบไฟล์อีกครั้ง
            </div>
          )}
        </div>
      )}
      {xsResult && (
        <div className="mt-3 p-3 rounded-lg bg-amber-50 text-amber-700 text-xs space-y-1">
          <div className="flex items-center gap-1 font-medium">
            <CheckCircle2 size={13} /> XS: นำเข้าแล้ว {xsResult.parsed} เอกสาร — ใหม่ {xsResult.imported} / อัปเดต {xsResult.updated}
          </div>
          {!xsResult.totalsMatch && (
            <div className="flex items-center gap-1">
              <AlertTriangle size={12} />
              ⚠️ ยอดรวมที่แยกได้ ({baht(xsResult.totalAmount)}) ไม่ตรงกับท้ายไฟล์
              {xsResult.fileTotal !== null && ` (${baht(xsResult.fileTotal)})`} — ตรวจสอบไฟล์อีกครั้ง
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Totals bar + RE list ─────────────────────────────────────────────────────
const PAGE_SIZE = 100;

function ReList({ refreshKey, isCeo }: { refreshKey: number; isCeo: boolean }) {
  const [status, setStatus] = useState<ReReconStatusFilter>('all');
  const [docType, setDocType] = useState<DocReconType | 'all'>('all');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<ReReconRow[]>([]);
  const [summary, setSummary] = useState<ReReconSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  // Bumped on every request; a response only lands if it's still the newest one, so a slow
  // page-2 append can never clobber the fresh page-1 of a filter the user changed to meanwhile.
  const genRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const load = useCallback((offset: number) => {
    const gen = ++genRef.current;
    const replace = offset === 0;
    if (replace) setLoading(true); else setLoadingMore(true);
    setError('');
    getReReconciliation({
      status, type: docType, q: q.trim() || undefined, from: from || undefined, to: to || undefined,
      limit: PAGE_SIZE, offset,
    })
      .then((r) => {
        if (gen !== genRef.current) return;
        setSummary(r.summary);
        setTotal(r.total);
        setHasMore(r.hasMore);
        setRows((prev) => (replace ? r.rows : [...prev, ...r.rows]));
      })
      .catch(() => { if (gen === genRef.current) setError('โหลดข้อมูลไม่สำเร็จ'); })
      .finally(() => {
        if (gen !== genRef.current) return;
        setLoading(false);
        setLoadingMore(false);
      });
  }, [status, docType, q, from, to]);

  useEffect(() => {
    const t = setTimeout(() => load(0), 250); // debounce the search box
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  // Auto-append the next page when the bottom sentinel scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading || loadingMore) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) load(rows.length); },
      { rootMargin: '300px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loading, loadingMore, rows.length, load]);

  return (
    <div className="space-y-3">
      <SummaryCards summary={summary} />

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="p-3 border-b border-slate-100 flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-slate-300 overflow-hidden">
            {TYPE_FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setDocType(f.key)}
                className={`px-2.5 py-1.5 text-xs ${docType === f.key ? 'bg-slate-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
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
              placeholder="ค้นหาเลขเอกสาร / ชื่อลูกค้า"
              className="w-full pl-7 pr-2 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
          </div>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-1.5 rounded-lg border border-slate-300 text-xs" title="ตั้งแต่วันที่" />
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-1.5 rounded-lg border border-slate-300 text-xs" title="ถึงวันที่" />
          <button onClick={() => load(0)} className="p-1.5 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50" title="รีเฟรช">
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
              <ReRow key={r.id} row={r} expanded={expanded === r.id} onToggle={() => setExpanded((e) => (e === r.id ? null : r.id))} isCeo={isCeo} onMutated={() => load(0)} />
            ))}
            {hasMore && (
              <div
                ref={sentinelRef}
                onClick={() => { if (!loadingMore) load(rows.length); }}
                className="p-3 text-center text-xs text-slate-400 cursor-pointer hover:bg-slate-50"
              >
                {loadingMore
                  ? <Loader2 className="animate-spin inline" size={15} />
                  : `แสดง ${rows.length} จาก ${total} รายการ — เลื่อนลงเพื่อโหลดเพิ่ม`}
              </div>
            )}
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
    { label: '✅ จับเอกสารแล้ว', count: summary.matched, tone: 'text-emerald-600' },
    { label: '⚠️ ยอดไม่ตรง', count: summary.mismatch, tone: 'text-amber-600' },
    { label: '⏳ ยังไม่จ่าย', count: summary.unpaid, tone: 'text-rose-600' },
    { label: '✔ ปิดแล้ว', count: summary.closed, tone: 'text-slate-500' },
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

function ReRow({ row, expanded, onToggle, isCeo, onMutated }: { row: ReReconRow; expanded: boolean; onToggle: () => void; isCeo: boolean; onMutated: () => void }) {
  return (
    <div>
      <div onClick={onToggle} className="px-3 py-2.5 flex items-center gap-2 cursor-pointer hover:bg-emerald-50/40 text-sm">
        {expanded ? <ChevronDown size={15} className="text-slate-400 shrink-0" /> : <ChevronRight size={15} className="text-slate-400 shrink-0" />}
        <div className={`w-24 shrink-0 font-semibold whitespace-nowrap ${docTone(row.docType)}`}>{docLabel(row)}</div>
        <div className="w-20 shrink-0 text-slate-500 whitespace-nowrap">{fmtReceiptDate(row.receiptDate)}</div>
        <div className="flex-1 min-w-0 truncate text-slate-600">
          {row.customerName}
          {row.docType === 're' && row.notPosted && <span className="ml-1.5 text-[11px] text-amber-500" title="*** ในไฟล์ Express = ยังไม่ได้รับเงิน / รายการยังไม่จบ">*** ไม่เรียบร้อย</span>}
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
          <StatusBadge status={row.status} docType={row.docType} />
        </div>
      </div>
      {expanded && <ReDetail row={row} isCeo={isCeo} onMutated={onMutated} />}
    </div>
  );
}

const PAY_STATUS_TH: Record<string, string> = {
  received: 'รอตรวจ', verified: 'ตรวจแล้ว', recorded: 'ยืนยันใน Express', void: 'ยกเลิก',
};

function channelLabel(p: Payment): string {
  if (p.source === 'cash') return 'เงินสด';
  if (p.source === 'cheque') return p.chequeNo ? `เช็ค #${p.chequeNo}` : 'เช็คธนาคาร';
  if (p.source === 'credit') return 'ใช้เครดิต';
  return 'โอนเงิน';
}

// One covering payment inside an expanded RE row: slip thumbnail (click = full view), channel,
// who paid, the money math (net → +WHT → +credit), stage chips, and every document the payment
// carries — a multi-RE/MB chip list is exactly how a split/bundled transfer explains its diff.
function PaymentMiniCard({ p, core }: { p: Payment; core: string }) {
  const isPdf = p.slipUrl.endsWith('#pdf');
  const whtBaht = p.grossAmount - p.amountNum;
  const creditBaht = Number(p.creditUsed || 0);
  return (
    <div className="flex gap-3 bg-white rounded-lg border border-slate-200 p-2.5">
      {p.slipUrl ? (
        <a href={p.slipUrl} target="_blank" rel="noreferrer" className="shrink-0 block" title="เปิดสลิปเต็มจอ">
          {isPdf ? (
            <span className="flex flex-col items-center justify-center w-16 h-20 rounded-md border border-slate-200 bg-slate-50 text-slate-500 text-[10px] gap-1">
              <FileText size={18} /> PDF
            </span>
          ) : (
            <img src={p.slipUrl} alt="สลิป" className="w-16 h-20 object-cover rounded-md border border-slate-200 bg-slate-50" />
          )}
        </a>
      ) : (
        <span className="shrink-0 flex items-center justify-center w-16 h-20 rounded-md border border-dashed border-slate-200 text-slate-300 text-[10px]">ไม่มีสลิป</span>
      )}
      <div className="min-w-0 flex-1 text-xs space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-slate-700">{channelLabel(p)}</span>
          {p.bank && <span className="text-slate-500">{p.bank}</span>}
          {p.transferAt && <span className="text-slate-500">{p.transferAt}</span>}
          <span className={`px-1.5 py-0.5 rounded-full text-[10px] whitespace-nowrap ${p.status === 'recorded' ? 'bg-emerald-100 text-emerald-700' : p.status === 'verified' ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-600'}`}>
            {PAY_STATUS_TH[p.status] ?? p.status}
          </span>
          {p.reconciled && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-teal-50 text-teal-700 whitespace-nowrap">จับคู่ธนาคารแล้ว</span>}
          {p.receivedAt && <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-teal-50 text-teal-700 whitespace-nowrap">ได้รับเงินแล้ว</span>}
        </div>
        <div className="text-slate-600 truncate">
          {p.senderName && <>ผู้โอน: <span className="text-slate-700">{p.senderName}</span> · </>}
          ลูกค้า: <span className="text-slate-700">{[p.customerCode, p.customerName].filter(Boolean).join(' ') || p.receiptName || '—'}</span>
          {p.ref && <> · อ้างอิง {p.ref}</>}
        </div>
        <div className="text-slate-600">
          รับจริง <span className="font-semibold text-slate-800">{baht(p.amountNum)}</span>
          {whtBaht > 0.004 && <> · หัก {p.whtRate}% {baht(whtBaht)} → เต็ม <span className="font-medium text-slate-800">{baht(p.grossAmount)}</span></>}
          {creditBaht > 0 && <> · เครดิต {baht(creditBaht)} → รวม <span className="font-medium text-slate-800">{baht(p.effectivePaidAmount)}</span></>}
        </div>
        {(p.reNumbers.length > 1 || p.billNos.length > 0) && (
          <div className="flex flex-wrap gap-1">
            {p.reNumbers.map((re) => (
              <span key={re} className={`px-1 py-0.5 rounded text-[10px] whitespace-nowrap ${re === core ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'bg-slate-100 text-slate-500'}`}>RE{re}</span>
            ))}
            {p.billNos.map((b) => (
              <span key={b} className="px-1 py-0.5 rounded text-[10px] whitespace-nowrap bg-sky-50 text-sky-600">MB {b}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ReDetail({ row, isCeo, onMutated }: { row: ReReconRow; isCeo: boolean; onMutated: () => void }) {
  const [payments, setPayments] = useState<Payment[] | null>(row.paymentCount === 0 ? [] : null);
  const [payError, setPayError] = useState('');
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (row.paymentCount === 0) { setPayments([]); return; }
    let alive = true;
    setPayments(null);
    setPayError('');
    getRePayments(row.reNumber)
      .then((r) => { if (alive) setPayments(r.payments); })
      .catch(() => { if (alive) setPayError('โหลดรายการรับเงินไม่สำเร็จ'); });
    return () => { alive = false; };
  }, [row.reNumber, row.paymentCount]);

  // Manual ปิดเอกสาร for MB/XS: docs settled without a Juno payment (historic XS, valued
  // samples/claims not being charged). Undo only offered on a manual stamp — a doc closed via
  // its stage-4 payment un-closes by voiding that payment, not here.
  const closable = row.docType !== 're' && isCeo;
  async function toggleClose(nextClosed: boolean) {
    let note: string | undefined;
    if (nextClosed) {
      const input = window.prompt('หมายเหตุการปิดเอกสาร (เช่น เครม / ตัวอย่าง / รับเงินนอกระบบ) — เว้นว่างได้', row.closeNote || '');
      if (input === null) return; // cancelled
      note = input.trim() || undefined;
    }
    setClosing(true);
    try {
      await closeDoc(row.reNumber, nextClosed, note);
      onMutated();
    } catch {
      setPayError('บันทึกการปิดเอกสารไม่สำเร็จ');
    } finally {
      setClosing(false);
    }
  }

  return (
    <div className="px-4 pb-4 pt-1 bg-slate-50 border-t border-slate-100 text-sm">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>พนักงานขาย: <span className="text-slate-700">{row.salesName || '—'}</span></span>
        <span>ยอดตามเอกสาร: <span className="text-slate-700 font-medium">{baht(row.amount)}</span></span>
        {row.paymentCount > 0 && (
          <span>รับเงินจริง (gross): <span className="text-slate-700 font-medium">{baht(row.paidGross)}</span></span>
        )}
        {row.paymentCount > 0 && (
          <span>ผลต่าง: <span className={`font-medium ${Math.abs(row.diff) < 0.01 ? 'text-emerald-600' : 'text-amber-600'}`}>{row.diff > 0 ? '+' : ''}{row.diff.toFixed(2)}</span></span>
        )}
        {row.closeNote && <span>หมายเหตุปิด: <span className="text-slate-700">{row.closeNote}</span></span>}
        {closable && !row.manualClosed && row.status !== 'closed' && (
          <button
            onClick={(e) => { e.stopPropagation(); toggleClose(true); }}
            disabled={closing}
            className="px-2 py-1 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
          >
            {closing ? '...' : '✔ ปิดเอกสาร (ไม่ผ่าน Juno)'}
          </button>
        )}
        {closable && row.manualClosed && (
          <button
            onClick={(e) => { e.stopPropagation(); toggleClose(false); }}
            disabled={closing}
            className="px-2 py-1 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-50"
          >
            {closing ? '...' : 'ยกเลิกการปิดเอกสาร'}
          </button>
        )}
      </div>
      {row.paymentCount > 0 && (
        <div className="mb-3">
          <div className="text-xs font-medium text-slate-500 mb-1.5">รายการรับเงิน ({row.paymentCount})</div>
          {payError ? (
            <div className="text-xs text-rose-600 flex items-center gap-1"><AlertTriangle size={12} /> {payError}</div>
          ) : payments === null ? (
            <div className="py-2"><Loader2 className="animate-spin text-slate-300" size={16} /></div>
          ) : (
            <div className="space-y-2">
              {payments.map((p) => <PaymentMiniCard key={p.id} p={p} core={row.reNumber} />)}
            </div>
          )}
        </div>
      )}
      {row.invoices.length === 0 ? (
        <div className="text-xs text-slate-400 flex items-center gap-1"><Ban size={12} /> ไม่มีรายละเอียดใบแจ้งหนี้</div>
      ) : (
        <>
        <div className="text-xs font-medium text-slate-500 mb-1">ใบแจ้งหนี้ใน RE (จาก Express)</div>
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
        </>
      )}
    </div>
  );
}
