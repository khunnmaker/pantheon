import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth, requireApp } from '../auth/middleware.js';
import { completeApolloTask, parseRecurrenceRule } from '../apollo/recurrence.js';
import { CALENDAR_MAX_RANGE_DAYS, buildEventData, dateSchema, eventDateRangeWhere, eventTimeSchema, expandCalendarEvents, occursOn, parseCalendarRange, parseDate, recurringEventRangeWhere, resolveCalendarScope, type EventData } from '../apollo/calendarQuery.js';
import { notifyApolloAssignment, thaiDateKey } from '../apollo/notify.js';
import { deleteApolloAttachment, readApolloAttachment, saveApolloAttachment } from '../apollo/attachmentStore.js';
import { EMPLOYEES, TIER_ACCOUNTS, employeeEmail } from '../db/ensureSeeded.js';
import { isApolloManager } from '../apollo/access.js';

// Roster email → display gender (see ensureSeeded.ts) — UI-only metadata for the board's avatar
// polish (§0 of the Apollo UI spec). Built once from the static roster consts.
const GENDER_BY_EMAIL = new Map<string, 'male' | 'female'>([
  ...TIER_ACCOUNTS.map((t) => [t.email, t.gender] as const),
  ...EMPLOYEES.map((e) => [employeeEmail(e.slug), e.gender] as const),
]);

const prioritySchema = z.enum(['urgent', 'high', 'normal', 'low']);
const recurrenceSchema = z.discriminatedUnion('freq', [
  z.object({ freq: z.literal('daily') }),
  z.object({ freq: z.literal('weekly'), weekday: z.number().int().min(0).max(6) }),
  z.object({ freq: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(31) }),
]);
const taskBody = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(20_000).optional(),
  assigneeId: z.string().cuid().nullable().optional(),
  dueDate: dateSchema,
  priority: prioritySchema.optional(),
  status: z.string().trim().min(1).max(80).optional(),
  customerRef: z.string().trim().max(300).nullable().optional(),
  recurrenceRule: recurrenceSchema.nullable().optional(),
});
// Same shape for create AND update — the EventModal always submits the whole form (there's no
// partial-edit UI), so PATCH reuses this rather than a second .partial() schema with its own
// provided/omitted tri-state to reason about.
const eventBody = z.object({
  title: z.string().trim().min(1).max(200),
  note: z.string().max(5000).optional(),
  date: dateSchema,
  endDate: dateSchema.nullable().optional(),
  startTime: eventTimeSchema.nullable().optional(),
  endTime: eventTimeSchema.nullable().optional(),
  visibility: z.enum(['private', 'public']).optional(),
  // Same rule vocabulary as taskBody (recurrenceSchema above). skipDates is intentionally NOT here
  // — it's owned by the skip route, so a whole-form PATCH can never clobber it. buildEventData does
  // the base-date-match + rule/endDate-exclusivity + until validation.
  recurrenceRule: recurrenceSchema.nullable().optional(),
  recurrenceUntil: dateSchema.nullable().optional(),
});
// EventData (recurrenceRule as a rule object | null) → Prisma create/update input: a nullable Json
// column needs Prisma.JsonNull, never a bare null. skipDates is never written here (see above).
function eventWriteData(data: EventData) {
  const { recurrenceRule, ...rest } = data;
  // Cast as InputJsonValue (a named interface lacks the string index signature Prisma's Json input
  // type wants) — same as recurrence.ts does for the task rule.
  return { ...rest, recurrenceRule: recurrenceRule ? (recurrenceRule as unknown as Prisma.InputJsonValue) : Prisma.JsonNull };
}

const peopleSelect = { id: true, name: true, email: true, role: true } as const;
const taskInclude = {
  project: { select: { id: true, name: true, color: true, columns: true, archived: true } },
  assignee: { select: peopleSelect },
  creator: { select: peopleSelect },
  comments: { include: { author: { select: peopleSelect } }, orderBy: { createdAt: 'asc' as const } },
  attachments: { include: { uploadedBy: { select: peopleSelect } }, orderBy: { createdAt: 'asc' as const } },
} as const;
// Lean projection for the calendar grid — no comments/attachments, just what a day cell renders.
const calendarTaskSelect = {
  id: true, title: true, dueDate: true, priority: true, status: true, recurrenceRule: true, customerRef: true,
  project: { select: { id: true, name: true, color: true, archived: true } },
  assignee: { select: peopleSelect },
} as const;
// Raw projection for the calendar's events — title/note ARE selected here (the DB read is
// unfiltered); maskEvent() strips them for non-owners afterward, in application code, never here.
const calendarEventSelect = {
  id: true, agentId: true, title: true, note: true, date: true, endDate: true, startTime: true, endTime: true, visibility: true,
  recurrenceRule: true, recurrenceUntil: true, skipDates: true,
  agent: { select: peopleSelect },
} as const;

function manager(req: FastifyRequest): boolean {
  return isApolloManager(req.agent?.role);
}

async function projectMember(projectId: string, agentId: string): Promise<boolean> {
  return (await prisma.apolloProjectMember.count({ where: { projectId, agentId } })) > 0;
}

async function canReadTask(req: FastifyRequest, taskId: string) {
  const task = await prisma.apolloTask.findUnique({ where: { id: taskId }, select: { id: true, projectId: true, assigneeId: true, creatorId: true } });
  if (!task) return null;
  if (manager(req) || task.assigneeId === req.agent!.id || await projectMember(task.projectId, req.agent!.id)) return task;
  return false;
}

async function canWorkInProject(req: FastifyRequest, projectId: string): Promise<boolean> {
  return manager(req) || projectMember(projectId, req.agent!.id);
}

async function assigneeAllowed(agentId: string | null | undefined): Promise<boolean> {
  if (!agentId) return true;
  return !!(await prisma.agent.findFirst({
    where: { id: agentId, OR: [{ role: { in: ['supervisor', 'gm'] } }, { apps: { has: 'apollo' } }] },
    select: { id: true },
  }));
}

export async function apolloRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth);
  app.addHook('onRequest', requireApp('apollo'));

  app.get('/api/apollo/agents', async () => ({
    agents: (await prisma.agent.findMany({
      where: { OR: [{ role: { in: ['supervisor', 'gm'] } }, { apps: { has: 'apollo' } }] },
      select: peopleSelect,
      orderBy: { name: 'asc' },
    })).map((a) => ({ ...a, gender: GENDER_BY_EMAIL.get(a.email) ?? 'male' })),
  }));

  app.get('/api/apollo/projects', async (req) => ({
    projects: await prisma.apolloProject.findMany({
      where: manager(req) ? {} : { members: { some: { agentId: req.agent!.id } } },
      include: { members: { include: { agent: { select: peopleSelect } } }, _count: { select: { tasks: true } } },
      orderBy: [{ archived: 'asc' }, { updatedAt: 'desc' }],
    }),
  }));

  app.post('/api/apollo/projects', async (req, reply) => {
    if (!manager(req)) return reply.code(403).send({ error: 'forbidden' });
    const parsed = z.object({
      name: z.string().trim().min(1).max(200),
      color: z.string().trim().min(1).max(40).optional(),
      columns: z.array(z.string().trim().min(1).max(80)).min(1).max(20).optional(),
      memberIds: z.array(z.string().cuid()).max(500).optional(),
    }).safeParse(req.body);
    if (!parsed.success || parsed.data.columns && new Set(parsed.data.columns).size !== parsed.data.columns.length) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const { memberIds = [], ...data } = parsed.data;
    const uniqueMemberIds = [...new Set(memberIds)];
    const validMembers = await prisma.agent.count({ where: { id: { in: uniqueMemberIds }, OR: [{ role: { in: ['supervisor', 'gm'] } }, { apps: { has: 'apollo' } }] } });
    if (validMembers !== uniqueMemberIds.length) return reply.code(400).send({ error: 'invalid_member' });
    const project = await prisma.apolloProject.create({
      data: {
        ...data,
        createdById: req.agent!.id,
        members: { create: uniqueMemberIds.map((agentId) => ({ agentId })) },
      },
      include: { members: { include: { agent: { select: peopleSelect } } } },
    });
    return reply.code(201).send(project);
  });

  app.get<{ Params: { id: string } }>('/api/apollo/projects/:id', async (req, reply) => {
    if (!manager(req) && !await projectMember(req.params.id, req.agent!.id)) return reply.code(404).send({ error: 'not_found' });
    const project = await prisma.apolloProject.findUnique({
      where: { id: req.params.id },
      include: {
        members: { include: { agent: { select: peopleSelect } } },
        tasks: { include: { assignee: { select: peopleSelect }, creator: { select: peopleSelect }, _count: { select: { comments: true, attachments: true } } }, orderBy: [{ status: 'asc' }, { sortOrder: 'asc' }] },
      },
    });
    return project ?? reply.code(404).send({ error: 'not_found' });
  });

  app.patch<{ Params: { id: string } }>('/api/apollo/projects/:id', async (req, reply) => {
    if (!manager(req)) return reply.code(403).send({ error: 'forbidden' });
    const parsed = z.object({ name: z.string().trim().min(1).max(200).optional(), color: z.string().trim().min(1).max(40).optional(), archived: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try { return await prisma.apolloProject.update({ where: { id: req.params.id }, data: parsed.data }); }
    catch { return reply.code(404).send({ error: 'not_found' }); }
  });

  app.delete<{ Params: { id: string } }>('/api/apollo/projects/:id', async (req, reply) => {
    if (!manager(req)) return reply.code(403).send({ error: 'forbidden' });
    const files = await prisma.apolloAttachment.findMany({ where: { task: { projectId: req.params.id } }, select: { uploadId: true } });
    try { await prisma.apolloProject.delete({ where: { id: req.params.id } }); }
    catch { return reply.code(404).send({ error: 'not_found' }); }
    await Promise.all(files.map((f) => deleteApolloAttachment(f.uploadId)));
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>('/api/apollo/projects/:id/columns', async (req, reply) => {
    if (!manager(req)) return reply.code(403).send({ error: 'forbidden' });
    const parsed = z.object({ columns: z.array(z.string().trim().min(1).max(80)).min(1).max(20), renames: z.record(z.string()).optional() }).safeParse(req.body);
    if (!parsed.success || new Set(parsed.data.columns).size !== parsed.data.columns.length) return reply.code(400).send({ error: 'invalid_columns' });
    const project = await prisma.apolloProject.findUnique({ where: { id: req.params.id }, select: { columns: true } });
    if (!project) return reply.code(404).send({ error: 'not_found' });
    const renames = parsed.data.renames ?? {};
    await prisma.$transaction(async (tx) => {
      for (const [from, to] of Object.entries(renames)) {
        if (project.columns.includes(from) && parsed.data.columns.includes(to)) {
          await tx.apolloTask.updateMany({ where: { projectId: req.params.id, status: from }, data: { status: to } });
        }
      }
      await tx.apolloTask.updateMany({
        where: { projectId: req.params.id, status: { notIn: parsed.data.columns } },
        data: { status: parsed.data.columns[0] },
      });
      await tx.apolloProject.update({ where: { id: req.params.id }, data: { columns: parsed.data.columns } });
    });
    return { ok: true, columns: parsed.data.columns };
  });

  app.put<{ Params: { id: string } }>('/api/apollo/projects/:id/members', async (req, reply) => {
    if (!manager(req)) return reply.code(403).send({ error: 'forbidden' });
    const parsed = z.object({ memberIds: z.array(z.string().cuid()).max(500) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const ids = [...new Set(parsed.data.memberIds)];
    const valid = await prisma.agent.count({ where: { id: { in: ids }, OR: [{ role: { in: ['supervisor', 'gm'] } }, { apps: { has: 'apollo' } }] } });
    if (valid !== ids.length) return reply.code(400).send({ error: 'invalid_member' });
    await prisma.$transaction(async (tx) => {
      await tx.apolloProjectMember.deleteMany({ where: { projectId: req.params.id } });
      if (ids.length) await tx.apolloProjectMember.createMany({ data: ids.map((agentId) => ({ projectId: req.params.id, agentId })) });
    });
    return { ok: true };
  });

  app.post('/api/apollo/tasks', async (req, reply) => {
    const parsed = taskBody.extend({ projectId: z.string().cuid() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { projectId, dueDate, recurrenceRule, ...data } = parsed.data;
    if (!await canWorkInProject(req, projectId)) return reply.code(403).send({ error: 'forbidden' });
    const project = await prisma.apolloProject.findUnique({ where: { id: projectId }, select: { columns: true, archived: true } });
    const date = parseDate(dueDate);
    if (!project || project.archived || !date) return reply.code(400).send({ error: 'invalid_project_or_date' });
    const status = data.status ?? project.columns[0];
    if (!project.columns.includes(status) || !await assigneeAllowed(data.assigneeId)) return reply.code(400).send({ error: 'invalid_status_or_assignee' });
    const max = await prisma.apolloTask.aggregate({ where: { projectId, status }, _max: { sortOrder: true } });
    const task = await prisma.apolloTask.create({
      data: {
        ...data,
        projectId, dueDate: date, status, creatorId: req.agent!.id,
        recurrenceRule: recurrenceRule ? recurrenceRule : Prisma.JsonNull,
        seriesId: recurrenceRule ? randomUUID() : null,
        sortOrder: (max._max.sortOrder ?? 0) + 1024,
      },
      include: taskInclude,
    });
    if (task.assigneeId) await notifyApolloAssignment(task.id).catch((err) => req.log.error({ err }, '[apollo] assignment LINE failed'));
    return reply.code(201).send(task);
  });

  app.get<{ Params: { id: string } }>('/api/apollo/tasks/:id', async (req, reply) => {
    const allowed = await canReadTask(req, req.params.id);
    if (!allowed) return reply.code(404).send({ error: 'not_found' });
    return prisma.apolloTask.findUnique({ where: { id: req.params.id }, include: taskInclude });
  });

  app.patch<{ Params: { id: string } }>('/api/apollo/tasks/:id', async (req, reply) => {
    const allowed = await canReadTask(req, req.params.id);
    if (!allowed) return reply.code(404).send({ error: 'not_found' });
    const parsed = taskBody.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const before = await prisma.apolloTask.findUnique({ where: { id: req.params.id }, include: { project: { select: { columns: true } } } });
    if (!before) return reply.code(404).send({ error: 'not_found' });
    if (parsed.data.status && !before.project.columns.includes(parsed.data.status)) return reply.code(400).send({ error: 'invalid_status' });
    if (parsed.data.assigneeId !== undefined && !await assigneeAllowed(parsed.data.assigneeId)) return reply.code(400).send({ error: 'invalid_assignee' });
    const dueDate = parsed.data.dueDate ? parseDate(parsed.data.dueDate) : undefined;
    if (parsed.data.dueDate && !dueDate) return reply.code(400).send({ error: 'invalid_date' });
    const rule = parsed.data.recurrenceRule;
    if (rule !== undefined && rule !== null && !parseRecurrenceRule(rule)) return reply.code(400).send({ error: 'invalid_recurrence' });
    const { dueDate: _due, recurrenceRule: _rule, ...rest } = parsed.data;
    const task = await prisma.apolloTask.update({
      where: { id: req.params.id },
      data: {
        ...rest,
        ...(dueDate ? { dueDate } : {}),
        ...(rule === null ? { recurrenceRule: Prisma.JsonNull, seriesId: null } : rule ? { recurrenceRule: rule, seriesId: before.seriesId ?? randomUUID() } : {}),
      },
      include: taskInclude,
    });
    if (task.assigneeId && task.assigneeId !== before.assigneeId) await notifyApolloAssignment(task.id).catch((err) => req.log.error({ err }, '[apollo] assignment LINE failed'));
    return task;
  });

  app.delete<{ Params: { id: string } }>('/api/apollo/tasks/:id', async (req, reply) => {
    const allowed = await canReadTask(req, req.params.id);
    if (!allowed) return reply.code(404).send({ error: 'not_found' });
    // Hard delete purges attachments with no undo — employees may only delete tasks they created.
    if (!manager(req) && allowed.creatorId !== req.agent!.id) return reply.code(403).send({ error: 'forbidden' });
    const files = await prisma.apolloAttachment.findMany({ where: { taskId: req.params.id }, select: { uploadId: true } });
    await prisma.apolloTask.delete({ where: { id: req.params.id } });
    await Promise.all(files.map((f) => deleteApolloAttachment(f.uploadId)));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/apollo/tasks/:id/move', async (req, reply) => {
    const allowed = await canReadTask(req, req.params.id);
    if (!allowed) return reply.code(404).send({ error: 'not_found' });
    const parsed = z.object({ status: z.string().min(1).max(80), orderedTaskIds: z.array(z.string().cuid()).min(1).max(500) }).safeParse(req.body);
    if (!parsed.success || !parsed.data.orderedTaskIds.includes(req.params.id)) return reply.code(400).send({ error: 'invalid_body' });
    const task = await prisma.apolloTask.findUnique({ where: { id: req.params.id }, include: { project: { select: { columns: true } } } });
    if (!task || !task.project.columns.includes(parsed.data.status)) return reply.code(400).send({ error: 'invalid_status' });
    const mayReorderAll = await canWorkInProject(req, task.projectId);
    if (!mayReorderAll) {
      const max = await prisma.apolloTask.aggregate({ where: { projectId: task.projectId, status: parsed.data.status }, _max: { sortOrder: true } });
      return prisma.apolloTask.update({ where: { id: task.id }, data: { status: parsed.data.status, sortOrder: (max._max.sortOrder ?? 0) + 1024 } });
    }
    const rows = await prisma.apolloTask.findMany({ where: { id: { in: parsed.data.orderedTaskIds }, projectId: task.projectId }, select: { id: true } });
    if (rows.length !== new Set(parsed.data.orderedTaskIds).size) return reply.code(400).send({ error: 'invalid_tasks' });
    await prisma.$transaction(parsed.data.orderedTaskIds.map((id, index) => prisma.apolloTask.update({ where: { id }, data: { status: parsed.data.status, sortOrder: (index + 1) * 1024 } })));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/apollo/tasks/:id/complete', async (req, reply) => {
    const allowed = await canReadTask(req, req.params.id);
    if (!allowed) return reply.code(404).send({ error: 'not_found' });
    const result = await completeApolloTask(req.params.id);
    if (!result) return reply.code(404).send({ error: 'not_found' });
    if (result.nextTask?.assigneeId) await notifyApolloAssignment(result.nextTask.id).catch((err) => req.log.error({ err }, '[apollo] recurrence LINE failed'));
    return result;
  });

  app.post<{ Params: { id: string } }>('/api/apollo/tasks/:id/comments', async (req, reply) => {
    const allowed = await canReadTask(req, req.params.id);
    if (!allowed) return reply.code(404).send({ error: 'not_found' });
    const parsed = z.object({ body: z.string().trim().min(1).max(10_000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    return reply.code(201).send(await prisma.apolloComment.create({ data: { taskId: req.params.id, authorId: req.agent!.id, body: parsed.data.body }, include: { author: { select: peopleSelect } } }));
  });

  app.delete<{ Params: { id: string } }>('/api/apollo/comments/:id', async (req, reply) => {
    const comment = await prisma.apolloComment.findUnique({ where: { id: req.params.id }, select: { authorId: true, taskId: true } });
    if (!comment || !await canReadTask(req, comment.taskId)) return reply.code(404).send({ error: 'not_found' });
    if (!manager(req) && comment.authorId !== req.agent!.id) return reply.code(403).send({ error: 'forbidden' });
    await prisma.apolloComment.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/apollo/tasks/:id/attachments', { bodyLimit: 35 * 1024 * 1024 }, async (req, reply) => {
    const allowed = await canReadTask(req, req.params.id);
    if (!allowed) return reply.code(404).send({ error: 'not_found' });
    const parsed = z.object({ dataB64: z.string().min(1), fileName: z.string().trim().min(1).max(255), contentType: z.string().trim().min(1).max(120) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const stored = await saveApolloAttachment(parsed.data.dataB64, parsed.data.contentType);
    if (!stored) return reply.code(413).send({ error: 'too_large_or_empty' });
    try {
      return reply.code(201).send(await prisma.apolloAttachment.create({
        data: { taskId: req.params.id, uploadedById: req.agent!.id, fileName: parsed.data.fileName, contentType: parsed.data.contentType, ...stored },
        include: { uploadedBy: { select: peopleSelect } },
      }));
    } catch (err) {
      await deleteApolloAttachment(stored.uploadId);
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/api/apollo/attachments/:id/content', async (req, reply) => {
    const attachment = await prisma.apolloAttachment.findUnique({ where: { id: req.params.id } });
    if (!attachment || !await canReadTask(req, attachment.taskId)) return reply.code(404).send({ error: 'not_found' });
    const buffer = await readApolloAttachment(attachment.uploadId);
    if (!buffer) return reply.code(404).send({ error: 'content_unavailable' });
    reply.header('content-type', attachment.contentType).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=3600');
    if (attachment.kind !== 'image') reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
    return reply.send(buffer);
  });

  app.delete<{ Params: { id: string } }>('/api/apollo/attachments/:id', async (req, reply) => {
    const attachment = await prisma.apolloAttachment.findUnique({ where: { id: req.params.id } });
    if (!attachment || !await canReadTask(req, attachment.taskId)) return reply.code(404).send({ error: 'not_found' });
    if (!manager(req) && attachment.uploadedById !== req.agent!.id) return reply.code(403).send({ error: 'forbidden' });
    await prisma.apolloAttachment.delete({ where: { id: attachment.id } });
    await deleteApolloAttachment(attachment.uploadId);
    return { ok: true };
  });

  // ── ApolloEvent: personal events (นัดหมอ, ธุระส่วนตัว) ──────────────────
  // Owner-only CRUD, no manager bypass anywhere here — the manager exception that governs
  // task delete/comment-delete/attachment-delete deliberately does NOT apply to events; see the
  // spec's hard rule. All three use the same 404-for-both-missing-and-forbidden shape as the
  // rest of this file (canReadTask etc.) so a probe can't tell "not yours" from "doesn't exist".
  // The CEO's view-only exception (see maskEvent) lives entirely in GET /calendar below — there
  // is no read exception here, so CRUD stays owner-only regardless of visibility or role.
  app.post('/api/apollo/events', async (req, reply) => {
    const parsed = eventBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const data = buildEventData(parsed.data);
    if (!data) return reply.code(400).send({ error: 'invalid_body' });
    // agentId always the caller — never accepted from the body.
    return reply.code(201).send(await prisma.apolloEvent.create({ data: { ...eventWriteData(data), agentId: req.agent!.id } }));
  });

  app.patch<{ Params: { id: string } }>('/api/apollo/events/:id', async (req, reply) => {
    const existing = await prisma.apolloEvent.findUnique({ where: { id: req.params.id }, select: { agentId: true } });
    if (!existing || existing.agentId !== req.agent!.id) return reply.code(404).send({ error: 'not_found' });
    const parsed = eventBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const data = buildEventData(parsed.data);
    if (!data) return reply.code(400).send({ error: 'invalid_body' });
    // Whole-series edit. eventWriteData omits skipDates, so individually-skipped occurrences survive
    // a series edit; stale skip entries (if the base date moved) are ignored harmlessly by occursOn.
    return prisma.apolloEvent.update({ where: { id: req.params.id }, data: eventWriteData(data) });
  });

  app.delete<{ Params: { id: string } }>('/api/apollo/events/:id', async (req, reply) => {
    const existing = await prisma.apolloEvent.findUnique({ where: { id: req.params.id }, select: { agentId: true } });
    if (!existing || existing.agentId !== req.agent!.id) return reply.code(404).send({ error: 'not_found' });
    await prisma.apolloEvent.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // "ลบเฉพาะวันนี้" — delete a single occurrence of a recurring event by adding its date to
  // skipDates. Owner-only, same 404-for-missing-or-not-yours shape as the other event routes (no
  // manager/CEO bypass — CRUD stays owner-only). 400 unless the date is a real occurrence.
  app.post<{ Params: { id: string } }>('/api/apollo/events/:id/skip', async (req, reply) => {
    const existing = await prisma.apolloEvent.findUnique({
      where: { id: req.params.id },
      select: { agentId: true, date: true, recurrenceRule: true, recurrenceUntil: true, skipDates: true },
    });
    if (!existing || existing.agentId !== req.agent!.id) return reply.code(404).send({ error: 'not_found' });
    const parsed = z.object({ date: dateSchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    // Occurrence check against the series with skipDates blanked — occursOn is skip-aware, so
    // checking the raw row would 400 a re-skip of an already-skipped date; blanking makes the
    // route idempotent (double-click/retry safe), which is what the dedupe append is for.
    if (!occursOn({ ...existing, skipDates: [] }, parsed.data.date)) return reply.code(400).send({ error: 'not_an_occurrence' });
    const skipDates = existing.skipDates.includes(parsed.data.date) ? existing.skipDates : [...existing.skipDates, parsed.data.date];
    return prisma.apolloEvent.update({ where: { id: req.params.id }, data: { skipDates } });
  });

  app.get('/api/apollo/my-tasks', async (req) => {
    const today = thaiDateKey();
    const tasks = await prisma.apolloTask.findMany({
      where: { assigneeId: req.agent!.id, completedAt: null },
      include: { project: { select: { id: true, name: true, color: true } }, assignee: { select: peopleSelect } },
      orderBy: [{ dueDate: 'asc' }, { priority: 'asc' }],
    });
    return {
      overdue: tasks.filter((t) => t.dueDate.toISOString().slice(0, 10) < today),
      today: tasks.filter((t) => t.dueDate.toISOString().slice(0, 10) === today),
      upcoming: tasks.filter((t) => t.dueDate.toISOString().slice(0, 10) > today),
    };
  });

  const calendarQuerySchema = z.object({ from: dateSchema, to: dateSchema, assignee: z.string().trim().min(1).max(80).optional() });
  app.get('/api/apollo/calendar', async (req, reply) => {
    const parsed = calendarQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const range = parseCalendarRange(parsed.data.from, parsed.data.to);
    if (!range) return reply.code(400).send({ error: `invalid_range_or_exceeds_${CALENDAR_MAX_RANGE_DAYS}_days` });
    const viewerId = req.agent!.id;
    // CEO-only view exception for private events (see maskEvent) — role 'supervisor' EXACTLY,
    // deliberately NOT the manager() helper above (which also covers 'gm'): GM users must never
    // see private event details, only the free/busy block everyone else gets.
    const isCeo = req.agent!.role === 'supervisor';
    // Peers may now scope to a colleague/'all'/'none' to check availability — but (unlike a
    // manager) that widened scope is ALSO member-project-restricted for tasks, so no new task
    // info leaks beyond what the board already shows them. Self scope is unchanged from before.
    const scope = resolveCalendarScope(manager(req), viewerId, parsed.data.assignee);
    const tasks = await prisma.apolloTask.findMany({
      where: {
        completedAt: null,
        dueDate: { gte: range.from, lte: range.to },
        project: scope.memberProjectOnly ? { archived: false, members: { some: { agentId: viewerId } } } : { archived: false },
        ...(scope.assigneeId === undefined ? {} : { assigneeId: scope.assigneeId }),
      },
      select: calendarTaskSelect,
      orderBy: { dueDate: 'asc' },
      take: 500,
    });
    // Events are always owned, so a 'none' (unassigned) scope can never match one — skip the
    // query rather than ask Prisma to filter a required column against null. No member-project
    // restriction here (see resolveCalendarScope's doc) — free/busy is team-wide by design, and
    // masking (not scoping) is what keeps title/note private.
    // Candidate fetch: rows overlapping the range (non-recurring + a recurring event's base day)
    // OR recurring series still active in the range. Expansion (below) turns each recurring row
    // into one masked row per occurrence; the take-500 cap is re-applied AFTER expansion since a
    // daily rule can fan a single row out to ~62 (range is capped at 62 days).
    const rawEvents = scope.assigneeId === null ? [] : await prisma.apolloEvent.findMany({
      where: {
        ...(scope.assigneeId === undefined ? {} : { agentId: scope.assigneeId }),
        OR: [eventDateRangeWhere(range.from, range.to), recurringEventRangeWhere(range.from, range.to)],
      },
      select: calendarEventSelect,
      orderBy: { date: 'asc' },
      take: 500,
    });
    const events = expandCalendarEvents(rawEvents, viewerId, isCeo, range.from, range.to).slice(0, 500);
    return { tasks, events };
  });

  app.get('/api/apollo/dashboard', async (req, reply) => {
    if (!manager(req)) return reply.code(403).send({ error: 'forbidden' });
    const today = new Date(`${thaiDateKey()}T00:00:00.000Z`);
    const [agents, openRows, overdueRows, statusRows] = await Promise.all([
      prisma.agent.findMany({ where: { OR: [{ role: { in: ['supervisor', 'gm'] } }, { apps: { has: 'apollo' } }] }, select: peopleSelect, orderBy: { name: 'asc' } }),
      prisma.apolloTask.groupBy({ by: ['assigneeId'], where: { completedAt: null, assigneeId: { not: null } }, _count: true }),
      prisma.apolloTask.groupBy({ by: ['assigneeId'], where: { completedAt: null, assigneeId: { not: null }, dueDate: { lt: today } }, _count: true }),
      prisma.apolloTask.groupBy({ by: ['projectId', 'status'], where: { completedAt: null }, _count: true }),
    ]);
    const open = new Map(openRows.map((r) => [r.assigneeId, r._count]));
    const overdue = new Map(overdueRows.map((r) => [r.assigneeId, r._count]));
    const projects = await prisma.apolloProject.findMany({ select: { id: true, name: true, color: true, columns: true }, orderBy: { name: 'asc' } });
    return {
      people: agents.map((a) => ({ ...a, open: open.get(a.id) ?? 0, overdue: overdue.get(a.id) ?? 0 })),
      projects: projects.map((p) => ({ ...p, statuses: Object.fromEntries(p.columns.map((status) => [status, statusRows.find((r) => r.projectId === p.id && r.status === status)?._count ?? 0])) })),
    };
  });

  app.get('/api/apollo/line-bind', async (req) => {
    const agent = await prisma.agent.findUnique({ where: { id: req.agent!.id }, select: { lineUserId: true, lineBindCode: true } });
    return { bound: !!agent?.lineUserId, code: agent?.lineBindCode ?? null };
  });

  // 32-char unambiguous alphabet (no I/O/0/1): 256 % 32 === 0, so bytes map uniformly —
  // every position carries full randomness (base64url stripping left deterministic filler).
  const BIND_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  app.post('/api/apollo/line-bind', async (req) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = Array.from(randomBytes(8), (b) => BIND_ALPHABET[b % BIND_ALPHABET.length]).join('');
      try {
        await prisma.agent.update({ where: { id: req.agent!.id }, data: { lineBindCode: code } });
        return { bound: false, code };
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      }
    }
    throw new Error('unable_to_generate_line_bind_code');
  });
}
