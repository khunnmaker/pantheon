import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Loader2,
  AlertTriangle,
  X,
  Send,
  ChevronLeft,
  Wallet,
  Receipt,
  ShoppingCart,
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
  type DuplicateReceipt,
} from './lib/api';
import { useMediaUrl } from './lib/media';
import { downscaleImage } from './lib/image';
import { useCeres } from './lib/bootstrapContext';
import CategoryPicker, { groupByCategoryGroup } from './components/CategoryPicker';

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

const TYPE_META: Record<V2RequestType, { label: string; sub: string; icon: React.ReactNode }> = {
  advance: { label: 'เบิกล่วงหน้า', sub: 'รับเงินไปใช้ล่วงหน้า', icon: <Wallet size={26} /> },
  reimbursement: { label: 'สำรองจ่าย-ขอคืน', sub: 'จ่ายไปก่อน แนบใบเสร็จขอคืนเงิน', icon: <Receipt size={26} /> },
  purchase: { label: 'ขอให้ซื้อ', sub: 'ให้บริษัทช่วยซื้อของให้', icon: <ShoppingCart size={26} /> },
};

function purposeFor(type: V2RequestType): MediaPurpose {
  return type === 'reimbursement' ? 'reimbursement_receipt' : 'request_photo';
}

export default function RequestSheet({
  editing,
  onClose,
  onSaved,
}: {
  editing?: StaffRequest | null;
  onClose: () => void;
  onSaved: (request: StaffRequest) => void;
}) {
  const { bootstrap } = useCeres();
  const entities = bootstrap.entities.length ? bootstrap.entities : ['PROM', 'TONR', 'DENC', 'DENL', 'KPKF'];
  const categories = [...bootstrap.categories].filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder);
  // Distinct group labels in sortOrder (first-appearance), same order the two-stage
  // CategoryPicker shows its group chips in — advance's multi-select row reuses it.
  const groupOptions = groupByCategoryGroup(categories).map((g) => g.group);

  const [step, setStep] = useState<'type' | 'form'>(editing ? 'form' : 'type');
  const [requestType, setRequestType] = useState<V2RequestType>(editing?.requestType ?? 'advance');

  // NO lazy defaults (owner rule, 2026-07-18) — entity/category start empty for a NEW
  // request; only an edit of an existing request pre-fills its own prior values.
  const [entity, setEntity] = useState(editing?.entity || '');
  const [categoryId, setCategoryId] = useState(() => {
    if (editing) {
      const match = categories.find((c) => c.name === editing.category);
      if (match) return match.id;
    }
    return '';
  });
  // Advance-only multi-group selection. NO lazy default on a NEW advance (starts empty).
  // Editing an OLD advance (has a real category, empty categoryGroups) prefills the
  // group that category belongs to — the one CategoryPicker-style exception for a
  // pre-filled value (see components/CategoryPicker.tsx's own comment on this rule).
  const [categoryGroups, setCategoryGroups] = useState<string[]>(() => {
    if (editing?.requestType === 'advance') {
      if (editing.categoryGroups.length > 0) return editing.categoryGroups;
      const match = categories.find((c) => c.name === editing.category);
      if (match) return [match.group];
    }
    return [];
  });
  const [groupsError, setGroupsError] = useState('');
  const [amount, setAmount] = useState(editing?.amount || '');
  const [amountError, setAmountError] = useState('');
  const [reason, setReason] = useState(editing?.reason || '');

  const [photoUploadId, setPhotoUploadId] = useState<string | null>(editing?.requestPhotoUploadId ?? null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const existingPreview = useMediaUrl(!localPreview && editing ? editing.requestPhotoUploadId : null);
  const photoPreview = localPreview ?? existingPreview;
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateReceipt | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedCategory = categories.find((c) => c.id === categoryId) || null;
  const meta = TYPE_META[requestType];

  const mountedRef = useRef(false);
  useEffect(() => {
    // Switching type after a photo was already staged for the OLD purpose clears it —
    // the server validates purpose against requestType, so a stale upload would fail.
    // Skip the very first run (mount) so an editing request's existing photo survives.
    if (mountedRef.current) {
      setPhotoUploadId(null);
      setLocalPreview(null);
      setOcr(null);
      setDuplicate(null);
      setUploadError('');
    }
    mountedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestType]);

  async function handleFile(file: File) {
    setUploadError('');
    setUploadBusy(true);
    setDuplicate(null);
    try {
      const { dataB64, contentType } = await downscaleImage(file);
      const result = await uploadMedia(dataB64, contentType, purposeFor(requestType));
      setLocalPreview(`data:${contentType};base64,${dataB64}`);
      setPhotoUploadId(result.uploadId);
      setOcr(result.ocr);
      setDuplicate(result.duplicate);
      if (result.ocr.amount && amount.trim() === '') setAmount(result.ocr.amount);
    } catch {
      setUploadError('อัปโหลดรูปไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setUploadBusy(false);
    }
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  }

  function toggleGroup(group: string) {
    setCategoryGroups((current) => (current.includes(group) ? current.filter((g) => g !== group) : [...current, group]));
    setGroupsError('');
  }

  function validate(): string {
    if (!AMOUNT_RE.test(amount.trim()) || Number(amount) <= 0) return 'invalid_amount';
    // Reason is optional for advance only — the precise detail comes at liquidation.
    if (requestType !== 'advance' && !reason.trim()) return 'missing_reason';
    if (!entity) return 'invalid_entity';
    if (requestType === 'advance') {
      if (categoryGroups.length === 0) return 'invalid_group';
    } else if (!selectedCategory) {
      return 'invalid_category';
    }
    if (requestType === 'reimbursement' && !photoUploadId) return 'missing_receipt';
    return '';
  }

  async function submit() {
    setSubmitError('');
    const problem = validate();
    if (problem) {
      setSubmitError(
        problem === 'invalid_amount'
          ? 'กรอกจำนวนเงินให้ถูกต้อง (มากกว่า 0)'
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
    if (requestType !== 'advance' && !selectedCategory) return;

    setSubmitBusy(true);
    try {
      const body = requestType === 'advance'
        ? {
            requestType,
            entity,
            categoryGroups,
            amount: amount.trim(),
            reason: reason.trim(),
            requestPhotoUploadId: photoUploadId,
          }
        : {
            requestType,
            entity,
            category: selectedCategory!.name,
            amount: amount.trim(),
            reason: reason.trim(),
            requestPhotoUploadId: photoUploadId,
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

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 sticky top-0 bg-white z-10">
          <div className="flex items-center gap-2">
            {step === 'form' && (
              <button
                onClick={() => setStep('type')}
                disabled={uploadBusy}
                aria-label="กลับไปเลือกประเภทคำขอ"
                className="text-slate-400 hover:text-slate-600 p-1 -ml-1 disabled:opacity-40"
              >
                <ChevronLeft size={20} />
              </button>
            )}
            <div className="font-semibold text-base">
              {step === 'type' ? 'ส่งคำขอเงิน' : editing ? `แก้ไข: ${meta.label}` : meta.label}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
            <X size={20} />
          </button>
        </div>

        {step === 'type' ? (
          <div className="p-4 space-y-2.5">
            {(Object.keys(TYPE_META) as V2RequestType[]).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setRequestType(t);
                  setStep('form');
                }}
                className="w-full min-h-[76px] rounded-2xl border-2 border-slate-200 hover:border-amber-400 hover:bg-amber-50 flex items-center gap-3 px-4 py-3 text-left transition-colors"
              >
                <div className="shrink-0 w-11 h-11 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center">
                  {TYPE_META[t].icon}
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-base">{TYPE_META[t].label}</div>
                  <div className="text-xs text-slate-500">{TYPE_META[t].sub}</div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="p-4 space-y-4">
              {/* Amount — primary input #1 */}
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

              {/* Reason — primary input #2 (optional for advance; the precise detail is
                  captured per-expense at liquidation instead) */}
              <div>
                <div className="text-xs font-semibold text-slate-500 mb-1.5">
                  {requestType === 'advance' ? 'เหตุผล (ไม่บังคับ)' : 'เหตุผล / รายละเอียด'}
                </div>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="เช่น ค่าน้ำมันไปส่งของ, ซื้ออุปกรณ์สำนักงาน"
                  rows={3}
                  className="w-full px-3 py-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none"
                />
              </div>

              {/* Photo — primary input #3 (required for reimbursement, optional otherwise) */}
              <div>
                <div className="text-xs font-semibold text-slate-500 mb-1.5">
                  {requestType === 'reimbursement' ? 'ใบเสร็จ (จำเป็น)' : 'รูปประกอบ (ถ้ามี)'}
                </div>
                {photoPreview ? (
                  <div className="relative">
                    <img
                      src={photoPreview}
                      alt="รูปแนบ"
                      className="w-full max-h-56 object-contain rounded-xl border border-slate-200 bg-slate-50"
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadBusy}
                      className="mt-2 w-full min-h-[48px] rounded-xl border border-slate-300 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
                    >
                      {uploadBusy ? 'กำลังอัปโหลด…' : 'ถ่ายรูปใหม่'}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadBusy}
                    className={`w-full min-h-[96px] rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-1.5 font-semibold disabled:opacity-60 ${
                      requestType === 'reimbursement'
                        ? 'border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800'
                        : 'border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-500'
                    }`}
                  >
                    {uploadBusy ? (
                      <>
                        <Loader2 className="animate-spin" size={22} />
                        <span className="text-sm">กำลังอัปโหลด…</span>
                      </>
                    ) : (
                      <>
                        <Camera size={24} />
                        <span>{requestType === 'reimbursement' ? 'ถ่ายรูปใบเสร็จ' : 'ถ่ายรูป / แนบรูป'}</span>
                      </>
                    )}
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={onFilePicked}
                />
                {uploadError && (
                  <div className="flex items-center gap-1 text-rose-600 text-xs mt-1.5">
                    <AlertTriangle size={12} /> {uploadError}
                  </div>
                )}
                {duplicate && (
                  <div className="mt-2 px-3 py-2.5 rounded-xl border border-rose-300 bg-rose-50 text-rose-700">
                    <div className="flex items-start gap-1.5 text-sm font-semibold">
                      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                      <span>รูปนี้ถูกใช้บันทึกไปแล้ว (ของ {duplicate.partyName} ฿{duplicate.amount})</span>
                    </div>
                  </div>
                )}
                {!photoPreview && requestType !== 'reimbursement' && (
                  <div className="flex items-center gap-1 text-xs text-slate-400 mt-1.5">
                    <ImageOff size={12} /> ไม่แนบรูปก็ส่งคำขอได้
                  </div>
                )}
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

              {/* Category — no default; explicit tap required. Advance replaces the
                  single-category picker with a multi-select GROUP chip row (Ceres
                  advance simplify, 2026-07-19): the requester only narrows down to
                  group(s); the exact category is picked per expense at liquidation. */}
              {requestType === 'advance' ? (
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
                disabled={submitBusy || uploadBusy}
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
