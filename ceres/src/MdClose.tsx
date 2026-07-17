import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, ChevronDown, ChevronUp, ShieldAlert } from 'lucide-react';
import { getBoard, closeDay, listSettlements, baht, ApiError, type Board, type Settlement } from './lib/api';

export default function MdClose() {
  const [board, setBoard] = useState<Board | null>(null);
  const [loadingBoard, setLoadingBoard] = useState(true);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState('');
  const [lastSettlement, setLastSettlement] = useState<Settlement | null>(null);

  const [history, setHistory] = useState<Settlement[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [expandedId, setExpandedId] = useState('');

  const loadBoard = useCallback(() => {
    setLoadingBoard(true);
    getBoard()
      .then(setBoard)
      .catch(() => setBoard(null))
      .finally(() => setLoadingBoard(false));
  }, []);

  const loadHistory = useCallback(() => {
    setHistoryLoading(true);
    listSettlements()
      .then((r) => setHistory(r.settlements))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }, []);

  useEffect(() => {
    loadBoard();
    loadHistory();
  }, [loadBoard, loadHistory]);

  const totalPending = board ? board.parties.reduce((s, p) => s + p.pendingCount, 0) : 0;

  async function handleClose() {
    setClosing(true);
    setCloseError('');
    try {
      const { settlement } = await closeDay(note.trim() || undefined);
      setLastSettlement(settlement);
      setConfirming(false);
      setNote('');
      loadBoard();
      loadHistory();
    } catch (e) {
      if (e instanceof ApiError && e.body && typeof e.body === 'object' && 'error' in e.body) {
        const err = (e.body as { error: string; pendingCount?: number }).error;
        if (err === 'already_closed_today') {
          setCloseError('ปิดยอดวันนี้ไปแล้ว');
        } else if (err === 'pending_exist') {
          const pc = (e.body as { pendingCount?: number }).pendingCount ?? 0;
          setCloseError(`มี ${pc} รายการรอตรวจ — ต้องเคลียร์ก่อนปิดยอด`);
        } else {
          setCloseError('ปิดยอดไม่สำเร็จ ลองใหม่อีกครั้ง');
        }
      } else {
        setCloseError('ปิดยอดไม่สำเร็จ ลองใหม่อีกครั้ง');
      }
      setConfirming(false);
    } finally {
      setClosing(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-bold mb-3">ปิดยอด</h2>

      {loadingBoard ? (
        <div className="py-8 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : board ? (
        <div className="bg-white rounded-xl border border-slate-200 p-4 mb-3">
          <div className="grid grid-cols-2 gap-3 text-sm mb-3">
            <div>
              <div className="text-xs text-slate-400">ยอดเงินกล่อง</div>
              <div className="text-xl font-bold text-amber-700">{baht(board.box.balance)}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400">จำนวนคน</div>
              <div className="text-xl font-bold">{board.parties.length}</div>
            </div>
          </div>

          {totalPending > 0 && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm mb-3">
              <ShieldAlert size={16} className="mt-0.5 shrink-0" />
              <span>มี {totalPending} รายการรอตรวจ — ต้องเคลียร์ก่อนปิดยอด</span>
            </div>
          )}

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="หมายเหตุ (ถ้ามี)"
            className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm mb-3"
            rows={2}
          />

          {closeError && (
            <div className="flex items-center gap-1 text-rose-600 text-sm mb-3">
              <AlertTriangle size={14} /> {closeError}
            </div>
          )}

          {confirming ? (
            <div className="p-3 rounded-lg border border-rose-200 bg-rose-50">
              <div className="text-sm text-rose-800 mb-2">
                ยืนยันปิดยอดวันนี้? ยอดเงินกล่อง {baht(board.box.balance)} · {board.parties.length} คน
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleClose}
                  disabled={closing}
                  className="flex-1 min-h-[44px] rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
                >
                  {closing ? <Loader2 size={14} className="animate-spin" /> : 'ยืนยัน'}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={closing}
                  className="px-4 min-h-[44px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
                >
                  ยกเลิก
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              disabled={totalPending > 0}
              className="w-full min-h-[48px] rounded-xl border-2 border-rose-500 text-rose-600 font-semibold hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ปิดยอดวันนี้
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1 text-rose-600 text-sm py-6 justify-center">
          <AlertTriangle size={15} /> โหลดข้อมูลไม่สำเร็จ
        </div>
      )}

      {lastSettlement && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-3">
          <div className="text-sm font-semibold text-emerald-800 mb-2">ปิดยอดสำเร็จ</div>
          <SettlementLines settlement={lastSettlement} />
        </div>
      )}

      <div className="text-sm font-semibold text-slate-500 mb-2 mt-4">ประวัติการปิดยอด</div>
      {historyLoading ? (
        <div className="py-8 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : history.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-8">ยังไม่มีประวัติ</div>
      ) : (
        <div className="space-y-2">
          {history.map((s) => (
            <div key={s.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <button
                onClick={() => setExpandedId((id) => (id === s.id ? '' : s.id))}
                className="w-full flex items-center justify-between px-4 py-3 text-sm"
              >
                <div className="flex items-center gap-3">
                  <span className="font-semibold">{s.dayKey}</span>
                  <span className="text-slate-400 text-xs">โดย {s.closedByName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{baht(Number(s.boxAfter))}</span>
                  {expandedId === s.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </button>
              {expandedId === s.id && (
                <div className="px-4 pb-3 border-t border-slate-100 pt-2">
                  <SettlementLines settlement={s} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const REQUEST_LINE_KIND_LABEL: Record<string, string> = {
  payment: 'จ่ายเงิน (คำขอ)',
  purchase: 'ซื้อของ (คำขอ)',
  refund: 'คืนเงิน (คำขอ)',
  reversal: 'ย้อนกลับ (คำขอ)',
};

function SettlementLines({ settlement }: { settlement: Settlement }) {
  const requestLines = settlement.requestLines ?? [];
  if (settlement.lines.length === 0 && requestLines.length === 0) {
    return <div className="text-xs text-slate-400">ไม่มีรายการเคลื่อนไหว</div>;
  }
  return (
    <div className="space-y-3">
      {settlement.lines.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left font-medium py-1 pr-2">ชื่อ</th>
                <th className="text-right font-medium py-1 px-2">เบิก</th>
                <th className="text-right font-medium py-1 px-2">ใช้ไป</th>
                <th className="text-right font-medium py-1 px-2">คืน</th>
                <th className="text-right font-medium py-1 pl-2">ค้าง</th>
              </tr>
            </thead>
            <tbody>
              {settlement.lines.map((l, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1 pr-2 font-medium">{l.partyName}</td>
                  <td className="py-1 px-2 text-right">{baht(Number(l.advances))}</td>
                  <td className="py-1 px-2 text-right">{baht(Number(l.expenses))}</td>
                  <td className="py-1 px-2 text-right">{baht(Number(l.refunds))}</td>
                  <td className="py-1 pl-2 text-right font-semibold">{baht(Number(l.outstanding))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {requestLines.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-500 mb-1">รายการเงินสดจากคำขอที่รวมในยอดปิดนี้</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left font-medium py-1 pr-2">ประเภท</th>
                  <th className="text-left font-medium py-1 px-2">ชื่อ</th>
                  <th className="text-right font-medium py-1 pl-2">จำนวนเงิน</th>
                </tr>
              </thead>
              <tbody>
                {requestLines.map((l) => (
                  <tr key={l.id} className="border-t border-slate-100">
                    <td className="py-1 pr-2">{REQUEST_LINE_KIND_LABEL[l.kind] ?? l.kind}</td>
                    <td className="py-1 px-2 font-medium">{l.partyName || '—'}</td>
                    <td className="py-1 pl-2 text-right font-semibold">{baht(Number(l.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
