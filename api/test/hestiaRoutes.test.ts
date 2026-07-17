import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentFindUnique: vi.fn(), goalFindMany: vi.fn(), goalFindFirst: vi.fn(), goalCreate: vi.fn(), goalUpdate: vi.fn(),
  habitFindMany: vi.fn(), habitFindFirst: vi.fn(), habitCreate: vi.fn(), habitUpdate: vi.fn(),
  checkInFindMany: vi.fn(), checkInUpsert: vi.fn(), checkInDeleteMany: vi.fn(), streakUpsert: vi.fn(),
  journalFindMany: vi.fn(), journalFindFirst: vi.fn(), journalCreate: vi.fn(), journalUpdate: vi.fn(), journalDelete: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: { JWT_SECRET: 'unit-test-jwt-secret' } }));
vi.mock('../src/db/prisma.js', () => {
  const prisma = {
    agent: { findUnique: mocks.agentFindUnique },
    hestiaGoal: { findMany: mocks.goalFindMany, findFirst: mocks.goalFindFirst, create: mocks.goalCreate, update: mocks.goalUpdate },
    hestiaHabit: { findMany: mocks.habitFindMany, findFirst: mocks.habitFindFirst, create: mocks.habitCreate, update: mocks.habitUpdate },
    hestiaCheckIn: { findMany: mocks.checkInFindMany, upsert: mocks.checkInUpsert, deleteMany: mocks.checkInDeleteMany },
    hestiaHabitStreak: { upsert: mocks.streakUpsert },
    hestiaJournalEntry: { findMany: mocks.journalFindMany, findFirst: mocks.journalFindFirst, create: mocks.journalCreate, update: mocks.journalUpdate, delete: mocks.journalDelete },
    $transaction: mocks.transaction,
  };
  mocks.transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return { prisma };
});

import { signToken } from '../src/auth/jwt.js';
import { hestiaRoutes } from '../src/routes/hestia.js';

const owner = { id: 'owner-1', email: 'owner@example.test', name: 'Owner', role: 'supervisor' as const, apps: [], authVersion: 0 };
const token = signToken(owner);
const headers = { authorization: `Bearer ${token}` };
const baseHabit = {
  id: 'habit-1', ownerId: owner.id, goalId: 'goal-1', code: 'H01', title: 'Walk', description: '',
  cadence: 'daily', scheduleDays: [0, 1, 2, 3, 4, 5, 6], targetCount: 1,
  startDate: new Date('2026-07-01T00:00:00.000Z'), endDate: null, active: true, sortOrder: 0,
  createdAt: new Date(), updatedAt: new Date(),
};

async function inject(options: { method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; payload?: unknown }) {
  const app = Fastify();
  await app.register(hestiaRoutes);
  const response = await app.inject({ ...options, headers });
  await app.close();
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
    hestiaGoal: { findMany: mocks.goalFindMany, findFirst: mocks.goalFindFirst, create: mocks.goalCreate, update: mocks.goalUpdate },
    hestiaHabit: { findMany: mocks.habitFindMany, findFirst: mocks.habitFindFirst, create: mocks.habitCreate, update: mocks.habitUpdate },
    hestiaCheckIn: { findMany: mocks.checkInFindMany, upsert: mocks.checkInUpsert, deleteMany: mocks.checkInDeleteMany },
    hestiaHabitStreak: { upsert: mocks.streakUpsert },
  }));
  mocks.agentFindUnique.mockResolvedValue(owner);
  mocks.checkInFindMany.mockResolvedValue([]);
  mocks.streakUpsert.mockImplementation(async ({ update }: { update: unknown }) => ({ habitId: baseHabit.id, ownerId: owner.id, ...update }));
});

describe('Hestia goal, habit, and check-in routes', () => {
  it('enforces Zod body/query bounds', async () => {
    expect((await inject({ method: 'POST', url: '/api/hestia/goals', payload: { code: '', title: 'x', year: 2026 } })).statusCode).toBe(400);
    expect((await inject({ method: 'GET', url: '/api/hestia/check-ins?from=2025-01-01&to=2026-01-02' })).statusCode).toBe(400);
    expect(mocks.checkInFindMany).not.toHaveBeenCalled();
  });

  it('rejects a body ownerId and always injects the authenticated owner', async () => {
    const rejected = await inject({ method: 'POST', url: '/api/hestia/goals', payload: { code: 'G01', title: 'Goal', year: 2026, ownerId: 'attacker' } });
    expect(rejected.statusCode).toBe(400);
    mocks.goalCreate.mockResolvedValue({ id: 'goal-1' });
    const accepted = await inject({ method: 'POST', url: '/api/hestia/goals', payload: { code: 'G01', title: 'Goal', year: 2026 } });
    expect(accepted.statusCode).toBe(201);
    expect(mocks.goalCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ ownerId: owner.id }) });
  });

  it('returns code_taken for duplicate goal identities', async () => {
    mocks.goalCreate.mockRejectedValue({ code: 'P2002' });
    const response = await inject({ method: 'POST', url: '/api/hestia/goals', payload: { code: 'G01', title: 'Goal', year: 2026 } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'code_taken' });
  });

  it('returns code_taken for duplicate habit identities within an owned goal', async () => {
    mocks.goalFindFirst.mockResolvedValue({ id: 'goal-1' });
    mocks.habitCreate.mockRejectedValue({ code: 'P2002' });
    const response = await inject({
      method: 'POST', url: '/api/hestia/habits',
      payload: { code: 'H01', title: 'Walk', goalId: 'goal-1', cadence: 'daily', targetCount: 1, startDate: '2026-07-01' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'code_taken' });
    expect(mocks.goalFindFirst).toHaveBeenCalledWith({ where: { id: 'goal-1', ownerId: owner.id }, select: { id: true } });
  });

  it('owner-scopes lookups and returns 404 for a wrong-owner object', async () => {
    mocks.goalFindFirst.mockResolvedValue(null);
    const response = await inject({ method: 'PATCH', url: '/api/hestia/goals/other-goal', payload: { title: 'Nope' } });
    expect(response.statusCode).toBe(404);
    expect(mocks.goalFindFirst).toHaveBeenCalledWith({ where: { id: 'other-goal', ownerId: owner.id }, select: { id: true } });
    expect(mocks.goalUpdate).not.toHaveBeenCalled();
  });

  it('owner-scopes goal filters before listing their habits', async () => {
    mocks.goalFindFirst.mockResolvedValue({ id: 'goal-1' });
    mocks.habitFindMany.mockResolvedValue([]);
    expect((await inject({ method: 'GET', url: '/api/hestia/habits?goalId=goal-1&active=1' })).statusCode).toBe(200);
    expect(mocks.habitFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerId: owner.id, goalId: 'goal-1', active: true },
    }));
  });

  it('uses an idempotent compound-key upsert and recomputes the streak', async () => {
    mocks.habitFindFirst.mockResolvedValue(baseHabit);
    mocks.checkInUpsert.mockResolvedValue({ id: 'check-1', habitId: baseHabit.id, count: 1 });
    const request = { method: 'PUT' as const, url: `/api/hestia/habits/${baseHabit.id}/check-ins/2026-07-17`, payload: { count: 1 } };
    expect((await inject(request)).statusCode).toBe(200);
    expect((await inject(request)).statusCode).toBe(200);
    expect(mocks.checkInUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.checkInUpsert).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { habitId_checkDate: { habitId: baseHabit.id, checkDate: new Date('2026-07-17T00:00:00.000Z') } },
      create: expect.objectContaining({ ownerId: owner.id }),
    }));
    expect(mocks.streakUpsert).toHaveBeenCalledTimes(2);
  });

  it('makes undo idempotent, owner-scoped, and recomputes the streak', async () => {
    mocks.habitFindFirst.mockResolvedValue(baseHabit);
    mocks.checkInDeleteMany.mockResolvedValue({ count: 0 });
    const response = await inject({ method: 'DELETE', url: `/api/hestia/habits/${baseHabit.id}/check-ins/2026-07-17` });
    expect(response.statusCode).toBe(200);
    expect(mocks.checkInDeleteMany).toHaveBeenCalledWith({ where: {
      ownerId: owner.id, habitId: baseHabit.id, checkDate: new Date('2026-07-17T00:00:00.000Z'),
    } });
    expect(mocks.streakUpsert).toHaveBeenCalledOnce();
  });
});
