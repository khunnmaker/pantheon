import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Plus, Pencil, X, ShieldAlert, ArrowRight } from 'lucide-react';
import {
  listTemplatesDue,
  createTemplate,
  updateTemplate,
  baht,
  type Category,
  type TemplateDue,
  type RecurringTemplate,
  type TemplatePeriod,
} from './lib/api';
import { useCeres } from './lib/bootstrapContext';
import type { RequestSheetPrefill } from './RequestSheet';
import CategoryPicker from './components/CategoryPicker';

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

const PERIOD_LABEL: Record<TemplatePeriod, string> = {
  monthly: 'รายเดือน',
  quarterly: 'รายไตรมาส',
  yearly: 'รายปี',
};

const STATE_META: Record<TemplateDue['state'], { label: string; cls: string }> = {
  paid: { label: 'จ่ายแล้ว', cls: 'bg-emerald-100 text-emerald-700' },
  pending: { label: 'รอดำเนินการ', cls: 'bg-amber-100 text-amber-700' },
  missing: { label: 'ยังไม่จ่าย', cls: 'bg-slate-200 text-slate-600' },
  overdue: { label: 'เลยกำหนด', cls: 'bg-rose-100 text-rose-700' },
};

export default function MdTemplates({ onCreateRequest }: { onCreateRequest: (prefill: RequestSheetPrefill) => void }) {
  const { bootstrap } = useCeres();
  const [due, setDue] = useState<TemplateDue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [editing, setEditing] = useState<RecurringTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    listTemplatesDue()
      .then((r) => setDue(r.due))
      .catch(() => setError('โหลดข้อมูลไม่สำเร็จ'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const bump = () => setRefreshKey((k) => k + 1);
  const overdueCount = due.filter((d) => d.state === 'overdue').length;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold">รายการประจำ</h2>
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1 px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold"
        >
          <Plus size={15} /> เพิ่มรายการ
        </button>
      </div>

      {overdueCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-sm mb-3">
          <ShieldAlert size={16} className="shrink-0" /> มี {overdueCount} รายการเลยกำหนดจ่าย
        </div>
      )}

      {(creating || editing) && (
        <TemplateDialog
          entities={bootstrap.entities}
          categories={bootstrap.categories}
          template={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            bump();
          }}
        />
      )}

      {error ? (
        <div className="flex items-center gap-1 text-rose-600 text-sm py-6 justify-center">
          <AlertTriangle size={15} /> {error}
        </div>
      ) : loading ? (
        <div className="py-10 flex justify-center text-slate-400">
          <Loader2 className="animate-spin" size={22} />
        </div>
      ) : due.length === 0 ? (
        <div className="text-center text-slate-400 text-sm py-10">ยังไม่มีรายการประจำ</div>
      ) : (
        <div className="space-y-2">
          {due.map((d) => (
            <div key={d.template.id} className={`bg-white rounded-xl border p-3 ${d.state === 'overdue' ? 'border-rose-300' : 'border-slate-200'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">{d.template.payee}</div>
                  <div className="text-xs text-slate-400">
                    {baht(Number(d.template.expectedAmount))} ± {d.template.tolerancePct}% · {PERIOD_LABEL[d.template.period]}
                  </div>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${STATE_META[d.state].cls}`}>{STATE_META[d.state].label}</span>
              </div>
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100 text-xs text-slate-500">
                <span>ครบกำหนด: {d.dueDate}</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setEditing(d.template)} className="flex items-center gap-1 text-slate-500 hover:text-slate-700">
                    <Pencil size={13} /> แก้ไข
                  </button>
                  {d.state !== 'paid' && (
                    <button
                      onClick={() =>
                        onCreateRequest({
                          amount: d.template.expectedAmount,
                          category: d.template.category,
                          reason: d.template.payee,
                        })
                      }
                      className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold"
                    >
                      สร้างคำขอจ่าย <ArrowRight size={12} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateDialog({
  entities,
  categories,
  template,
  onClose,
  onSaved,
}: {
  entities: string[];
  categories: Category[];
  template: RecurringTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [payee, setPayee] = useState(template?.payee ?? '');
  // NO lazy default (owner rule, 2026-07-18) — only an existing template pre-fills entity.
  const [entity, setEntity] = useState(template?.entity ?? '');
  const [category, setCategory] = useState(template?.category ?? '');
  const [expectedAmount, setExpectedAmount] = useState(template?.expectedAmount ?? '');
  const [tolerancePct, setTolerancePct] = useState(String(template?.tolerancePct ?? 10));
  const [period, setPeriod] = useState<TemplatePeriod>(template?.period ?? 'monthly');
  const [dueDay, setDueDay] = useState(String(template?.dueDay ?? 5));
  const [graceDays, setGraceDays] = useState(String(template?.graceDays ?? 3));
  const [active, setActive] = useState(template?.active ?? true);
  const [note, setNote] = useState(template?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    if (!payee.trim()) return setError('กรอกชื่อผู้รับเงิน');
    if (!entity) return setError('เลือกบริษัท');
    if (!AMOUNT_RE.test(expectedAmount) || Number(expectedAmount) <= 0) return setError('กรอกจำนวนเงินให้ถูกต้อง');
    if (!category) return setError('เลือกหมวดหมู่');
    const dueDayNum = Number(dueDay);
    const graceDaysNum = Number(graceDays);
    const toleranceNum = Number(tolerancePct);
    if (!Number.isInteger(dueDayNum) || dueDayNum < 1 || dueDayNum > 31) return setError('วันครบกำหนดไม่ถูกต้อง');
    if (!Number.isInteger(graceDaysNum) || graceDaysNum < 0) return setError('จำนวนวันผ่อนผันไม่ถูกต้อง');
    if (!Number.isFinite(toleranceNum) || toleranceNum < 0) return setError('เปอร์เซ็นต์คลาดเคลื่อนไม่ถูกต้อง');

    setBusy(true);
    try {
      const body = {
        payee: payee.trim(),
        entity,
        category,
        expectedAmount,
        tolerancePct: toleranceNum,
        period,
        dueDay: dueDayNum,
        graceDays: graceDaysNum,
        active,
        note: note.trim() || undefined,
      };
      if (template) {
        await updateTemplate(template.id, body);
      } else {
        await createTemplate(body);
      }
      onSaved();
    } catch {
      setError('บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold text-lg">{template ? 'แก้ไขรายการประจำ' : 'เพิ่มรายการประจำ'}</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-2">
          <input
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            placeholder="ผู้รับเงิน"
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

          <div className="grid grid-cols-2 gap-2">
            <input
              inputMode="decimal"
              value={expectedAmount}
              onChange={(e) => setExpectedAmount(e.target.value)}
              placeholder="จำนวนเงินที่คาด"
              className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]"
            />
            <input
              inputMode="decimal"
              value={tolerancePct}
              onChange={(e) => setTolerancePct(e.target.value)}
              placeholder="คลาดเคลื่อน %"
              className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]"
            />
          </div>

          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as TemplatePeriod)}
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm bg-white min-h-[44px]"
          >
            <option value="monthly">รายเดือน</option>
            <option value="quarterly">รายไตรมาส</option>
            <option value="yearly">รายปี</option>
          </select>

          <div className="grid grid-cols-2 gap-2">
            <input
              inputMode="numeric"
              value={dueDay}
              onChange={(e) => setDueDay(e.target.value)}
              placeholder="วันครบกำหนด"
              className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]"
            />
            <input
              inputMode="numeric"
              value={graceDays}
              onChange={(e) => setGraceDays(e.target.value)}
              placeholder="วันผ่อนผัน"
              className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]"
            />
          </div>

          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="หมายเหตุ (ถ้ามี)"
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm min-h-[44px]"
          />

          <label className="flex items-center gap-2 text-sm text-slate-600 px-1 py-1">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4" />
            เปิดใช้งาน
          </label>

          {error && (
            <div className="flex items-center gap-1 text-rose-600 text-xs">
              <AlertTriangle size={12} /> {error}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={submit}
              disabled={busy}
              className="flex-1 min-h-[44px] rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold flex items-center justify-center gap-1 disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : 'บันทึก'}
            </button>
            <button onClick={onClose} disabled={busy} className="px-4 min-h-[44px] rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50">
              ยกเลิก
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
