import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentFindUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: { JWT_SECRET: 'unit-test-jwt-secret' } }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    agent: { findUnique: mocks.agentFindUnique },
    hestiaGoal: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    hestiaHabit: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    hestiaCheckIn: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    hestiaHabitStreak: { upsert: vi.fn() },
    hestiaJournalEntry: { findMany: mocks.findMany, findFirst: mocks.findFirst, create: mocks.create, update: mocks.update, delete: mocks.delete },
    $transaction: vi.fn(),
  },
}));

import { signToken } from '../src/auth/jwt.js';
import { hestiaRoutes } from '../src/routes/hestia.js';

const owner = { id: 'owner-1', email: 'owner@example.test', name: 'Owner', role: 'supervisor' as const, apps: [], authVersion: 0 };
const headers = { authorization: `Bearer ${signToken(owner)}` };
const entry = (id: string, date = '2026-07-17') => ({
  id, ownerId: owner.id, entryDate: new Date(`${date}T00:00:00.000Z`), title: '', bodyMarkdown: id,
  mood: null, tags: [], source: 'manual', externalId: null, externalUrl: null, sourceUpdatedAt: null,
  importedAt: null, sourceMetadata: null, createdAt: new Date(), updatedAt: new Date(),
});

async function inject(options: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: unknown }) {
  const app = Fastify();
  await app.register(hestiaRoutes);
  const response = await app.inject({ ...options, headers });
  await app.close();
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agentFindUnique.mockResolvedValue(owner);
});

describe('Hestia journal routes', () => {
  it('creates multiple independent manual entries on the same day', async () => {
    mocks.create.mockResolvedValueOnce(entry('entry-1')).mockResolvedValueOnce(entry('entry-2'));
    const payload = { entryDate: '2026-07-17', bodyMarkdown: 'Reflection' };
    expect((await inject({ method: 'POST', url: '/api/hestia/journal', payload })).statusCode).toBe(201);
    expect((await inject({ method: 'POST', url: '/api/hestia/journal', payload })).statusCode).toBe(201);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({
      ownerId: owner.id, source: 'manual', entryDate: new Date('2026-07-17T00:00:00.000Z'),
    }) });
  });

  it('reserves source and external sync fields instead of accepting them from the client', async () => {
    const source = await inject({ method: 'POST', url: '/api/hestia/journal', payload: { entryDate: '2026-07-17', bodyMarkdown: 'x', source: 'notion' } });
    const external = await inject({ method: 'POST', url: '/api/hestia/journal', payload: { entryDate: '2026-07-17', bodyMarkdown: 'x', externalId: 'page-1' } });
    expect(source.statusCode).toBe(400);
    expect(external.statusCode).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('owner-scopes reads and returns 404 for missing or wrong-owner entries', async () => {
    mocks.findFirst.mockResolvedValue(null);
    const response = await inject({ method: 'GET', url: '/api/hestia/journal/foreign-entry' });
    expect(response.statusCode).toBe(404);
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign-entry', ownerId: owner.id } });
  });

  it('updates and deletes manual entries only', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'entry-1' });
    mocks.update.mockResolvedValue(entry('entry-1'));
    mocks.delete.mockResolvedValue(entry('entry-1'));
    expect((await inject({ method: 'PATCH', url: '/api/hestia/journal/entry-1', payload: { mood: 5 } })).statusCode).toBe(200);
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'entry-1', ownerId: owner.id, source: 'manual' }, select: { id: true } });
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'entry-1', ownerId: owner.id }, data: { mood: 5 } });
    expect((await inject({ method: 'DELETE', url: '/api/hestia/journal/entry-1' })).statusCode).toBe(200);
    expect(mocks.delete).toHaveBeenCalledWith({ where: { id: 'entry-1', ownerId: owner.id } });
  });

  it('hides notion-owned entries from update/delete as not_found', async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect((await inject({ method: 'PATCH', url: '/api/hestia/journal/notion-1', payload: { title: 'No' } })).statusCode).toBe(404);
    expect((await inject({ method: 'DELETE', url: '/api/hestia/journal/notion-1' })).statusCode).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('enforces mood, cursor, limit, and bounded range validation', async () => {
    expect((await inject({ method: 'POST', url: '/api/hestia/journal', payload: { entryDate: '2026-07-17', bodyMarkdown: 'x', mood: 6 } })).statusCode).toBe(400);
    expect((await inject({ method: 'GET', url: '/api/hestia/journal?limit=101' })).statusCode).toBe(400);
    expect((await inject({ method: 'GET', url: '/api/hestia/journal?from=2025-01-01&to=2026-01-02' })).statusCode).toBe(400);
    mocks.findFirst.mockResolvedValue(null);
    expect((await inject({ method: 'GET', url: '/api/hestia/journal?cursor=foreign' })).statusCode).toBe(400);
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign', ownerId: owner.id }, select: { id: true } });
  });

  it('returns newest-first pagination with an owner-scoped cursor', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'entry-2' });
    mocks.findMany.mockResolvedValue([entry('entry-1'), entry('entry-0', '2026-07-16')]);
    const response = await inject({ method: 'GET', url: '/api/hestia/journal?cursor=entry-2&limit=2&from=2026-07-01&to=2026-07-31' });
    expect(response.statusCode).toBe(200);
    expect(response.json().nextCursor).toBe('entry-0');
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerId: owner.id, entryDate: { gte: new Date('2026-07-01T00:00:00.000Z'), lte: new Date('2026-07-31T00:00:00.000Z') } },
      cursor: { id: 'entry-2' }, skip: 1, take: 2,
    }));
  });
});
