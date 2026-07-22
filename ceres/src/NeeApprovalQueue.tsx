import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ThumbsUp, X } from 'lucide-react';
import { ApiError, baht, listStaffRequests, neeDecision, type StaffRequest } from './lib/api';
import { REQUEST_TYPE_LABEL as TYPE_LABEL } from './lib/requestLabels';
import { useCeres } from './lib/bootstrapContext';
import { MediaThumbStrip } from './lib/media';
import { PayPanel } from './PayPanel';

function willForward(request: StaffRequest, threshold: number): boolean {
  return request.amountNum > threshold || request.aiScreenStatus !== 'clear';
}

export default function NeeApprovalQueue({
  highlightRequestId,
}: {
  // GM submit→approve bridge (Md.tsx's goToApprovalQueueWithRequest, 2026-07-21) — the
  // request a GM just submitted for themselves, jumped straight here from the ของฉัน tab.
  // Purely a visual highlight; the queue's own data/logic is untouched.
  highlightRequestId?: string | null;
} = {}) {
  const { bootstrap } = useCeres();
  const [rows, setRows] = useState<StaffRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [rejectingId, setRejectingId] = useState('');
  const [note, setNote] = useState('');
  const [success, setSuccess] = useState('');
  // "อนุมัติ = จ่าย" one-flow (owner directive, 2026-07-22): the id of the card currently
  // showing the inline lane question (จ่ายเงินสด / โอนเงิน / กลับ) instead of its normal
  // อนุมัติ/ไม่อนุมัติ footer. Tapping อนุมัติ on an eligible (non-forward) card ONLY sets
  // this — no API call yet, so the "กลับ" path back out is a true no-op. The actual
  // approve+pay call happens inside the shared PayPanel (mode="decideAndPay") once a lane
  // is picked. Single id (not a set) — same "one card interacts at a time" assumption
  // `rejectingId` already makes in this file.
  const [choosingLaneId, setChoosingLaneId] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    listStaffRequests('queue', 200)
      .then((result) => setRows(result.requests))
      .catch(() => setError('โหลดคิวอนุมัติไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => setSuccess(''), 3000);
    return () => clearTimeout(timer);
  }, [success]);

  // Scroll the GM's just-submitted request into view once the queue has loaded it.
  useEffect(() => {
    if (!highlightRequestId || loading) return;
    document.getElementById(`request-${highlightRequestId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightRequestId, loading, rows]);

  async function decide(request: StaffRequest, decision: 'approve' | 'reject') {
    if (decision === 'reject' && !note.trim()) {
      setError('กรอกเหตุผลที่ไม่อนุมัติ');
      return;
    }
    setBusyId(request.id);
    setError('');
    try {
      const result = await neeDecision(request.id, decision, note.trim() || undefined);
      setRows((current) => current.filter((row) => row.id !== request.id));
      setRejectingId('');
      setNote('');
      if (decision === 'reject') setSuccess('บันทึกว่าไม่อนุมัติแล้ว');
      else if (result.request.approvalStatus === 'pending_ceo') setSuccess('อนุมัติแล้วส่งต่อ CEO');
      else setSuccess('อนุมัติแล้ว');
    } catch (err) {
      setError(err instanceof ApiError && err.message === 'ai_review_pending'
        ? 'AI ยังตรวจคำขอนี้ไม่เสร็จ กรุณารอสักครู่แล้วโหลดใหม่'
        : 'บันทึกผลไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setBusyId('');
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div>
          <h2 className="text-lg font-bold">คำขอรอ GM อนุมัติ</h2>
          <p className="text-xs text-slate-400">ตรวจทุกคำขอก่อนส่งต่อหรืออนุมัติ</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          aria-label="โหลดคิวใหม่"
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
        <div className="py-10 flex justify-center text-slate-400"><Loader2 className="animate-spin" size={22} /></div>
      ) : rows.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-10 bg-white rounded-xl border border-slate-200">ไม่มีคำขอรออนุมัติ</div>
      ) : (
        <div className="space-y-3">
          {rows.map((request) => {
            const forward = willForward(request, bootstrap.ceoThreshold);
            const aiPending = request.aiScreenStatus === 'pending';
            const ocrMismatch = !!request.ocr.amount && Number(request.ocr.amount) !== request.amountNum;
            const duplicate = /รูปเดียวกัน|หลักฐาน.*ซ้ำ|ใบเสร็จซ้ำ/.test(request.aiReview?.reasoning ?? '');
            const highlighted = highlightRequestId === request.id;
            return (
              <article
                key={request.id}
                id={`request-${request.id}`}
                className={`bg-white rounded-xl border p-3 ${
                  highlighted ? 'border-amber-400 ring-2 ring-amber-300 ring-offset-1' : 'border-slate-200'
                }`}
              >
                {highlighted && (
                  <div className="mb-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-xs font-semibold">
                    คำขอที่คุณเพิ่งส่ง
                  </div>
                )}
                <div className="flex items-start gap-3">
                  <MediaThumbStrip ids={request.requestPhotoUploadIds} size={72} alt="หลักฐานคำขอ" rounded="rounded-xl" />
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
                  </div>
                </div>

                <div className="mt-2 text-sm text-slate-700 break-words">{request.reason}</div>

                {(ocrMismatch || duplicate) && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {duplicate && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-100 text-rose-700 text-xs font-medium">
                        <AlertTriangle size={12} /> พบหลักฐานซ้ำ
                      </span>
                    )}
                    {ocrMismatch && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-100 text-amber-700 text-xs font-medium">
                        <AlertTriangle size={12} /> OCR อ่านยอดได้ ฿{request.ocr.amount}
                      </span>
                    )}
                  </div>
                )}

                {/* Advances skip the AI screen entirely (Ceres advance simplify,
                    2026-07-19) — no aiReview/aiReviewId is ever set for them, so this
                    block renders nothing rather than a misleading "no AI explanation"
                    fallback. */}
                {request.requestType !== 'advance' && (
                  <div className="mt-2 px-3 py-2.5 rounded-xl bg-sky-50 border border-sky-200 text-xs text-sky-900">
                    <div className="font-semibold mb-0.5">เหตุผลจาก AI</div>
                    {request.aiReview?.reasoning || (request.aiScreenStatus === 'pending' ? 'กำลังตรวจคำขอ' : 'ไม่พบคำอธิบายจาก AI — ส่งต่อเพื่อความปลอดภัย')}
                  </div>
                )}

                {choosingLaneId === request.id ? (
                  // "อนุมัติ = จ่าย" one-flow (owner directive, 2026-07-22) — request is
                  // STILL pending_nee here; nothing was committed by opening this panel.
                  // The lane tap itself drives the composite decide-and-pay call.
                  <PayPanel
                    request={request}
                    mode="decideAndPay"
                    onDone={(msg) => {
                      setChoosingLaneId('');
                      setRows((current) => current.filter((row) => row.id !== request.id));
                      setSuccess(msg);
                    }}
                    onCancel={() => setChoosingLaneId('')}
                  />
                ) : (
                  <>
                    {aiPending && (
                      <div className="mt-2 text-xs font-semibold text-amber-700">
                        รอ AI ตรวจเสร็จก่อน จึงจะอนุมัติหรือไม่อนุมัติได้
                      </div>
                    )}

                    {forward && (
                      <div className="mt-2 px-3 py-2 rounded-xl bg-violet-50 border border-violet-200 text-violet-700 text-xs font-semibold">
                        เมื่อกดอนุมัติ: อนุมัติแล้วส่งต่อ CEO
                      </div>
                    )}

                    {rejectingId === request.id ? (
                      <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
                        <textarea
                          value={note}
                          onChange={(event) => setNote(event.target.value)}
                          placeholder="เหตุผลที่ไม่อนุมัติ (จำเป็น)"
                          rows={2}
                          autoFocus
                          className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm resize-none"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => decide(request, 'reject')}
                            disabled={busyId === request.id || aiPending || !note.trim()}
                            className="flex-1 min-h-[42px] rounded-lg bg-rose-600 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
                          >
                            {busyId === request.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} ยืนยันไม่อนุมัติ
                          </button>
                          <button
                            onClick={() => { setRejectingId(''); setNote(''); }}
                            disabled={busyId === request.id}
                            className="px-4 min-h-[42px] rounded-lg border border-slate-300 text-slate-600 text-sm"
                          >
                            กลับ
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex gap-2 mt-3 pt-3 border-t border-slate-100">
                        <button
                          onClick={() => (forward ? decide(request, 'approve') : setChoosingLaneId(request.id))}
                          disabled={busyId === request.id || aiPending}
                          className="flex-1 min-h-[44px] rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
                        >
                          {busyId === request.id ? <Loader2 size={14} className="animate-spin" /> : <ThumbsUp size={14} />} {forward ? 'อนุมัติและส่งต่อ' : 'อนุมัติ'}
                        </button>
                        <button
                          onClick={() => { setRejectingId(request.id); setNote(''); }}
                          disabled={busyId === request.id || aiPending}
                          className="flex-1 min-h-[44px] rounded-lg border border-rose-300 text-rose-600 text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
                        >
                          <X size={14} /> ไม่อนุมัติ
                        </button>
                      </div>
                    )}
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
