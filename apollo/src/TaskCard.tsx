import type { DragEvent } from 'react';
import { CalendarDays, MessageSquare, Paperclip, RefreshCw, Tag, UserPlus } from 'lucide-react';
import { PRIORITY_META, agentAvatar, dueClass, shortDate, type ColumnAccent } from './lib/ui';
import type { Person, TaskCardTask } from './types';

// Shared task card — used by the Board columns, My Tasks buckets, and the calendar's day
// modal/agenda so none of them drift apart. Takes TaskCardTask (a narrow Pick<Task, ...>) so
// callers with a leaner row shape (e.g. the calendar endpoint) can pass it straight through.
export default function TaskCard({ task, agents, accent, showProject, dragging, draggable, onClick, onDragStart, onDragEnd, onDragOver, onDrop }: {
  task: TaskCardTask; agents: Person[]; accent?: ColumnAccent; showProject?: boolean; dragging?: boolean; onClick?: () => void;
  draggable?: boolean; onDragStart?: () => void; onDragEnd?: () => void; onDragOver?: (e: DragEvent<HTMLElement>) => void; onDrop?: (e: DragEvent<HTMLElement>) => void;
}) {
  const meta = PRIORITY_META[task.priority]; const PriorityIcon = meta.icon;
  const hasChips = task.priority !== 'normal' || !!task.recurrenceRule || !!task.customerRef;
  const attachments = task._count?.attachments ?? 0; const comments = task._count?.comments ?? 0;

  return <article draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onDragOver} onDrop={onDrop} onClick={onClick}
    className={`cursor-pointer rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:-translate-y-px hover:shadow-md ${accent?.border ?? 'hover:border-blue-300'} ${dragging ? 'opacity-60 ring-2 ring-blue-400' : ''}`}>
    {showProject && task.project && <div className="mb-1 flex items-center gap-1.5 text-[11px] text-slate-500"><span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: task.project.color }}/>{task.project.name}</div>}
    <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{task.title}</h3>
    {hasChips && <div className="mt-1.5 flex flex-wrap gap-1">
      {task.priority !== 'normal' && <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] ${meta.chip}`}><PriorityIcon size={11}/>{meta.label}</span>}
      {task.recurrenceRule && <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"><RefreshCw size={11}/>ทำซ้ำ</span>}
      {task.customerRef && <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700"><Tag size={11}/><span className="max-w-[12ch] truncate">{task.customerRef}</span></span>}
    </div>}
    <div className="mt-2 flex items-center justify-between text-xs">
      {task.assignee
        ? <span className="flex min-w-0 items-center gap-1.5 text-slate-600"><img src={agentAvatar(task.assignee, agents)} alt="" className="h-5 w-5 shrink-0 rounded-full"/><span className="max-w-[9rem] truncate">{task.assignee.name}</span></span>
        : <span className="flex items-center gap-1.5 text-slate-400"><span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-dashed border-slate-300"><UserPlus size={11}/></span>มอบหมาย</span>}
      <span className="flex shrink-0 items-center gap-2 text-slate-400">
        <span className={`inline-flex items-center gap-1 ${dueClass(task.dueDate)}`}><CalendarDays size={12}/>{shortDate(task.dueDate)}</span>
        {attachments > 0 && <span className="inline-flex items-center gap-0.5"><Paperclip size={12}/>{attachments}</span>}
        {comments > 0 && <span className="inline-flex items-center gap-0.5"><MessageSquare size={12}/>{comments}</span>}
      </span>
    </div>
  </article>;
}
