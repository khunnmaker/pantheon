import { useCallback, useEffect, useState } from 'react';
import { Banknote, Loader2, AlertTriangle, CheckCircle2, RefreshCw, ExternalLink } from 'lucide-react';
import { getFinanceAudits, resolveFinanceAudit, type FinanceAudit } from './lib/api';

// ตรวจสอบยอด tab. The mis-read trail: whenever staff submit a slip amount that differs from
// what the AI read off the slip (OCR), a FinanceAudit row is logged. Finance (Benz/Meow) needs
// to SEE these flags on the payments they verify — so viewing is open to every Juno user. Only
// the CEO can mark one ตรวจแล้ว (resolve), so that button is hidden unless isCeo. Mirrors the
// Minerva console's supervisor-only FinanceAuditView (web/src/Console.tsx), re-homed to Juno.

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function Audit({ isCeo, onResolved }: { isCeo: boolean; onResolved?: () => void }) {
  const [audits, setAudits] = useState<FinanceAudit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getFinanceAudits('open')
      .then((r) => setAudits(r.audits))
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleResolve(id: string) {
    setResolvingId(id);
    try {
      await resolveFinanceAudit(id);
      setAudits((list) => list.filter((a) => a.id !== id));
      onResolved?.();
    } catch {
      setError('ทำเครื่องหมายไม่สำเร็จ');
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-emerald-700">
        <Banknote size={20} />
        <h1 className="text-lg font-bold text-slate-800">ตรวจสอบยอด</h1>
        <span className="text-xs text-slate-400">รายการที่พนักงานแก้ยอดจากสลิป ({audits.length})</span>
        <button onClick={load} className="ml-auto text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1">
          <RefreshCw size={13} /> รีเฟรช
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-slate-400"><Loader2 className="animate-spin inline" size={20} /></div>
        ) : error ? (
          <div className="p-6 text-center text-rose-600 text-sm flex items-center justify-center gap-1"><AlertTriangle size={15} /> {error}</div>
        ) : audits.length === 0 ? (
          <div className="p-10 text-center text-slate-400 text-sm">ไม่มีรายการที่ต้องตรวจสอบ ✓</div>
        ) : (
          <div className="p-3 space-y-2">
            {audits.map((a) => (
              <div key={a.id} className="border border-amber-200 bg-amber-50 rounded-xl p-3">
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <span className="font-semibold text-slate-800">{a.nickname || a.senderName || '—'}</span>
                  {a.senderName && <span className="text-slate-500 text-xs">ผู้โอน: {a.senderName}</span>}
                  <span className="ml-auto text-[11px] text-slate-400">{fmtTime(a.createdAt)}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-4 flex-wrap text-xs">
                  <span>อ่านจากสลิป <b className="text-slate-700">{a.ocrAmount}</b></span>
                  <span>กรอกส่ง <b className="text-rose-700">{a.amount}</b></span>
                  <span>ส่วนต่าง <b className={parseFloat(a.diff) < 0 ? 'text-rose-700' : 'text-sky-700'}>{a.diff}</b></span>
                  <span className="text-slate-500">โดย {a.salesName || '—'}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {a.slipUrl && (
                    <a href={a.slipUrl} target="_blank" rel="noreferrer" className="text-xs text-sky-700 underline flex items-center gap-1">
                      <ExternalLink size={12} /> ดูสลิป
                    </a>
                  )}
                  {isCeo && (
                    <button
                      onClick={() => handleResolve(a.id)}
                      disabled={resolvingId === a.id}
                      className="ml-auto text-xs px-3 py-1 rounded-lg bg-sky-600 hover:bg-sky-700 text-white flex items-center gap-1 disabled:opacity-50"
                    >
                      {resolvingId === a.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} ตรวจแล้ว
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
