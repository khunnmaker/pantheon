import { useRef, useState } from 'react';
import { Upload, Loader2, AlertTriangle, Check, X, Calendar } from 'lucide-react';
import {
  fileToBase64, previewSalesImport, applySalesImport, formatDate,
  type SalesImportPreview, type SalesImportApplyResult,
} from './lib/api';

// Supervisor-only: upload the OESOC sales-order export from Express (รายงานใบสั่งขาย
// แยกตามลูกค้า — grouped by customer, so the /code join key is present) → preview
// (docs/lines/codes + matched-to-customer counts + date coverage + self-certify) → apply.
// Mirrors ImportCustomers' preview→apply UX. Re-importing upserts by document number.
export default function ImportSales() {
  const [preview, setPreview] = useState<SalesImportPreview | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<SalesImportApplyResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File) {
    setErr('');
    setDone(null);
    setPreview(null);
    setFileName(file.name);
    setBusy('preview');
    try {
      const dataB64 = await fileToBase64(file);
      const p = await previewSalesImport(dataB64, file.name);
      setPreview(p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setErr(
        msg === 'forbidden'
          ? 'ไม่มีสิทธิ์นำเข้าข้อมูล (เฉพาะหัวหน้า)'
          : msg.includes('413')
          ? 'ไฟล์ใหญ่เกินไป — เกินขีดจำกัดของเซิร์ฟเวอร์'
          : msg.includes('422')
          ? 'ไม่พบรายการขายในไฟล์ — ต้องเป็นรายงานใบสั่งขาย "แยกตามลูกค้า" จาก Express (มีรหัสลูกค้ากำกับ)'
          : 'อ่านไฟล์ไม่สำเร็จ — ตรวจสอบว่าเป็นไฟล์รายงานใบสั่งขายจาก Express (.txt)',
      );
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy('apply');
    setErr('');
    try {
      const res = await applySalesImport(preview.token);
      setDone(res);
      setPreview(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setErr(msg.includes('410') ? 'พรีวิวหมดอายุ — กรุณาอัปโหลดไฟล์ใหม่' : 'นำเข้าไม่สำเร็จ');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-800 mb-1 flex items-center gap-2">
          <Upload size={18} className="text-rose-600" /> นำเข้าข้อมูลการขาย (รายงานใบสั่งขาย แยกตามลูกค้า — OESOC)
        </h2>
        <p className="text-sm text-slate-500 mb-4">
          ต้องเป็นรายงานที่ <b>แยกตามลูกค้า</b> (มีรหัสลูกค้ากำกับแต่ละราย) → ดูตัวอย่าง → ยืนยันเพื่อบันทึก
          (นำเข้าซ้ำได้ — จะอัปเดตตามเลขที่เอกสาร ไม่สร้างซ้ำ) ยิ่งช่วงข้อมูลยาว ยิ่งวิเคราะห์ RFM ได้แม่นขึ้น
        </p>

        <input
          ref={fileRef}
          type="file"
          accept=".txt,text/plain"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-50"
        >
          {busy === 'preview' ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
          เลือกไฟล์รายงานการขาย
        </button>
        {fileName && <span className="ml-3 text-sm text-slate-500">{fileName}</span>}

        {err && (
          <div className="mt-3 flex items-center gap-1 text-rose-600 text-sm">
            <AlertTriangle size={14} /> {err}
          </div>
        )}

        {done && (
          <div className="mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm">
            <div className="flex items-center gap-2 font-semibold">
              <Check size={16} /> นำเข้าสำเร็จ
            </div>
            <div className="mt-1 text-xs text-emerald-700">
              เอกสารใหม่ {done.docsCreated} · อัปเดต {done.docsUpdated} · รายการสินค้า {done.linesWritten}
              {done.unmatchedCodes.length > 0 && ` · รหัสลูกค้าที่ยังไม่พบในทะเบียน ${done.unmatchedCodes.length}`}
            </div>
            <div className="mt-1 text-xs text-emerald-600">อย่าลืมกด “คำนวณใหม่” เพื่ออัปเดตกลุ่มลูกค้า/สัญญาณ</div>
          </div>
        )}
      </div>

      {preview && <PreviewCard preview={preview} onApply={apply} onCancel={() => setPreview(null)} busy={busy} />}
    </div>
  );
}

function PreviewCard({
  preview: p, onApply, onCancel, busy,
}: {
  preview: SalesImportPreview;
  onApply: () => void;
  onCancel: () => void;
  busy: 'preview' | 'apply' | null;
}) {
  const docOkPct = p.selfCertify.docChecked
    ? Math.round((100 * p.selfCertify.docOk) / p.selfCertify.docChecked)
    : 100;
  return (
    <div className="mt-4 bg-white rounded-2xl border border-slate-200 p-5">
      <div className="flex flex-wrap gap-3 mb-4 text-sm">
        <Stat label="เอกสาร" value={p.docs} />
        <Stat label="รายการสินค้า" value={p.lineItems} />
        <Stat label="รหัสลูกค้า" value={p.distinctCodes} />
        <Stat label="ตรงกับทะเบียนลูกค้า" value={p.matchedCodes} tone="ok" />
        <Stat label="ยังไม่พบในทะเบียน" value={p.unmatchedCodes} tone={p.unmatchedCodes ? 'warn' : undefined} />
        {p.voids > 0 && <Stat label="ยกเลิก" value={p.voids} />}
        <span className="ml-auto text-xs text-slate-400 self-center">
          {p.fileName} · encoding: {p.encoding}
        </span>
      </div>

      {(p.dateSpan.min || p.dateSpan.max) && (
        <div className="mb-4 flex items-center gap-2 text-sm text-slate-600 px-3 py-2 rounded-xl bg-rose-50 border border-rose-100">
          <Calendar size={15} className="text-rose-500" />
          ช่วงข้อมูลการขาย: <b>{formatDate(p.dateSpan.min)}</b> – <b>{formatDate(p.dateSpan.max)}</b>
        </div>
      )}

      <div className="mb-4 text-xs text-slate-500">
        ตรวจยอด: เอกสารที่ยอดรวมตรงกับผลรวมรายการ {p.selfCertify.docOk}/{p.selfCertify.docChecked}{' '}
        <span className={docOkPct >= 95 ? 'text-emerald-600' : 'text-amber-600'}>({docOkPct}%)</span>
        {p.selfCertify.custSubtotalChecked > 0 &&
          ` · ยอดรวมต่อลูกค้าตรง ${p.selfCertify.custSubtotalOk}/${p.selfCertify.custSubtotalChecked}`}
      </div>

      {p.unmatchedCodes > 0 && (
        <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs">
          <div className="font-semibold mb-1 flex items-center gap-1">
            <AlertTriangle size={13} />
            {p.unmatchedCodes} รหัสลูกค้าในไฟล์ขายยังไม่มีในทะเบียนลูกค้า — ยอดขายจะถูกบันทึกไว้ แต่ยังจับคู่ชื่อไม่ได้ (นำเข้าทะเบียนลูกค้าให้ครบก่อนได้)
          </div>
          {p.unmatchedCodesSample.length > 0 && (
            <div className="font-mono">{p.unmatchedCodesSample.join(', ')}{p.unmatchedCodes > p.unmatchedCodesSample.length ? ' …' : ''}</div>
          )}
        </div>
      )}

      {p.unresolved > 0 && (
        <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs">
          <div className="font-semibold mb-1 flex items-center gap-1">
            <AlertTriangle size={13} /> อ่านไม่ได้ {p.unresolved} รายการ — จะไม่ถูกนำเข้า (รูปแบบไฟล์อาจเปลี่ยน แจ้งผู้ดูแลระบบ)
          </div>
          {p.unresolvedSamples.length > 0 && (
            <div className="font-mono">{p.unresolvedSamples.map((s, i) => <div key={i}>{s}</div>)}</div>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={onApply}
          disabled={busy !== null || p.docs === 0}
          className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-50"
        >
          {busy === 'apply' ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          ยืนยันนำเข้า ({p.docs} เอกสาร)
        </button>
        <button
          onClick={onCancel}
          disabled={busy !== null}
          className="px-4 py-2 rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 text-sm disabled:opacity-50 flex items-center gap-1"
        >
          <X size={14} /> ยกเลิก
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' }) {
  const color = tone === 'ok' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-700';
  return (
    <div className="px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200">
      <span className="text-xs text-slate-400">{label} </span>
      <span className={`font-bold ${color}`}>{value.toLocaleString()}</span>
    </div>
  );
}
