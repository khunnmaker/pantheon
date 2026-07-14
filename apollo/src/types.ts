export type Role = 'supervisor' | 'md' | 'employee';
export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export interface Agent { id: string; email: string; name: string; role: Role; apps: string[] }
export interface Person { id: string; email: string; name: string; role: Role }
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
