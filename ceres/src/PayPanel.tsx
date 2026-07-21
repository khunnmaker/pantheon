import { useRef, useState } from 'react';
import { AlertTriangle, Banknote, Camera, CheckCircle2, Landmark, Loader2 } from 'lucide-react';
import {
  describeMoneyError,
  fulfillStaffRequest,
  newIdempotencyKey,
  uploadMedia,
  type RequestMoneyLane,
  type StaffRequest,
} from './lib/api';
import { downscaleImage } from './lib/image';

// Shared pay-out panel (Ceres approve-and-pay collapse, 2026-07-21). Used both by the GM
// approval queue's combined "อนุมัติและจ่ายเลย" action (NeeApprovalQueue.tsx) and by the
// รอจ่าย fulfillment queue's "บันทึกจ่ายเงิน"/"บันทึกว่าซื้อแล้ว" expand
// (NeeFulfillmentQueue.tsx) — one component, two call sites, so the pay flow (and its error
// mapping) can never drift between them.
//
// Two shapes:
//  - advance/reimbursement: cash is a genuine ONE TAP — the lane tap itself submits the
//    fulfill call, no separate confirm step. Transfer always expands to a mandatory slip
//    upload + its own confirm (transfer can never be one-tap; evidence is required).
//  - purchase: unchanged two-step shape (lane choice + mandatory receipt + confirm) — never
//    one-tapped, per owner rule (a receipt has to be attached regardless of lane).
//
// NO lazy lane default (owner rule, 2026-07-18, carried over from the old FulfillForm this
// replaces) — nothing is preselected; the explicit tap on a lane/action IS the choice.

function EvidenceUpload({
  label,
  preview,
  busy,
  onPick,
}: {
  label: string;
  preview: string | null;
  busy: boolean;
  onPick: (file: File) => void;
}) {
  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onPick(file);
    e.target.value = '';
  }
  return (
    <div>
      <div className="text-xs font-semibold text-slate-500 mb-1.5">{label}</div>
      {preview ? (
        <div className="relative">
          <img src={preview} alt={label} className="w-full max-h-48 object-contain rounded-xl border border-slate-200 bg-slate-50" />
          <label
            className={`mt-2 w-full min-h-[40px] rounded-lg border border-slate-300 text-xs font-medium hover:bg-slate-50 flex items-center justify-center cursor-pointer ${busy ? 'opacity-50' : ''}`}
          >
            {busy ? 'กำลังอัปโหลด…' : 'ถ่ายรูปใหม่'}
            <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busy} onChange={onChange} />
          </label>
        </div>
      ) : (
        <label
          className={`w-full min-h-[80px] rounded-xl border-2 border-dashed border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 font-semibold flex flex-col items-center justify-center gap-1.5 cursor-pointer ${busy ? 'opacity-60' : ''}`}
        >
          {busy ? <Loader2 className="animate-spin" size={20} /> : <Camera size={20} />}
          <span className="text-xs">{busy ? 'กำลังอัปโหลด…' : 'ถ่ายรูป / แนบรูป'}</span>
          <input type="file" accept="image/*" capture="environment" className="hidden" disabled={busy} onChange={onChange} />
        </label>
      )}
    </div>
  );
}

export function PayPanel({
  request,
  onDone,
  onCancel,
}: {
  request: StaffRequest;
  onDone: (msg: string) => void;
  // Collapses/dismisses the panel without having paid — the fulfillment queue folds the
  // card back to its closed state; the approval queue refreshes the queue (the request is
  // already approved by the time this panel can show, so a refresh just makes it disappear
  // from the pending-approval list cleanly — see NeeApprovalQueue.tsx's decideAndPay()).
  onCancel: () => void;
}) {
  const isPurchase = request.requestType === 'purchase';
  const [lane, setLane] = useState<RequestMoneyLane | null>(null);
  const [slipId, setSlipId] = useState<string | null>(null);
  const [slipPreview, setSlipPreview] = useState<string | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState<'slip' | 'receipt' | null>(null);
  // Which lane is currently mid-submit — also drives the one-tap cash button's own spinner.
  const [busyLane, setBusyLane] = useState<RequestMoneyLane | null>(null);
  const [error, setError] = useState('');
  // Stable per PayPanel mount — a retried tap (incl. a retry after insufficient_cash etc.)
  // replays the SAME server-side event instead of creating a second money movement (see
  // api/src/ceres/requestMoney.ts's idempotencyKey).
  const idempotencyKey = useRef(newIdempotencyKey());

  const busy = busyLane !== null;

  async function handleUpload(kind: 'slip' | 'receipt', file: File) {
    setError('');
    setUploadBusy(kind);
    try {
      const { dataB64, contentType } = await downscaleImage(file);
      const result = await uploadMedia(dataB64, contentType, kind === 'slip' ? 'transfer_slip' : 'purchase_receipt');
      const preview = `data:${contentType};base64,${dataB64}`;
      if (kind === 'slip') {
        setSlipId(result.uploadId);
        setSlipPreview(preview);
      } else {
        setReceiptId(result.uploadId);
        setReceiptPreview(preview);
      }
    } catch {
      setError('อัปโหลดรูปไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setUploadBusy(null);
    }
  }

  async function doFulfill(l: RequestMoneyLane, evidence?: { slipUploadId?: string; receiptUploadId?: string }) {
    setError('');
    setBusyLane(l);
    try {
      await fulfillStaffRequest(request.id, {
        lane: l,
        transferSlipUploadId: evidence?.slipUploadId,
        purchaseReceiptUploadId: evidence?.receiptUploadId,
        idempotencyKey: idempotencyKey.current,
      });
      onDone(isPurchase ? 'บันทึกว่าซื้อแล้ว' : 'บันทึกจ่ายเงินแล้ว');
    } catch (err) {
      setError(describeMoneyError(err));
    } finally {
      setBusyLane(null);
    }
  }

  const missingSlip = lane === 'transfer' && !slipId;
  const missingReceipt = isPurchase && !receiptId;

  async function submit() {
    setError('');
    if (!lane) return setError('กรุณาเลือกช่องทางจ่ายเงิน');
    if (missingSlip) return setError('ต้องแนบสลิปโอนก่อนบันทึก');
    if (missingReceipt) return setError('ต้องแนบใบเสร็จซื้อของก่อนบันทึก');
    await doFulfill(lane, { slipUploadId: slipId ?? undefined, receiptUploadId: receiptId ?? undefined });
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
          <EvidenceUpload label="สลิปโอนเงิน (จำเป็น)" preview={slipPreview} busy={uploadBusy === 'slip'} onPick={(f) => handleUpload('slip', f)} />
        )}
        <EvidenceUpload
          label="ใบเสร็จซื้อของ (จำเป็น)"
          preview={receiptPreview}
          busy={uploadBusy === 'receipt'}
          onPick={(f) => handleUpload('receipt', f)}
        />

        {error && (
          <div className="flex items-center gap-1 text-rose-600 text-xs">
            <AlertTriangle size={12} /> {error}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={submit}
            disabled={busy || uploadBusy !== null}
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
          <EvidenceUpload label="สลิปโอนเงิน (จำเป็น)" preview={slipPreview} busy={uploadBusy === 'slip'} onPick={(f) => handleUpload('slip', f)} />

          {error && (
            <div className="flex items-center gap-1 text-rose-600 text-xs">
              <AlertTriangle size={12} /> {error}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={busy || uploadBusy !== null}
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
