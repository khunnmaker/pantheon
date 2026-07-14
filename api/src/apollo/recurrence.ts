import { randomUUID } from 'node:crypto';
import { Prisma, type ApolloTask } from '@prisma/client';
import { prisma } from '../db/prisma.js';

export interface ApolloRecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly';
  weekday?: number;
  dayOfMonth?: number;
}

export function parseRecurrenceRule(value: unknown): ApolloRecurrenceRule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.freq === 'daily') return { freq: 'daily' };
  if (v.freq === 'weekly' && Number.isInteger(v.weekday) && Number(v.weekday) >= 0 && Number(v.weekday) <= 6) {
    return { freq: 'weekly', weekday: Number(v.weekday) };
  }
  if (v.freq === 'monthly' && Number.isInteger(v.dayOfMonth) && Number(v.dayOfMonth) >= 1 && Number(v.dayOfMonth) <= 31) {
    return { freq: 'monthly', dayOfMonth: Number(v.dayOfMonth) };
  }
  return null;
}

export function nextOccurrenceDate(from: Date, rule: ApolloRecurrenceRule): Date {
  const base = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  if (rule.freq === 'daily') {
    base.setUTCDate(base.getUTCDate() + 1);
    return base;
  }
  if (rule.freq === 'weekly') {
    const target = rule.weekday ?? base.getUTCDay();
    let delta = (target - base.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    base.setUTCDate(base.getUTCDate() + delta);
    return base;
  }
  const targetDay = rule.dayOfMonth ?? base.getUTCDate();
  const year = base.getUTCMonth() === 11 ? base.getUTCFullYear() + 1 : base.getUTCFullYear();
  const month = (base.getUTCMonth() + 1) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(targetDay, lastDay)));
}

type RecurringTask = Pick<ApolloTask, 'id' | 'projectId' | 'title' | 'notes' | 'assigneeId' | 'creatorId' | 'dueDate' | 'priority' | 'customerRef' | 'recurrenceRule' | 'seriesId'>;

async function spawnNext(tx: Prisma.TransactionClient, task: RecurringTask): Promise<ApolloTask | null> {
  const rule = parseRecurrenceRule(task.recurrenceRule);
  const seriesId = task.seriesId;
  if (!rule || !seriesId) return null;
  const open = await tx.apolloTask.findFirst({ where: { seriesId, completedAt: null } });
  if (open) return null;
  const project = await tx.apolloProject.findUnique({ where: { id: task.projectId }, select: { columns: true } });
  if (!project?.columns.length) return null;
  const status = project.columns[0];
  const max = await tx.apolloTask.aggregate({ where: { projectId: task.projectId, status, completedAt: null }, _max: { sortOrder: true } });
  return tx.apolloTask.create({
    data: {
      projectId: task.projectId,
      title: task.title,
      notes: task.notes,
      assigneeId: task.assigneeId,
      creatorId: task.creatorId,
      dueDate: nextOccurrenceDate(task.dueDate, rule),
      priority: task.priority,
      status,
      customerRef: task.customerRef,
      recurrenceRule: task.recurrenceRule as Prisma.InputJsonValue,
      seriesId,
      sortOrder: (max._max.sortOrder ?? 0) + 1024,
    },
  });
}

export async function completeApolloTask(taskId: string) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.apolloTask.findUnique({ where: { id: taskId }, include: { project: { select: { columns: true } } } });
    if (!before) return null;
    if (before.completedAt) return { task: before, nextTask: null };
    const seriesId = before.recurrenceRule && !before.seriesId ? randomUUID() : before.seriesId;
    const won = await tx.apolloTask.updateMany({
      where: { id: taskId, completedAt: null },
      data: {
        completedAt: new Date(),
        status: before.project.columns.at(-1) ?? before.status,
        ...(seriesId ? { seriesId } : {}),
      },
    });
    const task = await tx.apolloTask.findUnique({ where: { id: taskId } });
    if (!task) return null;
    if (won.count === 0) return { task, nextTask: null };
    const nextTask = await spawnNext(tx, task);
    return { task, nextTask };
  });
}

export async function sweepApolloRecurrences(): Promise<number> {
  const completed = await prisma.apolloTask.findMany({
    where: { completedAt: { not: null }, seriesId: { not: null } },
    orderBy: [{ completedAt: 'desc' }, { dueDate: 'desc' }],
  });
  const latest = new Map<string, ApolloTask>();
  for (const task of completed) if (task.seriesId && task.recurrenceRule && !latest.has(task.seriesId)) latest.set(task.seriesId, task);
  let spawned = 0;
  for (const task of latest.values()) {
    try {
      const next = await prisma.$transaction((tx) => spawnNext(tx, task));
      if (next) spawned += 1;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
    }
  }
  return spawned;
}
