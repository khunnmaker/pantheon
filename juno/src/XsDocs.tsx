import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Ban, CheckCircle2, FileText, Loader2, RefreshCw, RotateCcw, Search, X,
} from 'lucide-react';
import {
  baht, closeDoc, getXsDocs, setXsAmount,
  type XsDoc, type XsDocCounts, type XsDocStatusFilter,
} from './lib/api';

// XS (Express จ่ายสินค้าภายใน docs) tab — task B, JUNO_XS_AMOUNTS_PLAN.md. Modeled closely on
// Bills.tsx (list + drawer, same visual language) but read-mostly: XS docs are born in Express's
// STTRNR6.TXT import (the นำเข้าไฟล์ panel lives on the เอกสาร/ReRecon tab), so there is no
// create/void/delete here — only the FIN-declared confirmedAmount editor (task A) and the
// CEO-only ปิดเอกสาร mark shared with MB.

const numberOf = (value: string): number => {
  const parsed = Number.parseFloat((value || '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

// docDate/paymentConfirmedAt come in two different shapes: the Express report prints dd/mm/yy
// (Buddhist); paymentConfirmedAt is a real ISO timestamp (the in-app CEO confirm).
const fmtReportDate = (dd: string): string => {
  const m = dd.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) return dd || '—';
  const greg = 2500 + Number(m[3]) - 543;
  return new Date(Date.UTC(greg, Number(m[2]) - 1, Number(m[1]))).toLocaleDateString('th-TH', {
    day: '2-digit', month: 'short', year: '2-digit',
  });
};
const fmtDateTime = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('th-TH', {
    day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
};

const STATUS_OPTIONS: { key: XsDocStatusFilter; label: string }[] = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'unpaid', label: 'ยังไม่จ่าย' },
  { key: 'paid', label: 'จ่ายแล้ว' },
  { key: 'closed', label: 'ปิดแล้ว' },
];

function XsStatusChip({ status }: { status: XsDoc['status'] }) {
  if (status === 'closed') return <span className="px-2 py-0.5 rounded-full text-[11px] bg-slate-200 text-slate-600 whitespace-nowrap">✔ ปิดแล้ว</span>;
  if (status === 'paid') return <span className="px-2 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-700 whitespace-nowrap">✅ จ่ายแล้ว</span>;
  return <span className="px-2 py-0.5 rounded-full text-[11px] bg-amber-100 text-amber-700 whitespace-nowrap">⏳ ยังไม่จ่าย</span>;
}

export default function XsDocs({ onCountsChanged, isCeo }: { onCountsChanged: (counts: XsDocCounts) => void; isCeo: boolean }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<XsDocStatusFilter>('all');
  const [rows, setRows] = useState<XsDoc[]>([]);
  const [selected, setSelected] = useState<XsDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getXsDocs({ q: q.trim() || undefined, status })
      .then((result) => {
        setRows(result.docs);
        onCountsChanged(result.counts);
        setSelected((current) => current ? (result.docs.find((doc) => doc.id === current.id) ?? null) : null);
      })
      .catch(() => setError('โหลดเอกสาร XS ไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [onCountsChanged, q, status]);

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText size={20} className="text-amber-700" />
          <h1 className="text-lg font-bold">XS (เอกสารจ่ายสินค้าภายใน)</h1>
        </div>
        {/* XS docs are born in Express — the นำเข้าไฟล์ STTRNR6.TXT panel lives on the เอกสาร tab. */}
        <span className="text-xs text-slate-400">นำเข้าไฟล์ STTRNR6.TXT ได้ที่แท็บ เอกสาร</span>
      </div>

      <div className="flex gap-3 items-start">
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden flex-1 min-w-0">
          <div className="p-3 border-b border-slate-100 flex flex-wrap gap-2 items-center">
            <select value={status} onChange={(event) => setStatus(event.target.value as XsDocStatusFilter)} className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white">
              {STATUS_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
            <div className="relative flex-1 min-w-[180px]">
              <Search size={14} className="absolute left-2.5 top-2 text-slate-400" />
              <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="ค้นหาเลขเอกสาร / หมายเหตุ" className="w-full pl-8 pr-2 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-amber-400" />
            </div>
            <button onClick={load} title="รีเฟรช" className="p-1.5 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50"><RefreshCw size={14} /></button>
          </div>

          {loading ? (
            <div className="p-10 text-center text-slate-400"><Loader2 size={20} className="animate-spin inline" /></div>
          ) : error ? (
            <div className="p-8 text-center text-rose-600 text-sm"><AlertTriangle size={15} className="inline mr-1" />{error}</div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center text-slate-400 text-sm">ไม่มีเอกสาร XS</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">เลขเอกสาร</th>
                    <th className="text-left px-3 py-2 font-medium">วันที่</th>
                    <th className="text-left px-3 py-2 font-medium">หมายเหตุ</th>
                    <th className="text-right px-3 py-2 font-medium">ยอดที่ยืนยัน</th>
                    <th className="text-left px-3 py-2 font-medium">สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((doc) => {
                    const rawDiffers = numberOf(doc.amount) > 0 && numberOf(doc.amount) !== numberOf(doc.confirmedAmount);
                    return (
                      <tr key={doc.id} onClick={() => setSelected(doc)} className={`border-t border-slate-100 cursor-pointer hover:bg-amber-50/40 ${selected?.id === doc.id ? 'bg-amber-50' : ''}`}>
                        <td className="px-3 py-2 font-bold whitespace-nowrap">{doc.xsNo}</td>
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{fmtReportDate(doc.docDate)}</td>
                        <td className="px-3 py-2"><div className="max-w-[200px] truncate">{doc.note || '—'}</div></td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <div className="font-semibold">{doc.confirmedAmount ? baht(numberOf(doc.confirmedAmount)) : <span className="text-slate-300">—</span>}</div>
                          {rawDiffers && <div className="text-[11px] text-slate-400">ดิบ: {baht(numberOf(doc.amount))}</div>}
                        </td>
                        <td className="px-3 py-2"><XsStatusChip status={doc.status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selected && (
          <XsDrawer doc={selected} isCeo={isCeo} onClose={() => setSelected(null)} onChanged={load} />
        )}
      </div>
    </div>
  );
}

function XsDrawer({ doc, isCeo, onClose, onChanged }: {
  doc: XsDoc; isCeo: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [amountInput, setAmountInput] = useState(doc.confirmedAmount);
  const [savingAmount, setSavingAmount] = useState(false);
  const [amountError, setAmountError] = useState('');
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState('');

  // Re-seed the editor whenever the drawer switches to a different doc (or a save round-trips a
  // fresh confirmedAmount back in) — never leaks the previous row's typed-but-unsaved value.
  useEffect(() => {
    setAmountInput(doc.confirmedAmount);
    setAmountError('');
  }, [doc.id, doc.confirmedAmount]);

  async function saveAmount() {
    const trimmed = amountInput.trim();
    if (!trimmed || numberOf(trimmed) <= 0) {
      setAmountError('ยอดต้องมากกว่า 0');
      return;
    }
    setSavingAmount(true);
    setAmountError('');
    try {
      await setXsAmount(doc.xsNo, trimmed);
      onChanged();
    } catch {
      setAmountError('บันทึกยอดไม่สำเร็จ');
    } finally {
      setSavingAmount(false);
    }
  }

  // Manual ปิดเอกสาร — shared with MB (same POST /api/juno/docs/:no/close route + closeDoc fn).
  async function toggleClose(nextClosed: boolean) {
    let note: string | undefined;
    if (nextClosed) {
      const input = window.prompt('หมายเหตุการปิดเอกสาร (เช่น เครม / ตัวอย่าง / รับเงินนอกระบบ) — เว้นว่างได้', doc.closeNote || '');
      if (input === null) return; // cancelled
      note = input.trim() || undefined;
    }
    setClosing(true);
    setCloseError('');
    try {
      await closeDoc(doc.xsNo, nextClosed, note);
      setConfirmingClose(false);
      onChanged();
    } catch {
      setCloseError('บันทึกการปิดเอกสารไม่สำเร็จ');
    } finally {
      setClosing(false);
    }
  }

  const rawDiffers = numberOf(doc.amount) > 0 && numberOf(doc.amount) !== numberOf(doc.confirmedAmount);

  return (
    <aside className="fixed inset-0 z-30 bg-slate-900/40 md:static md:bg-transparent md:z-auto md:w-[420px] md:shrink-0">
      <div className="absolute inset-x-0 bottom-0 top-10 md:static bg-white rounded-t-2xl md:rounded-xl border border-slate-200 overflow-y-auto md:sticky md:top-[104px] md:max-h-[calc(100vh-120px)]">
        <div className="sticky top-0 bg-white z-10 border-b border-slate-100 px-4 py-3 flex items-center justify-between gap-2">
          <div className="min-w-0"><div className="font-bold truncate">{doc.xsNo}</div><XsStatusChip status={doc.status} /></div>
          <div className="flex gap-1">
            {/* ปิดเอกสาร is CEO-only, mirrors ReRecon.tsx's ReDetail closable gate (docType !== 're' && isCeo). */}
            {isCeo && !doc.closed && (
              <button onClick={() => setConfirmingClose(true)} title="ปิดเอกสาร (ไม่ผ่าน Juno)" className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-100">
                <Ban size={16} />
              </button>
            )}
            {isCeo && doc.closed && (
              <button onClick={() => void toggleClose(false)} disabled={closing} title="ยกเลิกการปิดเอกสาร" className="p-2 rounded-lg border border-rose-200 text-rose-500 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50">
                {closing ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
              </button>
            )}
            <button onClick={onClose} title="ปิด" className="p-2 text-slate-400 hover:text-slate-600"><X size={18} /></button>
          </div>
        </div>

        {confirmingClose && (
          <div className="m-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-600 shrink-0" />
            <span className="flex-1">ปิดเอกสารนี้? (settled without a Juno payment)</span>
            <button disabled={closing} onClick={() => void toggleClose(true)} className="px-2 py-1 rounded bg-amber-600 text-white disabled:opacity-50">ยืนยัน</button>
            <button disabled={closing} onClick={() => setConfirmingClose(false)} className="px-2 py-1 rounded bg-white border border-slate-200">ปิด</button>
          </div>
        )}
        {closeError && <div className="m-3 p-2 bg-rose-50 text-rose-700 text-xs rounded-lg">{closeError}</div>}

        <div className="p-4 grid grid-cols-2 gap-3 text-sm">
          <Info label="วันที่" value={fmtReportDate(doc.docDate)} />
          <Info label="หมายเหตุ (รหัสลูกค้า Express)" value={doc.note} />
          <Info label="ยอดดิบจากรายงาน" value={numberOf(doc.amount) > 0 ? baht(numberOf(doc.amount)) : undefined} />
          <Info label="รายการรับเงินที่ผูก" value={String(doc.linkedPaymentCount)} />
          {doc.closed && <Info label="ปิดเอกสารโดย" value={doc.paymentConfirmedBy} />}
          {doc.closed && <Info label="ปิดเมื่อ" value={fmtDateTime(doc.paymentConfirmedAt)} />}
        </div>
        {doc.closeNote && <div className="mx-4 mb-3 p-3 rounded-lg bg-slate-50 text-xs whitespace-pre-wrap"><div className="text-slate-400 mb-1">หมายเหตุการปิด</div>{doc.closeNote}</div>}

        <div className="px-4 pb-4">
          <div className="text-xs text-slate-400 mb-1.5">ยอดที่ยืนยัน (task A — ใช้แทนยอดดิบจากรายงานเพื่อกระทบยอด)</div>
          <div className="flex items-center gap-2">
            <input
              value={amountInput}
              onChange={(event) => { setAmountInput(event.target.value); setAmountError(''); }}
              inputMode="decimal"
              placeholder="0.00"
              className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            <button
              onClick={() => void saveAmount()}
              disabled={savingAmount || amountInput.trim() === doc.confirmedAmount}
              className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center gap-1 disabled:opacity-50"
            >
              {savingAmount ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={13} />} บันทึก
            </button>
          </div>
          {amountError && <div className="mt-1 text-[11px] text-rose-600">{amountError}</div>}
          {rawDiffers && <div className="mt-1 text-[11px] text-slate-400">ยอดดิบจากรายงาน: {baht(numberOf(doc.amount))} (ไม่ใช้)</div>}
        </div>
      </div>
    </aside>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><div className="text-xs text-slate-400">{label}</div><div>{value || <span className="text-slate-300">—</span>}</div></div>;
}
