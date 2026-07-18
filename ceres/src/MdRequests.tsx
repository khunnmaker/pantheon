import { useCallback, useEffect, useState } from 'react';
import {
  Loader2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  CheckCircle2,
  Send,
  Plus,
  X,
  Banknote,
} from 'lucide-react';
import {
  createRequest,
  listRequests,
  markRequestPaid,
  cancelRequest,
  listTemplates,
  baht,
  type Category,
  type PaymentRequest,
  type RequestStatus,
  type RecurringTemplate,
} from './lib/api';
import { useCeres } from './lib/bootstrapContext';
import CategoryPicker from './components/CategoryPicker';

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

export function todayStr(): string {
  return new Date().toLocaleDateString('sv-SE');
}
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('sv-SE');
}

// Current period key for a recurring template, computed off "now" (Thai local time,
// which is what the browser clock reads for our staff). monthly -> YYYY-MM,
// quarterly -> YYYY-Qn, yearly -> YYYY.
export function currentPeriodKey(period: RecurringTemplate['period']): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11
  if (period === 'yearly') return String(y);
  if (period === 'quarterly') return `${y}-Q${Math.floor(m / 3) + 1}`;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

const STATUS_META: Record<RequestStatus, { label: string; cls: string }> = {
  requested: { label: 'รอ AI', cls: 'bg-slate-200 text-slate-600' },
  ai_approved: { label: 'AI อนุมัติ', cls: 'bg-emerald-100 text-emerald-700' },
  escalated: { label: 'รอ CEO', cls: 'bg-amber-100 text-amber-700' },
  ceo_approved: { label: 'CEO อนุมัติ', cls: 'bg-emerald-100 text-emerald-700' },
  rejected: { label: 'ปฏิเสธ', cls: 'bg-rose-100 text-rose-700' },
  cancelled: { label: 'ยกเลิก', cls: 'bg-slate-200 text-slate-500' },
  paid: { label: 'จ่ายแล้ว', cls: 'bg-sky-100 text-sky-700' },
};

// Prefill payload passed in from MdTemplates's "สร้างคำขอจ่าย" button.
export interface RequestPrefill {
  payee: string;
  entity: string;
  category: string;
  amount: string;
  recurringTemplateId: string;
  billPeriod: string;
}

export default function MdRequests({
  prefill,
  onConsumePrefill,
}: {
  prefill: RequestPrefill | null;
  onConsumePrefill: () => void;
}) {
  const { bootstrap } = useCeres();
  const [formOpen, setFormOpen] = useState(!!prefill);
  const [status, setStatus] = useState<RequestStatus | ''>('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState(daysAgoStr(30));
  const [to, setTo] = useState(todayStr());
  const [rows, setRows] = useState<PaymentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (prefill) setFormOpen(true);
  }, [prefill]);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    listRequests({ status: status || undefined, from: from || undefined, to: to || undefined, q: q || undefined, limit: 200 })
      .then((r) => setRows(r.requests))
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, [status, from, to, q]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const bump = () => setRefreshKey((k) => k + 1);

  return (
    <div>
      <h2 className="text-lg font-bold mb-3">จ่ายเงิน</h2>

      <RequestForm
        entities={bootstrap.entities}
        categories={bootstrap.categories}
        open={formOpen}
        setOpen={setFormOpen}
        prefill={prefill}
        onConsumePrefill={onConsumePrefill}
        onCreated={bump}
      />

      <div className="bg-white rounded-xl border border-slate-200 p-3 mb-3 flex flex-wrap items-center gap-2 mt-4">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as RequestStatus | '')}
          className="px-2 py-2 rounded-lg border border-slate-300 text-sm bg-white"
        >
          <option value="">ทุกสถานะ</option>
          {(Object.keys(STATUS_META) as RequestStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_META[s].label}
            </option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ค้นหาผู้รับเงิน/รายละเอียด"
          className="px-2 py-2 rounded-lg border border-slate-300 text-sm flex-1 min-w-[140px]"
        />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-2 rounded-lg border border-slate-300 text-sm" />
      </div>

      {error ? (
        <div className="flex items-center gap-1 text-rose-600 text-sm py-6 justify-center">
          <AlertTriangle size={15} /> {error}
        </div>
      ) : loading ? (
        <div className="py-10 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-10">ไม่มีรายการ</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <RequestRow
              key={r.id}
              r={r}
              expanded={expandedId === r.id}
              onToggle={() => setExpandedId((id) => (id === r.id ? '' : r.id))}
              onChanged={bump}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RequestRow({ r, expanded, onToggle, onChanged }: { r: PaymentRequest; expanded: boolean; onToggle: () => void; onChanged: () => void }) {
  const [payingOpen, setPayingOpen] = useState(false);
  const [paidRef, setPaidRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  const canPay = r.status === 'ai_approved' || r.status === 'ceo_approved';
  const canCancel = r.status === 'requested' || r.status === 'escalated';

  async function handlePaid() {
    setBusy(true);
    setError('');
    try {
      await markRequestPaid(r.id, paidRef.trim() || undefined);
      setPayingOpen(false);
      setPaidRef('');
      onChanged();
    } catch {
      setError('บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    setBusy(true);
    setError('');
    try {
      await cancelRequest(r.id);
      setConfirmCancel(false);
      onChanged();
    } catch {
      setError('ยกเลิกไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-start gap-3 px-3 py-3 text-left">
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-sm truncate">{r.payee}</span>
            <span className="font-bold">{baht(r.amountNum)}</span>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-1 items-center">
            <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">{r.entity}</span>
            <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs">{r.category}</span>
            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_META[r.status].cls}`}>{STATUS_META[r.status].label}</span>
          </div>
        </div>
        {expanded ? <ChevronUp size={16} className="mt-1 shrink-0 text-slate-400" /> : <ChevronDown size={16} className="mt-1 shrink-0 text-slate-400" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-slate-100 pt-2 text-sm">
          {r.detail && <div className="text-slate-600 mb-1">รายละเอียด: {r.detail}</div>}
          {r.billPeriod && <div className="text-xs text-slate-400 mb-1">งวด: {r.billPeriod}</div>}
          <div className="text-xs text-slate-400 mb-1">ผู้ขอ: {r.requestedByName}</div>
          {r.aiReview && (
            <div className="mt-1.5 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200">
              <div className="text-xs font-semibold text-slate-500 mb-0.5">เหตุผลของ AI</div>
              <div className="text-xs text-slate-600">{r.aiReview.reasoning}</div>
            </div>
          )}
          {r.decisionNote && (
            <div className="mt-1.5 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200">
              <div className="text-xs font-semibold text-slate-500 mb-0.5">หมายเหตุการตัดสิน</div>
              <div className="text-xs text-slate-600">{r.decisionNote}</div>
            </div>
          )}
          {r.paidRef && <div className="text-xs text-slate-400 mt-1.5">อ้างอิงการจ่าย: {r.paidRef}</div>}

          {error && (
            <div className="flex items-center gap-1 text-rose-600 text-xs mt-2">
              <AlertTriangle size={12} /> {error}
            </div>
          )}

          {canPay && (
            <div className="mt-2 pt-2 border-t border-slate-100">
              {payingOpen ? (
                <div className="space-y-2">
                  <input
                    value={paidRef}
                    onChange={(e) => setPaidRef(e.target.value)}
                    placeholder="อ้างอิงการจ่าย (ถ้ามี)"
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handlePaid}
                      disabled={busy}
                      className="flex-1 min-h-[40px] rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} ยืนยันจ่ายแล้ว
                    </button>
                    <button
                      onClick={() => setPayingOpen(false)}
                      disabled={busy}
                      className="px-3 min-h-[40px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
                    >
                      ยกเลิก
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setPayingOpen(true)}
                  className="w-full min-h-[40px] rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold flex items-center justify-center gap-1"
                >
                  <Banknote size={14} /> บันทึกว่าจ่ายแล้ว
                </button>
              )}
            </div>
          )}

          {canCancel && (
            <div className="mt-2 pt-2 border-t border-slate-100">
              {confirmCancel ? (
                <div className="flex gap-2">
                  <button
                    onClick={handleCancel}
                    disabled={busy}
                    className="flex-1 min-h-[40px] rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-40"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} ยืนยันยกเลิก
                  </button>
                  <button
                    onClick={() => setConfirmCancel(false)}
                    disabled={busy}
                    className="px-3 min-h-[40px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
                  >
                    กลับ
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmCancel(true)}
                  className="w-full min-h-[40px] rounded-lg border border-rose-300 text-rose-600 hover:bg-rose-50 text-sm font-semibold flex items-center justify-center gap-1"
                >
                  <X size={14} /> ยกเลิกคำขอ
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RequestForm({
  entities,
  categories,
  open,
  setOpen,
  prefill,
  onConsumePrefill,
  onCreated,
}: {
  entities: string[];
  categories: Category[];
  open: boolean;
  setOpen: (v: boolean) => void;
  prefill: RequestPrefill | null;
  onConsumePrefill: () => void;
  onCreated: () => void;
}) {
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [payee, setPayee] = useState('');
  const [amount, setAmount] = useState('');
  // NO lazy default (owner rule, 2026-07-18) — entity starts empty; a template/prefill
  // apply still fills it explicitly via applyTemplate()/the prefill effect below.
  const [entity, setEntity] = useState('');
  const [category, setCategory] = useState('');
  const [detail, setDetail] = useState('');
  const [billPeriod, setBillPeriod] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PaymentRequest | null>(null);

  useEffect(() => {
    listTemplates()
      .then((r) => setTemplates(r.templates.filter((t) => t.active)))
      .catch(() => setTemplates([]));
  }, []);

  useEffect(() => {
    if (!prefill) return;
    setPayee(prefill.payee);
    setEntity(prefill.entity);
    setCategory(prefill.category);
    setAmount(prefill.amount);
    setTemplateId(prefill.recurringTemplateId);
    setBillPeriod(prefill.billPeriod);
    onConsumePrefill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  function applyTemplate(id: string) {
    setTemplateId(id);
    if (!id) return;
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setPayee(t.payee);
    setEntity(t.entity);
    setCategory(t.category);
    setAmount(t.expectedAmount);
    setBillPeriod(currentPeriodKey(t.period));
  }

  function resetForm() {
    setTemplateId('');
    setPayee('');
    setAmount('');
    setCategory('');
    setDetail('');
    setBillPeriod('');
  }

  async function submit() {
    setError('');
    setResult(null);
    if (!payee.trim()) return setError('กรอกชื่อผู้รับเงิน');
    if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) return setError('กรอกจำนวนเงินให้ถูกต้อง');
    if (!entity) return setError('เลือกบริษัท');
    if (!category) return setError('เลือกหมวดหมู่');
    setBusy(true);
    try {
      const { request } = await createRequest({
        entity,
        payee: payee.trim(),
        category,
        amount,
        detail: detail.trim() || undefined,
        recurringTemplateId: templateId || undefined,
        billPeriod: billPeriod || undefined,
      });
      setResult(request);
      resetForm();
      onCreated();
    } catch {
      setError('ส่งคำขอไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3 font-semibold text-slate-700">
        <span className="flex items-center gap-2">
          <Plus size={18} className="text-amber-600" /> ขอจ่ายเงินใหม่
        </span>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-2 border-t border-slate-100">
          {templates.length > 0 && (
            <select
              value={templateId}
              onChange={(e) => applyTemplate(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm bg-white min-h-[44px]"
            >
              <option value="">ไม่ใช้รายการประจำ</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.payee} ({t.entity})
                </option>
              ))}
            </select>
          )}

          <input
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            placeholder="ผู้รับเงิน"
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]"
          />
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="จำนวนเงิน"
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]"
          />

          <div className="flex gap-2">
            {entities.map((e) => (
              <button
                key={e}
                onClick={() => setEntity(e)}
                className={`flex-1 min-h-[44px] rounded-lg border text-sm font-semibold ${
                  entity === e ? 'bg-amber-600 border-amber-600 text-white' : 'border-slate-300 text-slate-600'
                }`}
              >
                {e}
              </button>
            ))}
          </div>

          <CategoryPicker categories={categories} value={category} onChange={setCategory} getKey={(c) => c.name} />

          <input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder="รายละเอียด (ถ้ามี)"
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]"
          />

          {templateId && (
            <input
              value={billPeriod}
              onChange={(e) => setBillPeriod(e.target.value)}
              placeholder="งวดบิล เช่น 2026-07"
              className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]"
            />
          )}

          {error && (
            <div className="flex items-center gap-1 text-rose-600 text-xs">
              <AlertTriangle size={12} /> {error}
            </div>
          )}

          <button
            onClick={submit}
            disabled={busy}
            className="w-full min-h-[44px] rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} ส่งคำขอ
          </button>

          {result && (
            <div
              className={`mt-2 p-3 rounded-lg border text-sm ${
                result.status === 'ai_approved' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'
              }`}
            >
              <div className="flex items-center gap-1.5 font-semibold mb-1">
                {result.status === 'ai_approved' ? (
                  <>
                    <CheckCircle2 size={15} /> AI อนุมัติ — จ่ายได้เลย
                  </>
                ) : (
                  <>
                    <ChevronRight size={15} /> ส่งเรื่องให้ CEO แล้ว
                  </>
                )}
              </div>
              {result.aiReview && <div className="text-xs opacity-90">{result.aiReview.reasoning}</div>}
              {result.status === 'escalated' && <div className="text-xs opacity-90 mt-1">แจ้งเตือนไปยัง LINE ของ CEO แล้ว</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
