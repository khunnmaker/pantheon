import { useRef, useState } from 'react';
import { AlertTriangle, Banknote, CheckCircle2, Landmark, Loader2 } from 'lucide-react';
import {
  decideAndPayStaffRequest,
  describeMoneyError,
  fulfillStaffRequest,
  newIdempotencyKey,
  uploadMedia,
  type RequestMoneyLane,
  type StaffRequest,
} from './lib/api';
import PhotoListUpload, { type PhotoItem } from './lib/PhotoListUpload';

// Shared pay-out panel. Two call sites, one component, so the pay flow (and its error
// mapping) can never drift between them:
//  - NeeFulfillmentQueue.tsx's รอจ่าย queue ("บันทึกจ่ายเงิน"/"บันทึกว่าซื้อแล้ว" expand on
//    an ALREADY-approved request) — mode="fulfill" (the default).
//  - NeeApprovalQueue.tsx / CeoOverview.tsx's EscalationCard "อนุมัติ = จ่าย" one-flow
//    (owner directive, 2026-07-22) — the inline lane question that opens straight off the
//    GM/CEO "อนุมัติ" tap, BEFORE the request is approved — mode="decideAndPay".
//
// Two shapes:
//  - advance/reimbursement: cash is a genuine ONE TAP — the lane tap itself submits the
//    fulfill/decide-and-pay call, no separate confirm step. Transfer always expands to a
//    mandatory slip upload + its own confirm (transfer can never be one-tap; evidence is
//    required).
//  - purchase: unchanged two-step shape (lane choice + mandatory receipt + confirm) — never
//    one-tapped, per owner rule (a receipt has to be attached regardless of lane). Purchase
//    never reaches mode="decideAndPay" — the composite endpoint 400s on it server-side, and
//    every mode="decideAndPay" call site only ever offers this panel for advance/reimbursement.
//
// NO lazy lane default (owner rule, 2026-07-18, carried over from the old FulfillForm this
// replaces) — nothing is preselected; the explicit tap on a lane/action IS the choice.

export function PayPanel({
  request,
  mode = 'fulfill',
  extraAction,
  onDone,
  onCancel,
}: {
  request: StaffRequest;
  // 'fulfill' (default): request is ALREADY approved — drives the plain fulfill endpoint.
  // 'decideAndPay': request is STILL pending (pending_nee for GM, pending_ceo for CEO) —
  // the lane tap drives the composite decide-and-pay endpoint instead, approving AND
  // paying in one server transaction (Ceres approve-is-pay one-flow, 2026-07-22).
  mode?: 'fulfill' | 'decideAndPay';
  // Third choice alongside the lane buttons — only the CEO's EscalationCard passes this
  // ("ให้ GM จ่ายทีหลัง": a plain ceoDecision approve with NO payment, for a CEO approving
  // remotely who isn't the one physically handing over cash/making the transfer). Every
  // other call site omits it. Only ever shown on the un-expanded lane-choice screen — once
  // transfer expands to its slip upload, or for a purchase, this option makes no sense and
  // never renders.
  extraAction?: { label: string; onClick: () => void; busy?: boolean };
  onDone: (msg: string) => void;
  // Collapses/dismisses the panel without having paid.
  // mode="fulfill": the request is already approved, so the fulfillment queue just folds
  // the card back to its closed state (nothing to undo).
  // mode="decideAndPay": NO API call has been made yet at this point — cancelling here is
  // a true no-op, the request is untouched (still pending_nee/pending_ceo).
  onCancel: () => void;
}) {
  const isPurchase = request.requestType === 'purchase';
  const [lane, setLane] = useState<RequestMoneyLane | null>(null);
  const [slipPhotos, setSlipPhotos] = useState<PhotoItem[]>([]);
  const [receiptPhotos, setReceiptPhotos] = useState<PhotoItem[]>([]);
  // Which lane is currently mid-submit — also drives the one-tap cash button's own spinner.
  const [busyLane, setBusyLane] = useState<RequestMoneyLane | null>(null);
  const [error, setError] = useState('');
  // Stable per PayPanel mount — a retried tap (incl. a retry after insufficient_cash etc.)
  // replays the SAME server-side event instead of creating a second money movement (see
  // api/src/ceres/requestMoney.ts's idempotencyKey).
  const idempotencyKey = useRef(newIdempotencyKey());

  const busy = busyLane !== null;
  const uploadSlip = (dataB64: string, contentType: string) => uploadMedia(dataB64, contentType, 'transfer_slip');
  const uploadReceiptPhoto = (dataB64: string, contentType: string) => uploadMedia(dataB64, contentType, 'purchase_receipt');

  async function doFulfill(l: RequestMoneyLane, evidence?: { slipUploadIds?: string[]; receiptUploadIds?: string[] }) {
    setError('');
    setBusyLane(l);
    try {
      if (mode === 'decideAndPay') {
        const result = await decideAndPayStaffRequest(request.id, {
          lane: l,
          transferSlipUploadId: evidence?.slipUploadIds?.[0],
          transferSlipUploadIds: evidence?.slipUploadIds,
          idempotencyKey: idempotencyKey.current,
        });
        // 'escalated' — the prediction that offered this panel was wrong by the time the
        // server ran (AI verdict flipped, etc.): the decision alone committed, nothing was
        // paid. Still a successful call from this panel's point of view (no error), so it
        // folds the same way, just with the "sent to CEO" wording instead of "paid".
        onDone(result.outcome === 'escalated' ? 'ส่งต่อ CEO แล้ว รออนุมัติก่อนจ่าย' : 'อนุมัติและจ่ายเงินแล้ว');
      } else {
        await fulfillStaffRequest(request.id, {
          lane: l,
          transferSlipUploadId: evidence?.slipUploadIds?.[0],
          transferSlipUploadIds: evidence?.slipUploadIds,
          purchaseReceiptUploadId: evidence?.receiptUploadIds?.[0],
          purchaseReceiptUploadIds: evidence?.receiptUploadIds,
          idempotencyKey: idempotencyKey.current,
        });
        onDone(isPurchase ? 'บันทึกว่าซื้อแล้ว' : 'บันทึกจ่ายเงินแล้ว');
      }
    } catch (err) {
      setError(describeMoneyError(err));
    } finally {
      setBusyLane(null);
    }
  }

  const readySlipIds = slipPhotos.filter((p) => !p.busy).map((p) => p.uploadId);
  const readyReceiptIds = receiptPhotos.filter((p) => !p.busy).map((p) => p.uploadId);
  const uploadBusy = slipPhotos.some((p) => p.busy) || receiptPhotos.some((p) => p.busy);
  const missingSlip = lane === 'transfer' && readySlipIds.length === 0;
  const missingReceipt = isPurchase && readyReceiptIds.length === 0;

  async function submit() {
    setError('');
    if (!lane) return setError('กรุณาเลือกช่องทางจ่ายเงิน');
    if (missingSlip) return setError('ต้องแนบสลิปโอนก่อนบันทึก');
    if (missingReceipt) return setError('ต้องแนบใบเสร็จซื้อของก่อนบันทึก');
    await doFulfill(lane, { slipUploadIds: readySlipIds, receiptUploadIds: readyReceiptIds });
  }

  // ---- purchase: unchanged two-step shape (lane choice + mandatory receipt + confirm) ----
  if (isPurchase) {
    return (
      <div className="mt-3 pt-3 border-t border-slate-100 space-y-3">
        <div>
          <div className="text-xs font-semibold text-slate-500 mb-1.5">ช่องทางจ่ายเงิน</div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setLane('cash')}
              className={`min-h-[44px] rounded-lg border text-sm font-semibold flex items-center justify-center gap-1.5 ${
                lane === 'cash' ? 'bg-amber-600 border-amber-600 text-white' : 'border-slate-300 text-slate-600'
              }`}
            >
              <Banknote size={15} /> จ่ายสด
            </button>
            <button
              onClick={() => setLane('transfer')}
              className={`min-h-[44px] rounded-lg border text-sm font-semibold flex items-center justify-center gap-1.5 ${
                lane === 'transfer' ? 'bg-amber-600 border-amber-600 text-white' : 'border-slate-300 text-slate-600'
              }`}
            >
              <Landmark size={15} /> โอนเงิน
            </button>
          </div>
        </div>

        {lane === 'transfer' && (
          <div>
            <div className="text-xs font-semibold text-slate-500 mb-1.5">สลิปโอนเงิน (จำเป็น)</div>
            <PhotoListUpload items={slipPhotos} onChange={setSlipPhotos} upload={uploadSlip} compact />
          </div>
        )}
        <div>
          <div className="text-xs font-semibold text-slate-500 mb-1.5">ใบเสร็จซื้อของ (จำเป็น)</div>
          <PhotoListUpload items={receiptPhotos} onChange={setReceiptPhotos} upload={uploadReceiptPhoto} compact />
        </div>

        {error && (
          <div className="flex items-center gap-1 text-rose-600 text-xs">
            <AlertTriangle size={12} /> {error}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={submit}
            disabled={busy || uploadBusy}
            className="flex-1 min-h-[44px] rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} ยืนยันซื้อแล้ว
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 min-h-[44px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
          >
            ยกเลิก
          </button>
        </div>
      </div>
    );
  }

  // ---- advance/reimbursement: two-action panel — cash is one-tap, transfer expands ----
  return (
    <div className="mt-3 pt-3 border-t border-slate-100 space-y-3">
      {lane !== 'transfer' ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => doFulfill('cash')}
              disabled={busy}
              className="min-h-[48px] rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40"
            >
              {busyLane === 'cash' ? <Loader2 size={15} className="animate-spin" /> : <Banknote size={15} />} จ่ายสดจากกล่อง
            </button>
            <button
              onClick={() => setLane('transfer')}
              disabled={busy}
              className="min-h-[48px] rounded-lg border border-amber-400 bg-amber-50 hover:bg-amber-100 text-amber-800 text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40"
            >
              <Landmark size={15} /> โอนเงิน · แนบสลิป
            </button>
          </div>

          {extraAction && (
            <button
              onClick={extraAction.onClick}
              disabled={busy || !!extraAction.busy}
              className="w-full min-h-[40px] rounded-lg border border-violet-300 bg-violet-50 hover:bg-violet-100 text-violet-700 text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-40"
            >
              {extraAction.busy ? <Loader2 size={14} className="animate-spin" /> : null} {extraAction.label}
            </button>
          )}

          {error && (
            <div className="flex items-center gap-1 text-rose-600 text-xs">
              <AlertTriangle size={12} /> {error}
            </div>
          )}

          <button
            onClick={onCancel}
            disabled={busy}
            className="w-full min-h-[40px] rounded-lg border border-slate-300 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
          >
            ยกเลิก
          </button>
        </>
      ) : (
        <>
          <div>
            <div className="text-xs font-semibold text-slate-500 mb-1.5">สลิปโอนเงิน (จำเป็น)</div>
            <PhotoListUpload items={slipPhotos} onChange={setSlipPhotos} upload={uploadSlip} compact />
          </div>

          {error && (
            <div className="flex items-center gap-1 text-rose-600 text-xs">
              <AlertTriangle size={12} /> {error}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={busy || uploadBusy}
              className="flex-1 min-h-[44px] rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} ยืนยันจ่ายแล้ว
            </button>
            <button
              onClick={() => {
                setLane(null);
                setError('');
              }}
              disabled={busy}
              className="px-3 min-h-[44px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
            >
              กลับ
            </button>
          </div>
        </>
      )}
    </div>
  );
}
