import { useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2, Paperclip, Send, Trash2, X } from 'lucide-react';
import type { Agent, Person, Priority, Project, RecurrenceRule, Task, TaskInput } from './types';
import { addComment, completeTask, createTask, deleteAttachment, deleteComment, deleteTask, downloadAttachment, fileToBase64, getTask, updateTask, uploadAttachment } from './lib/api';
import { PRIORITY_META, agentAvatar } from './lib/ui';

const today = () => new Date().toLocaleDateString('en-CA');

export default function TaskModal({ taskId, project, agents, me, initialStatus, onClose, onChanged }: {
  taskId: string | null; project: Project | null; agents: Person[]; me: Agent; initialStatus?: string;
  onClose: () => void; onChanged: () => void;
}) {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(!!taskId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [title, setTitle] = useState(''); const [notes, setNotes] = useState('');
  const [assigneeId, setAssigneeId] = useState<string | null>(null); const [dueDate, setDueDate] = useState(today());
  const [priority, setPriority] = useState<Priority>('normal'); const [status, setStatus] = useState(initialStatus ?? project?.columns[0] ?? 'To do');
  const [customerRef, setCustomerRef] = useState(''); const [freq, setFreq] = useState<'none' | 'daily' | 'weekly' | 'monthly'>('none');
  const [weekday, setWeekday] = useState(new Date().getDay()); const [dayOfMonth, setDayOfMonth] = useState(new Date().getDate());
  const [comment, setComment] = useState('');

  function fill(value: Task) {
    setTask(value); setTitle(value.title); setNotes(value.notes); setAssigneeId(value.assigneeId);
    setDueDate(value.dueDate.slice(0, 10)); setPriority(value.priority); setStatus(value.status); setCustomerRef(value.customerRef ?? '');
    const rule = value.recurrenceRule; setFreq(rule?.freq ?? 'none');
    if (rule?.freq === 'weekly') setWeekday(rule.weekday); if (rule?.freq === 'monthly') setDayOfMonth(rule.dayOfMonth);
  }
  async function reload() { if (!taskId) return; setLoading(true); try { fill(await getTask(taskId)); } catch { setError('เปิดงานนี้ไม่ได้'); } finally { setLoading(false); } }
  useEffect(() => { void reload(); }, [taskId]);

  function recurrence(): RecurrenceRule | null {
    if (freq === 'daily') return { freq };
    if (freq === 'weekly') return { freq, weekday };
    if (freq === 'monthly') return { freq, dayOfMonth };
    return null;
  }
  async function save() {
    if (!title.trim() || !project && !task?.project) return;
    setBusy(true); setError('');
    const body: TaskInput = { title: title.trim(), notes, assigneeId, dueDate, priority, status, customerRef: customerRef.trim() || null, recurrenceRule: recurrence() };
    try {
      if (taskId) fill(await updateTask(taskId, body));
      else await createTask({ ...body, projectId: project!.id });
      onChanged(); if (!taskId) onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ'); } finally { setBusy(false); }
  }
  async function finish() { if (!taskId) return; setBusy(true); try { await completeTask(taskId); onChanged(); onClose(); } finally { setBusy(false); } }
  async function remove() { if (!taskId || !confirm('ลบงานนี้หรือไม่?')) return; setBusy(true); try { await deleteTask(taskId); onChanged(); onClose(); } finally { setBusy(false); } }
  async function sendComment() { if (!taskId || !comment.trim()) return; await addComment(taskId, comment.trim()); setComment(''); await reload(); onChanged(); }
  async function attach(file: File) { if (!taskId) return; setBusy(true); try { await uploadAttachment(taskId, { dataB64: await fileToBase64(file), fileName: file.name, contentType: file.type || 'application/octet-stream' }); await reload(); onChanged(); } finally { setBusy(false); } }

  const columns = task?.project?.columns ?? project?.columns ?? ['To do', 'Doing', 'Done'];
  if (loading) return <Shell onClose={onClose}><div className="grid h-72 place-items-center"><Loader2 className="animate-spin text-blue-500"/></div></Shell>;
  return <Shell onClose={onClose}>
    <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
      <div><div className="text-xs font-semibold uppercase tracking-wide text-blue-600">{taskId ? task?.project?.name ?? project?.name : project?.name}</div><h2 className="mt-1 text-lg font-bold">{taskId ? 'รายละเอียดงาน' : 'สร้างงานใหม่'}</h2></div>
      <button aria-label="ปิด" onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"><X/></button>
    </div>
    <div className="max-h-[calc(90vh-70px)] overflow-y-auto p-5">
      <label className="label">ชื่องาน</label><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus={!taskId}/>
      <label className="label">รายละเอียด</label><textarea className="input min-h-24" value={notes} onChange={(e) => setNotes(e.target.value)}/>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="ผู้รับผิดชอบ"><select className="input" value={assigneeId ?? ''} onChange={(e) => setAssigneeId(e.target.value || null)}><option value="">ยังไม่มอบหมาย</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="กำหนดส่ง"><input type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)}/></Field>
        <Field label="ความสำคัญ"><div className="flex flex-wrap gap-1.5">{(Object.keys(PRIORITY_META) as Priority[]).map((key) => { const meta = PRIORITY_META[key]; const active = priority === key; return <button type="button" key={key} onClick={() => setPriority(key)} className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${active ? `border-transparent ${meta.chip} ring-2 ${meta.ring}` : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}><meta.icon size={12}/>{meta.label}</button>; })}</div></Field>
        <Field label="สถานะ"><select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>{columns.map((c) => <option key={c}>{c}</option>)}</select></Field>
      </div>
      <label className="label">อ้างอิงลูกค้า (ถ้ามี)</label><input className="input" value={customerRef} onChange={(e) => setCustomerRef(e.target.value)}/>
      <div className="mt-4 rounded-xl border border-slate-200 p-3">
        <label className="text-xs font-semibold text-slate-600">ทำซ้ำ</label>
        <div className="mt-2 flex flex-wrap gap-2"><select className="input max-w-40" value={freq} onChange={(e) => setFreq(e.target.value as typeof freq)}><option value="none">ไม่ทำซ้ำ</option><option value="daily">ทุกวัน</option><option value="weekly">ทุกสัปดาห์</option><option value="monthly">ทุกเดือน</option></select>
          {freq === 'weekly' && <select className="input max-w-40" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>{['อาทิตย์','จันทร์','อังคาร','พุธ','พฤหัส','ศุกร์','เสาร์'].map((d, i) => <option key={d} value={i}>{d}</option>)}</select>}
          {freq === 'monthly' && <input aria-label="วันที่ของเดือน" className="input max-w-28" type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(Math.max(1, Math.min(31, Number(e.target.value))))}/>}</div>
      </div>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
      <div className="mt-5 flex flex-wrap gap-2">
        <button onClick={() => void save()} disabled={busy || !title.trim()} className="btn-primary">{busy && <Loader2 size={15} className="animate-spin"/>} บันทึก</button>
        {taskId && !task?.completedAt && <button onClick={() => void finish()} disabled={busy} className="btn bg-emerald-600 text-white"><CheckCircle2 size={16}/> เสร็จแล้ว</button>}
        {taskId && (me.role !== 'employee' || task?.creator?.id === me.id) && <button onClick={() => void remove()} disabled={busy} className="btn ml-auto text-rose-600 hover:bg-rose-50"><Trash2 size={16}/> ลบ</button>}
      </div>

      {taskId && <>
        <section className="mt-7 border-t border-slate-200 pt-5"><div className="flex items-center justify-between"><h3 className="font-bold">ไฟล์แนบ</h3><label className="btn cursor-pointer border border-slate-200"><Paperclip size={15}/> แนบไฟล์<input type="file" className="hidden" onChange={(e) => { const file = e.currentTarget.files?.[0]; if (file) void attach(file); e.currentTarget.value = ''; }}/></label></div>
          <div className="mt-2 space-y-2">{task?.attachments?.map((a) => <div key={a.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm"><Paperclip size={14}/><span className="min-w-0 flex-1 truncate">{a.fileName}</span><button aria-label="ดาวน์โหลด" onClick={() => void downloadAttachment(a)}><Download size={15}/></button>{(a.uploadedById === me.id || me.role !== 'employee') && <button aria-label="ลบไฟล์" onClick={async () => { await deleteAttachment(a.id); await reload(); }} className="text-rose-500"><Trash2 size={15}/></button>}</div>)}</div>
        </section>
        <section className="mt-6 border-t border-slate-200 pt-5"><h3 className="font-bold">ความคิดเห็น</h3><div className="mt-3 space-y-3">{task?.comments?.map((c) => <div key={c.id} className="rounded-xl bg-slate-50 p-3 text-sm"><div className="flex items-center justify-between text-xs text-slate-500"><span className="flex items-center gap-1.5 font-semibold text-slate-700"><img src={agentAvatar(c.author, agents)} alt="" className="h-[18px] w-[18px] rounded-full"/>{c.author.name}</span>{(c.authorId === me.id || me.role !== 'employee') && <button onClick={async () => { await deleteComment(c.id); await reload(); }} className="text-rose-500">ลบ</button>}</div><p className="mt-1 whitespace-pre-wrap">{c.body}</p></div>)}</div>
          <div className="mt-3 flex gap-2"><input className="input" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void sendComment()} placeholder="เขียนความคิดเห็น…"/><button aria-label="ส่ง" onClick={() => void sendComment()} className="btn-primary"><Send size={16}/></button></div>
        </section>
      </>}
    </div>
  </Shell>;
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) { return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl">{children}</div></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="label">{label}</label>{children}</div>; }
