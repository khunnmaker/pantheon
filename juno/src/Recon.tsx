import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Scale, Upload, Loader2, AlertTriangle, CheckCircle2, RefreshCw, ChevronDown,
  ChevronRight, Search, Link2, Unlink, Ban,
} from 'lucide-react';
import {
  baht, fileToBase64, previewBankImport, applyBankImport, getBankTxns, getBankSuggestions,
  matchBankTxn, unmatchBankTxn, setBankTxnRef, confirmBankTxn, confirmAllMatched, getBankSummary,
  getPaymentsRecon, getPaymentTxnSuggestions, matchPaymentTxns,
  type BankTxn, type BankTxnStatusFilter, type BankImportPreview,
  type BankSuggestion, type BankSummary, type PaymentReconRow, type PaymentReconState,
  type TxnSuggestion,
} from './lib/api';

// กระทบยอด (bank reconciliation) tab. See JUNO_PROCESS_BRIEF.md PHASE B / B4. The owner
// downloads KBIZ + K SHOP every Wed/Sat; this tab is where those credit lines get matched
// against checked (RE-carrying) Payments, and where the weekend ยืนยัน Express bulk action
// (advancing matched payments to "recorded") happens.

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' });

const STATUS_FILTERS: { key: BankTxnStatusFilter; label: string }[] = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'unmatched', label: 'ยังไม่จับคู่' },
  { key: 'matched', label: 'จับคู่แล้ว' },
  { key: 'confirmed', label: 'ยืนยันแล้ว' },
];

// Channel chip label — collapses the verbose KBIZ "Internet/Mobile BBL" style channels
// and the K SHOP fixed "K SHOP" channel into a short recognizable tag.
function channelChip(channel: string): string {
  if (channel === 'K SHOP') return 'K SHOP';
  if (channel.includes('K PLUS')) return 'K PLUS';
  if (channel.includes('K BIZ')) return 'K BIZ';
  if (channel.toLowerCase().includes('cheque') || channel === 'Automatic Transfer') return 'เช็ค/อื่นๆ';
  if (channel.includes('Internet/Mobile')) return channel.replace('Internet/Mobile ', '');
  return channel || '—';
}

export default function Recon({ isCeo }: { isCeo: boolean }) {
  const [summary, setSummary] = useState<BankSummary | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState<'receipt' | 'txn'>('receipt');
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    getBankSummary().then(setSummary).catch(() => setSummary(null));
  }, [refreshKey]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-emerald-700">
        <Scale size={20} />
        <h1 className="text-lg font-bold text-slate-800">กระทบยอด</h1>
      </div>

      <SummaryCards summary={summary} />
      <div className="flex justify-center">
        <div className="flex rounded-lg border border-slate-300 overflow-hidden bg-white">
          <button
            onClick={() => setView('receipt')}
            className={`px-4 py-1.5 text-sm ${view === 'receipt' ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            ตามใบเสร็จ
          </button>
          <button
            onClick={() => setView('txn')}
            className={`px-4 py-1.5 text-sm ${view === 'txn' ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            ตามเงินเข้า
          </button>
        </div>
      </div>
      {/* The bank-file IMPORT (uploading KBIZ / K SHOP) is CEO-only — server 403s the preview/apply
          endpoints for non-supervisor. The rest of reconciliation below (viewing txns, matching,
          confirming, receipt list) stays visible to finance. */}
      {isCeo && <ImportPanel onImported={bump} />}
      {view === 'receipt'
        ? <ReceiptList onChanged={bump} refreshKey={refreshKey} />
        : <TxnList onChanged={bump} refreshKey={refreshKey} />}
    </div>
  );
}

// ── Summary cards ────────────────────────────────────────────────────────────
function SummaryCards({ summary }: { summary: BankSummary | null }) {
  if (!summary) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-6 text-center text-slate-400">
        <Loader2 className="animate-spin inline" size={18} />
      </div>
    );
  }
  const cards = [
    { label: 'เงินเข้ายังไม่จับคู่', count: summary.unmatchedIn.count, sum: summary.unmatchedIn.sum, tone: 'text-rose-600' },
    { label: 'จับคู่แล้ว รอยืนยัน Express', count: summary.matchedUnconfirmed.count, sum: summary.matchedUnconfirmed.sum, tone: 'text-sky-600' },
    {
      label: 'ใบเสร็จตรวจแล้ว ยังไม่พบเงินเข้า',
      count: summary.verifiedUnreconciled.count,
      sum: summary.verifiedUnreconciled.sum,
      tone: summary.verifiedUnreconciled.oldestDays >= 7 ? 'text-rose-600' : 'text-amber-600',
      sub: summary.verifiedUnreconciled.count > 0 ? `เก่าสุด ${summary.verifiedUnreconciled.oldestDays} วัน` : undefined,
    },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-xs text-slate-400">{c.label}</div>
          <div className={`text-2xl font-bold ${c.tone}`}>{c.count}</div>
          <div className="text-sm text-slate-500">{baht(c.sum)}</div>
          {c.sub && <div className="text-xs text-rose-500 mt-0.5 flex items-center gap-1"><AlertTriangle size={11} /> {c.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ── Import panel ─────────────────────────────────────────────────────────────
function ImportPanel({ onImported }: { onImported: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<File[]>([]);
  const [preview, setPreview] = useState<BankImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [applyResult, setApplyResult] = useState<string>('');

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setQueue(Array.from(files));
    setError('');
    setApplyResult('');
  }

  async function previewNext(files: File[]) {
    const file = files[0];
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const dataB64 = await fileToBase64(file);
      const result = await previewBankImport(dataB64, file.name);
      setPreview(result);
    } catch (e) {
      setError((e as Error).message === 'unauthorized' ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : `อ่านไฟล์ไม่สำเร็จ: ${file.name}`);
      setQueue((prev) => prev.slice(1));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!preview && queue.length > 0 && !busy) previewNext(queue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, preview]);

  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await applyBankImport(preview.token);
      setApplyResult(
        `นำเข้า ${result.source === 'kbiz' ? 'KBIZ' : 'K SHOP'}: ใหม่ ${result.counts.new} / ซ้ำ ${result.counts.dup} / ยกเว้น ${result.counts.excluded}` +
        (result.autoMatched > 0 ? ` — จับคู่อัตโนมัติแล้ว ${result.autoMatched} รายการ` : '') +
        (result.chequeMatched > 0 ? ` · จับคู่เช็คธนาคาร ${result.chequeMatched} รายการ` : ''),
      );
      onImported();
      setPreview(null);
      setQueue((prev) => prev.slice(1));
    } catch (e) {
      setError((e as Error).message === 'unauthorized' ? 'เซสชันหมดอายุ — กรุณาเข้าสู่ระบบใหม่' : 'นำเข้าไม่สำเร็จ — ลองใหม่อีกครั้ง');
    } finally {
      setBusy(false);
    }
  }

  function cancelPreview() {
    setPreview(null);
    setQueue((prev) => prev.slice(1));
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-slate-800">นำเข้าไฟล์ธนาคาร</div>
        <div className="text-xs text-slate-400">รอบ พุธ/เสาร์ — วาง KBIZ + K SHOP พร้อมกันได้</div>
      </div>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50"
        >
          <Upload size={15} /> เลือกไฟล์ (KBIZ / K SHOP)
        </button>
        {queue.length > 1 && <span className="text-xs text-slate-400">รอในคิวอีก {queue.length - 1} ไฟล์</span>}
      </div>

      {error && (
        <div className="mt-3 p-2 rounded-lg bg-rose-50 text-rose-700 text-xs flex items-center gap-1">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      {applyResult && (
        <div className="mt-3 p-2 rounded-lg bg-emerald-50 text-emerald-700 text-xs flex items-center gap-1">
          <CheckCircle2 size={13} /> {applyResult}
        </div>
      )}

      {preview && (
        <div className="mt-3 border border-slate-200 rounded-lg overflow-hidden">
          <div className="bg-slate-50 px-3 py-2 flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm font-medium">
              {preview.source === 'kbiz' ? 'KBIZ' : 'K SHOP'} · {preview.fileName || '(ไม่มีชื่อไฟล์)'}
              {preview.periodFrom && preview.periodTo && (
                <span className="text-slate-400 font-normal ml-1.5">
                  {fmtDate(preview.periodFrom)} – {fmtDate(preview.periodTo)}
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 flex gap-2">
              <span>ทั้งหมด {preview.counts.parsed}</span>
              <span className="text-emerald-600">ใหม่ {preview.counts.new}</span>
              <span className="text-slate-400">ซ้ำ {preview.counts.dup}</span>
              <span className="text-slate-400">ยกเว้น {preview.counts.excluded}</span>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-400 sticky top-0">
                <tr>
                  <th className="text-left font-medium px-3 py-1.5">วันที่</th>
                  <th className="text-right font-medium px-3 py-1.5">ยอด</th>
                  <th className="text-left font-medium px-3 py-1.5">ช่องทาง</th>
                  <th className="text-left font-medium px-3 py-1.5">ผู้โอน/รายละเอียด</th>
                  <th className="text-left font-medium px-3 py-1.5">สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">{fmtDateTime(r.txnAt)}</td>
                    <td className={`px-3 py-1.5 text-right font-medium whitespace-nowrap ${r.direction === 'out' ? 'text-slate-400' : ''}`}>
                      {r.direction === 'out' ? '-' : ''}{r.amount}
                    </td>
                    <td className="px-3 py-1.5 text-slate-500">{channelChip(r.channel)}</td>
                    <td className="px-3 py-1.5 text-slate-500 truncate max-w-[200px]">{r.payerName || r.details}</td>
                    <td className="px-3 py-1.5">
                      {r.isNew
                        ? <span className="text-emerald-600 font-medium">ใหม่</span>
                        : <span className="text-slate-400">ซ้ำ</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="bg-slate-50 px-3 py-2 flex justify-end gap-2">
            <button onClick={cancelPreview} disabled={busy} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm disabled:opacity-50">
              ยกเลิก
            </button>
            <button
              onClick={apply}
              disabled={busy}
              className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center gap-1 disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={13} />} นำเข้า
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── เงินเข้า list ─────────────────────────────────────────────────────────────
function TxnList({ onChanged, refreshKey }: { onChanged: () => void; refreshKey: number }) {
  const [status, setStatus] = useState<BankTxnStatusFilter>('unmatched');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [txns, setTxns] = useState<BankTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [bulkMsg, setBulkMsg] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getBankTxns({ status, dir: 'in', from: from || undefined, to: to || undefined, q: q.trim() || undefined })
      .then((r) => setTxns(r.txns))
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, from, to, q, refreshKey]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const matchedCount = txns.filter((t) => t.matchStatus === 'matched' && !t.expressConfirmedAt).length;

  async function bulkConfirm() {
    setConfirmingBulk(false);
    setBulkMsg('');
    try {
      const result = await confirmAllMatched(to || undefined);
      setBulkMsg(`ยืนยัน Express แล้ว ${result.txnsConfirmed} รายการเงินเข้า (${result.paymentsAdvanced} ใบเสร็จเลื่อนสถานะ)`);
      onChanged();
      load();
    } catch {
      setBulkMsg('ยืนยันไม่สำเร็จ — ลองใหม่อีกครั้ง');
    }
  }

  function handleRowChanged(updated?: BankTxn) {
    if (updated) setTxns((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    else load();
    onChanged();
  }

  return (
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
            placeholder="ค้นหา RE / ชื่อ / จำนวน"
            className="w-full pl-7 pr-2 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
        </div>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-1.5 rounded-lg border border-slate-300 text-xs" title="ตั้งแต่วันที่" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-1.5 rounded-lg border border-slate-300 text-xs" title="ถึงวันที่" />
        <button onClick={load} className="p-1.5 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50" title="รีเฟรช">
          <RefreshCw size={14} />
        </button>
        {matchedCount > 0 && (
          <button
            onClick={() => setConfirmingBulk(true)}
            className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-medium hover:bg-sky-700"
          >
            <CheckCircle2 size={13} /> ยืนยัน Express ทั้งหมดที่จับคู่แล้ว ({matchedCount})
          </button>
        )}
      </div>

      {bulkMsg && (
        <div className="mx-3 mt-2 p-2 rounded-lg bg-sky-50 text-sky-700 text-xs flex items-center gap-1">
          <CheckCircle2 size={13} /> {bulkMsg}
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center text-slate-400"><Loader2 className="animate-spin inline" size={20} /></div>
      ) : error ? (
        <div className="p-6 text-center text-rose-600 text-sm flex items-center justify-center gap-1"><AlertTriangle size={15} /> {error}</div>
      ) : txns.length === 0 ? (
        <div className="p-8 text-center text-slate-400 text-sm">ไม่มีรายการ</div>
      ) : (
        <div className="divide-y divide-slate-100">
          {txns.map((t) => (
            <TxnRow
              key={t.id}
              txn={t}
              expanded={expanded === t.id}
              onToggle={() => setExpanded((e) => (e === t.id ? null : t.id))}
              onChanged={handleRowChanged}
            />
          ))}
        </div>
      )}

      {confirmingBulk && (
        <ConfirmDialog
          title="ยืนยัน Express ทั้งหมดที่จับคู่แล้ว"
          message={`จะยืนยัน Express ${matchedCount} รายการเงินเข้าที่จับคู่แล้วแต่ยังไม่ยืนยัน และเลื่อนสถานะใบเสร็จที่เชื่อมไว้ (สถานะ "ตรวจแล้ว") เป็น "ยืนยันใน Express" — ใบเสร็จที่บันทึกแล้วจะไม่ถูกแตะต้อง`}
          onConfirm={bulkConfirm}
          onCancel={() => setConfirmingBulk(false)}
        />
      )}
    </div>
  );
}

function TxnRow({ txn, expanded, onToggle, onChanged }: {
  txn: BankTxn; expanded: boolean; onToggle: () => void; onChanged: (updated?: BankTxn) => void;
}) {
  return (
    <div>
      <div onClick={onToggle} className="px-3 py-2.5 flex items-center gap-2 cursor-pointer hover:bg-emerald-50/40 text-sm">
        {expanded ? <ChevronDown size={15} className="text-slate-400 shrink-0" /> : <ChevronRight size={15} className="text-slate-400 shrink-0" />}
        <div className="w-32 shrink-0 text-slate-500 whitespace-nowrap">{fmtDateTime(txn.txnAt)}</div>
        <div className="w-28 shrink-0 text-right font-semibold whitespace-nowrap">{baht(txn.amountNum)}</div>
        <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-600">{channelChip(txn.channel)}</span>
        <div className="flex-1 min-w-0 truncate text-slate-500">{txn.payerName || txn.details}</div>
        <div className="shrink-0 flex items-center gap-1 flex-wrap justify-end max-w-[45%]">
          {txn.links.slice(0, 3).map((l) => (
            <span key={l.paymentId} className="px-1.5 py-0.5 rounded-full text-[11px] bg-emerald-50 text-emerald-700 whitespace-nowrap">
              RE {l.reNumber || '—'}
            </span>
          ))}
          {txn.links.length > 3 && <span className="text-[11px] text-slate-400">+{txn.links.length - 3}</span>}
          {txn.refText && !txn.links.length && (
            <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-600 truncate max-w-[140px]">{txn.refText}</span>
          )}
          <StatusBadge txn={txn} />
        </div>
      </div>
      {expanded && <TxnDetail txn={txn} onChanged={onChanged} />}
    </div>
  );
}

function StatusBadge({ txn }: { txn: BankTxn }) {
  if (txn.expressConfirmedAt) return <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-700 whitespace-nowrap">ยืนยันแล้ว</span>;
  if (txn.matchStatus === 'matched') return <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-sky-100 text-sky-700 whitespace-nowrap">จับคู่แล้ว</span>;
  return <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-rose-100 text-rose-700 whitespace-nowrap">ยังไม่จับคู่</span>;
}

// Expanded match panel: linked-payment chips (with sum + delta badge), จับคู่ suggestions
// + search, อ้างอิงอื่น free text, and the per-line ยืนยัน Express action.
function TxnDetail({ txn, onChanged }: { txn: BankTxn; onChanged: (updated?: BankTxn) => void }) {
  const [suggestions, setSuggestions] = useState<BankSuggestion[]>([]);
  const [loadingSug, setLoadingSug] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refText, setRefText] = useState(txn.refText);
  const [savingRef, setSavingRef] = useState(false);

  useEffect(() => {
    setLoadingSug(true);
    getBankSuggestions(txn.id)
      .then((r) => setSuggestions(r.suggestions))
      .catch(() => setSuggestions([]))
      .finally(() => setLoadingSug(false));
  }, [txn.id]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function addSelected() {
    if (selected.size === 0) return;
    setBusy(true);
    setError('');
    try {
      await matchBankTxn(txn.id, [...selected]);
      setSelected(new Set());
      onChanged();
    } catch {
      setError('จับคู่ไม่สำเร็จ — ลองใหม่อีกครั้ง');
    } finally {
      setBusy(false);
    }
  }

  async function unlink(paymentId: string) {
    setBusy(true);
    setError('');
    try {
      await unmatchBankTxn(txn.id, paymentId);
      onChanged();
    } catch {
      setError('ยกเลิกจับคู่ไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  async function saveRef() {
    setSavingRef(true);
    setError('');
    try {
      const result = await setBankTxnRef(txn.id, refText.trim());
      onChanged(result.txn);
    } catch {
      setError('บันทึกอ้างอิงไม่สำเร็จ');
    } finally {
      setSavingRef(false);
    }
  }

  async function confirmOne() {
    setBusy(true);
    setError('');
    try {
      await confirmBankTxn(txn.id);
      onChanged();
    } catch {
      setError('ยืนยัน Express ไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  const runningSum = txn.linkedSum + [...selected].reduce((s, id) => {
    const sug = suggestions.find((x) => x.paymentId === id);
    return s + (sug ? parseFloat(sug.amount || '0') : 0);
  }, 0);
  const linkedIds = new Set(txn.links.map((l) => l.paymentId));
  const availableSuggestions = suggestions.filter((s) => !linkedIds.has(s.paymentId));

  return (
    <div className="px-4 pb-4 pt-1 bg-slate-50 border-t border-slate-100 text-sm">
      {error && <div className="mb-2 p-2 rounded-lg bg-rose-50 text-rose-700 text-xs flex items-center gap-1"><AlertTriangle size={13} /> {error}</div>}

      {txn.links.length > 0 && (
        <div className="mb-3">
          <div className="text-xs text-slate-400 mb-1">ใบเสร็จที่เชื่อมไว้</div>
          <div className="flex flex-wrap gap-1.5 items-center">
            {txn.links.map((l) => (
              <span key={l.paymentId} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white border border-slate-200 text-xs">
                <span className="font-semibold text-emerald-700">RE {l.reNumber || '—'}</span>
                <span className="text-slate-400">·</span>
                <span>{baht(parseFloat(l.amount || '0'))}</span>
                {l.chequeNo && <>
                  <span className="text-slate-400">·</span>
                  <span className="text-slate-500 shrink-0">เช็ค {l.chequeNo}</span>
                </>}
                <span className="text-slate-400">·</span>
                <span className="text-slate-500 max-w-[120px] truncate">{l.receiptName || l.customerName}</span>
                <button onClick={() => unlink(l.paymentId)} disabled={busy} className="text-slate-300 hover:text-rose-600 ml-0.5" title="ยกเลิกจับคู่">
                  <Unlink size={12} />
                </button>
              </span>
            ))}
            {txn.sumDelta !== null && (
              <span className={`px-2 py-1 rounded-lg text-xs font-medium ${Math.abs(txn.sumDelta) < 0.01 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                รวม {baht(txn.linkedSum)} {Math.abs(txn.sumDelta) >= 0.01 && `(ต่าง ${txn.sumDelta > 0 ? '+' : ''}${txn.sumDelta.toFixed(2)})`}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="mb-3">
        <div className="text-xs text-slate-400 mb-1 flex items-center justify-between">
          <span>จับคู่ — คำแนะนำ</span>
          {selected.size > 0 && (
            <span className="text-slate-500">รวมที่เลือก {baht(runningSum)} (ยอดเงินเข้า {baht(txn.amountNum)})</span>
          )}
        </div>
        {loadingSug ? (
          <div className="text-xs text-slate-400 py-2"><Loader2 className="animate-spin inline" size={14} /> กำลังค้นหา…</div>
        ) : availableSuggestions.length === 0 ? (
          <div className="text-xs text-slate-400 py-1">ไม่พบใบเสร็จที่ตรงกัน — ลองใช้อ้างอิงอื่นด้านล่าง</div>
        ) : (
          <div className="space-y-1 max-h-52 overflow-y-auto">
            {availableSuggestions.map((s) => (
              <label key={s.paymentId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white border border-slate-200 hover:border-emerald-300 cursor-pointer text-xs">
                <input type="checkbox" checked={selected.has(s.paymentId)} onChange={() => toggle(s.paymentId)} className="accent-emerald-600" />
                <span className="font-semibold text-emerald-700 shrink-0">RE {s.reNumber || '—'}</span>
                <span className="shrink-0">{baht(parseFloat(s.amount || '0'))}</span>
                {s.exactAmount && <span className="px-1 py-0.5 rounded bg-emerald-50 text-emerald-600 shrink-0">ยอดตรง</span>}
                {s.chequeNo && <span className="text-slate-400 shrink-0">เช็ค {s.chequeNo}</span>}
                <span className="text-slate-500 truncate flex-1">{s.receiptName || s.customerName}</span>
                <span className="text-slate-400 shrink-0">±{s.dayDistance.toFixed(1)}ว</span>
              </label>
            ))}
          </div>
        )}
        {selected.size > 0 && (
          <button
            onClick={addSelected}
            disabled={busy}
            className="mt-2 flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} จับคู่ {selected.size} รายการที่เลือก
          </button>
        )}
      </div>

      <div className="mb-3">
        <div className="text-xs text-slate-400 mb-1">อ้างอิงอื่น (เช็ค / บิล / Shopee ฯลฯ)</div>
        <div className="flex gap-1.5">
          <input
            value={refText}
            onChange={(e) => setRefText(e.target.value)}
            placeholder="เช่น เช็คเลขที่ 26488913 / บิล 38/13 / Shopee"
            className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
          <button
            onClick={saveRef}
            disabled={savingRef || refText.trim() === txn.refText}
            className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-800 text-white text-xs font-medium disabled:opacity-40"
          >
            {savingRef ? <Loader2 size={13} className="animate-spin" /> : 'บันทึก'}
          </button>
        </div>
      </div>

      <button
        onClick={confirmOne}
        disabled={busy || txn.matchStatus !== 'matched' || !!txn.expressConfirmedAt}
        className="w-full px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-300 hover:bg-white disabled:opacity-40 flex items-center justify-center gap-1"
      >
        {txn.expressConfirmedAt ? <><CheckCircle2 size={13} className="text-emerald-600" /> ยืนยัน Express แล้ว</> : <><CheckCircle2 size={13} /> ยืนยัน Express</>}
      </button>
    </div>
  );
}

// ── ใบเสร็จ list ────────────────────────────────────────────────────────────
function ReceiptList({ onChanged, refreshKey }: { onChanged: () => void; refreshKey: number }) {
  const [state, setState] = useState<PaymentReconState>('pending');
  const [q, setQ] = useState('');
  const [payments, setPayments] = useState<PaymentReconRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getPaymentsRecon(state, q.trim() || undefined, 100)
      .then((result) => setPayments(result.payments))
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [state, q, refreshKey]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  function handleChanged() {
    setExpanded(null);
    load();
    onChanged();
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="p-3 border-b border-slate-100 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-slate-300 overflow-hidden">
          {([
            { key: 'pending', label: 'รอจับคู่' },
            { key: 'matched', label: 'จับคู่แล้ว' },
          ] as { key: PaymentReconState; label: string }[]).map((filter) => (
            <button
              key={filter.key}
              onClick={() => { setState(filter.key); setExpanded(null); }}
              className={`px-3 py-1.5 text-xs ${state === filter.key ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-2.5 top-2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหา RE / ชื่อ / จำนวน"
            className="w-full pl-7 pr-2 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-400"
          />
        </div>
        <button onClick={load} className="p-1.5 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50" title="รีเฟรช">
          <RefreshCw size={14} />
        </button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-slate-400"><Loader2 className="animate-spin inline" size={20} /></div>
      ) : error ? (
        <div className="p-6 text-center text-rose-600 text-sm flex items-center justify-center gap-1"><AlertTriangle size={15} /> {error}</div>
      ) : payments.length === 0 ? (
        <div className="p-8 text-center text-slate-400 text-sm">ไม่มีรายการ</div>
      ) : (
        <div className="divide-y divide-slate-100">
          {payments.map((payment) => (
            <ReceiptRow
              key={payment.id}
              payment={payment}
              state={state}
              expanded={expanded === payment.id}
              onToggle={() => setExpanded((id) => id === payment.id ? null : payment.id)}
              onChanged={handleChanged}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ReceiptRow({ payment, state, expanded, onToggle, onChanged }: {
  payment: PaymentReconRow;
  state: PaymentReconState;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const ageDays = Math.floor((Date.now() - new Date(payment.createdAt).getTime()) / (24 * 3600 * 1000));
  const allConfirmed = payment.linkedTxns.length > 0 && payment.linkedTxns.every((txn) => !!txn.expressConfirmedAt);

  return (
    <div>
      <div onClick={onToggle} className="px-3 py-2.5 flex items-center gap-2 cursor-pointer hover:bg-emerald-50/40 text-sm">
        {expanded ? <ChevronDown size={15} className="text-slate-400 shrink-0" /> : <ChevronRight size={15} className="text-slate-400 shrink-0" />}
        <div className="w-24 shrink-0 text-slate-500 whitespace-nowrap">{fmtDate(payment.createdAt)}</div>
        <div className="w-28 shrink-0 font-semibold text-emerald-700 truncate">RE {payment.reNumber || '—'}</div>
        {payment.chequeNo && <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[11px] bg-slate-100 text-slate-600">เช็ค {payment.chequeNo}</span>}
        <div className="flex-1 min-w-0 truncate text-slate-500">{payment.receiptName || payment.customerName}</div>
        <div className="w-28 shrink-0 text-right font-semibold whitespace-nowrap">{baht(payment.amountNum)}</div>
        {state === 'pending' ? (
          <span className={`shrink-0 px-1.5 py-0.5 rounded-full text-[11px] ${ageDays >= 7 ? 'bg-rose-100 text-rose-700 font-semibold' : 'bg-slate-100 text-slate-500'}`}>
            {ageDays} วัน
          </span>
        ) : (
          <div className="shrink-0 flex items-center gap-1">
            <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-sky-100 text-sky-700 whitespace-nowrap">เชื่อม {payment.linkedTxns.length} รายการ</span>
            {allConfirmed && <span className="px-1.5 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-700 whitespace-nowrap">ยืนยันแล้ว</span>}
          </div>
        )}
      </div>
      {expanded && <ReceiptMatchDetail payment={payment} state={state} onChanged={onChanged} />}
    </div>
  );
}

function ReceiptMatchDetail({ payment, state, onChanged }: {
  payment: PaymentReconRow;
  state: PaymentReconState;
  onChanged: () => void;
}) {
  const [suggestions, setSuggestions] = useState<TxnSuggestion[]>([]);
  const [loadingSug, setLoadingSug] = useState(state === 'pending');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (state !== 'pending') return;
    setLoadingSug(true);
    getPaymentTxnSuggestions(payment.id)
      .then((result) => setSuggestions(result.suggestions))
      .catch(() => setSuggestions([]))
      .finally(() => setLoadingSug(false));
  }, [payment.id, state]);

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function addSelected() {
    if (!selected.size) return;
    setBusy(true);
    setError('');
    try {
      await matchPaymentTxns(payment.id, [...selected]);
      onChanged();
    } catch {
      setError('จับคู่ไม่สำเร็จ — ลองใหม่อีกครั้ง');
    } finally {
      setBusy(false);
    }
  }

  async function unlink(bankTxnId: string) {
    setBusy(true);
    setError('');
    try {
      await unmatchBankTxn(bankTxnId, payment.id);
      onChanged();
    } catch {
      setError('ยกเลิกจับคู่ไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  const selectedSum = [...selected].reduce((sum, id) => {
    const suggestion = suggestions.find((item) => item.bankTxnId === id);
    return sum + (suggestion ? parseFloat(suggestion.amount || '0') : 0);
  }, 0);
  const linkedSum = payment.linkedTxns.reduce((sum, txn) => sum + parseFloat(txn.amount || '0'), 0);
  const sumDelta = Number((linkedSum - payment.amountNum).toFixed(2));

  return (
    <div className="px-4 pb-4 pt-2 bg-slate-50 border-t border-slate-100 text-sm">
      {error && <div className="mb-2 p-2 rounded-lg bg-rose-50 text-rose-700 text-xs flex items-center gap-1"><AlertTriangle size={13} /> {error}</div>}

      {state === 'matched' ? (
        <div>
          <div className="text-xs text-slate-400 mb-1">เงินเข้าที่เชื่อมไว้</div>
          <div className="flex flex-wrap gap-1.5 items-center">
            {payment.linkedTxns.map((txn) => (
              <span key={txn.bankTxnId} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white border border-slate-200 text-xs">
                <span>{fmtDateTime(txn.txnAt)}</span>
                <span className="text-slate-400">·</span>
                <span className="font-semibold">{baht(parseFloat(txn.amount || '0'))}</span>
                <span className="px-1 py-0.5 rounded bg-slate-100 text-slate-600">{channelChip(txn.channel)}</span>
                <span className="text-slate-500 max-w-[140px] truncate">{txn.payerName || '—'}</span>
                <button onClick={() => unlink(txn.bankTxnId)} disabled={busy} className="text-slate-300 hover:text-rose-600 ml-0.5" title="ยกเลิกจับคู่">
                  <Unlink size={12} />
                </button>
              </span>
            ))}
            <span className={`px-2 py-1 rounded-lg text-xs font-medium ${Math.abs(sumDelta) < 0.01 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
              รวม {baht(linkedSum)} {Math.abs(sumDelta) >= 0.01 && `(ต่าง ${sumDelta > 0 ? '+' : ''}${sumDelta.toFixed(2)})`}
            </span>
          </div>
        </div>
      ) : (
        <div>
          <div className="text-xs text-slate-400 mb-1 flex items-center justify-between">
            <span>จับคู่ — คำแนะนำ</span>
            {selected.size > 0 && <span className="text-slate-500">รวมที่เลือก {baht(selectedSum)} (ยอดใบเสร็จ {baht(payment.amountNum)})</span>}
          </div>
          {loadingSug ? (
            <div className="text-xs text-slate-400 py-2"><Loader2 className="animate-spin inline" size={14} /> กำลังค้นหา…</div>
          ) : suggestions.length === 0 ? (
            <div className="text-xs text-slate-400 py-1">ไม่พบเงินเข้าที่ใกล้เคียง — รอไฟล์ธนาคารรอบถัดไป หรือค้นหาในมุมมองเงินเข้า</div>
          ) : (
            <div className="space-y-1 max-h-52 overflow-y-auto">
              {suggestions.map((suggestion) => (
                <label key={suggestion.bankTxnId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white border border-slate-200 hover:border-emerald-300 cursor-pointer text-xs">
                  <input type="checkbox" checked={selected.has(suggestion.bankTxnId)} onChange={() => toggle(suggestion.bankTxnId)} className="accent-emerald-600" />
                  <span className="text-slate-500 whitespace-nowrap">{fmtDateTime(suggestion.txnAt)}</span>
                  <span className="font-semibold shrink-0">{baht(parseFloat(suggestion.amount || '0'))}</span>
                  {suggestion.exactAmount && <span className="px-1 py-0.5 rounded bg-emerald-50 text-emerald-600 shrink-0">ยอดตรง</span>}
                  <span className="px-1 py-0.5 rounded bg-slate-100 text-slate-600 shrink-0">{channelChip(suggestion.channel)}</span>
                  <span className="text-slate-500 truncate flex-1">{suggestion.payerName || suggestion.details}</span>
                  <span className="text-slate-400 shrink-0">±{suggestion.dayDistance.toFixed(1)}ว</span>
                  {suggestion.linkedCount > 0 && <span className="px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600 shrink-0">จับคู่แล้ว {suggestion.linkedCount} ใบ</span>}
                </label>
              ))}
            </div>
          )}
          {selected.size > 0 && (
            <button
              onClick={addSelected}
              disabled={busy}
              className="mt-2 flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />} จับคู่ {selected.size} รายการที่เลือก
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Small shared confirm dialog (weekend bulk action) ───────────────────────
function ConfirmDialog({ title, message, onConfirm, onCancel }: {
  title: string; message: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-2xl p-4 w-full max-w-sm space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="font-semibold text-slate-800 flex items-center gap-1.5">
          <AlertTriangle size={16} className="text-amber-500" /> {title}
        </div>
        <div className="text-sm text-slate-600">{message}</div>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onCancel} className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm flex items-center gap-1">
            <Ban size={13} /> ยกเลิก
          </button>
          <button onClick={onConfirm} className="px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center gap-1">
            <CheckCircle2 size={13} /> ยืนยัน
          </button>
        </div>
      </div>
    </div>
  );
}
