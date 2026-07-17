import { useCallback, useEffect, useState } from 'react';
import { LogOut, Loader2, AlertTriangle, Plus, Pencil, Trash2, CheckCircle2, Crown, Send } from 'lucide-react';
import {
  listExpenses,
  deleteExpense,
  logout as logoutSuite,
  type Expense,
  type ExpenseStatus,
  type StaffRequest,
  baht,
} from './lib/api';
import { useCeres } from './lib/bootstrapContext';
import MyRequests from './MyRequests';
import RequestSheet from './RequestSheet';
import RequestDetail from './RequestDetail';

// Portal-back link uses the canonical Pantheon domain unless build-time env overrides it.
const PORTAL_URL: string = import.meta.env.VITE_PORTAL_URL ?? 'https://pantheon.prominentdental.com';
import ExpenseSheet from './ExpenseSheet';

const STATUS_META: Record<ExpenseStatus, { label: string; cls: string }> = {
  pending: { label: 'รอตรวจ', cls: 'bg-amber-100 text-amber-700' },
  approved: { label: 'อนุมัติแล้ว', cls: 'bg-emerald-100 text-emerald-700' },
  settled: { label: 'ปิดยอดแล้ว', cls: 'bg-slate-200 text-slate-500' },
  rejected: { label: 'ตีกลับ', cls: 'bg-rose-100 text-rose-700' },
  void: { label: 'ยกเลิกแล้ว', cls: 'bg-slate-100 text-slate-400' },
};

function todayStr(): string {
  return new Date().toLocaleDateString('sv-SE'); // yields YYYY-MM-DD local
}
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('sv-SE');
}

export default function MessengerHome() {
  const { bootstrap, onLogout } = useCeres();
  const [wideRange, setWideRange] = useState(false);
  const [rows, setRows] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [requestSheetOpen, setRequestSheetOpen] = useState(false);
  const [editingRequest, setEditingRequest] = useState<StaffRequest | null>(null);
  const [requestReloadKey, setRequestReloadKey] = useState(0);
  const [detailRequestId, setDetailRequestId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const from = wideRange ? daysAgoStr(6) : todayStr();
    const to = todayStr();
    listExpenses({ scope: 'mine', from, to })
      .then((r) => setRows(r.expenses))
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [wideRange]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(''), 2500);
    return () => clearTimeout(t);
  }, [successMsg]);

  const total = rows.filter((r) => r.status !== 'rejected' && r.status !== 'void').reduce((s, r) => s + r.amountNum, 0);

  async function handleDelete(id: string) {
    setDeleteBusy(true);
    try {
      await deleteExpense(id);
      setConfirmDeleteId(null);
      load();
    } catch {
      setError('ลบไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800 pb-28">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-md mx-auto px-4 h-14 flex items-center justify-between">
          <div className="font-bold text-base text-amber-700">{bootstrap.party?.name || bootstrap.agent.name}</div>
          <div className="flex items-center gap-3">
            {PORTAL_URL && (
              <a href={PORTAL_URL} title="กลับพอร์ทัล Pantheon" className="flex items-center gap-1 text-sm text-slate-500 hover:text-violet-600">
                <Crown size={15} /> <span className="hidden sm:inline">พอร์ทัล</span>
              </a>
            )}
            <button
              onClick={() => {
                void logoutSuite();
                onLogout();
              }}
              className="flex items-center gap-1 text-sm text-slate-500 hover:text-rose-600"
            >
              <LogOut size={15} /> ออก
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto p-4">
        {successMsg && (
          <div className="mb-3 px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm flex items-center gap-1.5">
            <CheckCircle2 size={15} /> {successMsg}
          </div>
        )}

        <MyRequests
          reloadKey={requestReloadKey}
          onEdit={(request) => {
            setEditingRequest(request);
            setRequestSheetOpen(true);
          }}
          onOpenDetail={(request) => setDetailRequestId(request.id)}
        />

        <div className="flex items-center justify-between mb-3 gap-2">
          <div>
            <h2 className="font-bold text-base">ค่าใช้จ่ายเงินเบิกเดิม</h2>
            <p className="text-xs text-slate-400">บันทึกค่าใช้จ่ายหรือใบเสร็จจากเงินที่รับไปแล้ว</p>
          </div>
          <button
            onClick={() => {
              setEditing(null);
              setSheetOpen(true);
            }}
            className="shrink-0 min-h-[42px] px-3 rounded-xl border border-amber-300 bg-white text-amber-700 text-sm font-semibold flex items-center gap-1 hover:bg-amber-50"
          >
            <Plus size={16} /> บันทึก
          </button>
        </div>

        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold text-slate-500">{wideRange ? '7 วันที่ผ่านมา' : 'วันนี้'}</div>
          <button
            onClick={() => setWideRange((v) => !v)}
            className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {wideRange ? 'วันนี้' : '7 วัน'}
          </button>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 mb-3 flex items-center justify-between">
          <span className="text-sm text-slate-500">รวมทั้งหมด</span>
          <span className="text-xl font-bold text-amber-700">{baht(total)}</span>
        </div>

        {loading ? (
          <div className="py-10 flex justify-center text-slate-400">
            <Loader2 className="animate-spin" size={22} />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center gap-1 text-rose-600 text-sm py-6">
            <AlertTriangle size={15} /> {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center text-slate-400 text-sm py-10">ยังไม่มีรายการ</div>
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
                      <span className="font-bold text-base">{baht(r.amountNum)}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${STATUS_META[r.status].cls}`}>
                        {STATUS_META[r.status].label}
                      </span>
                    </div>
                    <div className="text-sm text-slate-500">{r.category}</div>
                    {r.customerNote && <div className="text-xs text-slate-400">ลูกค้า: {r.customerNote}</div>}
                    {r.status === 'rejected' && r.rejectReason && (
                      <div className="text-xs text-rose-600 mt-1">เหตุผล: {r.rejectReason}</div>
                    )}
                  </div>
                </div>

                {r.status === 'pending' && (
                  <div className="flex items-center gap-2 mt-2 pt-2 border-t border-slate-100">
                    <button
                      onClick={() => {
                        setEditing(r);
                        setSheetOpen(true);
                      }}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-300 text-slate-600 hover:bg-slate-50"
                    >
                      <Pencil size={12} /> แก้ไข
                    </button>
                    {confirmDeleteId === r.id ? (
                      <button
                        onClick={() => handleDelete(r.id)}
                        disabled={deleteBusy}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
                      >
                        {deleteBusy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} ยืนยันลบ
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(r.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-300 text-rose-600 hover:bg-rose-50"
                      >
                        <Trash2 size={12} /> ลบ
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>

      <div className="fixed bottom-0 inset-x-0 p-4 bg-gradient-to-t from-slate-100 via-slate-100 z-10">
        <button
          onClick={() => {
            setEditingRequest(null);
            setRequestSheetOpen(true);
          }}
          className="max-w-md mx-auto w-full min-h-[56px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-base font-semibold flex items-center justify-center gap-2 shadow-lg"
        >
          <Send size={20} /> ส่งคำขอเงิน
        </button>
      </div>

      {sheetOpen && (
        <ExpenseSheet
          editing={editing}
          onClose={() => setSheetOpen(false)}
          onSaved={() => {
            setSuccessMsg('บันทึกเรียบร้อย');
            load();
          }}
        />
      )}

      {requestSheetOpen && (
        <RequestSheet
          editing={editingRequest}
          onClose={() => setRequestSheetOpen(false)}
          onSaved={() => {
            setSuccessMsg(editingRequest ? 'แก้ไขคำขอเรียบร้อย' : 'ส่งคำขอแล้ว กำลังรอตรวจ');
            setRequestReloadKey((key) => key + 1);
          }}
        />
      )}

      {detailRequestId && (
        <RequestDetail
          requestId={detailRequestId}
          onClose={() => setDetailRequestId(null)}
          onChanged={() => setRequestReloadKey((key) => key + 1)}
        />
      )}
    </div>
  );
}
