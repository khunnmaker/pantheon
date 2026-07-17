import { useEffect, useState } from 'react';
import { ExternalLink, Flame, Loader2, NotebookText } from 'lucide-react';
import { getOverview } from './lib/api';
import { bangkokTodayKey, longThaiDate } from './lib/dates';
import type { Route } from './lib/navigation';
import type { Agent, HestiaOverview } from './types';

// Olympus home (`/`): greeting/date, a Hestia tile adapted from pantheon/src/Portal.tsx's tile
// styling, and a compact TodaySummary. Future Greek apps join this page as more tiles.
export default function OlympusHome({ agent, onNavigate }: { agent: Agent; onNavigate: (route: Route) => void }) {
  const [overview, setOverview] = useState<HestiaOverview | null>(null);
  useEffect(() => {
    let alive = true;
    void getOverview(bangkokTodayKey()).then((value) => { if (alive) setOverview(value); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const firstName = agent.name.split(' ')[0];
  return <div>
    <h1 className="text-xl font-bold text-stone-800">สวัสดี {firstName}</h1>
    <p className="mt-1 text-sm text-stone-500">{longThaiDate(bangkokTodayKey())}</p>

    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      <button onClick={() => onNavigate('hestia')} className="group flex items-center gap-4 rounded-2xl border border-amber-200 bg-white p-4 text-left transition hover:border-amber-400 hover:shadow-sm">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-700"><Flame size={22}/></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5"><span className="font-bold text-amber-700">Hestia</span><ExternalLink size={13} className="text-amber-300 group-hover:text-amber-500"/></div>
          <div className="truncate text-xs text-stone-500">เป้าหมาย · นิสัย · บันทึกประจำวัน</div>
        </div>
      </button>
      <TodaySummary overview={overview}/>
    </div>
  </div>;
}

function TodaySummary({ overview }: { overview: HestiaOverview | null }) {
  if (!overview) {
    return <div className="flex items-center justify-center rounded-2xl border border-dashed border-stone-300 bg-white p-4 text-stone-400">
      <Loader2 className="animate-spin" size={18}/>
    </div>;
  }
  const bestStreak = overview.goals.flatMap((goal) => goal.habits).reduce((max, habit) => Math.max(max, habit.streak?.currentStreak ?? 0), 0);
  const latest = overview.recentJournal[0];
  return <div className="rounded-2xl border border-stone-200 bg-white p-4">
    <div className="text-xs font-semibold text-stone-500">สรุปวันนี้</div>
    <div className="mt-1 flex items-baseline gap-1"><span className="text-2xl font-bold text-stone-800">{overview.totals.completed}</span><span className="text-stone-400">/ {overview.totals.total} นิสัยสำเร็จ</span></div>
    <div className="mt-2 flex items-center gap-1.5 text-sm text-stone-600"><Flame size={14} className="text-orange-500"/>สตรีคสูงสุด {bestStreak} วัน</div>
    {latest && <div className="mt-2 flex items-center gap-1.5 truncate text-xs text-stone-500"><NotebookText size={13} className="shrink-0"/><span className="truncate">{latest.title || latest.bodyMarkdown.slice(0, 40)}</span></div>}
  </div>;
}
