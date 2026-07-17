import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Banknote, ClipboardCheck, Landmark, Loader2, Scale, Wallet } from 'lucide-react';
import { baht, getBoard, getTransferReconciliation, listStaffRequests, type Board } from './lib/api';

// Phase 4 — Nee's (GM) home. Default landing is the approval/fulfillment work itself,
// not the old cash board. Four action cards, each a shortcut into the matching bottom-nav
// tool (Approvals / Fulfillment / Reconciliation) or the legacy board — see
// docs/CERES_REVAMP_PLAN.md "Phase 4" Nee section.

interface Snapshot {
  pendingApproval: number;
  awaitingFulfillment: number;
  transferExceptions: number;
  board: Board | null;
}

export default function NeeHome({
  onGoApprovals,
  onGoFulfillment,
  onGoRecon,
  onGoBoard,
}: {
  onGoApprovals: () => void;
  onGoFulfillment: () => void;
  onGoRecon: () => void;
  onGoBoard: () => void;
}) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([
      listStaffRequests('queue', 200),
      listStaffRequests('all', 300),
      getTransferReconciliation(),
      getBoard(),
    ])
      .then(([queue, all, recon, board]) => {
        const awaitingFulfillment = all.requests.filter(
          (r) => r.approvalStatus === 'approved' && r.fulfillmentStatus === 'unfulfilled',
        ).length;
        const transferExceptions = recon.transferEvents.filter((e) => e.reconciliationState === 'unmatched').length;
        setData({ pendingApproval: queue.requests.length, awaitingFulfillment, transferExceptions, board });
      })
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="py-16 flex justify-center text-slate-400">
        <Loader2 className="animate-spin" size={24} />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="py-16 flex items-center justify-center gap-1 text-rose-600 text-sm">
        <AlertTriangle size={15} /> {error || 'โหลดข้อมูลไม่สำเร็จ'}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <HomeCard
        onClick={onGoApprovals}
        icon={<ClipboardCheck size={22} />}
        label="รออนุมัติ"
        value={String(data.pendingApproval)}
        tone={data.pendingApproval > 0 ? 'amber' : 'slate'}
      />
      <HomeCard
        onClick={onGoFulfillment}
        icon={<Banknote size={22} />}
        label="อนุมัติแล้ว รอจ่าย/ซื้อ"
        value={String(data.awaitingFulfillment)}
        tone={data.awaitingFulfillment > 0 ? 'emerald' : 'slate'}
      />
      <HomeCard
        onClick={onGoRecon}
        icon={<Scale size={22} />}
        label="รายการโอนรอกระทบยอด"
        value={String(data.transferExceptions)}
        tone={data.transferExceptions > 0 ? 'rose' : 'slate'}
      />
      <button
        onClick={onGoBoard}
        className="w-full bg-white rounded-xl border border-slate-200 p-4 text-left hover:bg-slate-50"
      >
        <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
          <Wallet size={16} /> เงินสดวันนี้
        </div>
        <div className="flex items-end justify-between">
          <div className="text-2xl font-bold text-amber-700">{baht(data.board?.box.balance ?? 0)}</div>
          {data.board?.box.belowFloor && (
            <div className="flex items-center gap-1 text-xs font-semibold text-rose-600">
              <Landmark size={13} /> ต่ำกว่าเกณฑ์ — แนะนำเติม {baht(data.board.box.suggestedTopup)}
            </div>
          )}
        </div>
      </button>
    </div>
  );
}

function HomeCard({
  onClick,
  icon,
  label,
  value,
  tone,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: 'amber' | 'emerald' | 'rose' | 'slate';
}) {
  const toneCls: Record<typeof tone, string> = {
    amber: 'bg-amber-100 text-amber-700',
    emerald: 'bg-emerald-100 text-emerald-700',
    rose: 'bg-rose-100 text-rose-700',
    slate: 'bg-slate-100 text-slate-500',
  };
  return (
    <button
      onClick={onClick}
      className="w-full bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3 text-left hover:bg-slate-50"
    >
      <div className={`shrink-0 w-11 h-11 rounded-full flex items-center justify-center ${toneCls[tone]}`}>{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-slate-500">{label}</div>
      </div>
      <div className="text-2xl font-bold shrink-0">{value}</div>
    </button>
  );
}
