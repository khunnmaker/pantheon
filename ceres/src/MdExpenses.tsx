import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { listExpenses, baht, type Expense, type ExpenseStatus } from './lib/api';
import { useCeres } from './lib/bootstrapContext';

const STATUS_META: Record<ExpenseStatus, { label: string; cls: string }> = {
  pending: { label: 'รอตรวจ', cls: 'bg-amber-100 text-amber-700' },
  approved: { label: 'อนุมัติแล้ว', cls: 'bg-emerald-100 text-emerald-700' },
  settled: { label: 'ปิดยอดแล้ว', cls: 'bg-slate-200 text-slate-500' },
  rejected: { label: 'ตีกลับ', cls: 'bg-rose-100 text-rose-700' },
};

export default function MdExpenses() {
  const { bootstrap } = useCeres();
  const [status, setStatus] = useState<ExpenseStatus | ''>('');
  const [partyId, setPartyId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    listExpenses({
      scope: 'all',
      status: status || undefined,
      partyId: partyId || undefined,
      from: from || undefined,
      to: to || undefined,
    })
      .then((r) => setRows(r.expenses))
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [status, partyId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold">รายการค่าใช้จ่าย</h2>
        <button onClick={load} className="p-2 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50" title="รีเฟรช">
          <RefreshCw size={16} />
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-3 mb-3 flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value as ExpenseStatus | '')} className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white">
          <option value="">ทุกสถานะ</option>
          <option value="pending">รอตรวจ</option>
          <option value="approved">อนุมัติแล้ว</option>
          <option value="settled">ปิดยอดแล้ว</option>
          <option value="rejected">ตีกลับ</option>
        </select>
        <select value={partyId} onChange={(e) => setPartyId(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white">
          <option value="">ทุกคน</option>
          {bootstrap.parties.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" title="ตั้งแต่วันที่" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" title="ถึงวันที่" />
      </div>

      {error ? (
        <div className="flex items-center gap-1 text-rose-600 text-sm py-6 justify-center">
          <AlertTriangle size={15} /> {error}
        </div>
      ) : loading ? (
        <div className="py-10 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-10">ไม่มีรายการ</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="bg-white rounded-xl border border-slate-200 p-3">
              <div className="flex items-start gap-3">
                {r.receiptUrl && (
                  <a href={r.receiptUrl} target="_blank" rel="noreferrer" className="shrink-0">
                    <img src={r.receiptUrl} alt="ใบเสร็จ" className="w-14 h-14 object-cover rounded-lg border border-slate-200" />
                  </a>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-sm">{r.partyName}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${STATUS_META[r.status].cls}`}>
                      {STATUS_META[r.status].label}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="text-sm text-slate-500">{r.category}</span>
                    <span className="font-bold">{baht(r.amountNum)}</span>
                  </div>
                  {r.customerNote && <div className="text-xs text-slate-400">ลูกค้า: {r.customerNote}</div>}
                  {r.status === 'rejected' && r.rejectReason && (
                    <div className="text-xs text-rose-600 mt-1">เหตุผล: {r.rejectReason}</div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
