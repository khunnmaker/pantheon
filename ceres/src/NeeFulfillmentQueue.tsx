import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  Loader2,
  RefreshCw,
  ShoppingCart,
  Undo2,
} from 'lucide-react';
import {
  baht,
  describeMoneyError,
  getRequestLiquidation,
  listStaffRequests,
  newIdempotencyKey,
  refundAdvance,
  uploadMedia,
  type AdvanceLiquidation,
  type RequestMoneyLane,
  type StaffRequest,
} from './lib/api';
import { REQUEST_TYPE_LABEL as TYPE_LABEL } from './lib/requestLabels';
import { MediaThumbStrip } from './lib/media';
import { PayPanel } from './PayPanel';
import PhotoListUpload, { type PhotoItem } from './lib/PhotoListUpload';
import RequestDetail from './RequestDetail';

// Nee's approved-and-awaiting-fulfillment queue (Ceres revamp Phase 3). Two lanes:
// requests that still need the cash/transfer payout (or purchase receipt), and paid
// advances that are still open for liquidation (returns / linked expenses). See
// docs/CERES_REVAMP_PLAN.md "Phase 3" + api/src/ceres/requestMoney.ts.

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

export default function NeeFulfillmentQueue() {
  const [rows, setRows] = useState<StaffRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    // scope 'all' (gm/ceo only) — the queue needs both approved-unfulfilled AND
    // paid/settling advances, which no single narrower scope covers.
    listStaffRequests('all', 300)
      .then((r) => setRows(r.requests))
      .catch(() => setError('โหลดรายการไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(''), 3000);
    return () => clearTimeout(t);
  }, [success]);

  function onChanged(msg: string) {
    setSuccess(msg);
    load();
  }

  const toFulfill = rows
    .filter((r) => r.approvalStatus === 'approved' && r.fulfillmentStatus === 'unfulfilled')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const inLiquidation = rows.filter(
    (r) => r.requestType === 'advance' && (r.fulfillmentStatus === 'paid' || r.fulfillmentStatus === 'settling'),
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div>
          <h2 className="text-lg font-bold">จ่ายเงิน / ซื้อของ</h2>
          <p className="text-xs text-slate-400">คำขอที่อนุมัติแล้ว รอจ่ายสดหรือโอนเงิน</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          aria-label="โหลดใหม่"
          className="p-2 rounded-lg border border-slate-300 text-slate-500 hover:bg-white disabled:opacity-50"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {success && (
        <div className="mb-3 px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm flex items-center gap-1.5">
          <CheckCircle2 size={15} /> {success}
        </div>
      )}
      {error && (
        <div className="mb-3 flex items-center gap-1 text-rose-600 text-sm">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {loading ? (
        <div className="py-10 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : (
        <>
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-slate-500 mb-2">รอจ่ายเงิน ({toFulfill.length})</h3>
            {toFulfill.length === 0 ? (
              <div className="text-center text-slate-400 text-sm py-8 bg-white rounded-xl border border-slate-200">
                ไม่มีรายการรอจ่าย
              </div>
            ) : (
              <div className="space-y-3">
                {toFulfill.map((r) => (
                  <FulfillCard key={r.id} request={r} onDone={onChanged} onViewDetail={() => setDetailId(r.id)} />
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-slate-500 mb-2">
              เงินเบิกล่วงหน้าที่ยังไม่ปิดยอด ({inLiquidation.length})
            </h3>
            {inLiquidation.length === 0 ? (
              <div className="text-center text-slate-400 text-sm py-8 bg-white rounded-xl border border-slate-200">
                ไม่มีเงินเบิกค้างปิดยอด
              </div>
            ) : (
              <div className="space-y-3">
                {inLiquidation.map((r) => (
                  <LiquidationCard key={r.id} request={r} onDone={onChanged} onViewDetail={() => setDetailId(r.id)} />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {detailId && (
        <RequestDetail requestId={detailId} onClose={() => setDetailId(null)} onChanged={() => onChanged('บันทึกแล้ว')} />
      )}
    </div>
  );
}

function FulfillCard({
  request,
  onDone,
  onViewDetail,
}: {
  request: StaffRequest;
  onDone: (msg: string) => void;
  onViewDetail: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isPurchase = request.requestType === 'purchase';

  return (
    <article className="bg-white rounded-xl border border-slate-200 p-3">
      <div className="flex items-start gap-3">
        <MediaThumbStrip ids={request.requestPhotoUploadIds} size={56} alt="หลักฐานคำขอ" rounded="rounded-xl" />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-sm">{request.requestedByName}</div>
              <div className="text-xs text-slate-500">{TYPE_LABEL[request.requestType]}</div>
            </div>
            <div className="font-bold text-lg text-amber-700 shrink-0">{baht(request.amountNum)}</div>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">{request.entity}</span>
            <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">{request.category}</span>
          </div>
          <div className="mt-1.5 text-sm text-slate-700 break-words">{request.reason}</div>
        </div>
      </div>

      {!open ? (
        <div className="flex gap-2 mt-3 pt-3 border-t border-slate-100">
          <button
            onClick={() => setOpen(true)}
            className="flex-1 min-h-[44px] rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-1"
          >
            {isPurchase ? <ShoppingCart size={14} /> : <Banknote size={14} />} {isPurchase ? 'บันทึกว่าซื้อแล้ว' : 'บันทึกจ่ายเงิน'}
          </button>
          <button
            onClick={onViewDetail}
            aria-label="ดูรายละเอียด"
            className="px-3 min-h-[44px] rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50"
          >
            <Eye size={16} />
          </button>
        </div>
      ) : (
        <PayPanel
          request={request}
          onCancel={() => setOpen(false)}
          onDone={(msg) => {
            setOpen(false);
            onDone(msg);
          }}
        />
      )}
    </article>
  );
}

function LiquidationCard({
  request,
  onDone,
  onViewDetail,
}: {
  request: StaffRequest;
  onDone: (msg: string) => void;
  onViewDetail: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [liquidation, setLiquidation] = useState<AdvanceLiquidation | null>(null);
  const [loading, setLoading] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    setLoading(true);
    getRequestLiquidation(request.id)
      .then((r) => setLiquidation(r.liquidation))
      .catch(() => setLiquidation(null))
      .finally(() => setLoading(false));
  }, [expanded, request.id]);

  function reload() {
    getRequestLiquidation(request.id)
      .then((r) => setLiquidation(r.liquidation))
      .catch(() => {});
  }

  return (
    <article className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <button onClick={() => setExpanded((v) => !v)} className="w-full flex items-start gap-3 px-3 py-3 text-left">
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-sm">{request.requestedByName}</span>
            <span className="font-bold text-amber-700">{baht(request.amountNum)}</span>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-1 items-center">
            <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">{request.entity}</span>
            <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">{request.category}</span>
            <span
              className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                request.fulfillmentStatus === 'settling' ? 'bg-amber-100 text-amber-700' : 'bg-sky-100 text-sky-700'
              }`}
            >
              {request.fulfillmentStatus === 'settling' ? 'กำลังปิดยอด' : 'จ่ายแล้ว'}
            </span>
          </div>
        </div>
        {expanded ? <ChevronUp size={16} className="mt-1 shrink-0 text-slate-400" /> : <ChevronDown size={16} className="mt-1 shrink-0 text-slate-400" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-slate-100 pt-2">
          {loading ? (
            <div className="py-6 flex justify-center text-slate-400">
              <Loader2 className="animate-spin" size={18} />
            </div>
          ) : liquidation ? (
            <>
              <div className="grid grid-cols-3 gap-2 text-center text-xs mb-3">
                <div className="bg-slate-50 rounded-lg p-2">
                  <div className="text-slate-400">ใช้ไป</div>
                  <div className="font-bold">{baht(Number(liquidation.totals.approvedExpenses))}</div>
                </div>
                <div className="bg-slate-50 rounded-lg p-2">
                  <div className="text-slate-400">คืนแล้ว</div>
                  <div className="font-bold">{baht(Number(liquidation.totals.returned))}</div>
                </div>
                <div className="bg-amber-50 rounded-lg p-2">
                  <div className="text-amber-700">ค้าง</div>
                  <div className="font-bold text-amber-700">{baht(Number(liquidation.totals.remainingOutstanding))}</div>
                </div>
              </div>

              {!refundOpen ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => setRefundOpen(true)}
                    disabled={Number(liquidation.totals.remainingOutstanding) <= 0}
                    className="flex-1 min-h-[40px] rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
                  >
                    <Undo2 size={14} /> บันทึกคืนเงิน
                  </button>
                  <button
                    onClick={onViewDetail}
                    aria-label="ดูรายละเอียด"
                    className="px-3 min-h-[40px] rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50"
                  >
                    <Eye size={16} />
                  </button>
                </div>
              ) : (
                <RefundInlineForm
                  requestId={request.id}
                  fundingLane={liquidation.fundingLane}
                  remaining={liquidation.totals.remainingOutstanding}
                  onCancel={() => setRefundOpen(false)}
                  onDone={(msg) => {
                    setRefundOpen(false);
                    reload();
                    onDone(msg);
                  }}
                />
              )}
            </>
          ) : (
            <div className="text-xs text-rose-600 flex items-center gap-1">
              <AlertTriangle size={12} /> โหลดข้อมูลไม่สำเร็จ
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function RefundInlineForm({
  requestId,
  fundingLane,
  remaining,
  onCancel,
  onDone,
}: {
  requestId: string;
  fundingLane: RequestMoneyLane;
  remaining: string;
  onCancel: () => void;
  onDone: (msg: string) => void;
}) {
  const [lane, setLane] = useState<RequestMoneyLane>(fundingLane);
  const [amount, setAmount] = useState(remaining);
  const [slipPhotos, setSlipPhotos] = useState<PhotoItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const idempotencyKey = useRef(newIdempotencyKey());
  const uploadSlip = (dataB64: string, contentType: string) => uploadMedia(dataB64, contentType, 'refund_slip');

  const readySlipIds = slipPhotos.filter((p) => !p.busy).map((p) => p.uploadId);
  const uploadBusy = slipPhotos.some((p) => p.busy);

  async function submit() {
    setError('');
    const amt = amount.trim();
    if (!AMOUNT_RE.test(amt) || Number(amt) <= 0) return setError('กรอกจำนวนเงินให้ถูกต้อง');
    if (lane === 'transfer' && readySlipIds.length === 0) return setError('ต้องแนบสลิปก่อนบันทึก');
    setBusy(true);
    try {
      await refundAdvance(requestId, {
        lane,
        amount: amt,
        transferSlipUploadId: readySlipIds[0],
        transferSlipUploadIds: readySlipIds,
        idempotencyKey: idempotencyKey.current,
      });
      onDone('บันทึกคืนเงินแล้ว');
    } catch (err) {
      setError(describeMoneyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 pt-2 border-t border-slate-100 mt-2">
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setLane('cash')}
          className={`min-h-[40px] rounded-lg border text-sm font-semibold ${lane === 'cash' ? 'bg-amber-600 border-amber-600 text-white' : 'border-slate-300 text-slate-600'}`}
        >
          จ่ายสด
        </button>
        <button
          onClick={() => setLane('transfer')}
          className={`min-h-[40px] rounded-lg border text-sm font-semibold ${lane === 'transfer' ? 'bg-amber-600 border-amber-600 text-white' : 'border-slate-300 text-slate-600'}`}
        >
          โอนเงิน
        </button>
      </div>
      <input
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="จำนวนเงินที่คืน"
        className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
      />
      {lane === 'transfer' && (
        <div>
          <div className="text-xs font-semibold text-slate-500 mb-1.5">สลิปรับเงินคืน (จำเป็น)</div>
          <PhotoListUpload items={slipPhotos} onChange={setSlipPhotos} upload={uploadSlip} compact />
        </div>
      )}
      {error && (
        <div className="flex items-center gap-1 text-rose-600 text-xs">
          <AlertTriangle size={12} /> {error}
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={submit}
          disabled={busy || uploadBusy}
          className="flex-1 min-h-[40px] rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : 'บันทึกคืนเงิน'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-3 min-h-[40px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
        >
          ยกเลิก
        </button>
      </div>
    </div>
  );
}
