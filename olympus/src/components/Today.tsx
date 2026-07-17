import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Flame, Loader2, NotebookPen } from 'lucide-react';
import { deleteCheckIn, getOverview, putCheckIn } from '../lib/api';
import { addDaysToKey, bangkokTodayKey, longThaiDate } from '../lib/dates';
import type { HestiaCheckIn, HestiaHabit, HestiaOverview } from '../types';
import JournalEditorModal from './JournalEditorModal';

// Today tab: DateNavigator, DailyProgressRing, goal-grouped HabitChecklist/HabitCheckRow with an
// optimistic checkbox (rolled back on failure), StreakBadge, and a QuickJournalCard shortcut.
export default function Today() {
  const todayKey = bangkokTodayKey();
  const [date, setDate] = useState(todayKey);
  const [overview, setOverview] = useState<HestiaOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [journalOpen, setJournalOpen] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void getOverview(date).then((value) => { if (alive) { setOverview(value); setLoading(false); } }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [date]);

  const checkInByHabit = useMemo(() => new Map((overview?.checkIns ?? []).map((c) => [c.habitId, c])), [overview]);

  async function toggle(habit: HestiaHabit) {
    if (!overview || pending.has(habit.id)) return;
    const existing = checkInByHabit.get(habit.id);
    const isDone = (existing?.count ?? 0) >= habit.targetCount;
    const prevOverview = overview;
    setPending((current) => new Set(current).add(habit.id));

    // Optimistic flip of this habit's check-in + the day's completed total; rolled back on failure.
    const now = new Date().toISOString();
    const nextCheckIns = isDone
      ? overview.checkIns.filter((c) => c.habitId !== habit.id)
      : [...overview.checkIns.filter((c) => c.habitId !== habit.id), {
          id: `optimistic-${habit.id}`, ownerId: habit.ownerId, habitId: habit.id, checkDate: date,
          count: habit.targetCount, note: '', completedAt: now, createdAt: now, updatedAt: now,
        } as HestiaCheckIn];
    setOverview({ ...overview, checkIns: nextCheckIns, totals: { ...overview.totals, completed: overview.totals.completed + (isDone ? -1 : 1) } });

    try {
      const result = isDone ? await deleteCheckIn(habit.id, date) : await putCheckIn(habit.id, date, { count: habit.targetCount });
      setOverview((current) => {
        if (!current) return current;
        const goals = current.goals.map((goal) => ({
          ...goal,
          habits: goal.habits.map((h) => (h.id === habit.id ? { ...h, streak: result.streak ?? h.streak } : h)),
        }));
        return { ...current, goals };
      });
    } catch {
      setOverview(prevOverview);
    } finally {
      setPending((current) => { const next = new Set(current); next.delete(habit.id); return next; });
    }
  }

  function go(delta: number) { setDate((current) => addDaysToKey(current, delta)); }

  if (loading && !overview) return <div className="py-16 text-center text-stone-400"><Loader2 className="mx-auto animate-spin" size={20}/></div>;
  if (!overview) return <div className="py-16 text-center text-stone-400">โหลดไม่สำเร็จ</div>;

  return <div>
    <DateNavigator date={date} todayKey={todayKey} onPrev={() => go(-1)} onNext={() => go(1)} onToday={() => setDate(todayKey)}/>

    <div className="mt-4 flex items-center gap-4">
      <DailyProgressRing completed={overview.totals.completed} total={overview.totals.total}/>
      <div>
        <div className="text-2xl font-bold text-stone-800">{overview.totals.completed} / {overview.totals.total}</div>
        <div className="text-xs text-stone-500">นิสัยสำเร็จวันนี้</div>
      </div>
    </div>

    <div className="mt-6 space-y-5">
      {overview.goals.length === 0 && <Empty text="ยังไม่มีเป้าหมายที่ตั้งไว้ปีนี้"/>}
      {overview.goals.map((goal) => (
        <div key={goal.id}>
          <div className="mb-2 flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: goal.color }}/><h3 className="font-bold text-stone-700">{goal.title}</h3></div>
          <HabitChecklist habits={goal.habits} checkInByHabit={checkInByHabit} pending={pending} onToggle={toggle}/>
        </div>
      ))}
    </div>

    <button onClick={() => setJournalOpen(true)} className="mt-6 flex w-full items-center gap-2 rounded-2xl border border-dashed border-amber-300 bg-white p-4 text-left text-sm text-amber-700 hover:bg-amber-50">
      <NotebookPen size={17}/> เขียนบันทึกวันนี้
    </button>
    {journalOpen && <JournalEditorModal entryDate={date} onClose={() => setJournalOpen(false)} onSaved={() => setJournalOpen(false)}/>}
  </div>;
}

function HabitChecklist({ habits, checkInByHabit, pending, onToggle }: {
  habits: HestiaHabit[]; checkInByHabit: Map<string, HestiaCheckIn>; pending: Set<string>; onToggle: (habit: HestiaHabit) => void;
}) {
  if (!habits.length) return <p className="text-xs text-stone-400">ยังไม่มีนิสัยในเป้าหมายนี้</p>;
  return <div className="space-y-1.5">
    {habits.map((habit) => <HabitCheckRow key={habit.id} habit={habit} checkIn={checkInByHabit.get(habit.id)} busy={pending.has(habit.id)} onToggle={() => onToggle(habit)}/>)}
  </div>;
}

function HabitCheckRow({ habit, checkIn, busy, onToggle }: { habit: HestiaHabit; checkIn?: HestiaCheckIn; busy: boolean; onToggle: () => void }) {
  const count = checkIn?.count ?? 0;
  const done = count >= habit.targetCount;
  return <div className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-3 py-2.5">
    <button onClick={onToggle} disabled={busy} aria-label={done ? 'ยกเลิกทำสำเร็จ' : 'ทำสำเร็จ'}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 transition ${done ? 'border-amber-600 bg-amber-600 text-white' : 'border-stone-300 text-transparent hover:border-amber-400'}`}>
      {busy ? <Loader2 size={14} className="animate-spin"/> : <Check size={15}/>}
    </button>
    <div className="min-w-0 flex-1">
      <div className={`truncate text-sm font-medium ${done ? 'text-stone-400 line-through' : 'text-stone-800'}`}>{habit.title}</div>
      {habit.targetCount > 1 && <div className="text-xs text-stone-400">{count}/{habit.targetCount}</div>}
    </div>
    <StreakBadge streak={habit.streak?.currentStreak ?? 0}/>
  </div>;
}

function StreakBadge({ streak }: { streak: number }) {
  if (!streak) return null;
  return <span className="flex shrink-0 items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-700"><Flame size={12}/>{streak}</span>;
}

function DailyProgressRing({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.min(1, completed / total) : 0;
  const r = 26; const c = 2 * Math.PI * r;
  return <svg width="64" height="64" viewBox="0 0 64 64" className="shrink-0">
    <circle cx="32" cy="32" r={r} fill="none" stroke="#f1e4d0" strokeWidth="7"/>
    <circle cx="32" cy="32" r={r} fill="none" stroke="#d97706" strokeWidth="7" strokeLinecap="round"
      strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 32 32)"/>
  </svg>;
}

function DateNavigator({ date, todayKey, onPrev, onNext, onToday }: { date: string; todayKey: string; onPrev: () => void; onNext: () => void; onToday: () => void }) {
  return <div className="flex items-center justify-between gap-2">
    <h2 className="text-lg font-bold text-stone-800">{longThaiDate(date)}{date === todayKey ? ' · วันนี้' : ''}</h2>
    <div className="flex items-center gap-1">
      <button onClick={onPrev} aria-label="วันก่อนหน้า" className="btn rounded-lg border border-stone-200 bg-white"><ChevronLeft size={16}/></button>
      {date !== todayKey && <button onClick={onToday} className="btn rounded-lg border border-stone-200 bg-white text-xs">วันนี้</button>}
      <button onClick={onNext} aria-label="วันถัดไป" className="btn rounded-lg border border-stone-200 bg-white"><ChevronRight size={16}/></button>
    </div>
  </div>;
}

function Empty({ text }: { text: string }) { return <div className="rounded-2xl border border-dashed border-stone-300 bg-white py-16 text-center text-sm text-stone-400">{text}</div>; }
