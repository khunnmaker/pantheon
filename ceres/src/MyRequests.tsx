import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Bell,
  ChevronDown,
  ChevronUp,
  Eye,
  Loader2,
  Pencil,
  RefreshCw,
} from 'lucide-react';
import {
  baht,
  cancelStaffRequest,
  getLineBind,
  listStaffRequests,
  type FulfillmentStatus,
  type StaffRequest,
} from './lib/api';
import { REQUEST_TYPE_LABEL as TYPE_LABEL } from './lib/requestLabels';
import { MediaThumb } from './lib/media';

// Re-exported (from the shared helper) so StaffHome's home-screen sections (open-advance
// cards + the "รอดำเนินการ" compact list — see docs/CERES_STAFF_HOME_PLAN.md "1") can reuse
// the exact same type label + status-pill logic instead of re-deriving it.
export { TYPE_LABEL };

// Once a request is approved, its fulfillment status (paid/bought/settling/settled) is
// more useful to the requester than the flat "อนุมัติแล้ว" — Phase 3 (cash/transfer
// fulfillment + advance liquidation) surfaces those states here.
const FULFILLMENT_META: Partial<Record<FulfillmentStatus, { label: string; cls: string }>> = {
  unfulfilled: { label: 'อนุมัติแล้ว รอจ่าย', cls: 'bg-emerald-100 text-emerald-700' },
  paid: { label: 'จ่ายแล้ว', cls: 'bg-sky-100 text-sky-700' },
  bought: { label: 'ซื้อแล้ว', cls: 'bg-sky-100 text-sky-700' },
  settling: { label: 'กำลังปิดยอดเบิก', cls: 'bg-amber-100 text-amber-700' },
  settled: { label: 'ปิดยอดแล้ว', cls: 'bg-emerald-100 text-emerald-700' },
  reversed: { label: 'ย้อนกลับแล้ว', cls: 'bg-rose-100 text-rose-700' },
};

export function statusMeta(request: StaffRequest): { label: string; cls: string } {
  if (request.approvalStatus === 'pending_nee') {
    return request.aiScreenStatus === 'pending'
      ? { label: 'รอตรวจ', cls: 'bg-sky-100 text-sky-700' }
      : { label: 'รอ GM', cls: 'bg-amber-100 text-amber-700' };
  }
  if (request.approvalStatus === 'approved') {
    return FULFILLMENT_META[request.fulfillmentStatus] ?? { label: 'อนุมัติแล้ว', cls: 'bg-emerald-100 text-emerald-700' };
  }
  const statuses: Record<StaffRequest['approvalStatus'], { label: string; cls: string }> = {
    legacy: { label: 'รอตรวจ', cls: 'bg-slate-100 text-slate-600' },
    pending_nee: { label: 'รอ GM', cls: 'bg-amber-100 text-amber-700' },
    pending_ceo: { label: 'รอ CEO', cls: 'bg-violet-100 text-violet-700' },
    approved: { label: 'อนุมัติแล้ว', cls: 'bg-emerald-100 text-emerald-700' },
    rejected: { label: 'ไม่อนุมัติ', cls: 'bg-rose-100 text-rose-700' },
    cancelled: { label: 'ยกเลิก', cls: 'bg-slate-100 text-slate-500' },
    void: { label: 'ยกเลิก', cls: 'bg-slate-100 text-slate-500' },
  };
  return statuses[request.approvalStatus];
}

function rejectionReason(request: StaffRequest): string {
  if (request.approvalStatus !== 'rejected') return '';
  return request.ceoDecision?.note || request.neeDecision?.note || 'ไม่ได้ระบุเหตุผล';
}

export default function MyRequests({
  reloadKey,
  onEdit,
  onOpenDetail,
  limit,
  filterText,
  onOpenSettings,
  title = 'คำขอของฉัน',
}: {
  reloadKey: number;
  onEdit: (request: StaffRequest) => void;
  onOpenDetail: (request: StaffRequest) => void;
  /** Cap the number of rows shown (e.g. a "recent requests" home-screen preview). */
  limit?: number;
  /** Client-side search over reason/category/amount — powers a "searchable history" tab. */
  filterText?: string;
  /**
   * Non-blocking "รับแจ้งเตือนผ่าน LINE" invitation shown when this account isn't LINE-bound
   * yet (see Settings.tsx / api/src/line/staffBind.ts). Only fetched/shown when a handler is
   * given, so nested/secondary usages of this list don't pay for an extra bind-status call.
   */
  onOpenSettings?: () => void;
  title?: string;
}) {
  const [rows, setRows] = useState<StaffRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancelBusyId, setCancelBusyId] = useState('');
  const [lineUnbound, setLineUnbound] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    listStaffRequests('mine', 100)
      .then((result) => setRows(result.requests))
      .catch(() => setError('โหลดคำขอไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  useEffect(() => {
    if (!onOpenSettings) return;
    getLineBind()
      .then((state) => setLineUnbound(!state.bound))
      .catch(() => {});
  }, [onOpenSettings]);

  const visibleRows = (() => {
    const q = filterText?.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) =>
          [r.reason, r.category, r.entity, TYPE_LABEL[r.requestType], String(r.amountNum)].some((field) =>
            field.toLowerCase().includes(q),
          ),
        )
      : rows;
    return typeof limit === 'number' ? filtered.slice(0, limit) : filtered;
  })();

  async function cancel(request: StaffRequest) {
    setCancelBusyId(request.id);
    setError('');
    try {
      const result = await cancelStaffRequest(request.id);
      setRows((current) => current.map((row) => (row.id === request.id ? result.request : row)));
      setConfirmCancelId(null);
    } catch {
      setError('ยกเลิกคำขอไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setCancelBusyId('');
    }
  }

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-bold text-base">{title}</h2>
        <button
          onClick={load}
          disabled={loading}
          aria-label="โหลดคำขอใหม่"
          className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-white disabled:opacity-50"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {onOpenSettings && lineUnbound && (
        <button
          onClick={onOpenSettings}
          className="w-full mb-3 flex items-center gap-2 px-3 py-2.5 rounded-xl border border-sky-200 bg-sky-50 text-sky-800 text-xs text-left hover:bg-sky-100"
        >
          <Bell size={15} className="shrink-0" />
          <span className="flex-1">รับแจ้งเตือนผ่าน LINE เมื่อคำขอมีความคืบหน้า — ผูก LINE ได้ในตั้งค่า</span>
        </button>
      )}

      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-sm mb-2">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {loading ? (
        <div className="py-8 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={21} />
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl py-7 text-center text-sm text-slate-400">
          {filterText?.trim() ? 'ไม่พบคำขอที่ค้นหา' : 'ยังไม่มีคำขอ'}
        </div>
      ) : (
        <div className="space-y-2">
          {visibleRows.map((request) => {
            const status = statusMeta(request);
            const expanded = expandedId === request.id;
            const editable = request.approvalStatus === 'pending_nee';
            const rejectReason = rejectionReason(request);
            return (
              <article key={request.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <button
                  onClick={() => setExpandedId(expanded ? null : request.id)}
                  aria-expanded={expanded}
                  className="w-full p-3 flex items-center gap-3 text-left"
                >
                  <MediaThumb id={request.requestPhotoUploadId} size={48} alt="รูปแนบคำขอ" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-base">{baht(request.amountNum)}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${status.cls}`}>
                        {status.label}
                      </span>
                    </div>
                    <div className="text-sm text-slate-600 truncate">
                      {TYPE_LABEL[request.requestType]}
                      {request.reason ? ` · ${request.reason}` : ''}
                    </div>
                    {rejectReason && <div className="text-xs text-rose-600 mt-0.5 truncate">เหตุผล: {rejectReason}</div>}
                  </div>
                  {expanded ? <ChevronUp size={17} className="text-slate-400" /> : <ChevronDown size={17} className="text-slate-400" />}
                </button>

                {expanded && (
                  <div className="px-3 pb-3 border-t border-slate-100">
                    <dl className="grid grid-cols-[76px_1fr] gap-x-2 gap-y-1 pt-3 text-sm">
                      <dt className="text-slate-400">ประเภท</dt><dd>{TYPE_LABEL[request.requestType]}</dd>
                      <dt className="text-slate-400">บริษัท</dt><dd>{request.entity}</dd>
                      <dt className="text-slate-400">หมวดหมู่</dt><dd>{request.category}</dd>
                      <dt className="text-slate-400">เหตุผล</dt><dd className="break-words">{request.reason}</dd>
                      <dt className="text-slate-400">วันที่ส่ง</dt>
                      <dd>{new Date(request.createdAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}</dd>
                    </dl>

                    <button
                      onClick={() => onOpenDetail(request)}
                      className="w-full mt-3 min-h-[42px] rounded-lg border border-slate-300 text-slate-600 text-sm font-semibold flex items-center justify-center gap-1 hover:bg-slate-50"
                    >
                      <Eye size={14} /> ดูรายละเอียด / ประวัติ
                    </button>

                    {editable && (
                      <div className="flex gap-2 mt-3 pt-3 border-t border-slate-100">
                        <button
                          onClick={() => onEdit(request)}
                          className="flex-1 min-h-[42px] rounded-lg border border-slate-300 text-slate-600 text-sm font-semibold flex items-center justify-center gap-1 hover:bg-slate-50"
                        >
                          <Pencil size={14} /> แก้ไข
                        </button>
                        {confirmCancelId === request.id ? (
                          <button
                            onClick={() => cancel(request)}
                            disabled={cancelBusyId === request.id}
                            className="flex-1 min-h-[42px] rounded-lg bg-rose-600 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
                          >
                            {cancelBusyId === request.id ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />} ยืนยันยกเลิก
                          </button>
                        ) : (
                          <button
                            onClick={() => setConfirmCancelId(request.id)}
                            className="flex-1 min-h-[42px] rounded-lg border border-rose-300 text-rose-600 text-sm font-semibold flex items-center justify-center gap-1 hover:bg-rose-50"
                          >
                            <Ban size={14} /> ยกเลิกคำขอ
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
