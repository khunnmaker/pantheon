import { useRef, useState } from 'react';
import { Upload, Loader2, AlertTriangle, Check, X } from 'lucide-react';
import {
  fileToBase64, previewCustomerImport, applyCustomerImport, creditLabel,
  type ImportPreview, type ImportApplyResult, type VenusCustomer,
} from './lib/api';

// Supervisor-only: upload the ARMAST customer-master export from Express → preview
// (parsed/matched/unmatched counts + type/credit breakdown) → confirm to apply. Mirrors
// Vulcan's stock-import preview→apply UX (see vulcan/src/Stock.tsx ImportTab).
export default function ImportCustomers() {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<ImportApplyResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File) {
    setErr('');
    setDone(null);
    setPreview(null);
    setFileName(file.name);
    setBusy('preview');
    try {
      const dataB64 = await fileToBase64(file);
      const p = await previewCustomerImport(dataB64, file.name);
      setPreview(p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setErr(
        msg === 'forbidden'
          ? 'ไม่มีสิทธิ์นำเข้าข้อมูล (เฉพาะหัวหน้า)'
          : msg.includes('413')
          ? 'ไฟล์ใหญ่เกินไป — เกินขีดจำกัดของเซิร์ฟเวอร์'
          : msg.includes('422')
          ? 'ไม่พบรายการลูกค้าในไฟล์ — ตรวจสอบว่าเป็นรายงานรายละเอียดลูกค้าจาก Express (ARMAST)'
          : 'อ่านไฟล์ไม่สำเร็จ — ตรวจสอบว่าเป็นไฟล์รายงานลูกค้าจาก Express (.txt)',
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
      const res = await applyCustomerImport(preview.token);
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
          <Upload size={18} className="text-rose-600" /> นำเข้าข้อมูลลูกค้า (รายงานจาก Express — ARMAST)
        </h2>
        <p className="text-sm text-slate-500 mb-4">
          อัปโหลดไฟล์ → ดูตัวอย่างการนำเข้า → ยืนยันเพื่อบันทึก ข้อมูลลูกค้าจะอัปเดตทันที (นำเข้าซ้ำได้อย่างปลอดภัย — ไม่สร้างรายการซ้ำ)
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
          เลือกไฟล์รายงานลูกค้า
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
              สร้างใหม่ {done.created} ราย · อัปเดต {done.updated} ราย
              {done.unresolved > 0 && ` · อ่านไม่ได้ ${done.unresolved} บรรทัด`}
            </div>
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
  preview: ImportPreview;
  onApply: () => void;
  onCancel: () => void;
  busy: 'preview' | 'apply' | null;
}) {
  const creditKeys: VenusCustomer['creditTermsNorm'][] = ['CASH', 'PREPAY', 'CREDIT', 'OTHER'];
  return (
    <div className="mt-4 bg-white rounded-2xl border border-slate-200 p-5">
      <div className="flex flex-wrap gap-3 mb-4 text-sm">
        <Stat label="อ่านได้" value={p.parsedCount} />
        <Stat label="ตรงกับลูกค้าเดิม" value={p.matched} tone="ok" />
        <Stat label="ไม่พบลูกค้าเดิม" value={p.unmatched} tone={p.unmatched ? 'warn' : undefined} />
        <span className="ml-auto text-xs text-slate-400 self-center">
          {p.fileName} · encoding: {p.encoding} · {p.pageCount} หน้า
        </span>
      </div>

      {p.unresolved > 0 && (
        <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs">
          <div className="font-semibold mb-1 flex items-center gap-1">
            <AlertTriangle size={13} />
            อ่านไม่ได้ {p.unresolved} บรรทัด — แถวเหล่านี้จะไม่ถูกนำเข้า (รูปแบบไฟล์อาจเปลี่ยน แจ้งผู้ดูแลระบบ)
          </div>
          {p.unresolvedSamples.length > 0 && (
            <div className="font-mono">
              {p.unresolvedSamples.map((s, i) => (
                <div key={i}>{s}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4 mb-4">
        <div>
          <h4 className="text-xs font-semibold text-slate-500 mb-2">แยกตามประเภทลูกค้า</h4>
          <div className="space-y-1">
            {Object.entries(p.typeBreakdown).length === 0 ? (
              <div className="text-xs text-slate-300">—</div>
            ) : (
              Object.entries(p.typeBreakdown).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between text-sm">
                  <span className="text-slate-600 truncate">{k || '(ไม่ระบุ)'}</span>
                  <span className="font-semibold text-slate-700">{v}</span>
                </div>
              ))
            )}
          </div>
        </div>
        <div>
          <h4 className="text-xs font-semibold text-slate-500 mb-2">แยกตามเงื่อนไขชำระเงิน</h4>
          <div className="space-y-1">
            {creditKeys.map((k) => {
              const key = k ?? 'OTHER';
              const v = p.creditBreakdown[key as string] ?? 0;
              if (!v) return null;
              return (
                <div key={key} className="flex items-center justify-between text-sm">
                  <span className="text-slate-600">{creditLabel(k)}</span>
                  <span className="font-semibold text-slate-700">{v}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onApply}
          disabled={busy !== null || p.parsedCount === 0}
          className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center gap-2 disabled:opacity-50"
        >
          {busy === 'apply' ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          ยืนยันนำเข้า ({p.parsedCount} รายการ)
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
      <span className={`font-bold ${color}`}>{value}</span>
    </div>
  );
}
