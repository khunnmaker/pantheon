import { useEffect, useRef, useState } from 'react';
import {
  Loader2,
  AlertTriangle,
  X,
  Send,
  ChevronLeft,
  Wallet,
  Receipt,
  ShoppingBag,
  Building2,
  ImageOff,
} from 'lucide-react';
import {
  createStaffRequest,
  editStaffRequest,
  uploadMedia,
  type StaffRequest,
  type V2RequestType,
  type MediaPurpose,
  type OcrResult,
} from './lib/api';
import {
  advanceVariantOfKind,
  REQUEST_KIND_HINT,
  REQUEST_KIND_LABEL,
  REQUEST_KIND_ORDER,
  requestKindOf,
  requestTypeOfKind,
  type RequestKind,
} from './lib/requestLabels';
import { useCeres } from './lib/bootstrapContext';
import CategoryPicker, { groupByCategoryGroup } from './components/CategoryPicker';
import PhotoListUpload, { type PhotoItem } from './lib/PhotoListUpload';

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

// 4-button request chooser (owner-confirmed design, 2026-07-23) — replaces the old 2-button
// front door + payer toggle (2026-07-21). Every kind is a real, separately-named button now;
// เบิกเงินไปซื้อ rides the advance machinery (advanceVariant 'purchase') but is presented and
// validated as its own kind throughout this sheet. See lib/requestLabels.ts for the
// (requestType, advanceVariant) ↔ RequestKind mapping shared with every other screen.
const KIND_ICON: Record<RequestKind, React.ReactNode> = {
  advance: <Wallet size={24} />,
  reimbursement: <Receipt size={24} />,
  advance_purchase: <ShoppingBag size={24} />,
  purchase: <Building2 size={24} />,
};

function purposeFor(kind: RequestKind | null): MediaPurpose {
  return kind === 'reimbursement' ? 'reimbursement_receipt' : 'request_photo';
}

// Minimal prefill payload for MdTemplates's "สร้างคำขอจ่าย" button (v1 purge, 2026-07-19 —
// see docs/CERES_V1_PURGE_PLAN.md Phase B item 5). Only amount/category/reason carry over
// from the recurring template; the kind is forced to 'purchase' (ขอให้บริษัทซื้อ) by the
// caller passing this prop. `category` is the category NAME (matches Category.name, like
// editing.category).
export interface RequestSheetPrefill {
  amount: string;
  category: string;
  reason: string;
}

export default function RequestSheet({
  editing,
  prefill,
  onClose,
  onSaved,
}: {
  editing?: StaffRequest | null;
  // Absent for the normal staff flow — when omitted, every prefill-derived default below
  // falls back to the exact same value it had before this prop existed (no lazy defaults
  // reintroduced; owner rule, 2026-07-18).
  prefill?: RequestSheetPrefill | null;
  onClose: () => void;
  onSaved: (request: StaffRequest) => void;
}) {
  const { bootstrap } = useCeres();
  const entities = bootstrap.entities.length ? bootstrap.entities : ['PROM', 'TONR', 'DENC', 'DENL', 'KPKF'];
  const categories = [...bootstrap.categories].filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder);
  // Distinct group labels in sortOrder (first-appearance), same order the two-stage
  // CategoryPicker shows its group chips in — the float advance's multi-select row reuses it.
  const groupOptions = groupByCategoryGroup(categories).map((g) => g.group);

  const [step, setStep] = useState<'type' | 'form'>(editing || prefill ? 'form' : 'type');
  // `kind` is the ONE source of truth for which of the 4 buttons is active — every wire-level
  // (requestType, advanceVariant) pair derives from it via lib/requestLabels.ts's helpers.
  // Editing an existing request derives its starting kind straight from the stored row; a
  // template prefill always forces 'purchase' (ขอให้บริษัทซื้อ, unchanged from before this
  // redesign); a brand-new request starts with NO kind chosen — tapping one of the 4 buttons
  // is a required explicit tap (owner "no lazy defaults" rule), same as the old front door.
  const [kind, setKind] = useState<RequestKind | null>(() => {
    if (editing) return requestKindOf(editing.requestType, editing.advanceVariant);
    if (prefill) return 'purchase';
    return null;
  });

  // NO lazy defaults (owner rule, 2026-07-18) — entity/category start empty for a NEW
  // request; only an edit of an existing request pre-fills its own prior values. A
  // template prefill does NOT fill entity either (plan only names amount/category/reason)
  // — the requester still taps their company explicitly.
  const [entity, setEntity] = useState(editing?.entity || '');
  const [categoryId, setCategoryId] = useState(() => {
    if (editing) {
      const match = categories.find((c) => c.name === editing.category);
      if (match) return match.id;
    } else if (prefill) {
      const match = categories.find((c) => c.name === prefill.category);
      if (match) return match.id;
    }
    return '';
  });
  // Float-advance-only multi-group selection. NO lazy default on a NEW advance (starts
  // empty). Editing an OLD float advance (has a real category, empty categoryGroups)
  // prefills the group that category belongs to — the one CategoryPicker-style exception
  // for a pre-filled value (see components/CategoryPicker.tsx's own comment on this rule).
  const [categoryGroups, setCategoryGroups] = useState<string[]>(() => {
    if (editing?.requestType === 'advance' && !editing.advanceVariant) {
      if (editing.categoryGroups.length > 0) return editing.categoryGroups;
      const match = categories.find((c) => c.name === editing.category);
      if (match) return [match.group];
    }
    return [];
  });
  const [groupsError, setGroupsError] = useState('');
  const [amount, setAmount] = useState(editing?.amount || prefill?.amount || '');
  const [amountError, setAmountError] = useState('');
  const [reason, setReason] = useState(editing?.reason || prefill?.reason || '');

  // Seeded from the row's array field on edit (fallback to the singular id for legacy rows —
  // see api.ts's StaffRequest.requestPhotoUploadIds doc). No `preview` on seeded items — they
  // render via MediaThumb-by-id inside PhotoListUpload, same as any other already-saved image.
  const [photos, setPhotos] = useState<PhotoItem[]>(() => {
    if (!editing) return [];
    const ids = editing.requestPhotoUploadIds?.length ? editing.requestPhotoUploadIds : editing.requestPhotoUploadId ? [editing.requestPhotoUploadId] : [];
    return ids.map((uploadId) => ({ uploadId }));
  });
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  // Only the FIRST photo that yields an OCR amount is ever considered for the amount-prefill
  // decision (and only prefills if the field is still empty at that moment) — later photos'
  // OCR results are ignored for prefill purposes even if the field is still empty.
  const ocrPrefillDone = useRef(false);

  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const selectedCategory = categories.find((c) => c.id === categoryId) || null;
  // Header/title label — the picked kind's real name (no more generic placeholder while a
  // toggle resolves it, since every kind is now its own button).
  const headerLabel = kind ? REQUEST_KIND_LABEL[kind] : 'ส่งคำขอเงิน';

  const mountedRef = useRef(false);
  useEffect(() => {
    // Switching kind after photos were already staged for the OLD purpose clears them — the
    // server validates purpose against requestType, so stale uploads would fail. Skip the
    // very first run (mount) so an editing request's existing photos survive.
    if (mountedRef.current) {
      setPhotos([]);
      setOcr(null);
      ocrPrefillDone.current = false;
    }
    mountedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const uploadPhoto = (dataB64: string, contentType: string) => uploadMedia(dataB64, contentType, purposeFor(kind));

  function handleOcr(o: OcrResult) {
    if (ocrPrefillDone.current || !o.amount) return;
    ocrPrefillDone.current = true;
    setOcr(o);
    setAmount((current) => (current.trim() === '' ? o.amount : current));
  }

  function toggleGroup(group: string) {
    setCategoryGroups((current) => (current.includes(group) ? current.filter((g) => g !== group) : [...current, group]));
    setGroupsError('');
  }

  function validate(): string {
    if (!AMOUNT_RE.test(amount.trim()) || Number(amount) <= 0) return 'invalid_amount';
    if (!kind) return 'invalid_kind';
    // Reason is optional for the plain float advance only — the precise detail comes at
    // liquidation. Every other kind (reimbursement, purchase, and เบิกเงินไปซื้อ) requires it.
    if (kind !== 'advance' && !reason.trim()) return 'missing_reason';
    if (!entity) return 'invalid_entity';
    if (kind === 'advance') {
      if (categoryGroups.length === 0) return 'invalid_group';
    } else if (!selectedCategory) {
      return 'invalid_category';
    }
    if (kind === 'reimbursement' && photos.length === 0) return 'missing_receipt';
    return '';
  }

  async function submit() {
    setSubmitError('');
    const problem = validate();
    if (problem) {
      setSubmitError(
        problem === 'invalid_amount'
          ? 'กรอกจำนวนเงินให้ถูกต้อง (มากกว่า 0)'
          : problem === 'invalid_kind'
            ? 'กรุณาเลือกประเภทคำขอ'
            : problem === 'missing_reason'
              ? 'กรุณากรอกเหตุผล'
              : problem === 'invalid_entity'
                ? 'กรุณาเลือกบริษัท'
                : problem === 'invalid_category'
                  ? 'กรุณาเลือกหมวดหมู่'
                  : problem === 'invalid_group'
                    ? 'เลือกกลุ่มอย่างน้อย 1 กลุ่ม'
                    : 'กรุณาถ่ายรูปใบเสร็จก่อนส่งคำขอ',
      );
      if (problem === 'invalid_amount') setAmountError('กรอกจำนวนเงินให้ถูกต้อง');
      if (problem === 'invalid_group') setGroupsError('เลือกกลุ่มอย่างน้อย 1 กลุ่ม');
      return;
    }
    if (kind !== 'advance' && !selectedCategory) return;
    // Guaranteed non-null past validate() above.
    const finalKind = kind!;
    const finalType: V2RequestType = requestTypeOfKind(finalKind);

    setSubmitBusy(true);
    try {
      const readyPhotos = photos.filter((p) => !p.busy);
      const requestPhotoUploadIds = readyPhotos.map((p) => p.uploadId);
      const requestPhotoUploadId = requestPhotoUploadIds[0] ?? null;
      const body = finalKind === 'advance'
        ? {
            requestType: finalType,
            advanceVariant: null,
            entity,
            categoryGroups,
            amount: amount.trim(),
            reason: reason.trim(),
            requestPhotoUploadId,
            requestPhotoUploadIds,
          }
        : finalKind === 'advance_purchase'
          ? {
              requestType: finalType,
              advanceVariant: advanceVariantOfKind(finalKind),
              entity,
              category: selectedCategory!.name,
              amount: amount.trim(),
              reason: reason.trim(),
              requestPhotoUploadId,
              requestPhotoUploadIds,
            }
          : {
              requestType: finalType,
              entity,
              category: selectedCategory!.name,
              amount: amount.trim(),
              reason: reason.trim(),
              requestPhotoUploadId,
              requestPhotoUploadIds,
            };
      const result = editing
        ? await editStaffRequest(editing.id, body)
        : await createStaffRequest(body);
      onSaved(result.request);
      onClose();
    } catch {
      setSubmitError('ส่งคำขอไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setSubmitBusy(false);
    }
  }

  const ocrDiffers = !!ocr?.amount && Number(ocr.amount) !== Number(amount);
  const photosBusy = photos.some((p) => p.busy);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 sticky top-0 bg-white z-10">
          <div className="flex items-center gap-2">
            {step === 'form' && (
              <button
                onClick={() => setStep('type')}
                disabled={photosBusy}
                aria-label="กลับไปเลือกประเภทคำขอ"
                className="text-slate-400 hover:text-slate-600 p-1 -ml-1 disabled:opacity-40"
              >
                <ChevronLeft size={20} />
              </button>
            )}
            <div className="font-semibold text-base">
              {step === 'type' ? 'ส่งคำขอเงิน' : editing ? `แก้ไข: ${headerLabel}` : headerLabel}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
            <X size={20} />
          </button>
        </div>

        {step === 'type' ? (
          <div className="p-4 grid grid-cols-2 gap-2.5">
            {REQUEST_KIND_ORDER.map((k) => (
              <button
                key={k}
                onClick={() => {
                  setKind(k);
                  setStep('form');
                }}
                className="min-h-[124px] rounded-2xl border-2 border-slate-200 hover:border-amber-400 hover:bg-amber-50 flex flex-col items-center justify-center gap-1.5 px-3 py-3 text-center transition-colors"
              >
                <div className="shrink-0 w-11 h-11 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center">
                  {KIND_ICON[k]}
                </div>
                <div className="font-bold text-sm">{REQUEST_KIND_LABEL[k]}</div>
                <div className="text-xs text-slate-500 leading-snug">{REQUEST_KIND_HINT[k]}</div>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="p-4 space-y-4">
              {/* Photo — primary input #1 (required for reimbursement, optional otherwise —
                  including เบิกเงินไปซื้อ, which is optional at submit even though its reason
                  and category are required) */}
              <div>
                <div className="text-xs font-semibold text-slate-500 mb-1.5">
                  {kind === 'reimbursement' ? 'ใบเสร็จ (จำเป็น)' : 'รูปประกอบ (ถ้ามี)'}
                </div>
                <PhotoListUpload items={photos} onChange={setPhotos} upload={uploadPhoto} onOcr={handleOcr} />
                {photos.length === 0 && kind !== 'reimbursement' && (
                  <div className="flex items-center gap-1 text-xs text-slate-400 mt-1.5">
                    <ImageOff size={12} /> ไม่แนบรูปก็ส่งคำขอได้
                  </div>
                )}
              </div>

              {/* Amount — primary input #2 */}
              <div>
                <div className="text-xs font-semibold text-slate-500 mb-1.5">จำนวนเงิน</div>
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setAmountError('');
                  }}
                  placeholder="0.00"
                  className="w-full px-3 py-3 rounded-xl border border-slate-300 text-2xl font-bold focus:outline-none focus:ring-2 focus:ring-amber-400 min-h-[56px]"
                />
                {amountError && (
                  <div className="flex items-center gap-1 text-rose-600 text-xs mt-1">
                    <AlertTriangle size={12} /> {amountError}
                  </div>
                )}
                {ocrDiffers && <div className="text-xs text-amber-700 mt-1">AI อ่านได้ ฿{ocr?.amount}</div>}
              </div>

              {/* Reason — primary input #3 (optional for the plain float advance only; the
                  precise detail is captured per-expense at liquidation instead) */}
              <div>
                <div className="text-xs font-semibold text-slate-500 mb-1.5">
                  {kind === 'advance' ? 'เหตุผล (ไม่บังคับ)' : 'เหตุผล / รายละเอียด'}
                </div>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="เช่น ค่าน้ำมันไปส่งของ, ซื้ออุปกรณ์สำนักงาน"
                  rows={3}
                  className="w-full px-3 py-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none"
                />
              </div>

              {/* Entity — no default; explicit tap required */}
              <div>
                <div className="text-xs font-semibold text-slate-500 mb-1.5">บริษัท</div>
                <div className="grid grid-cols-3 gap-2">
                  {entities.map((e) => (
                    <button
                      key={e}
                      onClick={() => setEntity(e)}
                      className={`min-h-[44px] rounded-xl border text-sm font-semibold ${
                        entity === e ? 'bg-amber-600 border-amber-600 text-white' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>

              {/* Category — no default; explicit tap required. Only the plain float advance
                  replaces the single-category picker with a multi-select GROUP chip row
                  (Ceres advance simplify, 2026-07-19): the requester only narrows down to
                  group(s); the exact category is picked per expense at liquidation.
                  เบิกเงินไปซื้อ (advance + variant 'purchase') uses the normal single-category
                  picker instead, like reimbursement/purchase — it prefills the liquidation
                  expense's category, unlike a float advance's group-only selection. */}
              {kind === 'advance' ? (
                <div>
                  <div className="text-xs font-semibold text-slate-500 mb-1.5">กลุ่มหมวดหมู่</div>
                  <div className="flex flex-wrap gap-2">
                    {groupOptions.map((group) => (
                      <button
                        key={group}
                        type="button"
                        onClick={() => toggleGroup(group)}
                        className={`px-3 py-2 rounded-full text-sm font-semibold border min-h-[40px] ${
                          categoryGroups.includes(group)
                            ? 'bg-amber-100 border-amber-300 text-amber-800'
                            : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {group}
                      </button>
                    ))}
                  </div>
                  <div className="text-xs text-slate-400 mt-1.5">เลือกได้มากกว่า 1 กลุ่ม</div>
                  {groupsError && (
                    <div className="flex items-center gap-1 text-rose-600 text-xs mt-1">
                      <AlertTriangle size={12} /> {groupsError}
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div className="text-xs font-semibold text-slate-500 mb-1.5">หมวดหมู่</div>
                  <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} />
                </div>
              )}

              {submitError && (
                <div className="flex items-center gap-1 text-rose-600 text-sm">
                  <AlertTriangle size={14} /> {submitError}
                </div>
              )}
            </div>

            <div className="sticky bottom-0 bg-white border-t border-slate-100 p-4">
              <button
                onClick={submit}
                disabled={submitBusy || photosBusy}
                className="w-full min-h-[52px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-base font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {submitBusy ? (
                  <>
                    <Loader2 className="animate-spin" size={18} /> กำลังตรวจ…
                  </>
                ) : (
                  <>
                    <Send size={18} /> {editing ? 'บันทึกการแก้ไข' : 'ส่งคำขอ'}
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
