import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Banknote,
  CheckCircle2,
  Landmark,
  Loader2,
  Plus,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import {
  baht,
  describeMoneyError,
  describePurgeError,
  describeVoidError,
  getRequestLiquidation,
  getStaffRequest,
  newIdempotencyKey,
  purgeStaffRequest,
  reverseRequestMoneyEvent,
  voidStaffRequest,
  CERES_PURGE_CONFIRM_PHRASE,
  type AdvanceLiquidation,
  type ApprovalStatus,
  type FulfillmentStatus,
  type RequestEvent,
  type RequestMoneyEvent,
  type StaffRequest,
} from './lib/api';
import { REQUEST_TYPE_LABEL as TYPE_LABEL } from './lib/requestLabels';
import { useCeres } from './lib/bootstrapContext';
import { MediaThumb, MediaThumbStrip } from './lib/media';
import ExpenseSheet from './ExpenseSheet';
import FlagButton from './FlagButton';

// Shared timeline/liquidation view for one v2 staff request — used by both the
// requester (MyRequests) and management (NeeFulfillmentQueue, MdRecon). See
// docs/CERES_REVAMP_PLAN.md "Phase 3" item 2.

// Exported (2026-07-22, ประวัติ merge) — MdHistory.tsx reuses these two maps verbatim for its
// finished-request status chips so the wording/colors can never drift from this detail view's
// own timeline badges. SSOT, same rationale as requestLabels.ts's REQUEST_TYPE_LABEL.
export const APPROVAL_LABEL: Record<ApprovalStatus, { label: string; cls: string }> = {
  legacy: { label: 'รอตรวจ', cls: 'bg-slate-100 text-slate-600' },
  pending_nee: { label: 'รอ GM', cls: 'bg-amber-100 text-amber-700' },
  pending_ceo: { label: 'รอ CEO', cls: 'bg-violet-100 text-violet-700' },
  approved: { label: 'อนุมัติแล้ว', cls: 'bg-emerald-100 text-emerald-700' },
  rejected: { label: 'ไม่อนุมัติ', cls: 'bg-rose-100 text-rose-700' },
  cancelled: { label: 'ยกเลิก', cls: 'bg-slate-100 text-slate-500' },
  void: { label: 'ยกเลิก', cls: 'bg-slate-100 text-slate-500' },
};

export const FULFILLMENT_LABEL: Record<FulfillmentStatus, { label: string; cls: string } | null> = {
  legacy: null,
  unfulfilled: { label: 'รอจ่ายเงิน', cls: 'bg-slate-100 text-slate-600' },
  paid: { label: 'จ่ายแล้ว', cls: 'bg-sky-100 text-sky-700' },
  bought: { label: 'ซื้อแล้ว', cls: 'bg-sky-100 text-sky-700' },
  settling: { label: 'กำลังปิดยอด', cls: 'bg-amber-100 text-amber-700' },
  settled: { label: 'ปิดยอดแล้ว', cls: 'bg-emerald-100 text-emerald-700' },
  reversed: { label: 'ย้อนกลับแล้ว', cls: 'bg-rose-100 text-rose-700' },
};

const EVENT_LABEL: Record<string, string> = {
  submitted: 'ส่งคำขอ',
  edited: 'แก้ไขคำขอ',
  ai_screened: 'AI ตรวจคำขอแล้ว',
  ai_screen_timeout: 'AI ตรวจไม่ทันเวลา — ส่งต่อผู้บริหาร',
  nee_approved: 'GM อนุมัติ',
  nee_rejected: 'GM ไม่อนุมัติ',
  ceo_approved: 'CEO อนุมัติ',
  ceo_rejected: 'CEO ไม่อนุมัติ',
  cancelled: 'ยกเลิกคำขอ',
  paid: 'จ่ายเงินแล้ว',
  bought: 'ซื้อของแล้ว',
  refund_recorded: 'บันทึกเงินคืน',
  reversed: 'ย้อนกลับรายการเงิน',
  liquidation_added: 'เพิ่มค่าใช้จ่ายหักเงินเบิก',
  liquidation_reopened: 'เปิดยอดเบิกใหม่ (มีการเปลี่ยนแปลงหลังปิดยอด)',
  settled: 'ปิดยอดเงินเบิกครบแล้ว',
};

const MONEY_KIND_LABEL: Record<RequestMoneyEvent['kind'], string> = {
  payment: 'จ่ายเงิน',
  purchase: 'ซื้อของ',
  refund: 'คืนเงิน',
  reversal: 'ย้อนกลับ',
};
const LANE_LABEL: Record<RequestMoneyEvent['lane'], string> = { cash: 'เงินสด', transfer: 'โอนเงิน' };

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function RequestDetail({
  requestId,
  onClose,
  onChanged,
}: {
  requestId: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { agent, bootstrap } = useCeres();
  const isManager = bootstrap.role === 'gm' || bootstrap.role === 'ceo';
  const isCeo = bootstrap.role === 'ceo';
  const purgeEnabled = isCeo && bootstrap.alphaPurgeEnabled;

  const [request, setRequest] = useState<StaffRequest | null>(null);
  const [events, setEvents] = useState<RequestEvent[]>([]);
  const [moneyEvents, setMoneyEvents] = useState<RequestMoneyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);

  const [liquidation, setLiquidation] = useState<AdvanceLiquidation | null>(null);
  const [liquidationLoading, setLiquidationLoading] = useState(false);

  const [expenseSheetOpen, setExpenseSheetOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getStaffRequest(requestId)
      .then((r) => {
        setRequest(r.request);
        setEvents(r.events);
        setMoneyEvents(r.moneyEvents);
      })
      .catch(() => setError('โหลดรายละเอียดไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [requestId]);

  useEffect(() => {
    load();
  }, [load]);

  const showsLiquidation =
    !!request && request.requestType === 'advance' && ['paid', 'settling', 'settled'].includes(request.fulfillmentStatus);

  const loadLiquidation = useCallback(() => {
    if (!showsLiquidation) return;
    setLiquidationLoading(true);
    getRequestLiquidation(requestId)
      .then((r) => setLiquidation(r.liquidation))
      .catch(() => setLiquidation(null))
      .finally(() => setLiquidationLoading(false));
  }, [requestId, showsLiquidation]);

  useEffect(() => {
    loadLiquidation();
  }, [loadLiquidation]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  function notify(msg: string) {
    setNotice(msg);
    load();
    loadLiquidation();
    onChanged?.();
  }

  // CEO-only removal of this request in ANY state (owner directive, 2026-07-21) — a paid
  // request auto-reverses its fulfillment server-side, in the same transaction as the void
  // itself (see api/src/ceres/requestVoid.ts). See MdExpenses.tsx for the same tightening
  // on the expense-void action (gm/ceo → ceo-only).
  async function onVoidRequest() {
    const reason = window.prompt('ยกเลิกรายการนี้ทั้งหมด (CEO เท่านั้น) — กรอกเหตุผล (จำเป็น)');
    if (reason == null) return;
    const trimmed = reason.trim();
    if (!trimmed) { window.alert('ต้องกรอกเหตุผล'); return; }
    setVoidBusy(true);
    try {
      await voidStaffRequest(requestId, trimmed);
      notify('ยกเลิกรายการแล้ว');
    } catch (err) {
      const described = describeVoidError(err);
      const extra = described.blockers?.length
        ? `\nต้องจัดการรายการลูกก่อน: ${described.blockers.map((b) => `${b.category ?? ''} ${baht(Number(b.amount))}`).join(', ')}`
        : described.remainingOutstanding
          ? `\nยอดค้าง: ${baht(Number(described.remainingOutstanding))}`
          : '';
      window.alert(described.message + extra);
    } finally {
      setVoidBusy(false);
    }
  }

  // Alpha hard-purge (CEO only, owner directive 2026-07-22) — removes the request and its
  // whole graph, ANY state (in-flight test requests are purgeable too, unlike /void which
  // still writes an audit trail). The request no longer exists after this succeeds, so we
  // close the sheet and let the caller's list refresh itself instead of re-fetching it.
  async function onPurgeRequest() {
    const typed = window.prompt(`ลบถาวร — คำขอนี้ทั้งหมด\nพิมพ์ "${CERES_PURGE_CONFIRM_PHRASE}" เพื่อยืนยัน (ลบแบบถาวร กู้คืนไม่ได้ ไม่มีประวัติ)`);
    if (typed == null) return;
    if (typed.trim() !== CERES_PURGE_CONFIRM_PHRASE) { window.alert('พิมพ์ข้อความยืนยันไม่ตรง — ลบไม่สำเร็จ'); return; }
    setPurgeBusy(true);
    try {
      await purgeStaffRequest(requestId);
      onChanged?.();
      onClose();
    } catch (err) {
      window.alert(describePurgeError(err));
    } finally {
      setPurgeBusy(false);
    }
  }

  const canAddLiquidationExpense =
    !!request &&
    request.requestType === 'advance' &&
    request.requestedById === agent.id &&
    ['paid', 'settling', 'settled'].includes(request.fulfillmentStatus);

  // Money events that a reversal can still target: not a reversal itself, and not
  // already reversed by another event in this list (mirrors requestMoney.ts's
  // activeEvents()).
  const reversedIds = new Set(
    moneyEvents.filter((e) => e.kind === 'reversal' && e.reversesEventId).map((e) => e.reversesEventId as string),
  );

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 sticky top-0 bg-white z-10">
          <div className="font-semibold text-base">รายละเอียดคำขอ</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
            <X size={20} />
          </button>
        </div>

        {loading ? (
          <div className="py-16 flex justify-center text-slate-400">
            <Loader2 className="animate-spin" size={24} />
          </div>
        ) : error || !request ? (
          <div className="py-16 flex items-center justify-center gap-1 text-rose-600 text-sm">
            <AlertTriangle size={15} /> {error || 'ไม่พบคำขอ'}
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {notice && (
              <div className="px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm flex items-center gap-1.5">
                <CheckCircle2 size={15} /> {notice}
              </div>
            )}

            <div>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-bold text-xl">{baht(request.amountNum)}</div>
                  <div className="text-sm text-slate-500">
                    {TYPE_LABEL[request.requestType]} · {request.requestedByName}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${APPROVAL_LABEL[request.approvalStatus].cls}`}>
                    {APPROVAL_LABEL[request.approvalStatus].label}
                  </span>
                  {FULFILLMENT_LABEL[request.fulfillmentStatus] && (
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${FULFILLMENT_LABEL[request.fulfillmentStatus]!.cls}`}>
                      {FULFILLMENT_LABEL[request.fulfillmentStatus]!.label}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">{request.entity}</span>
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">{request.category}</span>
              </div>
              <div className="mt-2 text-sm text-slate-700 break-words">{request.reason}</div>
              {request.requestPhotoUploadIds.length > 0 && (
                <div className="mt-2">
                  <MediaThumbStrip ids={request.requestPhotoUploadIds} size={72} alt="รูปแนบคำขอ" rounded="rounded-xl" />
                </div>
              )}
              {request.approvalStatus === 'void' && request.voidReason && (
                <div className="mt-2 text-xs text-slate-500">ยกเลิกเพราะ: {request.voidReason}</div>
              )}

              {/* ติดธง — everyone who can see this request (flag button never hides on
                  ownership, server enforces visibility). ยกเลิกรายการ — CEO only, any state
                  (owner directive, 2026-07-21). */}
              {(request.approvalStatus !== 'void' || purgeEnabled) && (
                <div className="flex items-center justify-end gap-3 mt-3 pt-3 border-t border-slate-100">
                  {request.approvalStatus !== 'void' && (
                    <FlagButton targetType="request" targetId={request.id} onFlagged={() => notify('ติดธงแล้ว')} />
                  )}
                  {isCeo && request.approvalStatus !== 'void' && (
                    <button
                      onClick={onVoidRequest}
                      disabled={voidBusy}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 hover:text-rose-700 disabled:opacity-50"
                    >
                      {voidBusy ? <Loader2 size={13} className="animate-spin" /> : <Ban size={13} />} ยกเลิกรายการ
                    </button>
                  )}
                  {/* ลบถาวร — CEO-only alpha hard-purge, ANY state incl. already-voided
                      (owner directive, 2026-07-22), only rendered when the alpha flag is on. */}
                  {purgeEnabled && (
                    <button
                      onClick={onPurgeRequest}
                      disabled={purgeBusy}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-rose-700 hover:text-rose-800 disabled:opacity-50"
                    >
                      {purgeBusy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} ลบถาวร
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Liquidation progress (advances only) */}
            {showsLiquidation && (
              <div className="border-t border-slate-100 pt-3">
                <h3 className="text-sm font-bold mb-2">ความคืบหน้าการปิดยอดเงินเบิก</h3>
                {liquidationLoading ? (
                  <div className="py-6 flex justify-center text-slate-400">
                    <Loader2 className="animate-spin" size={18} />
                  </div>
                ) : liquidation ? (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs mb-3">
                      <div className="bg-slate-50 rounded-lg p-2">
                        <div className="text-slate-400">เบิกไป</div>
                        <div className="font-bold">{baht(Number(liquidation.advanceAmount))}</div>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-2">
                        <div className="text-slate-400">ใช้ไป</div>
                        <div className="font-bold">{baht(Number(liquidation.totals.approvedExpenses))}</div>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-2">
                        <div className="text-slate-400">คืนแล้ว</div>
                        <div className="font-bold">{baht(Number(liquidation.totals.returned))}</div>
                      </div>
                      <div className={`rounded-lg p-2 ${liquidation.totals.settled ? 'bg-emerald-50' : 'bg-amber-50'}`}>
                        <div className={liquidation.totals.settled ? 'text-emerald-700' : 'text-amber-700'}>ค้าง</div>
                        <div className={`font-bold ${liquidation.totals.settled ? 'text-emerald-700' : 'text-amber-700'}`}>
                          {baht(Number(liquidation.totals.remainingOutstanding))}
                        </div>
                      </div>
                    </div>

                    {liquidation.approvedExpenses.length > 0 && (
                      <div className="mb-2">
                        <div className="text-xs font-semibold text-slate-500 mb-1">ค่าใช้จ่ายที่หักแล้ว</div>
                        <div className="space-y-1.5">
                          {liquidation.approvedExpenses.map((e) => (
                            <div key={e.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-slate-50 text-sm">
                              <MediaThumb id={e.receiptUploadId} size={36} alt="ใบเสร็จ" />
                              <div className="flex-1 min-w-0">
                                <div className="truncate">{e.category}</div>
                                <div className="text-xs text-slate-400">{fmtDateTime(e.spentAt)}</div>
                              </div>
                              <span className="font-semibold shrink-0">{baht(Number(e.amount))}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {liquidation.returns.length > 0 && (
                      <div className="mb-2">
                        <div className="text-xs font-semibold text-slate-500 mb-1">เงินที่คืนแล้ว</div>
                        <div className="space-y-1.5">
                          {liquidation.returns.map((ev) => (
                            <div key={ev.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-slate-50 text-sm">
                              {ev.transferSlipUploadId && <MediaThumb id={ev.transferSlipUploadId} size={36} alt="สลิปคืนเงิน" />}
                              <div className="flex-1 min-w-0">
                                <div>{LANE_LABEL[ev.lane]}</div>
                                <div className="text-xs text-slate-400">{fmtDateTime(ev.createdAt)}</div>
                              </div>
                              <span className="font-semibold shrink-0">{baht(Number(ev.amount))}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {canAddLiquidationExpense && (
                      <button
                        onClick={() => setExpenseSheetOpen(true)}
                        className="w-full mt-1 min-h-[42px] rounded-lg border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 text-sm font-semibold flex items-center justify-center gap-1"
                      >
                        <Plus size={15} /> เพิ่มค่าใช้จ่ายเบิก
                      </button>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-rose-600 flex items-center gap-1">
                    <AlertTriangle size={12} /> โหลดข้อมูลปิดยอดไม่สำเร็จ
                  </div>
                )}
              </div>
            )}

            {/* Money events */}
            {moneyEvents.length > 0 && (
              <div className="border-t border-slate-100 pt-3">
                <h3 className="text-sm font-bold mb-2">รายการเงิน</h3>
                <div className="space-y-2">
                  {moneyEvents.map((ev) => (
                    <MoneyEventRow
                      key={ev.id}
                      event={ev}
                      reversed={reversedIds.has(ev.id)}
                      canReverse={isManager && ev.kind !== 'reversal' && !reversedIds.has(ev.id)}
                      onReversed={() => notify('ย้อนกลับรายการแล้ว')}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Timeline */}
            <div className="border-t border-slate-100 pt-3">
              <h3 className="text-sm font-bold mb-2">ประวัติคำขอ</h3>
              <ol className="space-y-2.5">
                {events.map((ev) => (
                  <li key={ev.id} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{EVENT_LABEL[ev.kind] ?? ev.kind}</span>
                      <span className="text-xs text-slate-400 shrink-0">{fmtDateTime(ev.createdAt)}</span>
                    </div>
                    {ev.actorName && <div className="text-xs text-slate-500">โดย {ev.actorName}</div>}
                    {ev.note && <div className="text-xs text-slate-500 mt-0.5 break-words">{ev.note}</div>}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </div>

      {expenseSheetOpen && request && (
        <ExpenseSheet
          editing={null}
          advanceRequestId={request.id}
          defaultEntity={request.entity}
          // request.category is the server-JOINED groups label for a group-based advance
          // (e.g. "กลุ่ม A · กลุ่ม B") — not a real category name, so don't prefill it;
          // staff picks the exact category per expense. Old (pre-migration) advances keep
          // a single real category (categoryGroups empty) and still prefill it as before.
          defaultCategory={request.categoryGroups.length > 0 ? undefined : request.category}
          partyId={bootstrap.role !== 'messenger' ? bootstrap.party?.id : undefined}
          onClose={() => setExpenseSheetOpen(false)}
          onSaved={() => notify('เพิ่มค่าใช้จ่ายเบิกแล้ว')}
        />
      )}
    </div>
  );
}

function MoneyEventRow({
  event,
  reversed,
  canReverse,
  onReversed,
}: {
  event: RequestMoneyEvent;
  reversed: boolean;
  canReverse: boolean;
  onReversed: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!reason.trim()) {
      setError('กรุณาระบุเหตุผลที่ย้อนกลับ');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await reverseRequestMoneyEvent(event.id, reason.trim(), newIdempotencyKey());
      setConfirming(false);
      setReason('');
      onReversed();
    } catch (err) {
      setError(describeMoneyError(err));
    } finally {
      setBusy(false);
    }
  }

  const evidenceIds = event.lane === 'transfer' ? event.transferSlipUploadIds : event.purchaseReceiptUploadIds;

  return (
    <div className={`rounded-lg border p-2.5 ${reversed ? 'border-slate-200 bg-slate-50 opacity-60' : 'border-slate-200 bg-white'}`}>
      <div className="flex items-center gap-2">
        <MediaThumbStrip ids={evidenceIds} size={36} alt="หลักฐาน" />
        <div className="flex-1 min-w-0 text-sm">
          <div className="flex items-center gap-1.5">
            {event.lane === 'transfer' ? <Landmark size={13} className="text-slate-400" /> : <Banknote size={13} className="text-slate-400" />}
            <span className="font-medium">
              {MONEY_KIND_LABEL[event.kind]} · {LANE_LABEL[event.lane]}
            </span>
            {reversed && <span className="px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-700 text-[10px] font-semibold">ถูกย้อนกลับ</span>}
          </div>
          <div className="text-xs text-slate-400">
            {fmtDateTime(event.createdAt)} · โดย {event.createdByName || '—'}
          </div>
          {event.note && <div className="text-xs text-slate-500 mt-0.5 break-words">{event.note}</div>}
        </div>
        <span className="font-semibold shrink-0">{baht(Number(event.amount))}</span>
      </div>

      {canReverse && (
        <div className="mt-2 pt-2 border-t border-slate-100">
          {confirming ? (
            <div className="space-y-1.5">
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="เหตุผลที่ย้อนกลับรายการนี้ (จำเป็น)"
                rows={2}
                autoFocus
                className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs resize-none"
              />
              {error && (
                <div className="flex items-center gap-1 text-rose-600 text-xs">
                  <AlertTriangle size={11} /> {error}
                </div>
              )}
              <div className="flex gap-1.5">
                <button
                  onClick={submit}
                  disabled={busy || !reason.trim()}
                  className="flex-1 min-h-[34px] rounded-lg bg-rose-600 text-white text-xs font-semibold disabled:opacity-40 flex items-center justify-center gap-1"
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />} ยืนยันย้อนกลับ
                </button>
                <button
                  onClick={() => {
                    setConfirming(false);
                    setError('');
                  }}
                  disabled={busy}
                  className="px-3 min-h-[34px] rounded-lg border border-slate-300 text-xs text-slate-600"
                >
                  ยกเลิก
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="text-xs text-rose-600 underline underline-offset-2 hover:text-rose-700"
            >
              ย้อนกลับรายการนี้ (ผิดพลาด)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
