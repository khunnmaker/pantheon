import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, Loader2, Lock, RefreshCw, Trash2, UserPlus, Users, X } from 'lucide-react';
import TaskCard from './TaskCard';
import TaskModal from './TaskModal';
import QuickCreate from './QuickCreate';
import type { Agent, CalendarEvent, CalendarTask, EventInput, Person, Project, RecurrenceRule, TaskInput } from './types';
import { addEvent, deleteEvent, getCalendar, skipEventDate, updateEvent } from './lib/api';
import { agentAvatar, dateKey, daysInMonth, eventDayKeys, monthGrid, WEEKDAYS_FULL, WEEKDAYS_SHORT, type CalendarCell } from './lib/ui';

const CHIP = 'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs';
const CHIP_ON = 'border-transparent bg-blue-50 text-blue-700 ring-1 ring-blue-300';
const CHIP_OFF = 'border-slate-200 text-slate-600 hover:border-blue-300';

// One day cell's chips: all-day events, then timed events by startTime, then tasks (existing
// order) — a single ordered list so the day-cell/day-modal/mobile-agenda 3-chip cap can count
// across both kinds without each caller re-deriving the ordering rule.
type DayChip = { kind: 'event'; event: CalendarEvent } | { kind: 'task'; task: CalendarTask };
function dayChips(events: CalendarEvent[], tasks: CalendarTask[]): DayChip[] {
  const allDay = events.filter((e) => !e.startTime);
  const timed = [...events.filter((e) => e.startTime)].sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  return [
    ...allDay.map((event): DayChip => ({ kind: 'event', event })),
    ...timed.map((event): DayChip => ({ kind: 'event', event })),
    ...tasks.map((task): DayChip => ({ kind: 'task', task })),
  ];
}

export default function CalendarView({ agents, me, isManager, onOpen, projects }: {
  agents: Person[]; me: Agent; isManager: boolean; onOpen: (id: string) => void; projects: Project[];
}) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [scope, setScope] = useState(isManager ? 'all' : me.id);
  const [tasks, setTasks] = useState<CalendarTask[] | null>(null);
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [dayModal, setDayModal] = useState<string | null>(null);
  const [eventModal, setEventModal] = useState<{ date: string; event?: CalendarEvent; initial?: Partial<EventInput> } | null>(null);
  const [quickCreate, setQuickCreate] = useState<{ date: string; anchor: HTMLElement } | null>(null);
  const [taskCreate, setTaskCreate] = useState<{ project: Project; initial?: Partial<TaskInput> } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const todayKey = new Date().toLocaleDateString('en-CA');

  useEffect(() => {
    let cancelled = false;
    setTasks(null);
    const from = dateKey(year, month, 1);
    const to = dateKey(year, month, daysInMonth(year, month));
    void getCalendar(from, to, scope).then((res) => { if (!cancelled) { setTasks(res.tasks); setEvents(res.events); } });
    return () => { cancelled = true; };
  }, [year, month, scope, refreshKey]);

  const tasksByDay = useMemo(() => {
    const map = new Map<string, CalendarTask[]>();
    for (const t of tasks ?? []) { const key = t.dueDate.slice(0, 10); const list = map.get(key); if (list) list.push(t); else map.set(key, [t]); }
    return map;
  }, [tasks]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events ?? []) {
      for (const key of eventDayKeys(e.date, e.endDate)) { const list = map.get(key); if (list) list.push(e); else map.set(key, [e]); }
    }
    return map;
  }, [events]);

  function go(delta: number) { const d = new Date(year, month + delta, 1); setYear(d.getFullYear()); setMonth(d.getMonth()); }
  function goToday() { const t = new Date(); setYear(t.getFullYear()); setMonth(t.getMonth()); }
  function openEvent(event: CalendarEvent) { setEventModal({ date: event.date.slice(0, 10), event }); }
  function afterEventChange() { setRefreshKey((k) => k + 1); }
  function openQuickCreate(date: string, anchor: HTMLElement) { setQuickCreate({ date, anchor }); }
  // The escape hatch from QuickCreate's "ตัวเลือกเพิ่มเติม" — swap the popover for the matching
  // full modal, carrying over whatever was typed so far as `initial`.
  function moreOptions(payload: { kind: 'event'; date: string; initial: Partial<EventInput> } | { kind: 'task'; project: Project; initial: Partial<TaskInput> }) {
    setQuickCreate(null);
    if (payload.kind === 'event') setEventModal({ date: payload.date, initial: payload.initial });
    else setTaskCreate({ project: payload.project, initial: payload.initial });
  }

  const monthTitle = new Date(year, month, 1).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });
  const cells = monthGrid(year, month);
  const sortedDayKeys = [...new Set([...tasksByDay.keys(), ...eventsByDay.keys()])].sort();

  return <div>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-lg font-bold">{monthTitle}</h1>
        {scope === me.id && <p className="text-xs text-slate-500">ปฏิทินของฉัน</p>}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => go(-1)} aria-label="เดือนก่อนหน้า" className="btn rounded-lg border border-slate-200 bg-white"><ChevronLeft size={16}/></button>
        <button onClick={goToday} className="btn rounded-lg border border-slate-200 bg-white">วันนี้</button>
        <button onClick={() => go(1)} aria-label="เดือนถัดไป" className="btn rounded-lg border border-slate-200 bg-white"><ChevronRight size={16}/></button>
        <button onClick={(e) => openQuickCreate(year === today.getFullYear() && month === today.getMonth() ? todayKey : dateKey(year, month, 1), e.currentTarget)} className="btn rounded-lg border border-slate-200 bg-white"><CalendarPlus size={16}/> กิจกรรม</button>
      </div>
    </div>

    <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
      <button onClick={() => setScope('all')} className={`${CHIP} ${scope === 'all' ? CHIP_ON : CHIP_OFF}`}><Users size={13}/>ทุกคน</button>
      {agents.map((a) => <button key={a.id} onClick={() => setScope(a.id)} className={`${CHIP} ${scope === a.id ? CHIP_ON : CHIP_OFF}`}>
        <img src={agentAvatar(a, agents)} alt="" className="h-[18px] w-[18px] rounded-full"/>{a.name.split(' ')[0]}
      </button>)}
      <button onClick={() => setScope('none')} className={`${CHIP} ${scope === 'none' ? CHIP_ON : CHIP_OFF}`}><UserPlus size={13}/>ยังไม่มอบหมาย</button>
    </div>

    {tasks === null ? <div className="py-20 text-center text-slate-400">กำลังโหลด…</div> : <>
      <div className="hidden md:grid grid-cols-7 pb-1 text-center text-xs font-semibold text-slate-500">
        {WEEKDAYS_SHORT.map((w) => <div key={w}>{w}</div>)}
      </div>
      <div className="hidden md:grid grid-cols-7 gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-200">
        {cells.map((cell) => {
          const key = dateKey(cell.year, cell.month, cell.day);
          return <DayCell key={key} cell={cell} isToday={key === todayKey} isPast={key < todayKey}
            tasks={tasksByDay.get(key) ?? []} events={eventsByDay.get(key) ?? []} scope={scope} agents={agents} onOpen={onOpen}
            onMore={() => setDayModal(key)} onQuickCreate={(el) => openQuickCreate(key, el)} onOpenEvent={openEvent}/>;
        })}
      </div>

      <div className="space-y-4 md:hidden">
        {!sortedDayKeys.length
          ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white py-20 text-center"><CalendarDays size={28} className="mx-auto text-slate-300"/><p className="mt-3 text-sm text-slate-400">ไม่มีงานในเดือนนี้</p></div>
          : sortedDayKeys.map((key) => {
            const isToday = key === todayKey; const isPast = key < todayKey;
            return <div key={key}>
              <h3 className={`mb-1.5 text-xs font-semibold ${isToday ? 'text-blue-700' : isPast ? 'text-slate-400' : 'text-slate-700'}`}>
                {new Date(`${key}T00:00:00`).toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' })}{isToday ? ' · วันนี้' : ''}
              </h3>
              <div className="space-y-2">
                {(eventsByDay.get(key) ?? []).map((e) => <EventChip key={`e-${e.id}`} event={e} agents={agents} detailed onOpen={openEvent}/>)}
                {(tasksByDay.get(key) ?? []).map((t) => <TaskCard key={t.id} task={t} agents={agents} showProject onClick={() => onOpen(t.id)}/>)}
              </div>
            </div>;
          })}
      </div>
    </>}

    {dayModal && <Shell onClose={() => setDayModal(null)}>
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <h2 className="text-lg font-bold">{new Date(`${dayModal}T00:00:00`).toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
        <button aria-label="ปิด" onClick={() => setDayModal(null)} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"><X/></button>
      </div>
      <div className="max-h-[calc(85vh-70px)] space-y-2 overflow-y-auto p-5">
        {(eventsByDay.get(dayModal) ?? []).map((e) => <EventChip key={`e-${e.id}`} event={e} agents={agents} detailed onOpen={(event) => { openEvent(event); setDayModal(null); }}/>)}
        {(tasksByDay.get(dayModal) ?? []).map((t) => <TaskCard key={t.id} task={t} agents={agents} showProject onClick={() => { onOpen(t.id); setDayModal(null); }}/>)}
      </div>
    </Shell>}

    {eventModal && <EventModal date={eventModal.date} event={eventModal.event} initial={eventModal.initial} onClose={() => setEventModal(null)} onChanged={afterEventChange}/>}
    {quickCreate && <QuickCreate date={quickCreate.date} anchor={quickCreate.anchor} agents={agents} me={me} scope={scope} projects={projects}
      onClose={() => setQuickCreate(null)} onChanged={afterEventChange} onMoreOptions={moreOptions}/>}
    {taskCreate && <TaskModal taskId={null} project={taskCreate.project} agents={agents} me={me} initial={taskCreate.initial} onClose={() => setTaskCreate(null)} onChanged={afterEventChange}/>}
  </div>;
}

function DayCell({ cell, isToday, isPast, tasks, events, scope, agents, onOpen, onMore, onQuickCreate, onOpenEvent }: {
  cell: CalendarCell; isToday: boolean; isPast: boolean; tasks: CalendarTask[]; events: CalendarEvent[]; scope: string; agents: Person[];
  onOpen: (id: string) => void; onMore: () => void; onQuickCreate: (anchor: HTMLElement) => void; onOpenEvent: (event: CalendarEvent) => void;
}) {
  const chips = dayChips(events, tasks);
  const shown = chips.slice(0, 3);
  const extra = chips.length - shown.length;
  // Guarded at both this level and the chip-wrapper below so a click on genuinely empty cell
  // background opens QuickCreate, while a click that bubbles up from a chip or the +n button
  // (e.target stays that descendant, never === currentTarget) is ignored — no changes needed
  // to the chips themselves.
  const openHere = (e: React.MouseEvent<HTMLDivElement>) => { if (e.target === e.currentTarget) onQuickCreate(e.currentTarget); };
  return <div onClick={openHere} className={`flex min-h-[96px] flex-col p-1.5 ${cell.inMonth ? 'bg-white' : 'bg-slate-50/60'}`}>
    <span onClick={(e) => onQuickCreate(e.currentTarget)} role="button"
      className={`self-end cursor-pointer rounded text-xs hover:bg-blue-50 ${!cell.inMonth ? 'text-slate-300' : isToday ? 'grid h-5 w-5 place-items-center rounded-full bg-blue-600 text-white' : isPast ? 'text-slate-400' : ''}`}>{cell.day}</span>
    <div onClick={openHere} className="mt-1 flex min-h-0 flex-1 flex-col gap-1">
      {shown.map((c) => c.kind === 'event'
        ? <EventChip key={`e-${c.event.id}`} event={c.event} agents={agents} onOpen={onOpenEvent}/>
        : <TaskChip key={`t-${c.task.id}`} task={c.task} scope={scope} agents={agents} isPast={isPast} isToday={isToday} onOpen={onOpen}/>)}
      {extra > 0 && <button onClick={onMore} className="text-left text-[11px] text-blue-600">+{extra} งาน</button>}
    </div>
  </div>;
}

function TaskChip({ task, scope, agents, isPast, isToday, onOpen }: {
  task: CalendarTask; scope: string; agents: Person[]; isPast: boolean; isToday: boolean; onOpen: (id: string) => void;
}) {
  const state = isPast ? 'bg-rose-50 text-rose-700' : isToday ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-700';
  return <button onClick={() => onOpen(task.id)} style={{ borderColor: task.project.color }}
    className={`flex w-full items-center gap-1 truncate rounded-md border-l-2 px-1.5 py-0.5 text-left text-[11px] hover:bg-blue-50 ${state}`}>
    {scope === 'all' && task.assignee && <img src={agentAvatar(task.assignee, agents)} alt="" className="h-3 w-3 shrink-0 rounded-full"/>}
    <span className="truncate">{task.title}</span>
    {task.recurrenceRule && <RefreshCw size={10} className="ml-auto shrink-0 opacity-70"/>}
  </button>;
}

// Own events are editable (violet, clickable, Lock/Users icon showing the owner their own
// visibility choice). A non-own event with title present — 'public', or the CEO viewing someone
// else's 'private' one — renders read-only (sky, not clickable; no read modal in this pass), with
// a Lock suffix ONLY on the CEO-viewing-private case as a confidentiality reminder. Everyone else
// gets the anonymous "ไม่ว่าง" busy block (dashed gray, static) — the server already stripped
// title/note/visibility for those, so there is nothing here that could leak them even by
// accident. `detailed` additionally shows the note as a secondary line (day modal/agenda only —
// the grid cell has no room for it).
function EventChip({ event, agents, onOpen, detailed }: { event: CalendarEvent; agents: Person[]; onOpen: (event: CalendarEvent) => void; detailed?: boolean }) {
  if (event.own) {
    const VisIcon = event.visibility === 'public' ? Users : Lock;
    return <button onClick={() => onOpen(event)}
      className="flex w-full flex-col gap-0.5 rounded-md bg-violet-50 px-1.5 py-0.5 text-left text-[11px] text-violet-700">
      <span className="flex items-center gap-1 truncate">
        <VisIcon size={10} className="shrink-0"/>
        <span className="truncate">{(event.startTime ? `${event.startTime} ` : '') + (event.title ?? '')}</span>
        {event.recurrenceRule && <RefreshCw size={10} className="ml-auto shrink-0 opacity-70"/>}
      </span>
      {detailed && event.note && <span className="truncate text-slate-500">{event.note}</span>}
    </button>;
  }
  if (event.title !== undefined) {
    // recurrenceRule is only ever present on own/public rows, and Lock only on the CEO-viewing-
    // private case — the two suffixes can't co-occur, so both can claim ml-auto.
    return <div className="flex w-full flex-col gap-0.5 rounded-md bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700">
      <span className="flex items-center gap-1 truncate">
        {event.assignee && <img src={agentAvatar(event.assignee, agents)} alt="" className="h-3 w-3 shrink-0 rounded-full"/>}
        <span className="truncate">{(event.startTime ? `${event.startTime} ` : '') + event.title}</span>
        {event.recurrenceRule && <RefreshCw size={10} className="ml-auto shrink-0 opacity-70"/>}
        {event.visibility === 'private' && <Lock size={10} className="ml-auto shrink-0 opacity-70"/>}
      </span>
      {detailed && event.note && <span className="truncate text-slate-500">{event.note}</span>}
    </div>;
  }
  return <div className="flex w-full items-center gap-1 truncate rounded-md border border-dashed border-slate-300 bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
    {event.assignee && <img src={agentAvatar(event.assignee, agents)} alt="" className="h-3 w-3 shrink-0 rounded-full"/>}
    <span className="truncate">{`ไม่ว่าง${event.startTime ? ` ${event.startTime}${event.endTime ? `–${event.endTime}` : ''}` : ''}`}</span>
  </div>;
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl">{children}</div>
  </div>;
}

// Personal-event editor — same Shell as the day modal. Non-owners never reach this (their chips
// aren't clickable), so there's no "view-only" mode to build: this is always the owner's own.
// `initial` seeds a brand-new event (no `event`) from whatever QuickCreate already had typed
// when the owner bailed to "ตัวเลือกเพิ่มเติม".
function EventModal({ date, event, initial, onClose, onChanged }: { date: string; event?: CalendarEvent; initial?: Partial<EventInput>; onClose: () => void; onChanged: () => void }) {
  const [title, setTitle] = useState(initial?.title ?? event?.title ?? '');
  const [note, setNote] = useState(initial?.note ?? event?.note ?? '');
  // THE REBASE TRAP: a recurring row's `date` is the clicked OCCURRENCE day, and PATCH submits
  // this whole form — seeding วันที่ from it would silently rebase the whole series onto that
  // occurrence the moment the owner presses บันทึก. Always seed from seriesDate (the base date).
  const [eventDate, setEventDate] = useState(initial?.date ?? (event ? (event.seriesDate ?? event.date.slice(0, 10)) : date));
  const [endDate, setEndDate] = useState(initial?.endDate ?? (event?.endDate ? event.endDate.slice(0, 10) : ''));
  const [startTime, setStartTime] = useState(initial?.startTime ?? event?.startTime ?? '');
  const [endTime, setEndTime] = useState(initial?.endTime ?? event?.endTime ?? '');
  const [visibility, setVisibility] = useState<'private' | 'public'>(initial?.visibility ?? event?.visibility ?? 'public');
  const [freq, setFreq] = useState<'none' | 'daily' | 'weekly' | 'monthly'>(initial?.recurrenceRule?.freq ?? event?.recurrenceRule?.freq ?? 'none');
  const [until, setUntil] = useState(initial?.recurrenceUntil ?? event?.recurrenceUntil ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const eventDay = new Date(`${eventDate}T00:00:00`);

  // Like QuickCreate, the rule's weekday/dayOfMonth are locked to the picked date (the server
  // rejects a mismatch) — changing วันที่ re-anchors the rule automatically at save.
  function eventRule(): RecurrenceRule | null {
    if (freq === 'daily') return { freq: 'daily' };
    if (freq === 'weekly') return { freq: 'weekly', weekday: eventDay.getDay() };
    if (freq === 'monthly') return { freq: 'monthly', dayOfMonth: eventDay.getDate() };
    return null;
  }
  async function save() {
    if (!title.trim()) return;
    setBusy(true); setError('');
    const rule = eventRule();
    const body: EventInput = {
      title: title.trim(), note, date: eventDate,
      endDate: endDate || null,
      startTime: startTime || null,
      endTime: startTime && endTime ? endTime : null,
      visibility, recurrenceRule: rule, recurrenceUntil: rule && until ? until : null,
    };
    try {
      if (event) await updateEvent(event.id, body); else await addEvent(body);
      onChanged(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ'); } finally { setBusy(false); }
  }
  async function remove() {
    if (!event || !confirm(event.recurrenceRule ? 'ลบกิจกรรมนี้ทั้งชุด (ทุกวันที่ทำซ้ำ) หรือไม่?' : 'ลบกิจกรรมนี้หรือไม่?')) return;
    setBusy(true);
    try { await deleteEvent(event.id); onChanged(); onClose(); } finally { setBusy(false); }
  }
  // ลบเฉพาะวันนี้ — skips ONLY the occurrence this modal was opened from: event.date IS the
  // clicked row's occurrence day (never the วันที่ field, which holds the series base date).
  async function skipThisDay() {
    if (!event) return;
    const occurrence = event.date.slice(0, 10);
    if (!confirm(`ลบเฉพาะวันที่ ${new Date(`${occurrence}T00:00:00`).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })} หรือไม่?`)) return;
    setBusy(true);
    try { await skipEventDate(event.id, occurrence); onChanged(); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : 'ลบไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  return <Shell onClose={onClose}>
    <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
      <div>
        <h2 className="text-lg font-bold">กิจกรรมส่วนตัว</h2>
        <p className="mt-0.5 text-xs text-slate-500">{visibility === 'public' ? 'ทุกคนเห็นรายละเอียดกิจกรรมนี้' : 'คนอื่นจะเห็นเพียงว่า "ไม่ว่าง" (CEO เห็นรายละเอียด)'}</p>
      </div>
      <button aria-label="ปิด" onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"><X/></button>
    </div>
    <div className="max-h-[calc(85vh-70px)] overflow-y-auto p-5">
      <label className="label">ชื่อกิจกรรม</label>
      <input className="input" autoFocus={!event} value={title} onChange={(e) => setTitle(e.target.value)}/>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">วันที่</label>
          <input type="date" className="input" value={eventDate} onChange={(e) => setEventDate(e.target.value)}/>
        </div>
        <div>
          <label className="label">ถึงวันที่</label>
          <div className="flex gap-1.5">
            {/* Rule + multi-day span can't combine (server rejects) — picking one drops the other. */}
            <input type="date" className="input" value={endDate} min={eventDate} onChange={(e) => { setEndDate(e.target.value); if (e.target.value) setFreq('none'); }}/>
            {endDate && <button type="button" aria-label="ล้างถึงวันที่" onClick={() => setEndDate('')} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"><X size={16}/></button>}
          </div>
        </div>
      </div>
      <label className="label">เวลา</label>
      <div className="flex gap-2">
        <input type="time" className="input" value={startTime} onChange={(e) => { setStartTime(e.target.value); if (!e.target.value) setEndTime(''); }}/>
        <input type="time" className="input" value={endTime} min={startTime || undefined} disabled={!startTime} onChange={(e) => setEndTime(e.target.value)}/>
      </div>
      <label className="label">การมองเห็น</label>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setVisibility('private')}
          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${visibility === 'private' ? 'border-transparent bg-violet-50 text-violet-700 ring-2 ring-violet-300' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
          <Lock size={12}/>ส่วนตัว
        </button>
        <button type="button" onClick={() => setVisibility('public')}
          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${visibility === 'public' ? 'border-transparent bg-sky-50 text-sky-700 ring-2 ring-sky-300' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
          <Users size={12}/>สาธารณะ
        </button>
      </div>
      <div className="mt-4 rounded-xl border border-slate-200 p-3">
        <label className="text-xs font-semibold text-slate-600">ทำซ้ำ</label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select className="input max-w-56" value={freq} onChange={(e) => { const f = e.target.value as typeof freq; setFreq(f); if (f !== 'none') setEndDate(''); }}>
            <option value="none">ไม่ทำซ้ำ</option>
            <option value="daily">ทุกวัน</option>
            <option value="weekly">ทุกสัปดาห์ในวัน{WEEKDAYS_FULL[eventDay.getDay()]}</option>
            <option value="monthly">ทุกเดือนวันที่ {eventDay.getDate()}</option>
          </select>
          {freq !== 'none' && <><span className="text-xs text-slate-500">สิ้นสุด</span><input aria-label="สิ้นสุด" type="date" className="input max-w-44" value={until} min={eventDate} onChange={(e) => setUntil(e.target.value)}/></>}
        </div>
      </div>
      <label className="label">โน้ต</label>
      <textarea className="input min-h-24" value={note} onChange={(e) => setNote(e.target.value)}/>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
      <div className="mt-5 flex flex-wrap gap-2">
        {event && (event.recurrenceRule
          ? <>
            <button onClick={() => void remove()} disabled={busy} className="btn text-rose-600 hover:bg-rose-50"><Trash2 size={16}/> ลบทั้งชุด</button>
            <button onClick={() => void skipThisDay()} disabled={busy} className="btn text-rose-600 hover:bg-rose-50">ลบเฉพาะวันนี้</button>
          </>
          : <button onClick={() => void remove()} disabled={busy} className="btn text-rose-600 hover:bg-rose-50"><Trash2 size={16}/> ลบ</button>)}
        <button onClick={() => void save()} disabled={busy || !title.trim()} className="btn-primary ml-auto">{busy && <Loader2 size={15} className="animate-spin"/>} บันทึก</button>
      </div>
    </div>
  </Shell>;
}
