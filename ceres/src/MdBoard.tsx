import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, RefreshCw, AlertCircle } from 'lucide-react';
import { getBoard, listMovements, baht, type Board } from './lib/api';

export default function MdBoard({ onViewPendingParty }: { onViewPendingParty: (partyId: string) => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Opening-balance guard rail: box reads 0 AND no movement has EVER been recorded —
  // a brand-new/never-set-up box, not just one that happens to be drained today.
  const [needsOpeningBalance, setNeedsOpeningBalance] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getBoard()
      .then((b) => {
        setBoard(b);
        if (b.box.balance === 0) {
          listMovements({})
            .then((r) => setNeedsOpeningBalance(r.movements.length === 0))
            .catch(() => setNeedsOpeningBalance(false));
        } else {
          setNeedsOpeningBalance(false);
        }
      })
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold">กระดานเงินสด</h2>
        <button
          onClick={load}
          className="p-2 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50"
          title="รีเฟรช"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
        </button>
      </div>

      {error ? (
        <div className="flex items-center gap-1 text-rose-600 text-sm py-6 justify-center">
          <AlertTriangle size={15} /> {error}
        </div>
      ) : !board ? (
        <div className="py-10 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : (
        <>
          {needsOpeningBalance && (
            <div className="mb-3 flex items-start gap-2 px-3 py-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>ยังไม่ได้ตั้งยอดเงินตั้งต้น — นับเงินสดในกล่อง แล้วบันทึกที่แท็บ ฝาก/เติมเงิน → ฝากเข้ากล่อง</span>
            </div>
          )}
          <div className="bg-white rounded-xl border border-slate-200 p-5 mb-3">
            <div className="text-xs text-slate-400 mb-1">ยอดเงินกล่อง</div>
            <div className="text-3xl font-bold text-amber-700">{baht(board.box.balance)}</div>
            {board.box.belowFloor && (
              <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>
                  ต่ำกว่าเกณฑ์ {baht(board.box.floor)} — แนะนำเติม {baht(board.box.suggestedTopup)}
                </span>
              </div>
            )}
          </div>

          {/* Mobile: stacked cards */}
          <div className="space-y-2 md:hidden">
            {board.parties.map((p) => (
              <div
                key={p.partyId}
                className={`bg-white rounded-xl border border-slate-200 p-3 ${!p.active ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold">{p.partyName}</span>
                  {p.pendingCount > 0 && (
                    <button
                      onClick={() => onViewPendingParty(p.partyId)}
                      className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-semibold hover:bg-amber-200 active:bg-amber-300"
                    >
                      รอตรวจ {p.pendingCount}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-y-1 text-xs text-slate-500">
                  <div>ค้างเดิม: {baht(p.outstandingBefore)}</div>
                  <div>เบิกรอบนี้: {baht(p.advancesSince)}</div>
                  <div>ใช้ไป: {baht(p.approvedSince)}</div>
                  <div>คืนแล้ว: {baht(p.refundsSince)}</div>
                </div>
                <div className="mt-2 pt-2 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-xs text-slate-500">เงินทอนที่ควรได้คืน</span>
                  <span className="font-bold text-amber-700">{baht(p.expectedChange)}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop: table */}
          <div className="hidden md:block bg-white rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs">
                <tr>
                  <th className="text-left font-medium px-4 py-2">ชื่อ</th>
                  <th className="text-right font-medium px-4 py-2">ค้างเดิม</th>
                  <th className="text-right font-medium px-4 py-2">เบิกรอบนี้</th>
                  <th className="text-right font-medium px-4 py-2">ใช้ไป</th>
                  <th className="text-right font-medium px-4 py-2">คืนแล้ว</th>
                  <th className="text-right font-medium px-4 py-2">เงินทอนที่ควรได้คืน</th>
                  <th className="text-right font-medium px-4 py-2">รอตรวจ</th>
                </tr>
              </thead>
              <tbody>
                {board.parties.map((p) => (
                  <tr key={p.partyId} className={`border-t border-slate-100 ${!p.active ? 'text-slate-400' : ''}`}>
                    <td className="px-4 py-2 font-medium">{p.partyName}</td>
                    <td className="px-4 py-2 text-right">{baht(p.outstandingBefore)}</td>
                    <td className="px-4 py-2 text-right">{baht(p.advancesSince)}</td>
                    <td className="px-4 py-2 text-right">{baht(p.approvedSince)}</td>
                    <td className="px-4 py-2 text-right">{baht(p.refundsSince)}</td>
                    <td className="px-4 py-2 text-right font-bold text-amber-700">{baht(p.expectedChange)}</td>
                    <td className="px-4 py-2 text-right">
                      {p.pendingCount > 0 && (
                        <button
                          onClick={() => onViewPendingParty(p.partyId)}
                          className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-semibold hover:bg-amber-200 active:bg-amber-300"
                        >
                          {p.pendingCount}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
