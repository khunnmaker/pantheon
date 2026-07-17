import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlignLeft, ChevronDown, Clock, Folder, Loader2, Lock, RefreshCw, User, Users, X, type LucideIcon } from 'lucide-react';
import type { Agent, EventInput, Person, Project, RecurrenceRule, TaskInput } from './types';
import { addEvent, createTask } from './lib/api';
import { WEEKDAYS_FULL, WEEKDAYS_SHORT, quickCreatePosition, shortDate } from './lib/ui';

const LAST_PROJECT_KEY = 'apollo_quick_project';
// Verbatim copies of EventModal's disclosure copy (see CalendarView.tsx) — staff must be able to
// see the CEO-can-read-a-private-event hint without expanding anything, so this is ALSO shown as
// a footnote under the collapsed visibility row, not reachable only by expanding it.
const PRIVATE_HINT = 'คนอื่นจะเห็นเพียงว่า "ไม่ว่าง" (CEO เห็นรายละเอียด)';
const PUBLIC_HINT = 'ทุกคนเห็นรายละเอียดกิจกรรมนี้';
const POPOVER_WIDTH = 340;
// First-paint guess for the popover's height, before it's ever actually been measured (title +
// tabs + 3 collapsed rows + footer). The layout effect below corrects this on the very first
// commit, so it only has to be roughly right — never exact — to avoid a visible jump.
const ESTIMATED_HEIGHT = 300;

type MoreOptionsPayload =
  | { kind: 'event'; date: string; initial: Partial<EventInput> }
  | { kind: 'task'; project: Project; initial: Partial<TaskInput> };

// Google-Calendar-style quick-create popover — the default create path for both กิจกรรม and งาน
// from ปฏิทิน (see CalendarView.tsx's entry points: empty day-cell space, the date number, and
// the "+ กิจกรรม" header button). Rows are collapsed icon+summary lines by default and expand in
// place; "ตัวเลือกเพิ่มเติม" bails to the matching full modal (EventModal / TaskModal), carrying
// over everything typed so far via `initial`.
export default function QuickCreate({ date, anchor, agents, me, scope, projects, onClose, onChanged, onMoreOptions }: {
  date: string; anchor: HTMLElement; agents: Person[]; me: Agent; scope: string; projects: Project[];
  onClose: () => void; onChanged: () => void; onMoreOptions: (payload: MoreOptionsPayload) => void;
}) {
  const nonArchivedProjects = projects.filter((p) => !p.archived);
  const showTaskTab = nonArchivedProjects.length > 0; // an employee with no member project can't create a task — don't show a tab that always 403s
  const scopeIsPerson = agents.some((a) => a.id === scope);

  const [tab, setTab] = useState<'event' | 'task'>('event');
  const [title, setTitle] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // กิจกรรม fields — same defaults/rules as EventModal's own useState initialisers.
  const [eventDate, setEventDate] = useState(date);
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'public'>('public'); // HARD RULE: defaults public, ส่วนตัว is an explicit opt-in
  const [note, setNote] = useState('');
  // ทำซ้ำ — quick mode locks the rule's weekday/dayOfMonth to the picked date (Google-style
  // "ทุกสัปดาห์ในวันพฤหัส"); no separate weekday picker here. Server rejects a mismatch anyway.
  const [recurFreq, setRecurFreq] = useState<'none' | 'daily' | 'weekly' | 'monthly'>('none');
  const [recurUntil, setRecurUntil] = useState('');

  // งาน fields.
  const [projectId, setProjectId] = useState(() => {
    const last = localStorage.getItem(LAST_PROJECT_KEY);
    return (last && nonArchivedProjects.some((p) => p.id === last) ? last : nonArchivedProjects[0]?.id) ?? '';
  });
  const [dueDate, setDueDate] = useState(date);
  const [assigneeId, setAssigneeId] = useState<string | null>(scopeIsPerson ? scope : me.id);
  const [notes, setNotes] = useState('');

  const selectedProject = nonArchivedProjects.find((p) => p.id === projectId) ?? null;
  const assignee = agents.find((a) => a.id === assigneeId) ?? null;

  // Positioning: anchored on desktop, bottom sheet on mobile (the month grid is `hidden md:grid`
  // — there are no day cells to anchor to below that breakpoint, so on mobile this only ever
  // opens from the header button).
  const popRef = useRef<HTMLDivElement>(null);
  const [isMobile, setIsMobile] = useState(() => innerWidth < 768);
  const [pos, setPos] = useState(() => quickCreatePosition(anchor.getBoundingClientRect(), { w: POPOVER_WIDTH, h: ESTIMATED_HEIGHT }, { w: innerWidth, h: innerHeight }));
  function reposition() {
    setIsMobile(innerWidth < 768);
    const el = popRef.current;
    if (!el) return;
    const next = quickCreatePosition(anchor.getBoundingClientRect(), { w: el.offsetWidth, h: el.offsetHeight }, { w: innerWidth, h: innerHeight });
    // Bail out to the *same* object when the numbers haven't moved — quickCreatePosition always
    // returns a fresh object, and this runs after every render (see the layout effect below), so
    // without this comparison setPos would never see an Object.is-equal value and would re-render
    // forever instead of converging after one corrective pass.
    setPos((prev) => (prev.top === next.top && prev.left === next.left ? prev : next));
  }
  // No dep array: expanding/collapsing a row resizes the popover, so every commit needs a
  // re-measure. useLayoutEffect runs before paint, so it never visibly jumps.
  useLayoutEffect(() => { reposition(); });
  useEffect(() => {
    addEventListener('scroll', reposition, true); // capture:true — catches scroll on any ancestor, not just window; brief says do NOT close on scroll
    addEventListener('resize', reposition);
    return () => { removeEventListener('scroll', reposition, true); removeEventListener('resize', reposition); };
  }, []);

  // Click outside → close, discard. 'mousedown' (not 'click') so this fires and unmounts the
  // popover BEFORE a click on a *different* day cell / header button reaches its own onClick —
  // that next click then opens a fresh popover instead of reusing this one's stale state.
  useEffect(() => {
    function onOutsideMouseDown(e: MouseEvent) { if (popRef.current && !popRef.current.contains(e.target as Node)) onClose(); }
    addEventListener('mousedown', onOutsideMouseDown);
    return () => removeEventListener('mousedown', onOutsideMouseDown);
  }, [onClose]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const isSingleLineInput = (e.target as HTMLElement).tagName === 'INPUT'; // title + the date/time fields — not textarea, select, or button
    if (e.ctrlKey || e.metaKey || isSingleLineInput) { e.preventDefault(); void save(); }
  }

  async function save() {
    if (!title.trim() || busy || (tab === 'task' && !selectedProject)) return;
    if (tab === 'event') await saveEvent(); else await saveTask();
  }
  function eventRule(): RecurrenceRule | null {
    const d = new Date(`${eventDate}T00:00:00`);
    if (recurFreq === 'daily') return { freq: 'daily' };
    if (recurFreq === 'weekly') return { freq: 'weekly', weekday: d.getDay() };
    if (recurFreq === 'monthly') return { freq: 'monthly', dayOfMonth: d.getDate() };
    return null;
  }
  async function saveEvent() {
    setBusy(true); setError('');
    const rule = eventRule();
    const body: EventInput = {
      title: title.trim(), note, date: eventDate,
      endDate: endDate || null, startTime: startTime || null, endTime: startTime && endTime ? endTime : null,
      visibility, recurrenceRule: rule, recurrenceUntil: rule && recurUntil ? recurUntil : null,
    };
    try { await addEvent(body); onChanged(); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ'); }
    finally { setBusy(false); }
  }
  async function saveTask() {
    if (!selectedProject) return;
    setBusy(true); setError('');
    try {
      // status omitted — the server defaults a brand-new task to the project's first column.
      await createTask({ projectId: selectedProject.id, title: title.trim(), notes, assigneeId, dueDate, priority: 'normal' });
      localStorage.setItem(LAST_PROJECT_KEY, selectedProject.id);
      onChanged(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  function handleMoreOptions() {
    if (tab === 'event') onMoreOptions({ kind: 'event', date: eventDate, initial: { title, note, date: eventDate, endDate, startTime, endTime, visibility, recurrenceRule: eventRule(), recurrenceUntil: recurFreq !== 'none' && recurUntil ? recurUntil : null } });
    else if (selectedProject) onMoreOptions({ kind: 'task', project: selectedProject, initial: { title, notes, assigneeId, dueDate, priority: 'normal' } });
  }

  function toggleRow(key: string) { setExpanded((cur) => (cur === key ? null : key)); }

  const clockSummary = formatEventClock(eventDate, endDate, startTime, endTime);
  const dueSummary = `${WEEKDAYS_SHORT[new Date(`${dueDate}T00:00:00`).getDay()]} ${shortDate(dueDate)}`;
  const eventDay = new Date(`${eventDate}T00:00:00`);
  const recurSummary = recurFreq === 'none' ? 'ไม่ทำซ้ำ'
    : recurFreq === 'daily' ? 'ทุกวัน'
    : recurFreq === 'weekly' ? `ทุกสัปดาห์ในวัน${WEEKDAYS_FULL[eventDay.getDay()]}`
    : `ทุกเดือนวันที่ ${eventDay.getDate()}`;

  return <div ref={popRef} onKeyDown={handleKeyDown} style={isMobile ? undefined : { top: pos.top, left: pos.left }}
    className={isMobile
      ? 'fixed inset-x-3 bottom-3 z-50 max-h-[85vh] overflow-y-auto rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200'
      : 'fixed z-50 w-[340px] max-h-[85vh] overflow-y-auto rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200'}>
    <div className="flex items-center gap-2 px-4 pt-3.5">
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เพิ่มชื่อ"
        className="min-w-0 flex-1 border-b border-transparent bg-transparent pb-2 text-[15px] font-medium text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-500"/>
      <button type="button" aria-label="ปิด" onClick={onClose} className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-100"><X size={18}/></button>
    </div>

    {showTaskTab && <div className="mx-4 mt-2.5 inline-flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium">
      <button type="button" onClick={() => { setTab('event'); setExpanded(null); }} className={`rounded-md px-3 py-1.5 ${tab === 'event' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>กิจกรรม</button>
      <button type="button" onClick={() => { setTab('task'); setExpanded(null); }} className={`rounded-md px-3 py-1.5 ${tab === 'task' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>งาน</button>
    </div>}

    <div className="mt-2.5">
      {tab === 'event' ? <>
        <Row icon={Clock} summary={clockSummary} expanded={expanded === 'clock'} onToggle={() => toggleRow('clock')}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="วันที่"><input type="date" className="input py-1.5 text-sm" value={eventDate} onChange={(e) => setEventDate(e.target.value)}/></Field>
            <Field label="ถึงวันที่">
              <div className="flex gap-1">
                {/* Rule + multi-day span can't combine (server rejects) — picking one drops the other. */}
                <input type="date" className="input py-1.5 text-sm" value={endDate} min={eventDate} onChange={(e) => { setEndDate(e.target.value); if (e.target.value) setRecurFreq('none'); }}/>
                {endDate && <button type="button" aria-label="ล้างถึงวันที่" onClick={() => setEndDate('')} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X size={14}/></button>}
              </div>
            </Field>
            <Field label="เริ่ม"><input type="time" className="input py-1.5 text-sm" value={startTime} onChange={(e) => { setStartTime(e.target.value); if (!e.target.value) setEndTime(''); }}/></Field>
            <Field label="สิ้นสุด"><input type="time" className="input py-1.5 text-sm" value={endTime} min={startTime || undefined} disabled={!startTime} onChange={(e) => setEndTime(e.target.value)}/></Field>
          </div>
        </Row>
        <Row icon={visibility === 'public' ? Users : Lock} summary={visibility === 'public' ? 'สาธารณะ' : 'ส่วนตัว'}
          expanded={expanded === 'visibility'} onToggle={() => toggleRow('visibility')} footnote={visibility === 'private' ? PRIVATE_HINT : undefined}>
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
          <p className="mt-2 text-[11px] text-slate-500">{visibility === 'public' ? PUBLIC_HINT : PRIVATE_HINT}</p>
        </Row>
        <Row icon={RefreshCw} summary={recurSummary} expanded={expanded === 'recur'} onToggle={() => toggleRow('recur')}>
          <div className="space-y-2">
            <select className="input py-1.5 text-sm" value={recurFreq} onChange={(e) => { const f = e.target.value as typeof recurFreq; setRecurFreq(f); if (f !== 'none') setEndDate(''); }}>
              <option value="none">ไม่ทำซ้ำ</option>
              <option value="daily">ทุกวัน</option>
              <option value="weekly">ทุกสัปดาห์ในวัน{WEEKDAYS_FULL[eventDay.getDay()]}</option>
              <option value="monthly">ทุกเดือนวันที่ {eventDay.getDate()}</option>
            </select>
            {recurFreq !== 'none' && <Field label="สิ้นสุด (ไม่บังคับ)"><input type="date" className="input py-1.5 text-sm" value={recurUntil} min={eventDate} onChange={(e) => setRecurUntil(e.target.value)}/></Field>}
          </div>
        </Row>
        <Row icon={AlignLeft} summary={note.split('\n')[0] || 'เพิ่มโน้ต'} expanded={expanded === 'note'} onToggle={() => toggleRow('note')}>
          <textarea className="input min-h-20 py-1.5 text-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder="โน้ต"/>
        </Row>
      </> : <>
        <Row icon={Folder}
          summary={selectedProject ? <span className="flex items-center gap-1.5"><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: selectedProject.color }}/>{selectedProject.name}</span> : 'เลือกโครงการ'}
          expanded={expanded === 'project'} onToggle={() => toggleRow('project')}>
          <select className="input py-1.5 text-sm" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {nonArchivedProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Row>
        <Row icon={Clock} summary={dueSummary} expanded={expanded === 'due'} onToggle={() => toggleRow('due')}>
          <input type="date" className="input py-1.5 text-sm" value={dueDate} onChange={(e) => setDueDate(e.target.value)}/>
        </Row>
        {/* Full name, never split(' ')[0] — a row summary reads like a card, and "Dr." alone is
            what the owner had us kill in the launch pack. Only the space-constrained filter chips
            up in CalendarView still abbreviate. */}
        <Row icon={User} summary={assignee ? assignee.name : 'ยังไม่มอบหมาย'} expanded={expanded === 'assignee'} onToggle={() => toggleRow('assignee')}>
          <select className="input py-1.5 text-sm" value={assigneeId ?? ''} onChange={(e) => setAssigneeId(e.target.value || null)}>
            <option value="">ยังไม่มอบหมาย</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Row>
        <Row icon={AlignLeft} summary={notes.split('\n')[0] || 'เพิ่มรายละเอียด'} expanded={expanded === 'notes'} onToggle={() => toggleRow('notes')}>
          <textarea className="input min-h-20 py-1.5 text-sm" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="รายละเอียด"/>
        </Row>
      </>}
    </div>

    {error && <p className="px-4 pt-2 text-xs text-rose-600">{error}</p>}
    <div className="mt-1 flex items-center justify-between border-t border-slate-100 px-4 py-3">
      <button type="button" onClick={handleMoreOptions} className="text-xs font-medium text-slate-500 hover:text-slate-700">ตัวเลือกเพิ่มเติม</button>
      <button type="button" onClick={() => void save()} disabled={!title.trim() || busy || (tab === 'task' && !selectedProject)} className="btn-primary">
        {busy && <Loader2 size={15} className="animate-spin"/>} บันทึก
      </button>
    </div>
  </div>;
}

function Row({ icon: Icon, summary, expanded, onToggle, footnote, children }: {
  icon: LucideIcon; summary: React.ReactNode; expanded: boolean; onToggle: () => void; footnote?: string; children: React.ReactNode;
}) {
  return <div className="border-t border-slate-100 first:border-t-0">
    <button type="button" onClick={onToggle} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50">
      <Icon size={16} className="shrink-0 text-slate-400"/>
      <span className="min-w-0 flex-1 truncate">{summary}</span>
      <ChevronDown size={14} className={`shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}/>
    </button>
    {!expanded && footnote && <p className="-mt-1 px-4 pb-2 text-[11px] text-slate-400">{footnote}</p>}
    {expanded && <div className="px-4 pb-3">{children}</div>}
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><span className="text-[11px] text-slate-500">{label}</span><div className="mt-0.5">{children}</div></div>;
}

// พฤ 15 ก.ค. · ทั้งวัน / พฤ 15 ก.ค. · 09:00–12:00 / พฤ 15 – ส 17 ก.ค. (multi-day, same month) — the
// weekday abbreviation always comes from WEEKDAYS_SHORT (never Intl's own) so it never drifts
// from the grid header's own labels. Never touches toISOString: every read here is a local-time
// Date built from a plain YYYY-MM-DD key, same convention as the rest of lib/ui.ts.
function formatEventClock(eventDate: string, endDate: string, startTime: string, endTime: string): string {
  const weekdayDay = (key: string) => { const d = new Date(`${key}T00:00:00`); return `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()}`; };
  const month = (key: string) => new Date(`${key}T00:00:00`).toLocaleDateString('th-TH', { month: 'short' });
  if (endDate && endDate !== eventDate) {
    const sameMonth = eventDate.slice(0, 7) === endDate.slice(0, 7);
    return sameMonth
      ? `${weekdayDay(eventDate)} – ${weekdayDay(endDate)} ${month(endDate)}`
      : `${weekdayDay(eventDate)} ${month(eventDate)} – ${weekdayDay(endDate)} ${month(endDate)}`;
  }
  const label = `${WEEKDAYS_SHORT[new Date(`${eventDate}T00:00:00`).getDay()]} ${shortDate(eventDate)}`;
  if (startTime && endTime) return `${label} · ${startTime}–${endTime}`;
  if (startTime) return `${label} · ${startTime}`;
  return `${label} · ทั้งวัน`;
}
