export type Role = 'supervisor' | 'gm' | 'agm' | 'employee';
export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export interface Agent { id: string; email: string; name: string; role: Role; apps: string[] }
// gender is only populated on the agents list from GET /api/apollo/agents (roster lookup, §0 of
// the polish spec) — other Person-shaped payloads (assignee/author/uploadedBy) omit it.
export interface Person { id: string; email: string; name: string; role: Role; gender?: 'male' | 'female' }
export type RecurrenceRule = { freq: 'daily' } | { freq: 'weekly'; weekday: number } | { freq: 'monthly'; dayOfMonth: number };
export interface ProjectMember { id: string; agentId: string; agent: Person }
export interface Project { id: string; name: string; color: string; columns: string[]; archived: boolean; members: ProjectMember[]; _count?: { tasks: number }; tasks?: Task[] }
export interface Comment { id: string; body: string; authorId: string; author: Person; createdAt: string }
export interface Attachment { id: string; fileName: string; contentType: string; kind: 'image' | 'file'; size: number; uploadedById: string; uploadedBy: Person; createdAt: string }
export interface Task {
  id: string; projectId: string; project?: Pick<Project, 'id' | 'name' | 'color' | 'columns' | 'archived'>;
  title: string; notes: string; assigneeId: string | null; assignee: Person | null; creator?: Person;
  dueDate: string; priority: Priority; status: string; customerRef: string | null;
  recurrenceRule: RecurrenceRule | null; seriesId: string | null; sortOrder: number; completedAt: string | null;
  comments?: Comment[]; attachments?: Attachment[]; _count?: { comments: number; attachments: number };
}
export interface TaskInput { projectId?: string; title: string; notes?: string; assigneeId?: string | null; dueDate: string; priority?: Priority; status?: string; customerRef?: string | null; recurrenceRule?: RecurrenceRule | null }

// Narrow structural shape TaskCard actually reads — lets it accept both full Task objects
// (Board/List/MyTasks) and the calendar endpoint's leaner rows without either side casting.
export type TaskCardTask = Pick<Task, 'id' | 'title' | 'priority' | 'dueDate' | 'recurrenceRule' | 'customerRef' | 'assignee' | '_count'> & { project?: Pick<Project, 'name' | 'color'> };
// Row shape returned by GET /api/apollo/calendar (see api/src/routes/apollo.ts calendarTaskSelect).
export interface CalendarTask {
  id: string; title: string; dueDate: string; priority: Priority; status: string;
  recurrenceRule: RecurrenceRule | null; customerRef: string | null;
  project: Pick<Project, 'id' | 'name' | 'color' | 'archived'>; assignee: Person | null;
}

// Personal event (นัดหมอ, ธุระส่วนตัว), as returned by GET /api/apollo/calendar's `events`
// (see api/src/apollo/calendarQuery.ts maskEvent). The server includes title/note/visibility
// only for the owner, the CEO, or a 'public' event; every other viewer gets them genuinely
// absent from the payload, not just blank — so `title !== undefined` (not `own`) is what the UI
// branches on to render a real chip vs. the anonymous "ไม่ว่าง" block.
// A recurring event arrives as one row PER OCCURRENCE (row `date` = the occurrence day, so all
// per-day grouping just works); own/public rows additionally carry the rule, `seriesDate` (the
// series' base date — what EventModal must seed its วันที่ from, NEVER `date`; see THE REBASE
// TRAP comment there) and `recurrenceUntil`. Masked free/busy rows omit all three, like title.
export interface CalendarEvent {
  id: string; agentId: string; date: string; endDate: string | null;
  startTime: string | null; endTime: string | null; own: boolean;
  title?: string; note?: string; visibility?: 'private' | 'public'; assignee?: Person;
  recurrenceRule?: RecurrenceRule | null; seriesDate?: string; recurrenceUntil?: string | null;
}
// POST /api/apollo/events + PATCH /api/apollo/events/:id body — the same full shape for both
// (the EventModal always submits the whole form; see apollo.ts's eventBody for why). skipDates
// is deliberately NOT here: only the skip route may touch it.
export interface EventInput { title: string; note?: string; date: string; endDate?: string | null; startTime?: string | null; endTime?: string | null; visibility?: 'private' | 'public'; recurrenceRule?: RecurrenceRule | null; recurrenceUntil?: string | null }
// Raw row returned by the CRUD endpoints themselves (always the owner's own event, so no
// mask/own/assignee — distinct from the calendar's read-shaped CalendarEvent above).
export interface ApolloEvent {
  id: string; agentId: string; title: string; note: string; date: string; endDate: string | null;
  startTime: string | null; endTime: string | null; createdAt: string; updatedAt: string;
  recurrenceRule: RecurrenceRule | null; recurrenceUntil: string | null; skipDates: string[];
}
