import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, X, ThumbsUp } from 'lucide-react';
import { listExpenses, approveExpense, rejectExpense, baht, type Expense } from './lib/api';
import { useCeres } from './lib/bootstrapContext';

// Prefill payload passed in from MdBoard's tappable "รอตรวจ" party badge — jumps here
// pre-filtered to that party (see Md.tsx's approvalPrefill state / goToApprovalWithPrefill).
export interface ApprovalPrefill {
  partyId: string;
}

export default function MdApproval({
  prefill,
  onConsumePrefill,
}: {
  prefill: ApprovalPrefill | null;
  onConsumePrefill: () => void;
}) {
  const { bootstrap } = useCeres();
  const [partyId, setPartyId] = useState(prefill?.partyId ?? '');
  const [rows, setRows] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [rejectingId, setRejectingId] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!prefill) return;
    setPartyId(prefill.partyId);
    onConsumePrefill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    listExpenses({ scope: 'all', status: 'pending', partyId: partyId || undefined })
      .then((r) => setRows(r.expenses))
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [partyId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleApprove(id: string) {
    setBusyId(id);
    setError('');
    try {
      await approveExpense(id);
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch {
      setError('อนุมัติไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setBusyId('');
    }
  }

  async function handleReject(id: string) {
    if (!reason.trim()) return;
    setBusyId(id);
    setError('');
    try {
      await rejectExpense(id, reason.trim());
      setRows((prev) => prev.filter((r) => r.id !== id));
      setRejectingId('');
      setReason('');
    } catch {
      setError('ตีกลับไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setBusyId('');
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-lg font-bold">รอตรวจ</h2>
        <select
          value={partyId}
          onChange={(e) => setPartyId(e.target.value)}
          className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white"
        >
          <option value="">ทุกคน</option>
          {bootstrap.parties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-sm mb-3">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {loading ? (
        <div className="py-10 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-10">ไม่มีรายการรอตรวจ</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const ocrMismatch = r.ocrAmount && r.amountNum !== Number(r.ocrAmount);
            return (
              <div key={r.id} className="bg-white rounded-xl border border-slate-200 p-3">
                <div className="flex items-start gap-3">
                  {r.receiptUrl && (
                    <a href={r.receiptUrl} target="_blank" rel="noreferrer" className="shrink-0">
                      <img src={r.receiptUrl} alt="ใบเสร็จ" className="w-16 h-16 object-cover rounded-lg border border-slate-200" />
                    </a>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm">{r.partyName}</span>
                      <span className="font-bold text-lg">{baht(r.amountNum)}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">{r.entity}</span>
                      <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">{r.category}</span>
                    </div>
                    {r.customerNote && <div className="text-xs text-slate-400 mt-1">ลูกค้า: {r.customerNote}</div>}
                    {(ocrMismatch || r.duplicateReceipt) && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {ocrMismatch && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs">
                            <AlertTriangle size={11} /> OCR อ่านได้ ฿{r.ocrAmount}
                          </span>
                        )}
                        {r.duplicateReceipt && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 text-xs">
                            <AlertTriangle size={11} /> ใบเสร็จซ้ำ
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {rejectingId === r.id ? (
                  <div className="mt-2 pt-2 border-t border-slate-100">
                    <input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="เหตุผลที่ตีกลับ (จำเป็น)"
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm mb-2"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleReject(r.id)}
                        disabled={busyId === r.id || !reason.trim()}
                        className="flex-1 min-h-[40px] rounded-lg bg-rose-600 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
                      >
                        {busyId === r.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} ยืนยันตีกลับ
                      </button>
                      <button
                        onClick={() => {
                          setRejectingId('');
                          setReason('');
                        }}
                        className="px-3 min-h-[40px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
                      >
                        ยกเลิก
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2 mt-2 pt-2 border-t border-slate-100">
                    <button
                      onClick={() => handleApprove(r.id)}
                      disabled={busyId === r.id}
                      className="flex-1 min-h-[40px] rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
                    >
                      {busyId === r.id ? <Loader2 size={14} className="animate-spin" /> : <ThumbsUp size={14} />} อนุมัติ
                    </button>
                    <button
                      onClick={() => setRejectingId(r.id)}
                      disabled={busyId === r.id}
                      className="flex-1 min-h-[40px] rounded-lg border border-rose-300 text-rose-600 hover:bg-rose-50 text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
                    >
                      <X size={14} /> ตีกลับ
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
