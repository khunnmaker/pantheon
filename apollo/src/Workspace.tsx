import { useEffect, useMemo, useState } from 'react';
import { BarChart3, CalendarDays, CheckSquare, Kanban, List, LogOut, Plus, Settings, SlidersHorizontal, Users } from 'lucide-react';
import AppSwitcher from './AppSwitcher';
import TaskModal from './TaskModal';
import type { Agent, Person, Priority, Project, Task } from './types';
import { createProject, generateLineBind, getAgents, getDashboard, getLineBind, getMyTasks, getProject, getProjects, logout, moveTask, updateColumns, updateMembers, updateProject } from './lib/api';

type View = 'board' | 'list' | 'mine' | 'dashboard' | 'settings';
const priorityRank: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const priorityStyle: Record<Priority, string> = { urgent: 'bg-rose-100 text-rose-700', high: 'bg-orange-100 text-orange-700', normal: 'bg-blue-50 text-blue-700', low: 'bg-slate-100 text-slate-600' };
const priorityTh: Record<Priority, string> = { urgent: 'ด่วนที่สุด', high: 'สูง', normal: 'ปกติ', low: 'ต่ำ' };
const deepTaskId = () => /^\/t\/([^/]+)$/.exec(location.pathname)?.[1] ?? null;

export default function Workspace({ agent, onLogout }: { agent: Agent; onLogout: () => void }) {
  const isManager = agent.role !== 'employee';
  const [view, setView] = useState<View>('board'); const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Person[]>([]); const [projectId, setProjectId] = useState(''); const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true); const [modalOpen, setModalOpen] = useState(!!deepTaskId()); const [taskId, setTaskId] = useState<string | null>(deepTaskId());
  const [projectSettings, setProjectSettings] = useState(false);

  async function loadIndex() {
    const [p, a] = await Promise.all([getProjects(), getAgents()]); setProjects(p.projects); setAgents(a.agents);
    const next = projectId && p.projects.some((x) => x.id === projectId) ? projectId : p.projects.find((x) => !x.archived)?.id ?? p.projects[0]?.id ?? '';
    setProjectId(next); return next;
  }
  async function loadProject(id = projectId) { if (!id) { setProject(null); return; } try { setProject(await getProject(id)); } catch { setProject(null); } }
  async function refresh() { const next = await loadIndex(); await loadProject(next); }
  useEffect(() => { void refresh().finally(() => setLoading(false)); }, []);
  useEffect(() => { if (projectId) void loadProject(projectId); }, [projectId]);
  useEffect(() => { const pop = () => { const id = deepTaskId(); setTaskId(id); setModalOpen(!!id); }; addEventListener('popstate', pop); return () => removeEventListener('popstate', pop); }, []);
  function openTask(id: string) { setTaskId(id); setModalOpen(true); history.pushState({}, '', `/t/${id}`); }
  function newTask() { if (!project) return; setTaskId(null); setModalOpen(true); }
  function closeModal() { setModalOpen(false); setTaskId(null); if (deepTaskId()) history.pushState({}, '', '/'); }
  async function addProject() { const name = prompt('ชื่อโครงการ'); if (!name?.trim()) return; const created = await createProject({ name: name.trim(), memberIds: [] }); await refresh(); setProjectId(created.id); }
  async function signOut() { await logout(); onLogout(); }

  const nav: { key: View; label: string; icon: typeof Kanban; manager?: boolean }[] = [
    { key: 'board', label: 'บอร์ด', icon: Kanban }, { key: 'list', label: 'รายการ', icon: List },
    { key: 'mine', label: 'งานของฉัน', icon: CheckSquare }, { key: 'dashboard', label: 'ภาพรวม', icon: BarChart3, manager: true },
    { key: 'settings', label: 'ตั้งค่า', icon: Settings },
  ];
  return <div className="min-h-screen bg-slate-50">
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white"><div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between px-4"><AppSwitcher agent={agent}/><div className="flex items-center gap-3 text-sm"><span className="hidden text-slate-500 sm:inline">{agent.name}</span><button onClick={() => void signOut()} className="text-slate-400 hover:text-rose-600" title="ออกจากระบบ"><LogOut size={18}/></button></div></div></header>
    <div className="mx-auto flex max-w-[1600px]">
      <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-52 shrink-0 border-r border-slate-200 bg-white p-3 md:block">{nav.filter((n) => !n.manager || isManager).map(({ key, label, icon: Icon }) => <button key={key} onClick={() => setView(key)} className={`mb-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm ${view === key ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-600 hover:bg-slate-50'}`}><Icon size={17}/>{label}</button>)}</aside>
      <main className="min-w-0 flex-1 p-3 pb-24 sm:p-5">
        {(view === 'board' || view === 'list') && <div className="mb-4 flex flex-wrap items-center gap-2"><select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><option value="">เลือกโครงการ</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.archived ? '🗄 ' : ''}{p.name}</option>)}</select>{isManager && <button onClick={() => void addProject()} className="btn border border-slate-200 bg-white"><Plus size={16}/> โครงการ</button>}{project && isManager && <button onClick={() => setProjectSettings(true)} className="btn border border-slate-200 bg-white"><SlidersHorizontal size={16}/> ตั้งค่าโครงการ</button>}<button onClick={newTask} disabled={!project || project.archived} className="btn-primary ml-auto"><Plus size={16}/> เพิ่มงาน</button></div>}
        {loading ? <div className="py-20 text-center text-slate-400">กำลังโหลด…</div> : view === 'board' ? <Board project={project} onOpen={openTask} onMoved={() => void loadProject()}/> : view === 'list' ? <TaskList project={project} onOpen={openTask}/> : view === 'mine' ? <MyTasks onOpen={openTask}/> : view === 'dashboard' && isManager ? <Dashboard/> : <LineSettings/>}
      </main>
    </div>
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white md:hidden">{nav.filter((n) => !n.manager || isManager).map(({ key, label, icon: Icon }) => <button key={key} onClick={() => setView(key)} className={`flex flex-1 flex-col items-center gap-1 py-2 text-[10px] ${view === key ? 'text-blue-700' : 'text-slate-500'}`}><Icon size={18}/>{label}</button>)}</nav>
    {modalOpen && <TaskModal taskId={taskId} project={project} agents={agents} me={agent} onClose={closeModal} onChanged={() => void refresh()}/>} 
    {projectSettings && project && <ProjectSettings project={project} agents={agents} onClose={() => setProjectSettings(false)} onSaved={async () => { setProjectSettings(false); await refresh(); }}/>}
  </div>;
}

function Board({ project, onOpen, onMoved }: { project: Project | null; onOpen: (id: string) => void; onMoved: () => void }) {
  const [dragged, setDragged] = useState<string | null>(null); const tasks = (project?.tasks ?? []).filter((t) => !t.completedAt);
  async function drop(status: string, beforeId?: string) {
    if (!dragged || !project) return;
    const ids = tasks.filter((t) => t.status === status && t.id !== dragged).map((t) => t.id);
    const at = beforeId ? ids.indexOf(beforeId) : -1; if (at >= 0) ids.splice(at, 0, dragged); else ids.push(dragged);
    await moveTask(dragged, status, ids); setDragged(null); onMoved();
  }
  if (!project) return <Empty text="ยังไม่มีโครงการที่เปิดได้"/>;
  return <div className="flex gap-3 overflow-x-auto pb-4">{project.columns.map((column) => <section key={column} onDragOver={(e) => e.preventDefault()} onDrop={() => void drop(column)} className="min-h-[65vh] w-72 shrink-0 rounded-2xl bg-slate-100 p-3"><div className="mb-3 flex items-center justify-between"><h2 className="font-bold text-slate-700">{column}</h2><span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-500">{tasks.filter((t) => t.status === column).length}</span></div><div className="space-y-2">{tasks.filter((t) => t.status === column).sort((a,b) => a.sortOrder-b.sortOrder).map((task) => <article key={task.id} draggable onDragStart={() => setDragged(task.id)} onDragEnd={() => setDragged(null)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.stopPropagation(); void drop(column, task.id); }} onClick={() => onOpen(task.id)} className="cursor-pointer rounded-xl border border-slate-200 bg-white p-3 shadow-sm hover:border-blue-300"><div className="mb-2 flex items-start gap-2"><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${task.priority === 'urgent' ? 'bg-rose-500' : task.priority === 'high' ? 'bg-orange-400' : task.priority === 'normal' ? 'bg-blue-400' : 'bg-slate-300'}`}/><h3 className="text-sm font-semibold leading-snug">{task.title}</h3></div><div className="flex items-center justify-between text-xs text-slate-500"><span>{task.assignee?.name ?? 'ยังไม่มอบหมาย'}</span><Due task={task}/></div></article>)}</div></section>)}</div>;
}

function TaskList({ project, onOpen }: { project: Project | null; onOpen: (id: string) => void }) {
  const [sort, setSort] = useState<'due'|'priority'|'assignee'>('due');
  const tasks = useMemo(() => [...(project?.tasks ?? [])].filter((t) => !t.completedAt).sort((a,b) => sort === 'priority' ? priorityRank[a.priority]-priorityRank[b.priority] : sort === 'assignee' ? (a.assignee?.name ?? '').localeCompare(b.assignee?.name ?? '', 'th') : a.dueDate.localeCompare(b.dueDate)), [project, sort]);
  if (!project) return <Empty text="ยังไม่มีโครงการที่เปิดได้"/>;
  return <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white"><div className="flex items-center justify-between border-b border-slate-200 p-3"><h2 className="font-bold">{project.name}</h2><select className="rounded-lg border border-slate-200 px-2 py-1 text-xs" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="due">เรียงกำหนดส่ง</option><option value="priority">เรียงความสำคัญ</option><option value="assignee">เรียงผู้รับผิดชอบ</option></select></div><div className="overflow-x-auto"><table className="w-full min-w-[700px] text-sm"><thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="p-3">งาน</th><th>สถานะ</th><th>ผู้รับผิดชอบ</th><th>กำหนดส่ง</th><th>ความสำคัญ</th></tr></thead><tbody>{tasks.map((t) => <tr key={t.id} onClick={() => onOpen(t.id)} className="cursor-pointer border-t border-slate-100 hover:bg-blue-50/40"><td className="p-3 font-medium">{t.title}</td><td>{t.status}</td><td>{t.assignee?.name ?? '—'}</td><td><Due task={t}/></td><td><span className={`rounded-full px-2 py-1 text-xs ${priorityStyle[t.priority]}`}>{priorityTh[t.priority]}</span></td></tr>)}</tbody></table></div></div>;
}

function MyTasks({ onOpen }: { onOpen: (id: string) => void }) {
  const [data, setData] = useState<{ overdue: Task[]; today: Task[]; upcoming: Task[] } | null>(null);
  useEffect(() => { void getMyTasks().then(setData); }, []);
  if (!data) return <div className="py-20 text-center text-slate-400">กำลังโหลด…</div>;
  return <div><h1 className="mb-4 text-xl font-bold">งานของฉัน</h1><div className="grid gap-4 lg:grid-cols-3"><Bucket title="เลยกำหนด" color="text-rose-600" tasks={data.overdue} onOpen={onOpen}/><Bucket title="วันนี้" color="text-blue-600" tasks={data.today} onOpen={onOpen}/><Bucket title="กำลังจะถึง" color="text-slate-700" tasks={data.upcoming} onOpen={onOpen}/></div></div>;
}
function Bucket({ title, color, tasks, onOpen }: { title: string; color: string; tasks: Task[]; onOpen: (id:string)=>void }) { return <section className="rounded-2xl border border-slate-200 bg-white p-4"><h2 className={`mb-3 font-bold ${color}`}>{title} <span className="text-xs font-normal text-slate-400">{tasks.length}</span></h2><div className="space-y-2">{tasks.map((t) => <button key={t.id} onClick={() => onOpen(t.id)} className="w-full rounded-xl border border-slate-100 p-3 text-left hover:border-blue-300"><div className="text-sm font-semibold">{t.title}</div><div className="mt-1 flex justify-between text-xs text-slate-500"><span>{t.project?.name}</span><Due task={t}/></div></button>)}{!tasks.length && <p className="py-5 text-center text-xs text-slate-400">ไม่มีงาน</p>}</div></section>; }

function Dashboard() {
  const [data, setData] = useState<Awaited<ReturnType<typeof getDashboard>> | null>(null); useEffect(() => { void getDashboard().then(setData); }, []);
  if (!data) return <div className="py-20 text-center text-slate-400">กำลังโหลด…</div>;
  return <div><h1 className="mb-4 text-xl font-bold">ภาพรวมงานทีม</h1><div className="grid gap-4 xl:grid-cols-2"><section className="rounded-2xl border border-slate-200 bg-white p-4"><h2 className="mb-3 flex items-center gap-2 font-bold"><Users size={18}/> รายคน</h2>{data.people.map((p) => <div key={p.id} className="flex items-center border-t border-slate-100 py-2 text-sm"><span className="flex-1">{p.name}</span><span className="mr-4 text-slate-500">ค้าง {p.open}</span><span className={p.overdue ? 'font-semibold text-rose-600' : 'text-slate-400'}>เลยกำหนด {p.overdue}</span></div>)}</section><section className="rounded-2xl border border-slate-200 bg-white p-4"><h2 className="mb-3 flex items-center gap-2 font-bold"><BarChart3 size={18}/> ตามโครงการ</h2>{data.projects.map((p) => <div key={p.id} className="border-t border-slate-100 py-3"><div className="font-semibold" style={{color:p.color}}>{p.name}</div><div className="mt-2 flex flex-wrap gap-2">{p.columns.map((c) => <span key={c} className="rounded-full bg-slate-100 px-2 py-1 text-xs">{c} {p.statuses[c]}</span>)}</div></div>)}</section></div></div>;
}

function LineSettings() {
  const [state, setState] = useState<{ bound: boolean; code: string | null } | null>(null); useEffect(() => { void getLineBind().then(setState); }, []);
  return <div className="mx-auto max-w-xl"><h1 className="mb-4 text-xl font-bold">ตั้งค่า Apollo</h1><section className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="font-bold">ผูก LINE</h2>{state?.bound ? <p className="mt-2 text-sm text-emerald-700">✓ ผูก LINE แล้ว รับแจ้งเตือนงานและสรุปตอนเช้าได้</p> : <><p className="mt-2 text-sm text-slate-600">สร้างรหัสแล้วส่งข้อความตามตัวอักษรทุกตัวไปที่ Minerva OA</p>{state?.code && <div className="mt-4 rounded-xl bg-slate-900 p-4 text-center font-mono text-xl font-bold tracking-wider text-white">APOLLO-{state.code}</div>}<button onClick={async () => setState(await generateLineBind())} className="btn-primary mt-4">{state?.code ? 'สร้างรหัสใหม่' : 'สร้างรหัสผูก LINE'}</button></>}</section></div>;
}

function ProjectSettings({ project, agents, onClose, onSaved }: { project: Project; agents: Person[]; onClose:()=>void; onSaved:()=>void }) {
  const [name, setName] = useState(project.name); const [color, setColor] = useState(project.color); const [archived, setArchived] = useState(project.archived);
  const [columns, setColumns] = useState(project.columns.map((value) => ({ original: value as string | null, value })));
  const [members, setMembers] = useState(new Set(project.members.map((m) => m.agentId))); const [busy, setBusy] = useState(false);
  async function save() { const clean = columns.map((c) => c.value.trim()).filter(Boolean); if (!name.trim() || clean.length !== columns.length || !clean.length || new Set(clean).size !== clean.length) return alert('กรุณาตรวจชื่อคอลัมน์ (ห้ามซ้ำ/ว่าง)'); setBusy(true); const renames: Record<string,string> = {}; columns.forEach((c) => { if (c.original && c.value.trim() !== c.original) renames[c.original] = c.value.trim(); }); await updateProject(project.id, { name: name.trim(), color, archived }); await updateColumns(project.id, clean, renames); await updateMembers(project.id, [...members]); setBusy(false); onSaved(); }
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-3"><div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl"><div className="flex items-center justify-between"><h2 className="text-lg font-bold">ตั้งค่าโครงการ</h2><button onClick={onClose}>×</button></div><label className="label">ชื่อ</label><input className="input" value={name} onChange={(e) => setName(e.target.value)}/><label className="label">สี / emoji</label><input className="input" value={color} onChange={(e) => setColor(e.target.value)}/><label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)}/> เก็บโครงการเข้าคลัง</label><label className="label">คอลัมน์สถานะ</label><div className="space-y-2">{columns.map((column,i) => <div key={column.original ?? `new-${i}`} className="flex gap-2"><input className="input" value={column.value} onChange={(e) => setColumns(columns.map((x,j) => j===i ? { ...x, value: e.target.value } : x))}/><button onClick={() => columns.length > 1 && setColumns(columns.filter((_,j)=>j!==i))} className="px-2 text-rose-500">ลบ</button></div>)}<button onClick={() => setColumns([...columns, { original: null, value: '' }])} className="text-sm text-blue-600">+ เพิ่มคอลัมน์</button></div><label className="label">สมาชิก</label><div className="max-h-40 overflow-y-auto rounded-xl border border-slate-200 p-2">{agents.map((a) => <label key={a.id} className="flex items-center gap-2 px-2 py-1 text-sm"><input type="checkbox" checked={members.has(a.id)} onChange={() => { const next = new Set(members); next.has(a.id) ? next.delete(a.id) : next.add(a.id); setMembers(next); }}/>{a.name}</label>)}</div><div className="mt-5 flex justify-end gap-2"><button onClick={onClose} className="btn">ยกเลิก</button><button disabled={busy} onClick={() => void save()} className="btn-primary">บันทึก</button></div></div></div>;
}

function Due({ task }: { task: Task }) { const day = task.dueDate.slice(0,10); const now = new Date().toLocaleDateString('en-CA'); return <span className={`inline-flex items-center gap-1 ${day < now ? 'font-semibold text-rose-600' : ''}`}><CalendarDays size={13}/>{new Date(`${day}T00:00:00`).toLocaleDateString('th-TH', { day:'numeric', month:'short' })}</span>; }
function Empty({ text }: { text: string }) { return <div className="rounded-2xl border border-dashed border-slate-300 bg-white py-20 text-center text-sm text-slate-400">{text}</div>; }
