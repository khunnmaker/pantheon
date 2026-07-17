import { useEffect, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { createGoal, createHabit, getGoals, updateGoal, updateHabit } from '../lib/api';
import { bangkokTodayKey } from '../lib/dates';
import type { GoalStatus, HabitCadence, HestiaGoal, HestiaHabit } from '../types';
import ModalShell from './Shell';

const STATUS_LABEL: Record<GoalStatus, string> = { active: 'กำลังทำ', completed: 'สำเร็จ', archived: 'เก็บเข้าคลัง' };
const CADENCE_LABEL: Record<HabitCadence, string> = { daily: 'ทุกวัน', weekdays: 'วันธรรมดา', custom: 'กำหนดเอง' };
const WEEKDAY_LABELS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

// Goals tab: YearSelector, GoalCard, nested HabitList, GoalFormModal, HabitFormModal, with
// active/completed/archived filtering (via includeArchived + each goal's own status badge).
export default function Goals() {
  const nowYear = new Date().getFullYear();
  const [year, setYear] = useState(nowYear);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [goals, setGoals] = useState<HestiaGoal[] | null>(null);
  const [goalModal, setGoalModal] = useState<{ goal?: HestiaGoal } | null>(null);
  const [habitModal, setHabitModal] = useState<{ goal: HestiaGoal; habit?: HestiaHabit } | null>(null);

  async function refresh() { setGoals(await getGoals(year, includeArchived)); }
  useEffect(() => { setGoals(null); void refresh(); }, [year, includeArchived]);

  if (!goals) return <div className="py-16 text-center text-stone-400"><Loader2 className="mx-auto animate-spin" size={20}/></div>;

  return <div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <YearSelector year={year} onChange={setYear}/>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-stone-500"><input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)}/> แสดงที่เก็บเข้าคลัง</label>
        <button onClick={() => setGoalModal({})} className="btn-primary"><Plus size={16}/> เป้าหมาย</button>
      </div>
    </div>
    <div className="mt-4 space-y-4">
      {!goals.length && <div className="rounded-2xl border border-dashed border-stone-300 bg-white py-16 text-center text-sm text-stone-400">ยังไม่มีเป้าหมายในปีนี้</div>}
      {goals.map((goal) => (
        <GoalCard key={goal.id} goal={goal}
          onEditGoal={() => setGoalModal({ goal })}
          onAddHabit={() => setHabitModal({ goal })}
          onEditHabit={(habit) => setHabitModal({ goal, habit })}/>
      ))}
    </div>
    {goalModal && <GoalFormModal goal={goalModal.goal} year={year} onClose={() => setGoalModal(null)} onSaved={async () => { setGoalModal(null); await refresh(); }}/>}
    {habitModal && <HabitFormModal goal={habitModal.goal} habit={habitModal.habit} onClose={() => setHabitModal(null)} onSaved={async () => { setHabitModal(null); await refresh(); }}/>}
  </div>;
}

function YearSelector({ year, onChange }: { year: number; onChange: (year: number) => void }) {
  const years = Array.from({ length: 6 }, (_, i) => year - 2 + i);
  return <div className="inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white pl-3 pr-1">
    <select value={year} onChange={(e) => onChange(Number(e.target.value))} className="rounded-xl border-0 bg-transparent py-2 pr-2 text-sm font-semibold outline-none">
      {years.map((y) => <option key={y} value={y}>{y}</option>)}
    </select>
  </div>;
}

function GoalCard({ goal, onEditGoal, onAddHabit, onEditHabit }: {
  goal: HestiaGoal; onEditGoal: () => void; onAddHabit: () => void; onEditHabit: (habit: HestiaHabit) => void;
}) {
  return <section className="rounded-2xl border border-stone-200 bg-white p-4">
    <div className="flex items-start justify-between gap-2">
      <button onClick={onEditGoal} className="flex min-w-0 items-center gap-2 text-left">
        <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: goal.color }}/>
        <span className="truncate font-bold text-stone-800">{goal.code} · {goal.title}</span>
      </button>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${goal.status === 'active' ? 'bg-emerald-50 text-emerald-700' : goal.status === 'completed' ? 'bg-sky-50 text-sky-700' : 'bg-stone-100 text-stone-500'}`}>
        {STATUS_LABEL[goal.status]}
      </span>
    </div>
    {goal.description && <p className="mt-1 text-xs text-stone-500">{goal.description}</p>}
    <HabitList habits={goal.habits} onEdit={onEditHabit}/>
    <button onClick={onAddHabit} className="mt-3 text-sm text-amber-700 hover:underline">+ เพิ่มนิสัย</button>
  </section>;
}

function HabitList({ habits, onEdit }: { habits: HestiaHabit[]; onEdit: (habit: HestiaHabit) => void }) {
  if (!habits.length) return <p className="mt-3 text-xs text-stone-400">ยังไม่มีนิสัย</p>;
  return <div className="mt-3 space-y-1.5">
    {habits.map((habit) => (
      <button key={habit.id} onClick={() => onEdit(habit)}
        className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-sm ${habit.active ? 'border-stone-200 hover:border-amber-300' : 'border-stone-100 bg-stone-50 text-stone-400'}`}>
        <span className="truncate">{habit.code} · {habit.title}</span>
        <span className="shrink-0 text-xs text-stone-400">{CADENCE_LABEL[habit.cadence]}</span>
      </button>
    ))}
  </div>;
}

// Goal create/edit form order (plan §4): code first, then title, year, description, color/status.
function GoalFormModal({ goal, year, onClose, onSaved }: { goal?: HestiaGoal; year: number; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(goal?.code ?? '');
  const [title, setTitle] = useState(goal?.title ?? '');
  const [goalYear, setGoalYear] = useState(goal?.year ?? year);
  const [description, setDescription] = useState(goal?.description ?? '');
  const [color, setColor] = useState(goal?.color ?? '#b45309');
  const [status, setStatus] = useState<GoalStatus>(goal?.status ?? 'active');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!code.trim() || !title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      if (goal) await updateGoal(goal.id, { code: code.trim(), title: title.trim(), year: goalYear, description, color, status });
      else await createGoal({ code: code.trim(), title: title.trim(), year: goalYear, description, color });
      onSaved();
    } catch (err) {
      setError(err instanceof Error && err.message === 'code_taken' ? 'รหัสนี้ถูกใช้แล้วในปีนี้' : 'บันทึกไม่สำเร็จ');
    } finally { setBusy(false); }
  }

  return <ModalShell title={goal ? 'แก้ไขเป้าหมาย' : 'เป้าหมายใหม่'} onClose={onClose}>
    <label className="label">รหัส</label>
    <input className="input" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="เช่น G01"/>
    <label className="label">ชื่อเป้าหมาย</label>
    <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}/>
    <label className="label">ปี</label>
    <input type="number" className="input" value={goalYear} onChange={(e) => setGoalYear(Number(e.target.value))}/>
    <label className="label">รายละเอียด</label>
    <textarea className="input min-h-20" value={description} onChange={(e) => setDescription(e.target.value)}/>
    <div className="grid grid-cols-2 gap-3">
      <div><label className="label">สี</label><input type="color" className="input h-10 p-1" value={color} onChange={(e) => setColor(e.target.value)}/></div>
      {goal && <div><label className="label">สถานะ</label>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value as GoalStatus)}>
          {(['active', 'completed', 'archived'] as GoalStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </div>}
    </div>
    {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
    <div className="mt-5 flex justify-end gap-2">
      <button onClick={onClose} className="btn">ยกเลิก</button>
      <button onClick={() => void save()} disabled={busy || !code.trim() || !title.trim()} className="btn-primary">{busy && <Loader2 size={15} className="animate-spin"/>} บันทึก</button>
    </div>
  </ModalShell>;
}

// Habit create/edit form order (plan §4): code first, then title, goal, cadence/schedule,
// target, dates, description/status. `goal` is fixed to the goal this modal was opened from
// (Goals view is grouped per-goal), shown read-only for identity context.
function HabitFormModal({ goal, habit, onClose, onSaved }: { goal: HestiaGoal; habit?: HestiaHabit; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(habit?.code ?? '');
  const [title, setTitle] = useState(habit?.title ?? '');
  const [cadence, setCadence] = useState<HabitCadence>(habit?.cadence ?? 'daily');
  const [scheduleDays, setScheduleDays] = useState<number[]>(habit?.scheduleDays ?? [0, 1, 2, 3, 4, 5, 6]);
  const [targetCount, setTargetCount] = useState(habit?.targetCount ?? 1);
  const [startDate, setStartDate] = useState(habit?.startDate.slice(0, 10) ?? bangkokTodayKey());
  const [endDate, setEndDate] = useState(habit?.endDate?.slice(0, 10) ?? '');
  const [description, setDescription] = useState(habit?.description ?? '');
  const [active, setActive] = useState(habit?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function toggleDay(day: number) {
    setScheduleDays((days) => (days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b)));
  }

  async function save() {
    if (!code.trim() || !title.trim() || busy) return;
    setBusy(true); setError('');
    const base = {
      code: code.trim(), title: title.trim(), goalId: goal.id, cadence,
      scheduleDays: cadence === 'custom' ? scheduleDays : undefined,
      targetCount, startDate, endDate: endDate || null, description,
    };
    try {
      if (habit) await updateHabit(habit.id, { ...base, active });
      else await createHabit(base);
      onSaved();
    } catch (err) {
      setError(err instanceof Error && err.message === 'code_taken' ? 'รหัสนี้ถูกใช้แล้วในเป้าหมายนี้' : 'บันทึกไม่สำเร็จ');
    } finally { setBusy(false); }
  }

  return <ModalShell title={habit ? 'แก้ไขนิสัย' : 'นิสัยใหม่'} onClose={onClose}>
    <label className="label">รหัส</label>
    <input className="input" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="เช่น H01"/>
    <label className="label">ชื่อนิสัย</label>
    <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}/>
    <label className="label">เป้าหมาย</label>
    <input className="input bg-stone-50 text-stone-500" value={`${goal.code} · ${goal.title}`} disabled/>
    <label className="label">ความถี่</label>
    <div className="flex flex-wrap gap-1.5">
      {(['daily', 'weekdays', 'custom'] as HabitCadence[]).map((c) => (
        <button key={c} type="button" onClick={() => setCadence(c)}
          className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium ${cadence === c ? 'border-transparent bg-amber-50 text-amber-700 ring-2 ring-amber-300' : 'border-stone-200 text-stone-500 hover:border-stone-300'}`}>
          {CADENCE_LABEL[c]}
        </button>
      ))}
    </div>
    {cadence === 'custom' && <div className="mt-2 flex flex-wrap gap-1.5">
      {WEEKDAY_LABELS.map((label, day) => (
        <button key={day} type="button" onClick={() => toggleDay(day)}
          className={`h-8 w-8 rounded-full text-xs font-semibold ${scheduleDays.includes(day) ? 'bg-amber-600 text-white' : 'bg-stone-100 text-stone-500'}`}>
          {label}
        </button>
      ))}
    </div>}
    <label className="label">เป้าจำนวนครั้งต่อวัน</label>
    <input type="number" min={1} className="input" value={targetCount} onChange={(e) => setTargetCount(Math.max(1, Number(e.target.value)))}/>
    <div className="grid grid-cols-2 gap-3">
      <div><label className="label">วันเริ่ม</label><input type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)}/></div>
      <div><label className="label">วันสิ้นสุด</label><input type="date" className="input" min={startDate} value={endDate} onChange={(e) => setEndDate(e.target.value)}/></div>
    </div>
    <label className="label">รายละเอียด</label>
    <textarea className="input min-h-16" value={description} onChange={(e) => setDescription(e.target.value)}/>
    {habit && <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)}/> ใช้งานอยู่</label>}
    {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
    <div className="mt-5 flex justify-end gap-2">
      <button onClick={onClose} className="btn">ยกเลิก</button>
      <button onClick={() => void save()} disabled={busy || !code.trim() || !title.trim()} className="btn-primary">{busy && <Loader2 size={15} className="animate-spin"/>} บันทึก</button>
    </div>
  </ModalShell>;
}
