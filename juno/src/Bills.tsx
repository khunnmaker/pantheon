import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Ban, CheckCircle2, Loader2, PackageSearch, PenLine,
  Plus, Printer, ReceiptText, RefreshCw, RotateCcw, Search, Trash2, X,
} from 'lucide-react';
import {
  baht, createManualBill, deleteManualBill, getManualBillProducts, getManualBills, setManualBillVoid,
  updateManualBill, type ManualBill, type ManualBillBody, type ManualBillCounts,
  type ManualBillItem, type ManualBillProduct, type ManualBillStatus,
  type ManualBillStatusFilter,
} from './lib/api';
import PrintBill from './PrintBill';

const numberOf = (value: string): number => {
  const parsed = Number.parseFloat((value || '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};
const round2 = (value: number): number => Math.round(value * 100) / 100;
const moneyString = (value: number): string => round2(value).toFixed(2);
const bangkokToday = (): string => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const fmtDate = (value: string): string => {
  if (!value) return '—';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00+07:00`) : new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('th-TH', {
    day: '2-digit', month: 'short', year: '2-digit', timeZone: 'Asia/Bangkok',
  });
};

const STATUS_OPTIONS: { key: ManualBillStatusFilter; label: string }[] = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'unpaid', label: 'ยังไม่จ่าย' },
  { key: 'mismatch', label: 'ยอดไม่ตรง' },
  { key: 'paid', label: 'จับคู่แล้ว' },
  { key: 'void', label: 'ยกเลิก' },
];

function BillStatusChip({ status }: { status: ManualBillStatus }) {
  if (status === 'paid') return <span className="px-2 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-700 whitespace-nowrap">✅ จับคู่แล้ว</span>;
  if (status === 'mismatch') return <span className="px-2 py-0.5 rounded-full text-[11px] bg-amber-100 text-amber-700 whitespace-nowrap">⚠️ ยอดไม่ตรง</span>;
  if (status === 'void') return <span className="px-2 py-0.5 rounded-full text-[11px] bg-slate-200 text-slate-500 whitespace-nowrap">ยกเลิก</span>;
  return <span className="px-2 py-0.5 rounded-full text-[11px] bg-rose-100 text-rose-700 whitespace-nowrap">⏳ ยังไม่จ่าย</span>;
}

// canDelete = CEO-only ลบถาวร (mirrors the payment drawer's gate; server 403s non-supervisor).
// canEdit = md/supervisor only (owner 2026-07-15): FIN sees the ledger + print but never
// issues/edits/voids — mirrors the server's EMPLOYEE_JUNO_DENIED_ROUTES 403s.
export default function Bills({ onCountsChanged, canDelete, canEdit }: { onCountsChanged: (counts: ManualBillCounts) => void; canDelete: boolean; canEdit: boolean }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<ManualBillStatusFilter>('all');
  const [rows, setRows] = useState<ManualBill[]>([]);
  const [selected, setSelected] = useState<ManualBill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ManualBill | 'new' | null>(null);
  const [printQueue, setPrintQueue] = useState<ManualBill[] | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getManualBills({ q: q.trim() || undefined, status })
      .then((result) => {
        setRows(result.bills);
        onCountsChanged(result.counts);
        setSelected((current) => current ? (result.bills.find((bill) => bill.id === current.id) ?? null) : null);
      })
      .catch(() => setError('โหลดบิลมือไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [onCountsChanged, q, status]);

  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  if (printQueue) return <PrintBill bills={printQueue} onDone={() => setPrintQueue(null)} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ReceiptText size={20} className="text-emerald-700" />
          <h1 className="text-lg font-bold">บิลมือ</h1>
        </div>
        {canEdit && (
          <button onClick={() => setEditing('new')} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700">
            <Plus size={15} /> ออกบิล
          </button>
        )}
      </div>

      <div className="flex gap-3 items-start">
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden flex-1 min-w-0">
          <div className="p-3 border-b border-slate-100 flex flex-wrap gap-2 items-center">
            <select value={status} onChange={(event) => setStatus(event.target.value as ManualBillStatusFilter)} className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white">
              {STATUS_OPTIONS.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
            <div className="relative flex-1 min-w-[180px]">
              <Search size={14} className="absolute left-2.5 top-2 text-slate-400" />
              <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="ค้นหาเลขบิล / รหัสลูกค้า / ผู้ซื้อ" className="w-full pl-8 pr-2 py-1.5 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-400" />
            </div>
            <button onClick={load} title="รีเฟรช" className="p-1.5 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50"><RefreshCw size={14} /></button>
          </div>

          {loading ? (
            <div className="p-10 text-center text-slate-400"><Loader2 size={20} className="animate-spin inline" /></div>
          ) : error ? (
            <div className="p-8 text-center text-rose-600 text-sm"><AlertTriangle size={15} className="inline mr-1" />{error}</div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center text-slate-400 text-sm">ไม่มีบิลมือ</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">เลขบิล</th>
                    <th className="text-left px-3 py-2 font-medium">วันที่</th>
                    <th className="text-left px-3 py-2 font-medium">ผู้ซื้อ</th>
                    <th className="text-right px-3 py-2 font-medium">ยอดรวม</th>
                    <th className="text-left px-3 py-2 font-medium">สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((bill) => (
                    <tr key={bill.id} onClick={() => setSelected(bill)} className={`border-t border-slate-100 cursor-pointer hover:bg-emerald-50/40 ${selected?.id === bill.id ? 'bg-emerald-50' : ''}`}>
                      <td className="px-3 py-2 font-bold whitespace-nowrap">{bill.billNo}</td>
                      <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{fmtDate(bill.billedAt)}</td>
                      <td className="px-3 py-2"><div className="max-w-[230px] truncate">{bill.customerCode && <span className="text-slate-400 mr-1.5">{bill.customerCode}</span>}{bill.buyerName || '—'}</div></td>
                      <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">{baht(numberOf(bill.amount))}</td>
                      <td className="px-3 py-2"><BillStatusChip status={bill.billStatus} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selected && (
          <BillDrawer
            bill={selected}
            canDelete={canDelete}
            canEdit={canEdit}
            onClose={() => setSelected(null)}
            onEdit={() => setEditing(selected)}
            onPrint={() => setPrintQueue([selected])}
            onChanged={load}
          />
        )}
      </div>

      {editing && (
        <BillModal
          bill={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function BillDrawer({ bill, canDelete, canEdit, onClose, onEdit, onPrint, onChanged }: {
  bill: ManualBill; canDelete: boolean; canEdit: boolean; onClose: () => void; onEdit: () => void; onPrint: () => void; onChanged: () => void;
}) {
  // 'void' = the reversible ยกเลิก confirm; 'delete' = the CEO-only ลบถาวร confirm (กู้คืนไม่ได้).
  const [confirming, setConfirming] = useState<'void' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function toggleVoid() {
    setBusy(true);
    setError('');
    try {
      await setManualBillVoid(bill.id, bill.billStatus !== 'void');
      setConfirming(null);
      onChanged();
    } catch {
      setError('บันทึกสถานะไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  async function hardDelete() {
    setBusy(true);
    setError('');
    try {
      await deleteManualBill(bill.id);
      setConfirming(null);
      onChanged(); // reload no longer finds this id → the drawer clears itself
      onClose();
    } catch (e) {
      // server 409 bill_linked: payments still carry this bill number in their chips
      setError((e as Error).message === 'HTTP 409'
        ? 'ลบไม่ได้ — มีรายการรับเงินอ้างถึงบิลนี้ (แก้เลขบิลออกจากรายการก่อน)'
        : 'ลบบิลไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="fixed inset-0 z-30 bg-slate-900/40 md:static md:bg-transparent md:z-auto md:w-[420px] md:shrink-0">
      <div className="absolute inset-x-0 bottom-0 top-10 md:static bg-white rounded-t-2xl md:rounded-xl border border-slate-200 overflow-y-auto md:sticky md:top-[104px] md:max-h-[calc(100vh-120px)]">
        <div className="sticky top-0 bg-white z-10 border-b border-slate-100 px-4 py-3 flex items-center justify-between gap-2">
          <div className="min-w-0"><div className="font-bold truncate">{bill.billNo}</div><BillStatusChip status={bill.billStatus} /></div>
          <div className="flex gap-1">
            <button onClick={onPrint} title="พิมพ์บิล" className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"><Printer size={16} /></button>
            {canEdit && <button onClick={onEdit} title="แก้ไข" className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"><PenLine size={16} /></button>}
            {canEdit && <button onClick={() => setConfirming('void')} title={bill.billStatus === 'void' ? 'กู้คืน' : 'ยกเลิกบิล'} className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-rose-50 hover:text-rose-600">
              {bill.billStatus === 'void' ? <RotateCcw size={16} /> : <Ban size={16} />}
            </button>}
            {/* ลบถาวร — CEO-only (canDelete = supervisor; server 403s everyone else). */}
            {canDelete && (
              <button onClick={() => setConfirming('delete')} title="ลบถาวร (กู้คืนไม่ได้)" className="p-2 rounded-lg border border-rose-200 text-rose-500 hover:bg-rose-50 hover:text-rose-700">
                <Trash2 size={16} />
              </button>
            )}
            <button onClick={onClose} title="ปิด" className="p-2 text-slate-400 hover:text-slate-600"><X size={18} /></button>
          </div>
        </div>

        {confirming === 'void' && (
          <div className="m-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-600 shrink-0" />
            <span className="flex-1">{bill.billStatus === 'void' ? 'กู้คืนบิลนี้?' : 'ยกเลิกบิลนี้? ข้อมูลจะยังอยู่และกู้คืนได้'}</span>
            <button disabled={busy} onClick={() => void toggleVoid()} className="px-2 py-1 rounded bg-amber-600 text-white disabled:opacity-50">ยืนยัน</button>
            <button disabled={busy} onClick={() => setConfirming(null)} className="px-2 py-1 rounded bg-white border border-slate-200">ปิด</button>
          </div>
        )}
        {confirming === 'delete' && (
          <div className="m-3 p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs flex items-center gap-2">
            <AlertTriangle size={14} className="text-rose-600 shrink-0" />
            <span className="flex-1">ลบบิล {bill.billNo} ถาวร? <b>กู้คืนไม่ได้</b></span>
            <button disabled={busy} onClick={() => void hardDelete()} className="px-2 py-1 rounded bg-rose-600 text-white disabled:opacity-50">ลบถาวร</button>
            <button disabled={busy} onClick={() => setConfirming(null)} className="px-2 py-1 rounded bg-white border border-slate-200">ปิด</button>
          </div>
        )}
        {error && <div className="m-3 p-2 bg-rose-50 text-rose-700 text-xs rounded-lg">{error}</div>}

        <div className="p-4 grid grid-cols-2 gap-3 text-sm">
          <Info label="วันที่" value={fmtDate(bill.billedAt)} />
          <Info label="ยอดรวม" value={<b>{baht(numberOf(bill.amount))}</b>} />
          <Info label="รหัสลูกค้า" value={bill.customerCode} />
          <Info label="ผู้ซื้อ" value={bill.buyerName} />
          <Info label="โทรศัพท์" value={bill.buyerPhone} />
          <div className="col-span-2"><Info label="ที่อยู่" value={bill.buyerAddress} /></div>
          <Info label="ผู้ออกบิล" value={bill.createdByName} />
          <Info label="สร้างเมื่อ" value={fmtDate(bill.createdAt)} />
        </div>

        <div className="px-4 pb-4">
          <div className="text-xs text-slate-400 mb-1.5">รายการ</div>
          <div className="rounded-lg border border-slate-200 overflow-hidden">
            {bill.items.map((item, index) => (
              <div key={index} className="p-2 border-b last:border-b-0 border-slate-100 text-xs flex gap-2">
                <span className="text-slate-400 w-5">{index + 1}.</span>
                <div className="flex-1 min-w-0"><div>{item.name}</div>{item.sku && <div className="text-slate-400">{item.sku}</div>}</div>
                <div className="text-right whitespace-nowrap"><div>{item.qty} × {baht(numberOf(item.unitPrice))}</div><b>{baht(numberOf(item.amount))}</b></div>
              </div>
            ))}
          </div>
        </div>

        <div className="px-4 pb-4">
          <div className="text-xs text-slate-400 mb-1.5">รายการรับเงินที่ผูกไว้</div>
          {bill.linkedPayments.length === 0 ? <div className="text-xs text-slate-400 p-3 rounded-lg bg-slate-50">ยังไม่มีรายการรับเงิน</div> : (
            <div className="space-y-1.5">
              {bill.linkedPayments.map((payment) => (
                <div key={payment.id} className="rounded-lg bg-slate-50 p-2 text-xs flex justify-between gap-2">
                  <div><div>{payment.customerName || '—'}</div><div className="text-slate-400">{fmtDate(payment.createdAt)} · {payment.source}</div></div>
                  <div className="text-right"><b>{baht(numberOf(payment.amount) + numberOf(payment.whtAmount))}</b><div className="text-slate-400">gross</div></div>
                </div>
              ))}
            </div>
          )}
        </div>
        {bill.note && <div className="mx-4 mb-4 p-3 rounded-lg bg-slate-50 text-xs whitespace-pre-wrap"><div className="text-slate-400 mb-1">หมายเหตุ</div>{bill.note}</div>}
      </div>
    </aside>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><div className="text-xs text-slate-400">{label}</div><div>{value || <span className="text-slate-300">—</span>}</div></div>;
}

type EditorLine = ManualBillItem & { key: number; mode: 'product' | 'free' };
let nextLineKey = 1;
const blankLine = (): EditorLine => ({ key: nextLineKey++, mode: 'product', name: '', qty: 1, unitPrice: '', amount: '' });

function BillModal({ bill, onClose, onSaved }: { bill: ManualBill | null; onClose: () => void; onSaved: () => void }) {
  const [billNo, setBillNo] = useState(bill?.billNo ?? '');
  const [billedAt, setBilledAt] = useState(bill?.billedAt || bangkokToday());
  const [customerCode, setCustomerCode] = useState(bill?.customerCode ?? '');
  const [buyerName, setBuyerName] = useState(bill?.buyerName ?? '');
  const [buyerPhone, setBuyerPhone] = useState(bill?.buyerPhone ?? '');
  const [buyerAddress, setBuyerAddress] = useState(bill?.buyerAddress ?? '');
  const [note, setNote] = useState(bill?.note ?? '');
  const [lines, setLines] = useState<EditorLine[]>(() => bill?.items.length
    ? bill.items.map((item) => ({ ...item, key: nextLineKey++, mode: item.productId || item.sku ? 'product' : 'free' }))
    : [blankLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const total = round2(lines.reduce((sum, line) => sum + numberOf(line.amount), 0));

  function updateLine(key: number, patch: Partial<EditorLine>, recompute = false) {
    setLines((current) => current.map((line) => {
      if (line.key !== key) return line;
      const next = { ...line, ...patch };
      return recompute ? { ...next, amount: moneyString(numberOf(String(next.qty)) * numberOf(next.unitPrice)) } : next;
    }));
  }

  async function save() {
    if (saving) return;
    if (!billedAt || lines.length === 0 || lines.some((line) => !line.name.trim() || line.qty <= 0)) {
      setError('กรุณากรอกวันที่และรายการให้ครบ');
      return;
    }
    if (!bill && billNo && /[/,\s]/.test(billNo)) {
      setError('เลขบิลห้ามมี / , หรือช่องว่าง');
      return;
    }
    const body: ManualBillBody = {
      ...(!bill && billNo.trim() ? { billNo: billNo.trim().toUpperCase() } : {}),
      billedAt, customerCode: customerCode.trim(), buyerName: buyerName.trim(), buyerPhone: buyerPhone.trim(),
      buyerAddress: buyerAddress.trim(), note: note.trim(), amount: moneyString(total),
      items: lines.map(({ key: _key, mode: _mode, ...line }) => ({
        ...(line.productId ? { productId: line.productId } : {}),
        ...(line.sku ? { sku: line.sku } : {}),
        name: line.name.trim(), qty: Number(line.qty), unitPrice: line.unitPrice.trim() || '0',
        amount: line.amount.trim() || '0',
      })),
    };
    setSaving(true);
    setError('');
    try {
      if (bill) await updateManualBill(bill.id, body);
      else await createManualBill(body);
      onSaved();
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message === 'HTTP 409' ? 'เลขบิลนี้มีอยู่แล้ว' : 'บันทึกบิลไม่สำเร็จ — กรุณาตรวจข้อมูลแล้วลองใหม่');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-3" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[94vh] overflow-y-auto" onClick={(event) => event.stopPropagation()}>
        <div className="sticky top-0 z-20 bg-white border-b border-slate-100 px-4 py-3 flex items-center justify-between">
          <div className="font-bold flex items-center gap-2"><ReceiptText size={18} className="text-emerald-700" />{bill ? `แก้ไข ${bill.billNo}` : 'ออกบิลมือ'}</div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600"><X size={19} /></button>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            {!bill && <Field label="เลขบิลเดิม (เว้นว่างเพื่อรันอัตโนมัติ)"><input value={billNo} onChange={(event) => setBillNo(event.target.value.replace(/\//g, '-').toUpperCase())} placeholder="เช่น 38/13 → 38-13" className="input" /></Field>}
            <Field label="วันที่"><input type="date" value={billedAt} onChange={(event) => setBilledAt(event.target.value)} className="input" /></Field>
            {/* รหัสก่อนชื่อ — owner form-field-order rule 2026-07-15 (CODE name) */}
            <Field label="รหัสลูกค้า (ถ้ามี)"><input value={customerCode} onChange={(event) => setCustomerCode(event.target.value)} className="input" /></Field>
            <Field label="ชื่อผู้ซื้อ"><input value={buyerName} onChange={(event) => setBuyerName(event.target.value)} className="input" /></Field>
            <Field label="เบอร์โทร"><input value={buyerPhone} onChange={(event) => setBuyerPhone(event.target.value)} className="input" /></Field>
            <div className="sm:col-span-2"><Field label="ที่อยู่"><textarea rows={2} value={buyerAddress} onChange={(event) => setBuyerAddress(event.target.value)} className="input" /></Field></div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2"><div className="font-semibold text-sm">รายการสินค้า</div><span className="text-xs text-slate-400">{lines.length}/40 รายการ</span></div>
            <div className="space-y-2">
              {lines.map((line, index) => (
                <div key={line.key} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-xs font-semibold text-slate-500">รายการ {index + 1}</span>
                    <div className="flex items-center gap-1">
                      <button type="button" onClick={() => updateLine(line.key, line.mode === 'product'
                        ? { mode: 'free', productId: undefined, sku: undefined }
                        : { mode: 'product' })} className="px-2 py-1 rounded-lg bg-slate-100 text-slate-600 text-xs">
                        {line.mode === 'product' ? 'กรอกเอง (นอกแคตตาล็อก)' : 'เลือกจากสินค้า'}
                      </button>
                      <button type="button" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))} className="p-1.5 text-slate-400 hover:text-rose-600 disabled:opacity-30"><Trash2 size={14} /></button>
                    </div>
                  </div>

                  {line.mode === 'product' && <ProductPicker onPick={(product) => updateLine(line.key, {
                    productId: product.id, sku: product.sku, name: product.name,
                    unitPrice: String(product.price), amount: moneyString(line.qty * product.price),
                  })} />}

                  <div className={`grid gap-2 mt-2 ${line.mode === 'product' ? 'sm:grid-cols-[120px_1fr_80px_120px_120px]' : 'sm:grid-cols-[1fr_80px_120px_120px]'}`}>
                    {line.mode === 'product' && <Field label="SKU"><input value={line.sku ?? ''} onChange={(event) => updateLine(line.key, { sku: event.target.value })} className="input" /></Field>}
                    <Field label="ชื่อรายการ"><input value={line.name} onChange={(event) => updateLine(line.key, { name: event.target.value })} className="input" /></Field>
                    <Field label="จำนวน"><input type="number" min="0.01" step="any" value={line.qty} onChange={(event) => updateLine(line.key, { qty: Number(event.target.value) }, true)} className="input text-right" /></Field>
                    <Field label="หน่วยละ"><input inputMode="decimal" value={line.unitPrice} onChange={(event) => updateLine(line.key, { unitPrice: event.target.value }, true)} className="input text-right" /></Field>
                    <Field label="จำนวนเงิน"><input inputMode="decimal" value={line.amount} onChange={(event) => updateLine(line.key, { amount: event.target.value })} className="input text-right font-semibold" /></Field>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" disabled={lines.length >= 40} onClick={() => setLines((current) => [...current, blankLine()])} className="mt-2 flex items-center gap-1 px-3 py-1.5 rounded-lg border border-dashed border-emerald-300 text-emerald-700 text-xs hover:bg-emerald-50 disabled:opacity-40"><Plus size={13} /> เพิ่มรายการ</button>
          </div>

          <div className="grid sm:grid-cols-[1fr_260px] gap-3 items-end">
            <Field label="หมายเหตุ"><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} className="input" /></Field>
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 flex justify-between"><span className="text-sm text-emerald-700">รวมทั้งสิ้น</span><b className="text-lg text-emerald-800">{baht(total)}</b></div>
          </div>

          {error && <div className="p-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-1"><AlertTriangle size={13} />{error}</div>}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-2 rounded-lg bg-slate-100 text-slate-600 text-sm">ยกเลิก</button>
            <button disabled={saving} onClick={() => void save()} className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold flex items-center gap-1 disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} บันทึกบิล
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="text-xs text-slate-500">{label}</span>{children}</label>;
}

function ProductPicker({ onPick }: { onPick: (product: ManualBillProduct) => void }) {
  const [q, setQ] = useState('');
  const [products, setProducts] = useState<ManualBillProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) { setProducts([]); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      getManualBillProducts(q.trim())
        .then((result) => { if (!cancelled) setProducts(result.products); })
        .catch(() => { if (!cancelled) setProducts([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q]);

  return (
    <div ref={wrapperRef} className="relative">
      <PackageSearch size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
      <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="ค้นหา SKU หรือชื่อสินค้า" className="input pl-8" />
      {loading && <Loader2 size={13} className="absolute right-2.5 top-2.5 text-slate-400 animate-spin" />}
      {q.trim() && !loading && products.length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl">
          {products.map((product) => (
            <button key={product.id} type="button" onClick={() => { onPick(product); setQ(''); setProducts([]); }} className="w-full px-3 py-2 text-left hover:bg-emerald-50 border-b last:border-b-0 border-slate-100">
              <div className="text-xs font-semibold text-slate-700">{product.sku} · {product.name}</div>
              <div className="text-[11px] text-slate-400">{product.price > 0 ? baht(product.price) : 'ไม่ระบุราคา'} · คงเหลือ {product.stock ?? '—'}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
