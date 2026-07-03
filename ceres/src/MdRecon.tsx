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
  listRequests,
  listMovements,
  baht,
  ApiError,
  type StatementSummary,
  type StatementImport,
  type StatementLine,
  type StatementPreview,
  type MatchStatus,
  type PaymentRequest,
  type Movement,
} from './lib/api';
import { todayStr } from './MdRequests';

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

  const [dir, setDir] = useState<'out' | 'in'>('out');
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

  const loadLines = useCallback(() => {
    setLinesLoading(true);
    setLinesError('');
    listStatementLines({ dir, status: status || undefined, from: from || undefined, to: to || undefined, q: q || undefined, limit: 200 })
      .then((r) => setLines(r.lines))
      .catch(() => setLinesError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLinesLoading(false));
  }, [dir, status, from, to, q]);

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
        <div className="flex rounded-lg border border-slate-300 overflow-hidden">
          <button
            onClick={() => setDir('out')}
            className={`px-3 py-2 text-sm font-medium ${dir === 'out' ? 'bg-amber-600 text-white' : 'bg-white text-slate-600'}`}
          >
            ออก
          </button>
          <button
            onClick={() => setDir('in')}
            className={`px-3 py-2 text-sm font-medium ${dir === 'in' ? 'bg-amber-600 text-white' : 'bg-white text-slate-600'}`}
          >
            เข้า
          </button>
        </div>
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-slate-200 p-3">
          <div className="text-xs text-slate-400">เงินออกยังไม่จับคู่</div>
          <div className="text-lg font-bold text-rose-600">{baht(summary.unmatchedOut.sum)}</div>
          <div className="text-xs text-slate-400">{summary.unmatchedOut.count} รายการ</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3">
          <div className="text-xs text-slate-400">เงินเข้ายังไม่จับคู่</div>
          <div className="text-lg font-bold text-emerald-600">{baht(summary.unmatchedIn.sum)}</div>
          <div className="text-xs text-slate-400">{summary.unmatchedIn.count} รายการ</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-3">
          <div className="text-xs text-slate-400">จ่ายแล้วแต่ไม่พบในสเตทเมนท์</div>
          <div className="text-lg font-bold">{baht(summary.paidRequestsUnreconciled.sum)}</div>
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            {summary.paidRequestsUnreconciled.count} รายการ
            {summary.paidRequestsUnreconciled.oldestDays >= 7 && (
              <span className="px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 font-semibold">{summary.paidRequestsUnreconciled.oldestDays} วัน</span>
            )}
          </div>
        </div>
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
  const [matchDialog, setMatchDialog] = useState<'request' | 'movement' | null>(null);
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
              {line.direction === 'out' ? (
                <button
                  onClick={() => setMatchDialog('request')}
                  className="w-full min-h-[40px] rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center justify-center gap-1"
                >
                  <Link2 size={14} /> จับคู่กับคำขอจ่ายเงิน
                </button>
              ) : (
                <button
                  onClick={() => setMatchDialog('movement')}
                  className="w-full min-h-[40px] rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center justify-center gap-1"
                >
                  <Link2 size={14} /> จับคู่กับเงินเข้า/เติมเงิน
                </button>
              )}
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

          {matchDialog && (
            <MatchPickerDialog
              type={matchDialog}
              onClose={() => setMatchDialog(null)}
              onPicked={async (targetId) => {
                setBusy(true);
                setError('');
                try {
                  await matchStatementLine(line.id, matchDialog === 'request' ? 'paymentRequest' : 'cashMovement', targetId);
                  setMatchDialog(null);
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

function MatchPickerDialog({
  type,
  onClose,
  onPicked,
}: {
  type: 'request' | 'movement';
  onClose: () => void;
  onPicked: (targetId: string) => void;
}) {
  const [q, setQ] = useState('');
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    if (type === 'request') {
      listRequests({ status: 'paid', q: q || undefined, limit: 50 })
        .then((r) => setRequests(r.requests))
        .catch(() => setRequests([]))
        .finally(() => setLoading(false));
    } else {
      Promise.all([listMovements({ type: 'topup' }), listMovements({ type: 'deposit' })])
        .then(([a, b]) => {
          const all = [...a.movements, ...b.movements].sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1));
          setMovements(q ? all.filter((m) => m.note.toLowerCase().includes(q.toLowerCase()) || (m.partyName ?? '').toLowerCase().includes(q.toLowerCase())) : all);
        })
        .catch(() => setMovements([]))
        .finally(() => setLoading(false));
    }
  }, [type, q]);

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-base">{type === 'request' ? 'เลือกคำขอจ่ายเงินที่จ่ายแล้ว' : 'เลือกเงินเข้า/เติมเงิน'}</h3>
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
        ) : type === 'request' ? (
          requests.length === 0 ? (
            <div className="text-center text-slate-400 text-sm py-8">ไม่พบรายการ</div>
          ) : (
            <div className="space-y-1.5">
              {requests.map((r) => (
                <button
                  key={r.id}
                  onClick={() => onPicked(r.id)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-left text-sm"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{r.payee}</div>
                    <div className="text-xs text-slate-400">{r.paidAt ? fmtDateTime(r.paidAt) : ''}</div>
                  </div>
                  <span className="font-semibold shrink-0">{baht(r.amountNum)}</span>
                </button>
              ))}
            </div>
          )
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
