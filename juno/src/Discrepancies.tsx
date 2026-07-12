import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Loader2, RefreshCw, Scale, Undo2 } from 'lucide-react';
import {
  baht,
  confirmDiscrepancy,
  getDiscrepancies,
  resolveDiscrepancy,
  setDiscrepancyExpected,
  type DiscResolution,
  type DiscrepancyResponse,
  type DiscrepancyRow,
  type Payment,
} from './lib/api';

const RESOLUTION_LABELS: Record<Exclude<DiscResolution, ''>, string> = {
  refund: 'โอนคืนแล้ว',
  credit: 'เก็บเป็นเครดิตรอบหน้า',
  chase: 'รอลูกค้าชำระเพิ่ม',
  writeoff: 'ปิดส่วนต่าง (ปัดเศษ/ยกให้)',
};

const fmtDate = (value: string): string => {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' });
};

function signedDiff(diff: number): string {
  if (diff > 0) return `เกิน +${baht(diff)}`;
  if (diff < 0) return `ขาด −${baht(Math.abs(diff))}`;
  return 'ยอดลงตัวแล้ว';
}

function stateOf(row: DiscrepancyRow): 'open' | 'resolved' | 'confirmed' {
  if (row.discConfirmedAt) return 'confirmed';
  if (row.discResolution) return 'resolved';
  return 'open';
}

function StateBadge({ row }: { row: DiscrepancyRow }) {
  if (row.diff === 0) return <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">ยอดลงตัวแล้ว</span>;
  const state = stateOf(row);
  if (state === 'confirmed') return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">เสร็จสิ้น</span>;
  if (state === 'resolved') return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">รอ CEO ยืนยัน</span>;
  return <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700">เปิดอยู่</span>;
}

export default function Discrepancies({ isCeo, onChanged }: { isCeo: boolean; onChanged: () => void }) {
  const [data, setData] = useState<DiscrepancyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [direction, setDirection] = useState<'all' | 'over' | 'under'>('all');
  const [state, setState] = useState<'open' | 'resolved' | 'confirmed'>('open');
  const [editing, setEditing] = useState<DiscrepancyRow | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getDiscrepancies()
      .then(setData)
      .catch(() => setError('โหลดข้อมูลยอดเกิน/ขาดไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const rows = useMemo(() => (data?.rows ?? []).filter((row) => (
    (direction === 'all' || row.direction === direction) && stateOf(row) === state
  )), [data, direction, state]);

  const changed = () => { load(); onChanged(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-emerald-700">
        <Scale size={20} />
        <h1 className="text-lg font-bold text-slate-800">ยอดเกิน/ขาด</h1>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard label="Σ เกิน (เปิดอยู่)" count={data?.totals.over.count} value={data?.totals.over.sum} tone="text-emerald-700" />
        <SummaryCard label="Σ ขาด (เปิดอยู่)" count={data?.totals.under.count} value={Math.abs(data?.totals.under.sum ?? 0)} tone="text-rose-700" />
        <SummaryCard label="รอ CEO ยืนยัน" count={data?.totals.pendingConfirm} tone="text-amber-700" />
      </div>
      {!!data?.groupHints && (
        <div className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700">
          กลุ่มหลายรายการยอดไม่ตรง {data.groupHints} กลุ่ม — ดูใน กระทบยอด RE
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <ChipGroup value={direction} onChange={setDirection} options={[['all', 'ทั้งหมด'], ['over', 'เกิน'], ['under', 'ขาด']]} />
          <ChipGroup value={state} onChange={setState} options={[['open', 'เปิดอยู่'], ['resolved', 'รอ CEO ยืนยัน'], ['confirmed', 'เสร็จสิ้น']]} />
          <button onClick={load} className="ml-auto rounded-lg border border-slate-300 p-1.5 text-slate-500 hover:bg-slate-50" title="รีเฟรช"><RefreshCw size={14} /></button>
        </div>

        {loading ? (
          <div className="p-10 text-center text-slate-400"><Loader2 className="inline animate-spin" size={20} /></div>
        ) : error ? (
          <div className="flex items-center justify-center gap-1 p-8 text-sm text-rose-600"><AlertTriangle size={15} /> {error}</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-400">ไม่มีรายการในตัวกรองนี้</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-[980px] w-full text-sm">
              <thead className="sticky top-[104px] z-10 bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">วันที่โอน</th><th className="px-3 py-2 text-left">ลูกค้า / RE</th>
                  <th className="px-3 py-2 text-right">ยอดเต็ม</th><th className="px-3 py-2 text-right">ยอดตาม RE</th>
                  <th className="px-3 py-2 text-right">ส่วนต่าง</th><th className="px-3 py-2 text-left">สถานะ</th><th className="px-3 py-2 text-right">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} className="align-top hover:bg-emerald-50/30">
                    <td className="px-3 py-3 whitespace-nowrap text-slate-500">{row.transferAt || fmtDate(row.createdAt)}</td>
                    <td className="px-3 py-3">
                      <div className="font-medium text-slate-800">{row.receiptName || row.customerName || '—'}</div>
                      <div className="mt-1 flex flex-wrap gap-1">{row.reNumbers.map((re) => <span key={re} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">RE {re}</span>)}</div>
                    </td>
                    <td className="px-3 py-3 text-right font-semibold whitespace-nowrap">{baht(row.gross)}</td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">{baht(row.expected)}<div className="text-[10px] text-slate-400">{row.expectedSource === 'typed' ? 'FIN กรอก' : 'จาก RE'}</div></td>
                    <td className={`px-3 py-3 text-right font-bold whitespace-nowrap ${row.diff > 0 ? 'text-emerald-700' : row.diff < 0 ? 'text-rose-700' : 'text-sky-700'}`}>{signedDiff(row.diff)}</td>
                    <td className="px-3 py-3"><StateBadge row={row} />{row.discResolution && <div className="mt-1 text-[11px] text-slate-500">{RESOLUTION_LABELS[row.discResolution]}</div>}</td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      <button onClick={() => setEditing(row)} className="rounded-lg border border-emerald-200 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50">บันทึกการจัดการ</button>
                      {isCeo && row.discResolution && (
                        <ConfirmButton row={row} onChanged={changed} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && <ResolutionDialog row={editing} onClose={() => setEditing(null)} onChanged={() => { setEditing(null); changed(); }} />}
    </div>
  );
}

function SummaryCard({ label, count, value, tone }: { label: string; count?: number; value?: number; tone: string }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-xs text-slate-400">{label}</div><div className={`text-2xl font-bold ${tone}`}>{count ?? '—'}</div>{value !== undefined && <div className="text-sm text-slate-500">{baht(value)}</div>}</div>;
}

function ChipGroup<T extends string>({ value, onChange, options }: { value: T; onChange: (value: T) => void; options: [T, string][] }) {
  return <div className="flex overflow-hidden rounded-lg border border-slate-300">{options.map(([key, label]) => <button key={key} onClick={() => onChange(key)} className={`px-2.5 py-1.5 text-xs ${value === key ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{label}</button>)}</div>;
}

function ConfirmButton({ row, onChanged }: { row: DiscrepancyRow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  async function run() { setBusy(true); try { await confirmDiscrepancy(row.id, !row.discConfirmedAt); onChanged(); } catch { window.alert('ยืนยันไม่สำเร็จ — ลองใหม่อีกครั้ง'); } finally { setBusy(false); } }
  return <button disabled={busy} onClick={run} className="ml-1.5 rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50">{busy ? <Loader2 size={13} className="inline animate-spin" /> : row.discConfirmedAt ? <><Undo2 size={13} className="inline" /> ยกเลิกยืนยัน</> : <><Check size={13} className="inline" /> ยืนยัน</>}</button>;
}

function ResolutionDialog({ row, onClose, onChanged }: { row: DiscrepancyRow; onClose: () => void; onChanged: () => void }) {
  const [expected, setExpected] = useState(row.discExpected || String(row.expected));
  const [resolution, setResolution] = useState<DiscResolution>(row.discResolution);
  const [note, setNote] = useState(row.discNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options: Exclude<DiscResolution, ''>[] = row.direction === 'under' ? ['chase', 'writeoff'] : ['refund', 'credit', 'writeoff'];
  async function save() {
    setBusy(true); setError('');
    try {
      await setDiscrepancyExpected(row.id, expected.trim());
      await resolveDiscrepancy(row.id, resolution, note.trim() || undefined);
      onChanged();
    } catch { setError('บันทึกไม่สำเร็จ — ตรวจสอบยอดและลองใหม่'); } finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={onClose}><div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
    <div className="font-semibold text-slate-800">บันทึกการจัดการส่วนต่าง</div>
    <label className="block text-xs text-slate-500">ยอดตาม RE (ก่อนหัก)<input value={expected} onChange={(e) => setExpected(e.target.value)} inputMode="decimal" className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm" /></label>
    <div><div className="mb-1 text-xs text-slate-500">วิธีจัดการ</div><div className="grid gap-1.5">{options.map((key) => <button key={key} onClick={() => setResolution(key)} className={`rounded-lg border px-3 py-2 text-left text-sm ${resolution === key ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600'}`}>{RESOLUTION_LABELS[key]}</button>)}</div></div>
    <label className="block text-xs text-slate-500">หมายเหตุ<textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm" /></label>
    {error && <div className="text-xs text-rose-600">{error}</div>}
    <div className="flex justify-between gap-2"><button disabled={busy || !row.discResolution} onClick={() => { setResolution(''); setNote(''); }} className="text-xs text-rose-600 disabled:opacity-30">ล้างการจัดการ</button><div className="flex gap-2"><button onClick={onClose} className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-600">ยกเลิก</button><button disabled={busy} onClick={save} className="flex items-center gap-1 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} บันทึก</button></div></div>
  </div></div>;
}

// Drawer section: shown only when the payment has a live discrepancy row or preserved stamps.
export function PaymentDiscrepancyBlock({ payment, isCeo, onUpdated }: { payment: Payment; isCeo: boolean; onUpdated: (payment: Payment) => void }) {
  const [row, setRow] = useState<DiscrepancyRow | null>(null);
  const [expected, setExpected] = useState(payment.discExpected);
  const [resolution, setResolution] = useState<DiscResolution>(payment.discResolution);
  const [note, setNote] = useState(payment.discNote);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    // Cheap pre-filter: most payments carry no REs, typed expected, or stamps — skip the
    // full-ledger fetch for those instead of hitting /discrepancies on every drawer open.
    const canHaveRow = payment.reNumbers.length > 0 || !!payment.discExpected ||
      !!(payment.discResolution || payment.discResolvedAt || payment.discConfirmedAt);
    if (!canHaveRow) { setRow(null); return; }
    getDiscrepancies().then((result) => { const found = result.rows.find((item) => item.id === payment.id) ?? null; setRow(found); setExpected(payment.discExpected || (found ? String(found.expected) : '')); }).catch(() => setRow(null));
  }, [payment]);
  useEffect(() => { load(); }, [load]);
  const hasStamps = !!(payment.discResolution || payment.discResolvedAt || payment.discConfirmedAt);
  if (!row && !hasStamps) return null;
  const direction = row?.direction ?? 'balanced';
  const options: Exclude<DiscResolution, ''>[] = direction === 'under' ? ['chase', 'writeoff'] : ['refund', 'credit', 'writeoff'];
  async function run(key: string, action: () => Promise<{ payment: Payment }>) { setBusy(key); setErr(''); try { const result = await action(); onUpdated(result.payment); load(); } catch { setErr('บันทึกไม่สำเร็จ — ตรวจสอบยอดและลองใหม่'); } finally { setBusy(''); } }
  return <div className="mx-4 mt-3 space-y-2 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 text-xs">
    <div className="flex items-center justify-between"><span className="font-semibold text-slate-700">ส่วนต่างยอด</span>{row && <span className={`font-bold ${row.diff > 0 ? 'text-emerald-700' : row.diff < 0 ? 'text-rose-700' : 'text-sky-700'}`}>{signedDiff(row.diff)}</span>}</div>
    {row && <div className="text-slate-500">ยอดเต็ม {baht(row.gross)} · ยอดตาม RE {baht(row.expected)} ({row.expectedSource === 'typed' ? 'FIN กรอก' : 'จาก RE'})</div>}
    <div className="flex gap-1.5"><input value={expected} onChange={(e) => setExpected(e.target.value)} inputMode="decimal" placeholder="ยอดตาม RE" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5" /><button disabled={!!busy} onClick={() => run('expected', () => setDiscrepancyExpected(payment.id, expected.trim()))} className="rounded-lg bg-white px-2 py-1.5 text-emerald-700 border border-emerald-200">ปรับยอด</button>{payment.discExpected && <button disabled={!!busy} onClick={() => run('expected', () => setDiscrepancyExpected(payment.id, ''))} className="text-slate-500">ใช้ RE</button>}</div>
    <select value={resolution} onChange={(e) => setResolution(e.target.value as DiscResolution)} className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5"><option value="">เลือกวิธีจัดการ</option>{options.map((key) => <option key={key} value={key}>{RESOLUTION_LABELS[key]}</option>)}</select>
    <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="หมายเหตุ" className="w-full rounded-lg border border-slate-300 px-2 py-1.5" />
    {err && <div className="text-rose-600">{err}</div>}
    <div className="flex justify-end gap-1.5"><button disabled={!!busy || !payment.discResolution} onClick={() => run('resolve', () => resolveDiscrepancy(payment.id, ''))} className="mr-auto text-rose-600 disabled:opacity-30">ล้าง</button><button disabled={!!busy || !resolution} onClick={() => run('resolve', () => resolveDiscrepancy(payment.id, resolution, note.trim() || undefined))} className="rounded-lg bg-emerald-600 px-3 py-1.5 font-medium text-white disabled:opacity-40">บันทึกการจัดการ</button>{isCeo && payment.discResolution && <button disabled={!!busy} onClick={() => run('confirm', () => confirmDiscrepancy(payment.id, !payment.discConfirmedAt))} className="rounded-lg border border-emerald-300 bg-white px-2 py-1.5 text-emerald-700">{payment.discConfirmedAt ? 'ยกเลิกยืนยัน' : 'ยืนยัน'}</button>}</div>
  </div>;
}
