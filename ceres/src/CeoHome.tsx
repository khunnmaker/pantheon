import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Scale, Send } from 'lucide-react';
import { getCeoOverview, type CeoOverview as CeoOverviewData } from './lib/api';
import { CashSection, DailyOutflowSection, EscalationsSection, FlaggedExpensesSection, SectionCard, SettlementSection } from './CeoOverview';

// v1 purge (2026-07-19) — MdRequests.tsx is gone; local copy matching MdMoney.tsx's pattern.
function todayStr(): string {
  return new Date().toLocaleDateString('sv-SE');
}

// Phase 4 — CEO home. Default view is TODAY's oversight snapshot: pending CEO
// decisions, daily outflow by lane/type, cash balance, unreconciled transfers, AI
// flags, and close status. History/date-picker/CSV exports move to More (the existing
// full CeoOverview.tsx screen) — see docs/CERES_REVAMP_PLAN.md "Phase 4" CEO section.
// The outflow section itself was extracted to CeoOverview.tsx (2026-07-18) so the desktop
// ภาพรวม tab can render the identical markup — no visual change here.

export default function CeoHome({ onGoOwnRequest }: { onGoOwnRequest: () => void }) {
  const [data, setData] = useState<CeoOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getCeoOverview(todayStr())
      .then(setData)
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const bump = () => setRefreshKey((k) => k + 1);

  if (loading || !data) {
    return error ? (
      <div className="py-16 flex items-center justify-center gap-1 text-rose-600 text-sm">
        <AlertTriangle size={15} /> {error}
      </div>
    ) : (
      <div className="py-16 flex justify-center text-slate-400">
        <Loader2 className="animate-spin" size={24} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        onClick={onGoOwnRequest}
        className="w-full bg-amber-50 rounded-xl border border-amber-200 px-4 py-3 flex items-center gap-3 text-left text-amber-800 hover:bg-amber-100"
      >
        <div className="shrink-0 w-9 h-9 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center">
          <Send size={18} />
        </div>
        <div>
          <div className="text-sm font-bold">ส่งคำขอเงิน</div>
          <div className="text-xs text-amber-700">ส่งคำขอสำหรับตัวเอง</div>
        </div>
      </button>
      <EscalationsSection escalations={data.escalations} onDecided={bump} />
      <CashSection cash={data.cash} onTopupDone={bump} />

      <DailyOutflowSection dailyOutflow={data.dailyOutflow} />

      <SectionCard title="กระทบยอดโอนเงิน">
        <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
          <div
            className={`shrink-0 w-11 h-11 rounded-full flex items-center justify-center ${
              data.transferReconciliation.unmatched > 0 ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'
            }`}
          >
            <Scale size={20} />
          </div>
          <div>
            <div className="text-sm text-slate-500">รายการค้างกระทบยอด</div>
            <div className="text-xl font-bold">
              {data.transferReconciliation.unmatched}
              {data.transferReconciliation.reversalExceptions > 0 && (
                <span className="text-xs font-semibold text-rose-600 ml-2">
                  ({data.transferReconciliation.reversalExceptions} เป็นรายการย้อนกลับ)
                </span>
              )}
            </div>
          </div>
        </div>
      </SectionCard>

      <FlaggedExpensesSection flaggedExpenses={data.flaggedExpenses} />
      <SettlementSection settlementToday={data.settlementToday} />
    </div>
  );
}
