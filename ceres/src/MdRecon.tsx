import { useCallback, useEffect, useState } from 'react';
import {
  Loader2,
  AlertTriangle,
  RefreshCw,
  Upload,
  X,
  ChevronDown,
  ChevronUp,
  Link2,
  Unlink,
  FileEdit,
  Search,
  Landmark,
  Banknote,
  ShoppingCart,
  Undo2,
} from 'lucide-react';
import {
  getStatementSummary,
  runAutomatch,
  previewStatement,
  applyStatement,
  listStatementImports,
  listStatementLines,
  matchStatementLine,
  unmatchStatementLine,
  setStatementLineRef,
  listMovements,
  getTransferReconciliation,
  baht,
  ApiError,
  type StatementSummary,
  type StatementImport,
  type StatementLine,
  type StatementPreview,
  type MatchStatus,
  type Movement,
  type TransferReconciliationEvent,
  type TransferReconciliationBankLine,
} from './lib/api';

function todayStr(): string {
  return new Date().toLocaleDateString('sv-SE');
}
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('sv-SE');
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('th-TH', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function MdRecon() {
  const [summary, setSummary] = useState<StatementSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [automatchBusy, setAutomatchBusy] = useState(false);
  const [automatchMsg, setAutomatchMsg] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [imports, setImports] = useState<StatementImport[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const [status, setStatus] = useState<MatchStatus | ''>('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState(daysAgoStr(30));
  const [to, setTo] = useState(todayStr());
  const [lines, setLines] = useState<StatementLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(true);
  const [linesError, setLinesError] = useState('');
  const [expandedId, setExpandedId] = useState('');

  const bump = () => setRefreshKey((k) => k + 1);

  const loadSummary = useCallback(() => {
    setSummaryLoading(true);
    getStatementSummary()
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setSummaryLoading(false));
  }, []);

  const loadImports = useCallback(() => {
    listStatementImports()
      .then((r) => setImports(r.imports))
      .catch(() => setImports([]));
  }, []);

  // v1 purge (2026-07-19): only 'in' lines get browsed/matched here now — the 'out'
  // v1-request matching UI is gone (see docs/CERES_V1_PURGE_PLAN.md Phase B item 4).
  const loadLines = useCallback(() => {
    setLinesLoading(true);
    setLinesError('');
    listStatementLines({ dir: 'in', status: status || undefined, from: from || undefined, to: to || undefined, q: q || undefined, limit: 200 })
      .then((r) => setLines(r.lines))
      .catch(() => setLinesError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLinesLoading(false));
  }, [status, from, to, q]);

  useEffect(() => {
    loadSummary();
    loadImports();
  }, [loadSummary, loadImports, refreshKey]);

  useEffect(() => {
    loadLines();
  }, [loadLines, refreshKey]);

  async function handleAutomatch() {
    setAutomatchBusy(true);
    setAutomatchMsg('');
    try {
      const r = await runAutomatch();
      setAutomatchMsg(`จับคู่อัตโนมัติ ${r.autoMatched} รายการ`);
      bump();
    } catch {
      setAutomatchMsg('จับคู่อัตโนมัติไม่สำเร็จ');
    } finally {
      setAutomatchBusy(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-bold mb-3">กระทบยอด</h2>

      <TransferReconciliationPanel refreshKey={refreshKey} onChanged={bump} summary={summary} />

      <div className="text-sm font-semibold text-slate-500 mb-2 mt-5">กระทบยอดเงินเข้า</div>
      <SummaryCards
        summary={summary}
        loading={summaryLoading}
        automatchBusy={automatchBusy}
        automatchMsg={automatchMsg}
        onAutomatch={handleAutomatch}
      />

      <div className="my-3">
        <button
          onClick={() => setImportOpen(true)}
          className="w-full flex items-center justify-center gap-2 min-h-[44px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold"
        >
          <Upload size={16} /> นำเข้าสเตทเมนท์
        </button>
      </div>

      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            bump();
          }}
        />
      )}

      <div className="bg-white rounded-xl border border-slate-200 p-3 mb-3 flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value as MatchStatus | '')} className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white">
          <option value="">ทุกสถานะ</option>
          <option value="unmatched">ยังไม่จับคู่</option>
          <option value="matched">จับคู่แล้ว</option>
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ค้นหา"
          className="px-2 py-2 rounded-lg border border-slate-300 text-sm flex-1 min-w-[100px]"
        />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" />
      </div>

      {linesError ? (
        <div className="flex items-center gap-1 text-rose-600 text-sm py-6 justify-center">
          <AlertTriangle size={15} /> {linesError}
        </div>
      ) : linesLoading ? (
        <div className="py-10 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : lines.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-10">ไม่มีรายการ</div>
      ) : (
        <div className="space-y-2">
          {lines.map((l) => (
            <LineRow key={l.id} line={l} expanded={expandedId === l.id} onToggle={() => setExpandedId((id) => (id === l.id ? '' : l.id))} onChanged={bump} />
          ))}
        </div>
      )}

      <div className="text-sm font-semibold text-slate-500 mb-2 mt-4">ประวัติการนำเข้า</div>
      {imports.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-6">ยังไม่มีประวัติ</div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
          {imports.map((im) => (
            <div key={im.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <div className="min-w-0">
                <div className="font-medium truncate">{im.fileName}</div>
                <div className="text-xs text-slate-400">
                  {im.periodFrom} – {im.periodTo} · ใหม่ {im.linesNew} · ซ้ำ {im.linesDup} · ตัดออก {im.excluded}
                </div>
              </div>
              <div className="text-xs text-slate-400 shrink-0">{fmtDateTime(im.importedAt)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The Phase 3 transfer reconciliation workspace: every transfer money event (payment /
// purchase / refund / reversal on the transfer lane) next to its matched bank line (or
// lack of one), slip status, and manual match/unmatch. Reversal exceptions stay visible
// as unmatched until their real compensating bank line shows up. See
// GET /api/ceres/transfers/reconciliation + docs/CERES_REVAMP_PLAN.md "Phase 3".
function TransferReconciliationPanel({
  refreshKey,
  onChanged,
  summary,
}: {
  refreshKey: number;
  onChanged: () => void;
  // Adversarial-review fix (2026-07-19 follow-up): the old "กระทบยอดแบบเดิม" section was
  // the only proactive surface for unexplained 'out' bank lines (bank fees, unknown
  // withdrawals with no Ceres record at all) — dropping it made them invisible even
  // though getStatementSummary()/getTransferReconciliation() still compute/return them.
  // Passed down from MdRecon's own `summary` state (getStatementSummary()) rather than
  // re-fetched here. See docs/CERES_V1_PURGE_PLAN.md.
  summary: StatementSummary | null;
}) {
  const [events, setEvents] = useState<TransferReconciliationEvent[]>([]);
  const [bankLines, setBankLines] = useState<TransferReconciliationBankLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [matchingEventId, setMatchingEventId] = useState('');
  const [showMatched, setShowMatched] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getTransferReconciliation()
      .then((r) => {
        setEvents(r.transferEvents);
        setBankLines(r.unmatchedBankLines);
      })
      .catch(() => setError('โหลดข้อมูลกระทบยอดเงินโอนไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const unmatchedCount = events.filter((e) => e.reconciliationState === 'unmatched').length;
  const reversalExceptionCount = events.filter((e) => e.reversalException).length;
  const visibleEvents = showMatched ? events : events.filter((e) => e.reconciliationState === 'unmatched');
  // Same `unmatchedBankLines` this panel already fetches for TransferMatchDialog's
  // candidate list (statements.ts's GET /api/ceres/transfers/reconciliation) — just
  // narrowed to 'out' for direct display instead of only surfacing inside the dialog.
  const outLines = bankLines.filter((l) => l.direction === 'out');

  async function handleUnmatch(bankLineId: string) {
    try {
      await unmatchStatementLine(bankLineId);
      load();
      onChanged();
    } catch {
      setError('ยกเลิกจับคู่ไม่สำเร็จ');
    }
  }

  return (
    <div className="mb-2">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="font-bold text-base flex items-center gap-1.5">
          <Landmark size={17} className="text-amber-700" /> กระทบยอดเงินโอน
        </h3>
        <button
          onClick={load}
          disabled={loading}
          aria-label="โหลดใหม่"
          className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-white disabled:opacity-50"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="bg-white rounded-xl border border-slate-200 p-3">
          <div className="text-xs text-slate-400">ยังไม่จับคู่กับสเตทเมนท์</div>
          <div className="text-lg font-bold text-rose-600">{unmatchedCount}</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3">
          <div className="text-xs text-slate-400">รายการย้อนกลับที่ยังไม่พบในสเตทเมนท์</div>
          <div className="text-lg font-bold text-amber-600">{reversalExceptionCount}</div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-sm py-3 justify-center">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {!loading && !error && (
        <button
          onClick={() => setShowMatched((v) => !v)}
          className="text-xs text-slate-500 underline underline-offset-2 hover:text-slate-700 mb-2"
        >
          {showMatched ? 'ซ่อนรายการที่จับคู่แล้ว' : `แสดงรายการที่จับคู่แล้วด้วย (${events.length - unmatchedCount})`}
        </button>
      )}

      {loading ? (
        <div className="py-8 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : visibleEvents.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-6 bg-white rounded-xl border border-slate-200">
          ไม่มีรายการเงินโอนที่ต้องกระทบยอด
        </div>
      ) : (
        <div className="space-y-2">
          {visibleEvents.map((ev) => (
            <div key={ev.id} className="bg-white rounded-xl border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {ev.requestType === 'purchase' ? <ShoppingCart size={13} className="text-slate-400" /> : <Banknote size={13} className="text-slate-400" />}
                    {ev.requester || '—'}
                    {ev.kind === 'reversal' && <Undo2 size={13} className="text-rose-500" />}
                  </div>
                  <div className="text-xs text-slate-400">
                    {ev.entity} · {ev.kind === 'reversal' ? 'ย้อนกลับ' : ev.direction === 'in' ? 'เงินเข้า' : 'เงินออก'} · {fmtDateTime(ev.createdAt)}
                  </div>
                </div>
                <span className={`font-bold shrink-0 ${ev.direction === 'in' ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {ev.direction === 'in' ? '+' : '-'}
                  {baht(Number(ev.amount))}
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5 mt-2">
                {ev.slipRequired && (
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ev.slipPresent ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                    {ev.slipPresent ? 'มีสลิป' : 'ไม่มีสลิป'}
                  </span>
                )}
                {ev.requestType === 'purchase' && (
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ev.purchaseReceiptPresent ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                    {ev.purchaseReceiptPresent ? 'มีใบเสร็จ' : 'ไม่มีใบเสร็จ'}
                  </span>
                )}
                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${ev.reconciliationState === 'matched' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                  {ev.reconciliationState === 'matched' ? 'จับคู่แล้ว' : 'ยังไม่จับคู่'}
                </span>
                {ev.reversalException && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">ยังไม่พบในสเตทเมนท์</span>
                )}
              </div>

              {ev.reconciliationState === 'matched' && ev.bankLine ? (
                <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                  <div className="text-xs text-slate-500 truncate">
                    จับคู่กับ: {fmtDateTime(ev.bankLine.txnAt)} · {ev.bankLine.details || 'รายการธนาคาร'}
                  </div>
                  <button
                    onClick={() => handleUnmatch(ev.bankLine!.id)}
                    className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-rose-300 text-rose-600 text-xs font-semibold hover:bg-rose-50"
                  >
                    <Unlink size={12} /> ยกเลิกจับคู่
                  </button>
                </div>
              ) : (
                <div className="mt-2 pt-2 border-t border-slate-100">
                  <button
                    onClick={() => setMatchingEventId(ev.id)}
                    className="w-full min-h-[38px] rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold flex items-center justify-center gap-1"
                  >
                    <Link2 size={13} /> จับคู่กับรายการธนาคาร
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="text-sm font-semibold text-slate-500 mb-2 mt-4">เงินออกที่ยังไม่มีรายการรองรับ</div>
      {summary && (
        <div className="bg-white rounded-xl border border-slate-200 p-3 mb-2">
          <div className="text-xs text-slate-400">เงินออกยังไม่จับคู่</div>
          <div className="text-lg font-bold text-rose-600">{baht(summary.unmatchedOut.sum)}</div>
          <div className="text-xs text-slate-400">{summary.unmatchedOut.count} รายการ</div>
        </div>
      )}
      {outLines.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-6 bg-white rounded-xl border border-slate-200">
          ไม่มีรายการเงินออกที่ยังไม่มีรายการรองรับ
        </div>
      ) : (
        <div className="space-y-2">
          {outLines.map((l) => (
            <div key={l.id} className="bg-white rounded-xl border border-slate-200 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-slate-400">{fmtDateTime(l.txnAt)}</span>
                <span className="font-bold text-rose-600">-{baht(Number(l.amount))}</span>
              </div>
              <div className="text-sm text-slate-600 truncate mt-1">{l.payerName || l.details || l.channel}</div>
            </div>
          ))}
        </div>
      )}
      <div className="text-xs text-slate-400 mt-2">
        รายการเหล่านี้ยังไม่มีคำขอ/รายการโอนใดจับคู่ด้วย — จับคู่ได้จากปุ่ม “จับคู่กับรายการธนาคาร” ของรายการที่เกี่ยวข้องด้านบน หรือตรวจสอบว่าเป็นค่าธรรมเนียมธนาคารหรือรายการไม่ทราบที่มา
      </div>

      {matchingEventId && (
        <TransferMatchDialog
          event={events.find((e) => e.id === matchingEventId)!}
          bankLines={bankLines}
          onClose={() => setMatchingEventId('')}
          onMatched={() => {
            setMatchingEventId('');
            load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function TransferMatchDialog({
  event,
  bankLines,
  onClose,
  onMatched,
}: {
  event: TransferReconciliationEvent;
  bankLines: TransferReconciliationBankLine[];
  onClose: () => void;
  onMatched: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Same direction is the only hard filter — amounts can legitimately differ (partial
  // matches aren't a thing here, but Nee still needs to see near-misses to catch typos).
  const candidates = [...bankLines]
    .filter((l) => l.direction === event.direction)
    .sort((a, b) => {
      const aExact = Number(a.amount) === Number(event.amount) ? 0 : 1;
      const bExact = Number(b.amount) === Number(event.amount) ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.txnAt < b.txnAt ? 1 : -1;
    });

  async function pick(bankLineId: string) {
    setBusy(true);
    setError('');
    try {
      await matchStatementLine(bankLineId, 'requestMoneyEvent', event.id);
      onMatched();
    } catch {
      setError('จับคู่ไม่สำเร็จ');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-base">เลือกรายการธนาคาร</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>
        <div className="text-xs text-slate-500 mb-3">
          {event.requester} · {baht(Number(event.amount))} · {event.direction === 'in' ? 'เงินเข้า' : 'เงินออก'}
        </div>

        {error && (
          <div className="flex items-center gap-1 text-rose-600 text-xs mb-2">
            <AlertTriangle size={12} /> {error}
          </div>
        )}

        {candidates.length === 0 ? (
          <div className="text-center text-slate-400 text-sm py-8">ไม่พบรายการธนาคารที่ยังไม่จับคู่ในทิศทางเดียวกัน</div>
        ) : (
          <div className="space-y-1.5">
            {candidates.map((l) => {
              const exact = Number(l.amount) === Number(event.amount);
              return (
                <button
                  key={l.id}
                  onClick={() => pick(l.id)}
                  disabled={busy}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border text-left text-sm disabled:opacity-50 ${
                    exact ? 'border-emerald-300 bg-emerald-50 hover:bg-emerald-100' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{l.payerName || l.details || l.channel}</div>
                    <div className="text-xs text-slate-400">{fmtDateTime(l.txnAt)}</div>
                  </div>
                  <span className="font-semibold shrink-0">{baht(Number(l.amount))}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCards({
  summary,
  loading,
  automatchBusy,
  automatchMsg,
  onAutomatch,
}: {
  summary: StatementSummary | null;
  loading: boolean;
  automatchBusy: boolean;
  automatchMsg: string;
  onAutomatch: () => void;
}) {
  if (loading) {
    return (
      <div className="py-8 flex justify-center text-slate-400">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="flex items-center gap-1 text-rose-600 text-sm py-6 justify-center">
        <AlertTriangle size={15} /> โหลดข้อมูลไม่สำเร็จ
      </div>
    );
  }

  return (
    <div>
      <div className="bg-white rounded-xl border border-slate-200 p-3">
        <div className="text-xs text-slate-400">เงินเข้ายังไม่จับคู่</div>
        <div className="text-lg font-bold text-emerald-600">{baht(summary.unmatchedIn.sum)}</div>
        <div className="text-xs text-slate-400">{summary.unmatchedIn.count} รายการ</div>
      </div>

      <div className="flex items-center justify-between mt-3 gap-2 flex-wrap">
        <div className="text-xs text-slate-400">
          {summary.lastImport ? (
            <>
              นำเข้าล่าสุด: {summary.lastImport.fileName} ({fmtDateTime(summary.lastImport.importedAt)})
            </>
          ) : (
            'ยังไม่เคยนำเข้าสเตทเมนท์'
          )}
        </div>
        <button
          onClick={onAutomatch}
          disabled={automatchBusy}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {automatchBusy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} จับคู่อัตโนมัติ
        </button>
      </div>
      {automatchMsg && <div className="text-xs text-emerald-600 mt-1 text-right">{automatchMsg}</div>}
    </div>
  );
}

function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resultMsg, setResultMsg] = useState('');

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setResultMsg('');
    setBusy(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = String(reader.result);
        const comma = dataUrl.indexOf(',');
        const dataB64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
        const p = await previewStatement(dataB64, file.name);
        setPreview(p);
      } catch (err) {
        if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'error' in err.body) {
          const code = String((err.body as { error: unknown }).error);
          setError(code === 'not_kbiz' ? 'ไฟล์ไม่ใช่สเตทเมนท์ KBIZ' : 'อ่านไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง');
        } else {
          setError('อ่านไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง');
        }
      } finally {
        setBusy(false);
      }
    };
    reader.onerror = () => {
      setError('อ่านไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง');
      setBusy(false);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function handleApply() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const r = await applyStatement(preview.token);
      setResultMsg(`นำเข้าแล้ว ${r.inserted} รายการ (ซ้ำ ${r.dup}) · จับคู่อัตโนมัติ ${r.autoMatched} รายการ`);
      setTimeout(() => onImported(), 1200);
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setError('ตัวอย่างหมดอายุ กรุณาอัปโหลดไฟล์ใหม่');
        setPreview(null);
      } else {
        setError('นำเข้าไม่สำเร็จ ลองใหม่อีกครั้ง');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-lg">นำเข้าสเตทเมนท์</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>

        {!preview && (
          <div>
            <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-300 rounded-xl py-8 cursor-pointer hover:bg-slate-50">
              <Upload size={22} className="text-slate-400" />
              <span className="text-sm text-slate-500">เลือกไฟล์ CSV สเตทเมนท์ KBIZ</span>
              <input type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />
            </label>
            {busy && (
              <div className="flex justify-center py-3 text-slate-400">
                <Loader2 className="animate-spin" size={18} />
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-center gap-1 text-rose-600 text-sm mt-2">
            <AlertTriangle size={13} /> {error}
          </div>
        )}

        {preview && !resultMsg && (
          <div>
            <div className="text-sm text-slate-600 mb-2">
              {preview.fileName} · {preview.periodFrom} – {preview.periodTo}
            </div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              <span className="px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 text-xs font-medium">ทั้งหมด {preview.counts.parsed}</span>
              <span className="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">ใหม่ {preview.counts.new}</span>
              <span className="px-2.5 py-1 rounded-full bg-slate-200 text-slate-600 text-xs font-medium">ซ้ำ {preview.counts.dup}</span>
              <span className="px-2.5 py-1 rounded-full bg-rose-100 text-rose-700 text-xs font-medium">ตัดออก {preview.counts.excluded}</span>
            </div>

            <div className="max-h-64 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
              {preview.rows.map((r, i) => (
                <div key={i} className={`flex items-center justify-between px-3 py-2 text-xs ${r.isNew ? 'bg-emerald-50' : ''}`}>
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.payerName || r.details || r.channel}</div>
                    <div className="text-slate-400">{fmtDateTime(r.txnAt)}</div>
                  </div>
                  <div className={`font-semibold shrink-0 ${r.direction === 'out' ? 'text-rose-600' : 'text-emerald-600'}`}>
                    {r.direction === 'out' ? '-' : '+'}
                    {baht(Number(r.amount))}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-2 mt-3">
              <button
                onClick={handleApply}
                disabled={busy}
                className="flex-1 min-h-[44px] rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : 'นำเข้า'}
              </button>
              <button onClick={() => setPreview(null)} disabled={busy} className="px-4 min-h-[44px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
                เลือกไฟล์ใหม่
              </button>
            </div>
          </div>
        )}

        {resultMsg && <div className="mt-2 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm">{resultMsg}</div>}
      </div>
    </div>
  );
}

function LineRow({ line, expanded, onToggle, onChanged }: { line: StatementLine; expanded: boolean; onToggle: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [matchDialogOpen, setMatchDialogOpen] = useState(false);
  const [refDialog, setRefDialog] = useState(false);
  const [refText, setRefText] = useState(line.refText || '');

  async function handleUnmatch() {
    setBusy(true);
    setError('');
    try {
      await unmatchStatementLine(line.id);
      onChanged();
    } catch {
      setError('ยกเลิกจับคู่ไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  async function handleSetRef() {
    setBusy(true);
    setError('');
    try {
      await setStatementLineRef(line.id, refText.trim());
      setRefDialog(false);
      onChanged();
    } catch {
      setError('บันทึกอ้างอิงไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-start gap-3 px-3 py-3 text-left">
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-400">{fmtDateTime(line.txnAt)}</span>
            <span className={`font-bold ${line.direction === 'out' ? 'text-rose-600' : 'text-emerald-600'}`}>
              {line.direction === 'out' ? '-' : '+'}
              {baht(Number(line.amount))}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 mt-1">
            <span className="text-sm text-slate-600 truncate">{line.payerName || line.details}</span>
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${
                line.matchStatus === 'matched' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'
              }`}
            >
              {line.matchStatus === 'matched' ? 'จับคู่แล้ว' : 'ยังไม่จับคู่'}
            </span>
          </div>
          {line.channel && <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-xs">{line.channel}</span>}
        </div>
        {expanded ? <ChevronUp size={16} className="mt-1 shrink-0 text-slate-400" /> : <ChevronDown size={16} className="mt-1 shrink-0 text-slate-400" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-slate-100 pt-2 text-sm">
          {line.details && <div className="text-slate-600 mb-1">{line.details}</div>}
          {line.payerBank && <div className="text-xs text-slate-400 mb-1">ธนาคาร: {line.payerBank}</div>}
          {line.refText && <div className="text-xs text-slate-400 mb-1">อ้างอิง: {line.refText}</div>}

          {error && (
            <div className="flex items-center gap-1 text-rose-600 text-xs mt-1 mb-1">
              <AlertTriangle size={12} /> {error}
            </div>
          )}

          {line.matchStatus === 'matched' ? (
            <div className="mt-2 pt-2 border-t border-slate-100">
              {line.matched && <div className="text-xs text-slate-500 mb-2">จับคู่กับ: {line.matched.summary}</div>}
              <button
                onClick={handleUnmatch}
                disabled={busy}
                className="w-full min-h-[40px] rounded-lg border border-rose-300 text-rose-600 hover:bg-rose-50 text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Unlink size={14} />} ยกเลิกจับคู่
              </button>
            </div>
          ) : (
            <div className="mt-2 pt-2 border-t border-slate-100 space-y-2">
              <button
                onClick={() => setMatchDialogOpen(true)}
                className="w-full min-h-[40px] rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center justify-center gap-1"
              >
                <Link2 size={14} /> จับคู่กับเงินเข้า/เติมเงิน
              </button>
              <button
                onClick={() => setRefDialog(true)}
                className="w-full min-h-[40px] rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 text-sm font-semibold flex items-center justify-center gap-1"
              >
                <FileEdit size={14} /> อ้างอิงอื่น
              </button>
            </div>
          )}

          {refDialog && (
            <div className="mt-2 space-y-2">
              <input
                value={refText}
                onChange={(e) => setRefText(e.target.value)}
                placeholder="เช็ค/บิล/อื่นๆ"
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSetRef}
                  disabled={busy}
                  className="flex-1 min-h-[40px] rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold disabled:opacity-50"
                >
                  {busy ? <Loader2 size={14} className="animate-spin mx-auto" /> : 'บันทึก'}
                </button>
                <button onClick={() => setRefDialog(false)} disabled={busy} className="px-3 min-h-[40px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
                  ยกเลิก
                </button>
              </div>
            </div>
          )}

          {matchDialogOpen && (
            <MatchPickerDialog
              onClose={() => setMatchDialogOpen(false)}
              onPicked={async (targetId) => {
                setBusy(true);
                setError('');
                try {
                  await matchStatementLine(line.id, 'cashMovement', targetId);
                  setMatchDialogOpen(false);
                  onChanged();
                } catch {
                  setError('จับคู่ไม่สำเร็จ');
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// v1 purge (2026-07-19) — this dialog used to also offer matching against a paid v1
// PaymentRequest; now it only ever picks a topup/deposit CashMovement (the เงินเข้า
// matching capability the plan explicitly kept). See docs/CERES_V1_PURGE_PLAN.md.
function MatchPickerDialog({
  onClose,
  onPicked,
}: {
  onClose: () => void;
  onPicked: (targetId: string) => void;
}) {
  const [q, setQ] = useState('');
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([listMovements({ type: 'topup' }), listMovements({ type: 'deposit' })])
      .then(([a, b]) => {
        const all = [...a.movements, ...b.movements].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
        setMovements(q ? all.filter((m) => m.note.toLowerCase().includes(q.toLowerCase()) || (m.partyName ?? '').toLowerCase().includes(q.toLowerCase())) : all);
      })
      .catch(() => setMovements([]))
      .finally(() => setLoading(false));
  }, [q]);

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-base">เลือกเงินเข้า/เติมเงิน</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>

        <div className="relative mb-3">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหา"
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 text-sm"
          />
        </div>

        {loading ? (
          <div className="py-8 flex justify-center text-slate-400">
            <Loader2 className="animate-spin" size={20} />
          </div>
        ) : movements.length === 0 ? (
          <div className="text-center text-slate-400 text-sm py-8">ไม่พบรายการ</div>
        ) : (
          <div className="space-y-1.5">
            {movements.map((m) => (
              <button
                key={m.id}
                onClick={() => onPicked(m.id)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-left text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{m.note || (m.type === 'topup' ? 'เติมเงิน' : 'ฝากเข้ากล่อง')}</div>
                  <div className="text-xs text-slate-400">{fmtDateTime(m.createdAt)}</div>
                </div>
                <span className="font-semibold shrink-0">{baht(Number(m.amount))}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
