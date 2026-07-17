import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { prisma } from '../db/prisma.js';
import { bangkokDate, bangkokDateKey, dateKey, dateRange, parseDateOnly } from '../hestia/dates.js';
import { calculateStreak } from '../hestia/streaks.js';

const dateString = z.string().refine((value) => parseDateOnly(value) !== null);
const idString = z.string().trim().min(1).max(100);
const year = z.coerce.number().int().min(2000).max(2100);
const code = z.string().trim().min(1).max(40);
const title = z.string().trim().min(1).max(200);
const description = z.string().trim().max(5_000);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const sortOrder = z.number().int().min(-1_000_000).max(1_000_000);
const status = z.enum(['active', 'completed', 'archived']);
const cadence = z.enum(['daily', 'weekdays', 'custom']);
const scheduleDays = z.array(z.number().int().min(0).max(6)).max(7).refine((days) => new Set(days).size === days.length);

const goalCreate = z.object({
  code, title, year, description: description.optional(), color: color.optional(), sortOrder: sortOrder.optional(),
}).strict();
const goalPatch = z.object({
  code: code.optional(), title: title.optional(), year: year.optional(), description: description.optional(),
  color: color.optional(), sortOrder: sortOrder.optional(), status: status.optional(),
}).strict().refine((body) => Object.keys(body).length > 0);

const habitFields = z.object({
  code,
  title,
  goalId: idString,
  cadence,
  scheduleDays: scheduleDays.optional(),
  targetCount: z.number().int().min(1).max(100_000),
  startDate: dateString,
  endDate: dateString.nullable().optional(),
  description: description.optional(),
  sortOrder: sortOrder.optional(),
}).strict();
const validHabitDates = (body: { startDate?: string; endDate?: string | null }) =>
  !body.startDate || !body.endDate || body.endDate >= body.startDate;
const habitCreate = habitFields.refine(validHabitDates);
const habitPatch = habitFields.partial().extend({ active: z.boolean().optional() }).strict()
  .refine((body) => Object.keys(body).length > 0);

const checkInBody = z.object({
  count: z.number().int().min(0).max(100_000), note: z.string().trim().max(5_000).optional(),
}).strict();
const journalCreate = z.object({
  entryDate: dateString,
  title: z.string().trim().max(200).optional(),
  bodyMarkdown: z.string().min(1).max(100_000),
  mood: z.number().int().min(1).max(5).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
}).strict();
const journalPatch = journalCreate.partial().strict().refine((body) => Object.keys(body).length > 0);

function duplicateCode(error: unknown): boolean {
  return (error instanceof Prisma.PrismaClientKnownRequestError || typeof error === 'object')
    && error !== null && 'code' in error && error.code === 'P2002';
}

async function recomputeStreak(tx: Prisma.TransactionClient, ownerId: string, habitId: string, calculatedOn = bangkokDate()) {
  const habit = await tx.hestiaHabit.findFirst({ where: { id: habitId, ownerId } });
  if (!habit) return null;
  const checkIns = await tx.hestiaCheckIn.findMany({
    where: { ownerId, habitId, checkDate: { lte: calculatedOn } },
    select: { checkDate: true, count: true },
  });
  const result = calculateStreak({
    cadence: habit.cadence as 'daily' | 'weekdays' | 'custom', scheduleDays: habit.scheduleDays,
    targetCount: habit.targetCount, startDate: habit.startDate, endDate: habit.endDate,
  }, checkIns, calculatedOn);
  return tx.hestiaHabitStreak.upsert({
    where: { habitId },
    create: { habitId, ownerId, ...result },
    update: result,
  });
}

async function refreshStaleStreaks(ownerId: string, habits: Array<{ id: string; streak: { calculatedOn: Date } | null }>): Promise<boolean> {
  const calculatedOn = bangkokDate();
  const stale = habits.filter((habit) => !habit.streak || dateKey(habit.streak.calculatedOn) !== dateKey(calculatedOn));
  if (!stale.length) return false;
  await prisma.$transaction(async (tx) => {
    for (const habit of stale) await recomputeStreak(tx, ownerId, habit.id, calculatedOn);
  });
  return true;
}

export async function hestiaRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAuth);
  app.addHook('onRequest', requireRole('supervisor'));

  app.get('/api/hestia/overview', async (req, reply) => {
    const parsed = z.object({ date: dateString.optional(), year: year.optional() }).strict().safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const dateValue = parsed.data.date ?? bangkokDateKey();
    const date = parseDateOnly(dateValue)!;
    const selectedYear = parsed.data.year ?? Number(dateValue.slice(0, 4));
    const ownerId = req.agent!.id;
    let [goals, checkIns, recentJournal] = await Promise.all([
      prisma.hestiaGoal.findMany({
        where: { ownerId, year: selectedYear, status: 'active' },
        include: { habits: { where: { ownerId, active: true }, include: { streak: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.hestiaCheckIn.findMany({ where: { ownerId, checkDate: date }, orderBy: { completedAt: 'asc' } }),
      prisma.hestiaJournalEntry.findMany({ where: { ownerId, entryDate: { lte: date } }, orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }], take: 3 }),
    ]);
    if (await refreshStaleStreaks(ownerId, goals.flatMap((goal) => goal.habits))) {
      goals = await prisma.hestiaGoal.findMany({
        where: { ownerId, year: selectedYear, status: 'active' },
        include: { habits: { where: { ownerId, active: true }, include: { streak: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
    }
    const byHabit = new Map(checkIns.map((row) => [row.habitId, row]));
    const scheduled = goals.flatMap((goal) => goal.habits).filter((habit) => {
      const endDate = habit.endDate;
      if (date < habit.startDate || (endDate && date > endDate)) return false;
      const day = date.getUTCDay();
      return habit.cadence === 'daily' || (habit.cadence === 'weekdays' && day >= 1 && day <= 5)
        || (habit.cadence === 'custom' && habit.scheduleDays.includes(day));
    });
    const completed = scheduled.filter((habit) => (byHabit.get(habit.id)?.count ?? 0) >= habit.targetCount).length;
    return { date: dateValue, year: selectedYear, goals, checkIns, totals: { completed, total: scheduled.length }, recentJournal };
  });

  app.get('/api/hestia/goals', async (req, reply) => {
    const parsed = z.object({ year, includeArchived: z.enum(['0', '1']).optional() }).strict().safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const query = {
      where: { ownerId: req.agent!.id, year: parsed.data.year, ...(parsed.data.includeArchived === '1' ? {} : { status: { not: 'archived' } }) },
      include: { habits: { where: { ownerId: req.agent!.id }, include: { streak: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    } satisfies Prisma.HestiaGoalFindManyArgs;
    let goals = await prisma.hestiaGoal.findMany(query);
    if (await refreshStaleStreaks(req.agent!.id, goals.flatMap((goal) => goal.habits))) goals = await prisma.hestiaGoal.findMany(query);
    return goals;
  });

  app.post('/api/hestia/goals', async (req, reply) => {
    const parsed = goalCreate.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try {
      return reply.code(201).send(await prisma.hestiaGoal.create({ data: { ...parsed.data, ownerId: req.agent!.id } }));
    } catch (error) {
      if (duplicateCode(error)) return reply.code(409).send({ error: 'code_taken' });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/api/hestia/goals/:id', async (req, reply) => {
    const parsed = goalPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const ownerId = req.agent!.id;
    if (!await prisma.hestiaGoal.findFirst({ where: { id: req.params.id, ownerId }, select: { id: true } })) {
      return reply.code(404).send({ error: 'not_found' });
    }
    try {
      return await prisma.hestiaGoal.update({ where: { id: req.params.id, ownerId }, data: parsed.data });
    } catch (error) {
      if (duplicateCode(error)) return reply.code(409).send({ error: 'code_taken' });
      throw error;
    }
  });

  app.get('/api/hestia/habits', async (req, reply) => {
    const parsed = z.object({ goalId: idString.optional(), active: z.enum(['0', '1']).optional() }).strict().safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const ownerId = req.agent!.id;
    if (parsed.data.goalId && !await prisma.hestiaGoal.findFirst({ where: { id: parsed.data.goalId, ownerId }, select: { id: true } })) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const query = {
      where: { ownerId, ...(parsed.data.goalId ? { goalId: parsed.data.goalId } : {}), ...(parsed.data.active ? { active: parsed.data.active === '1' } : {}) },
      include: { goal: true, streak: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    } satisfies Prisma.HestiaHabitFindManyArgs;
    let habits = await prisma.hestiaHabit.findMany(query);
    if (await refreshStaleStreaks(ownerId, habits)) habits = await prisma.hestiaHabit.findMany(query);
    return habits;
  });

  app.post('/api/hestia/habits', async (req, reply) => {
    const parsed = habitCreate.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const ownerId = req.agent!.id;
    if (!await prisma.hestiaGoal.findFirst({ where: { id: parsed.data.goalId, ownerId }, select: { id: true } })) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const { startDate, endDate, ...data } = parsed.data;
    try {
      const habit = await prisma.$transaction(async (tx) => {
        const created = await tx.hestiaHabit.create({
          data: { ...data, ownerId, startDate: parseDateOnly(startDate)!, endDate: endDate ? parseDateOnly(endDate) : null },
        });
        await recomputeStreak(tx, ownerId, created.id);
        return tx.hestiaHabit.findFirst({ where: { id: created.id, ownerId }, include: { streak: true } });
      });
      return reply.code(201).send(habit);
    } catch (error) {
      if (duplicateCode(error)) return reply.code(409).send({ error: 'code_taken' });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/api/hestia/habits/:id', async (req, reply) => {
    const parsed = habitPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const ownerId = req.agent!.id;
    const existing = await prisma.hestiaHabit.findFirst({ where: { id: req.params.id, ownerId } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const goalId = parsed.data.goalId ?? existing.goalId;
    if (parsed.data.goalId && !await prisma.hestiaGoal.findFirst({ where: { id: goalId, ownerId }, select: { id: true } })) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const nextStart = parsed.data.startDate ? parseDateOnly(parsed.data.startDate)! : existing.startDate;
    const nextEnd = parsed.data.endDate === undefined ? existing.endDate : parsed.data.endDate ? parseDateOnly(parsed.data.endDate) : null;
    if (nextEnd && nextEnd < nextStart) return reply.code(400).send({ error: 'invalid_body' });
    const { startDate: _start, endDate: _end, ...data } = parsed.data;
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.hestiaHabit.update({ where: { id: req.params.id, ownerId }, data: { ...data, startDate: nextStart, endDate: nextEnd } });
        await recomputeStreak(tx, ownerId, req.params.id);
        return tx.hestiaHabit.findFirst({ where: { id: req.params.id, ownerId }, include: { streak: true } });
      });
    } catch (error) {
      if (duplicateCode(error)) return reply.code(409).send({ error: 'code_taken' });
      throw error;
    }
  });

  app.get('/api/hestia/check-ins', async (req, reply) => {
    const parsed = z.object({ from: dateString, to: dateString, habitId: idString.optional() }).strict().safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const range = dateRange(parsed.data.from, parsed.data.to);
    if (!range) return reply.code(400).send({ error: 'invalid_query' });
    const ownerId = req.agent!.id;
    if (parsed.data.habitId && !await prisma.hestiaHabit.findFirst({ where: { id: parsed.data.habitId, ownerId }, select: { id: true } })) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return prisma.hestiaCheckIn.findMany({
      where: { ownerId, checkDate: { gte: range.from, lte: range.to }, ...(parsed.data.habitId ? { habitId: parsed.data.habitId } : {}) },
      orderBy: [{ checkDate: 'asc' }, { habitId: 'asc' }],
    });
  });

  app.put<{ Params: { id: string; date: string } }>('/api/hestia/habits/:id/check-ins/:date', async (req, reply) => {
    const parsed = checkInBody.safeParse(req.body);
    const checkDate = parseDateOnly(req.params.date);
    if (!parsed.success || !checkDate) return reply.code(400).send({ error: 'invalid_body' });
    const ownerId = req.agent!.id;
    if (!await prisma.hestiaHabit.findFirst({ where: { id: req.params.id, ownerId }, select: { id: true } })) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return prisma.$transaction(async (tx) => {
      const checkIn = await tx.hestiaCheckIn.upsert({
        where: { habitId_checkDate: { habitId: req.params.id, checkDate } },
        create: { ownerId, habitId: req.params.id, checkDate, count: parsed.data.count, note: parsed.data.note ?? '' },
        update: { count: parsed.data.count, ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }), completedAt: new Date() },
      });
      const streak = await recomputeStreak(tx, ownerId, req.params.id);
      return { checkIn, streak };
    });
  });

  app.delete<{ Params: { id: string; date: string } }>('/api/hestia/habits/:id/check-ins/:date', async (req, reply) => {
    const checkDate = parseDateOnly(req.params.date);
    if (!checkDate) return reply.code(400).send({ error: 'invalid_query' });
    const ownerId = req.agent!.id;
    if (!await prisma.hestiaHabit.findFirst({ where: { id: req.params.id, ownerId }, select: { id: true } })) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return prisma.$transaction(async (tx) => {
      await tx.hestiaCheckIn.deleteMany({ where: { ownerId, habitId: req.params.id, checkDate } });
      const streak = await recomputeStreak(tx, ownerId, req.params.id);
      return { ok: true, streak };
    });
  });

  app.get('/api/hestia/journal', async (req, reply) => {
    const parsed = z.object({
      from: dateString.optional(), to: dateString.optional(), cursor: idString.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).strict().refine((query) => Boolean(query.from) === Boolean(query.to)).safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const range = parsed.data.from ? dateRange(parsed.data.from, parsed.data.to!) : null;
    if (parsed.data.from && !range) return reply.code(400).send({ error: 'invalid_query' });
    const ownerId = req.agent!.id;
    if (parsed.data.cursor && !await prisma.hestiaJournalEntry.findFirst({ where: { id: parsed.data.cursor, ownerId }, select: { id: true } })) {
      return reply.code(400).send({ error: 'invalid_query' });
    }
    const entries = await prisma.hestiaJournalEntry.findMany({
      where: { ownerId, ...(range ? { entryDate: { gte: range.from, lte: range.to } } : {}) },
      orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: parsed.data.limit,
      ...(parsed.data.cursor ? { cursor: { id: parsed.data.cursor }, skip: 1 } : {}),
    });
    return { entries, nextCursor: entries.length === parsed.data.limit ? entries.at(-1)!.id : null };
  });

  app.get<{ Params: { id: string } }>('/api/hestia/journal/:id', async (req, reply) => {
    const entry = await prisma.hestiaJournalEntry.findFirst({ where: { id: req.params.id, ownerId: req.agent!.id } });
    if (!entry) return reply.code(404).send({ error: 'not_found' });
    return entry;
  });

  app.post('/api/hestia/journal', async (req, reply) => {
    const parsed = journalCreate.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { entryDate, ...data } = parsed.data;
    return reply.code(201).send(await prisma.hestiaJournalEntry.create({
      data: { ...data, entryDate: parseDateOnly(entryDate)!, source: 'manual', ownerId: req.agent!.id },
    }));
  });

  app.patch<{ Params: { id: string } }>('/api/hestia/journal/:id', async (req, reply) => {
    const parsed = journalPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const ownerId = req.agent!.id;
    const existing = await prisma.hestiaJournalEntry.findFirst({ where: { id: req.params.id, ownerId, source: 'manual' }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const { entryDate, ...data } = parsed.data;
    return prisma.hestiaJournalEntry.update({
      where: { id: req.params.id, ownerId }, data: { ...data, ...(entryDate ? { entryDate: parseDateOnly(entryDate)! } : {}) },
    });
  });

  app.delete<{ Params: { id: string } }>('/api/hestia/journal/:id', async (req, reply) => {
    const ownerId = req.agent!.id;
    const existing = await prisma.hestiaJournalEntry.findFirst({ where: { id: req.params.id, ownerId, source: 'manual' }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    await prisma.hestiaJournalEntry.delete({ where: { id: req.params.id, ownerId } });
    return { ok: true };
  });
}
