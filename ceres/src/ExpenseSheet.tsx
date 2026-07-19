import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, AlertTriangle, X, Check, ImageOff } from 'lucide-react';
import { ApiError, createExpense, updateExpense, uploadReceipt, type Expense, type OcrResult, type DuplicateReceipt } from './lib/api';
import { downscaleImage } from './lib/image';
import { useCeres } from './lib/bootstrapContext';
import CategoryPicker from './components/CategoryPicker';

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

export default function ExpenseSheet({
  editing,
  partyId,
  advanceRequestId,
  defaultEntity,
  defaultCategory,
  onClose,
  onSaved,
}: {
  editing: Expense | null;
  partyId?: string; // required for gm/ceo creating on behalf of a party
  // Set when this entry LIQUIDATES a paid advance request (Ceres revamp Phase 3) — the
  // receipt becomes mandatory (no "no receipt" escape hatch) and the server links the
  // expense back to the advance via CeresExpense.advanceRequestId. See
  // api/src/routes/ceres/p1.ts POST /api/ceres/expenses.
  advanceRequestId?: string;
  defaultEntity?: string;
  defaultCategory?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { bootstrap } = useCeres();
  const entities = bootstrap.entities.length ? bootstrap.entities : ['PROM', 'TONR', 'DENC', 'DENL', 'KPKF'];
  const categories = [...bootstrap.categories].filter((c) => c.active).sort((a, b) => a.sortOrder - b.sortOrder);
  const isLiquidation = !!advanceRequestId;

  // NO lazy default (owner rule, 2026-07-18) — only editing or an explicit defaultEntity
  // (e.g. advance-liquidation prefill) pre-fills; otherwise starts empty for an explicit tap.
  const [entity, setEntity] = useState(editing?.entity || defaultEntity || '');
  const [categoryId, setCategoryId] = useState(() => {
    const wantName = editing?.category || defaultCategory;
    if (!wantName) return '';
    const match = categories.find((c) => c.name === wantName);
    return match?.id ?? '';
  });
  const [customerNote, setCustomerNote] = useState(editing?.customerNote || '');
  const [note, setNote] = useState(editing?.note || '');
  const [amount, setAmount] = useState(editing?.amount || '');
  const [amountError, setAmountError] = useState('');

  const [receiptUploadId, setReceiptUploadId] = useState<string | null>(editing?.receiptUploadId ?? null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(editing?.receiptUrl ?? null);
  const [ocr, setOcr] = useState<OcrResult | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateReceipt | null>(null);
  const [noReceiptConfirming, setNoReceiptConfirming] = useState(false);
  const [noReceipt, setNoReceipt] = useState(!isLiquidation && !!editing && !editing.receiptUploadId);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');

  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(''), 2500);
    return () => clearTimeout(t);
  }, [successMsg]);

  const selectedCategory = categories.find((c) => c.id === categoryId) || null;

  async function handleFile(file: File) {
    setUploadError('');
    setUploadBusy(true);
    setDuplicate(null);
    try {
      const { dataB64, contentType } = await downscaleImage(file);
      setReceiptPreview(`data:${contentType};base64,${dataB64}`);
      const result = await uploadReceipt(dataB64, contentType);
      setReceiptUploadId(result.uploadId);
      setOcr(result.ocr);
      setDuplicate(result.duplicate);
      setNoReceipt(false);
      // prefill amount from OCR ONLY if the field is currently empty
      if (result.ocr.amount && amount.trim() === '') {
        setAmount(result.ocr.amount);
      }
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

  function validate(): string {
    if (!AMOUNT_RE.test(amount.trim()) || Number(amount) <= 0) return 'invalid_amount';
    if (!entity) return 'invalid_entity';
    if (!selectedCategory) return 'invalid_category';
    if (selectedCategory.needsCustomerNote && !customerNote.trim()) return 'missing_customer_note';
    if (!receiptUploadId && (isLiquidation || !noReceipt)) return 'missing_receipt';
    return '';
  }

  async function submit() {
    setSubmitError('');
    const amt = amount.trim();
    if (!AMOUNT_RE.test(amt) || Number(amt) <= 0) {
      setAmountError('กรอกจำนวนเงินให้ถูกต้อง (มากกว่า 0)');
      return;
    }
    setAmountError('');
    const problem = validate();
    if (problem) {
      setSubmitError(
        problem === 'invalid_entity'
          ? 'กรุณาเลือกบริษัท'
          : problem === 'invalid_category'
            ? 'กรุณาเลือกหมวดหมู่'
            : problem === 'missing_customer_note'
              ? 'กรุณากรอกชื่อลูกค้า'
              : problem === 'missing_receipt'
                ? isLiquidation
                  ? 'กรุณาถ่ายรูปใบเสร็จ (จำเป็นสำหรับรายการหักเงินเบิก)'
                  : 'กรุณาถ่ายรูปใบเสร็จ หรือยืนยันว่าไม่มีใบเสร็จ'
                : 'กรอกจำนวนเงินให้ถูกต้อง',
      );
      return;
    }
    if (!selectedCategory) return;

    setSubmitBusy(true);
    try {
      const body = {
        entity,
        category: selectedCategory.name,
        customerNote: customerNote.trim() || undefined,
        amount: amt,
        receiptUploadId: receiptUploadId ?? undefined,
        note: note.trim() || undefined,
        ...(partyId ? { partyId } : {}),
        ...(advanceRequestId ? { advanceRequestId } : {}),
      };
      if (editing) {
        await updateExpense(editing.id, body);
      } else {
        await createExpense(body);
      }
      setSuccessMsg('บันทึกเรียบร้อย');
      onSaved();
      onClose();
    } catch (err) {
      const code = err instanceof ApiError && typeof (err.body as { error?: string })?.error === 'string'
        ? (err.body as { error: string }).error
        : '';
      const known: Record<string, string> = {
        media_not_owned: 'รูปใบเสร็จใช้กับรายการนี้ไม่ได้ กรุณาถ่ายรูปใหม่อีกครั้ง',
        receipt_required: 'ต้องแนบใบเสร็จสำหรับรายการหักเงินเบิก',
        advance_not_paid: 'เบิกล่วงหน้านี้ยังไม่ถูกจ่ายเงิน จึงยังบันทึกค่าใช้จ่ายไม่ได้',
        not_yours: 'รายการเบิกนี้ไม่ใช่ของบัญชีที่ล็อกอินอยู่',
        no_party: 'บัญชีนี้ยังไม่ถูกผูกกับรายชื่อพนักงานเบิกเงิน แจ้ง GM ให้ตรวจสอบ',
        invalid_advance: 'ไม่พบรายการเบิกล่วงหน้าที่อ้างถึง ลองปิดแล้วเปิดหน้านี้ใหม่',
        invalid_amount: 'จำนวนเงินไม่ถูกต้อง',
      };
      setSubmitError(known[code] ?? `บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง${code ? ` (${code})` : ''}`);
    } finally {
      setSubmitBusy(false);
    }
  }

  // Numeric compare so "12" vs "12.00" doesn't flag a spurious mismatch.
  const ocrDiffers = !!ocr?.amount && Number(ocr.amount) !== Number(amount);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-end sm:items-center justify-center">
      <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 sticky top-0 bg-white z-10">
          <div className="font-semibold text-base">
            {editing ? 'แก้ไขค่าใช้จ่าย' : isLiquidation ? 'เพิ่มค่าใช้จ่ายเบิก' : 'บันทึกค่าใช้จ่าย'}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
            <X size={20} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {isLiquidation && (
            <div className="px-3 py-2.5 rounded-xl bg-sky-50 border border-sky-200 text-sky-900 text-xs">
              รายการนี้จะหักออกจากยอดเงินเบิกล่วงหน้าที่ค้างอยู่ — ต้องแนบใบเสร็จทุกครั้ง
            </div>
          )}
          {/* Photo step */}
          <div>
            <div className="text-xs font-semibold text-slate-500 mb-1.5">ใบเสร็จ</div>
            {receiptPreview && !noReceipt ? (
              <div className="relative">
                <img src={receiptPreview} alt="ใบเสร็จ" className="w-full max-h-56 object-contain rounded-xl border border-slate-200 bg-slate-50" />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-2 w-full min-h-[48px] rounded-xl border border-slate-300 text-sm font-medium hover:bg-slate-50"
                >
                  ถ่ายรูปใหม่
                </button>
              </div>
            ) : noReceipt ? (
              <div className="flex items-center justify-between px-3 py-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">
                <span className="flex items-center gap-1.5"><ImageOff size={16} /> ไม่มีใบเสร็จ</span>
                <button
                  onClick={() => {
                    setNoReceipt(false);
                    setNoReceiptConfirming(false);
                  }}
                  className="text-amber-700 underline underline-offset-2"
                >
                  เปลี่ยน
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadBusy}
                className="w-full min-h-[96px] rounded-xl border-2 border-dashed border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 font-semibold flex flex-col items-center justify-center gap-1.5 disabled:opacity-60"
              >
                {uploadBusy ? (
                  <>
                    <Loader2 className="animate-spin" size={22} />
                    <span className="text-sm">AI กำลังอ่านใบเสร็จ…</span>
                  </>
                ) : (
                  <>
                    <Camera size={24} />
                    <span>ถ่ายรูปใบเสร็จ</span>
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
            {duplicate && !noReceipt && (
              <div className="mt-2 px-3 py-2.5 rounded-xl border border-rose-300 bg-rose-50 text-rose-700">
                <div className="flex items-start gap-1.5 text-sm font-semibold">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>⚠️ ใบเสร็จรูปนี้ถูกใช้บันทึกไปแล้ว (ของ {duplicate.partyName} ฿{duplicate.amount})</span>
                </div>
                <div className="text-xs text-rose-600 mt-1 pl-[22px]">
                  ตรวจสอบก่อนบันทึก — ถ้าถ่ายใหม่จากบิลใบเดิมของคนอื่น อย่าส่งซ้ำ
                </div>
              </div>
            )}

            {!receiptPreview && !noReceipt && !isLiquidation && (
              noReceiptConfirming ? (
                <button
                  onClick={() => setNoReceipt(true)}
                  className="mt-2 w-full min-h-[44px] rounded-xl border border-rose-300 bg-rose-50 text-rose-700 text-sm font-semibold"
                >
                  ยืนยันว่าไม่มีใบเสร็จ
                </button>
              ) : (
                <button
                  onClick={() => setNoReceiptConfirming(true)}
                  className="mt-2 text-xs text-slate-400 underline underline-offset-2 hover:text-slate-600"
                >
                  ไม่มีใบเสร็จ
                </button>
              )
            )}
          </div>

          {/* Amount */}
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
            {ocrDiffers && (
              <div className="text-xs text-amber-700 mt-1">AI อ่านได้ ฿{ocr?.amount}</div>
            )}
          </div>

          {/* Entity segmented control */}
          <div>
            <div className="text-xs font-semibold text-slate-500 mb-1.5">บริษัท</div>
            <div className="grid grid-cols-3 gap-2">
              {entities.map((e) => (
                <button
                  key={e}
                  onClick={() => setEntity(e)}
                  className={`min-h-[48px] rounded-xl border text-sm font-semibold ${
                    entity === e ? 'bg-amber-600 border-amber-600 text-white' : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          {/* Category chips — grouped, no default; explicit tap required */}
          <div>
            <div className="text-xs font-semibold text-slate-500 mb-1.5">หมวดหมู่</div>
            <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} />
          </div>

          {selectedCategory?.needsCustomerNote && (
            <div>
              <div className="text-xs font-semibold text-slate-500 mb-1.5">ลูกค้า</div>
              <input
                value={customerNote}
                onChange={(e) => setCustomerNote(e.target.value)}
                placeholder="ชื่อลูกค้า"
                className="w-full px-3 py-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 min-h-[48px]"
              />
            </div>
          )}

          <div>
            <div className="text-xs font-semibold text-slate-500 mb-1.5">หมายเหตุ (ถ้ามี)</div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="หมายเหตุเพิ่มเติม"
              className="w-full px-3 py-3 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 min-h-[48px]"
            />
          </div>

          {submitError && (
            <div className="flex items-center gap-1 text-rose-600 text-sm">
              <AlertTriangle size={14} /> {submitError}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-white border-t border-slate-100 p-4">
          <button
            onClick={submit}
            disabled={submitBusy}
            className="w-full min-h-[52px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-base font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {submitBusy ? <Loader2 className="animate-spin" size={18} /> : <Check size={18} />} บันทึก
          </button>
        </div>
      </div>
    </div>
  );
}
