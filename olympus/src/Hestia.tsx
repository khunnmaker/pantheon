import { useHashTab } from '@pantheon/ui';
import { BookOpen, CalendarClock, Flame, Target } from 'lucide-react';
import Today from './components/Today';
import Goals from './components/Goals';
import History from './components/History';
import Journal from './components/Journal';

type Tab = 'today' | 'goals' | 'history' | 'journal';
const TABS: { key: Tab; label: string; icon: typeof Flame }[] = [
  { key: 'today', label: 'วันนี้', icon: Flame },
  { key: 'goals', label: 'เป้าหมาย', icon: Target },
  { key: 'history', label: 'ประวัติ', icon: CalendarClock },
  { key: 'journal', label: 'บันทึก', icon: BookOpen },
];
const TAB_KEYS = TABS.map((t) => t.key);

// Hestia (`/hestia`): desktop top nav + mobile bottom nav over the four Thai tabs, synced with
// location.hash via @pantheon/ui's useHashTab (shareable, F5-safe, never a navigation-stack entry).
export default function Hestia() {
  const [tab, setTab] = useHashTab<Tab>(TAB_KEYS, 'today');
  return <div>
    <nav className="mb-5 hidden gap-1 border-b border-stone-200 md:flex">
      {TABS.map(({ key, label, icon: Icon }) => (
        <button key={key} onClick={() => setTab(key)}
          className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium ${tab === key ? 'border-amber-600 text-amber-700' : 'border-transparent text-stone-500 hover:text-stone-700'}`}>
          <Icon size={15}/>{label}
        </button>
      ))}
    </nav>

    {tab === 'today' && <Today/>}
    {tab === 'goals' && <Goals/>}
    {tab === 'history' && <History/>}
    {tab === 'journal' && <Journal/>}

    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-stone-200 bg-white md:hidden">
      {TABS.map(({ key, label, icon: Icon }) => (
        <button key={key} onClick={() => setTab(key)}
          className={`flex flex-1 flex-col items-center gap-1 border-t-2 py-2 text-[10px] ${tab === key ? 'border-amber-600 text-amber-700' : 'border-transparent text-stone-500'}`}>
          <Icon size={18}/>{label}
        </button>
      ))}
    </nav>
  </div>;
}
