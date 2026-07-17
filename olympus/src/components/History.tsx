import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Flame, Loader2 } from 'lucide-react';
import { getCheckIns, getHabits } from '../lib/api';
import { dateKey, daysInMonth, longThaiDate, monthGrid, monthTitleThai, WEEKDAYS_SHORT } from '../lib/dates';
import type { HestiaCheckIn, HestiaHabitWithGoal } from '../types';

// History tab: HabitFilter, a desktop MonthGrid / mobile agenda list (adapted from
// apollo/src/CalendarView.tsx's month math), completion cells, and current/longest streak
// summaries. Fetches one bounded month of check-ins for the selected habit at a time.
export default function History() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [habits, setHabits] = useState<HestiaHabitWithGoal[] | null>(null);
  const [habitId, setHabitId] = useState('');
  const [checkIns, setCheckIns] = useState<HestiaCheckIn[] | null>(null);

  useEffect(() => {
    void getHabits().then((all) => {
      setHabits(all);
      setHabitId((current) => current || all[0]?.id || '');
    });
  }, []);

  useEffect(() => {
    if (!habitId) { setCheckIns(null); return; }
    let alive = true;
    setCheckIns(null);
    const from = dateKey(year, month, 1);
    const to = dateKey(year, month, daysInMonth(year, month));
    void getCheckIns(from, to, habitId).then((value) => { if (alive) setCheckIns(value); });
    return () => { alive = false; };
  }, [year, month, habitId]);

  const habit = habits?.find((h) => h.id === habitId);
  const doneDays = useMemo(() => {
    if (!habit) return new Set<string>();
    return new Set((checkIns ?? []).filter((c) => c.count >= habit.targetCount).map((c) => c.checkDate.slice(0, 10)));
  }, [checkIns, habit]);

  function go(delta: number) { const d = new Date(year, month + delta, 1); setYear(d.getFullYear()); setMonth(d.getMonth()); }

  if (!habits) return <div className="py-16 text-center text-stone-400"><Loader2 className="mx-auto animate-spin" size={20}/></div>;
  if (!habits.length) return <div className="rounded-2xl border border-dashed border-stone-300 bg-white py-16 text-center text-sm text-stone-400">ยังไม่มีนิสัยให้ดูประวัติ</div>;

  const cells = monthGrid(year, month);
  const todayKey = today.toLocaleDateString('en-CA');

  return <div>
    <HabitFilter habits={habits} value={habitId} onChange={setHabitId}/>
    <div className="mt-4 flex items-center justify-between">
      <h2 className="text-lg font-bold text-stone-800">{monthTitleThai(year, month)}</h2>
      <div className="flex items-center gap-1">
        <button onClick={() => go(-1)} aria-label="เดือนก่อนหน้า" className="btn rounded-lg border border-stone-200 bg-white"><ChevronLeft size={16}/></button>
        <button onClick={() => go(1)} aria-label="เดือนถัดไป" className="btn rounded-lg border border-stone-200 bg-white"><ChevronRight size={16}/></button>
      </div>
    </div>
    {habit && <div className="mt-2 flex items-center gap-4 text-sm text-stone-600">
      <span className="flex items-center gap-1.5"><Flame size={14} className="text-orange-500"/>ต่อเนื่อง {habit.streak?.currentStreak ?? 0} วัน</span>
      <span>สูงสุด {habit.streak?.longestStreak ?? 0} วัน</span>
    </div>}

    {checkIns === null ? <div className="py-16 text-center text-stone-400"><Loader2 className="mx-auto animate-spin" size={20}/></div> : <>
      <div className="mt-4 hidden md:block">
        <div className="grid grid-cols-7 pb-1 text-center text-xs font-semibold text-stone-500">{WEEKDAYS_SHORT.map((w) => <div key={w}>{w}</div>)}</div>
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-2xl border border-stone-200 bg-stone-200">
          {cells.map((cell) => {
            const key = dateKey(cell.year, cell.month, cell.day);
            const done = doneDays.has(key);
            return <div key={key} className={`flex min-h-[64px] flex-col items-center justify-center gap-1 p-1 ${cell.inMonth ? 'bg-white' : 'bg-stone-50/60'}`}>
              <span className={`text-xs ${key === todayKey ? 'font-bold text-amber-700' : cell.inMonth ? 'text-stone-500' : 'text-stone-300'}`}>{cell.day}</span>
              {cell.inMonth && (done ? <span className="h-3 w-3 rounded-full bg-amber-600"/> : <span className="h-3 w-3 rounded-full border border-stone-200"/>)}
            </div>;
          })}
        </div>
      </div>
      <div className="mt-4 space-y-1.5 md:hidden">
        {Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1).map((day) => {
          const key = dateKey(year, month, day);
          const done = doneDays.has(key);
          return <div key={key} className="flex items-center justify-between rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm">
            <span className={key === todayKey ? 'font-semibold text-amber-700' : 'text-stone-600'}>{longThaiDate(key)}</span>
            {done ? <span className="h-3 w-3 rounded-full bg-amber-600"/> : <span className="h-3 w-3 rounded-full border border-stone-300"/>}
          </div>;
        })}
      </div>
    </>}
  </div>;
}

function HabitFilter({ habits, value, onChange }: { habits: HestiaHabitWithGoal[]; value: string; onChange: (id: string) => void }) {
  return <div className="inline-flex items-center gap-2 rounded-xl border border-stone-300 bg-white pl-3 pr-1">
    <CalendarDays size={15} className="text-stone-400"/>
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-xl border-0 bg-transparent py-2 pr-2 text-sm font-semibold outline-none">
      {habits.map((h) => <option key={h.id} value={h.id}>{h.goal.title} · {h.title}</option>)}
    </select>
  </div>;
}
