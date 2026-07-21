import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route-level tests for POST /api/apollo/events/:id/skip ("ลบเฉพาะวันนี้") — auth shape
// (owner-only, 404-for-missing-or-not-yours, NO manager/CEO bypass), occurrence validation,
// and skipDates append/dedupe. Same mocked-middleware inject harness as learningRoutes.test.ts.

const mocks = vi.hoisted(() => ({
  eventFindUnique: vi.fn(),
  eventUpdate: vi.fn(),
  // Mutable caller identity so tests can switch who's asking without rebuilding the mock module.
  caller: { id: 'owner-1', role: 'staff' },
}));

vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (req: { agent?: unknown }) => {
    req.agent = { id: mocks.caller.id, email: 'x@example.test', name: 'X', role: mocks.caller.role, apps: ['apollo'], authVersion: 0 };
  },
  requireApp: () => async () => undefined,
  requireRole: () => async () => undefined,
}));
vi.mock('../src/db/prisma.js', () => ({
  prisma: { apolloEvent: { findUnique: mocks.eventFindUnique, update: mocks.eventUpdate } },
}));
// These pull env/LINE/fs chains at import time — the skip route touches none of them.
vi.mock('../src/apollo/notify.js', () => ({ notifyApolloAssignment: vi.fn(), thaiDateKey: () => '2026-07-17' }));
vi.mock('../src/apollo/attachmentStore.js', () => ({ deleteApolloAttachment: vi.fn(), readApolloAttachment: vi.fn(), saveApolloAttachment: vi.fn() }));
vi.mock('../src/db/ensureSeeded.js', () => ({ STAFF: [], TIER_ACCOUNTS: [], staffEmail: (slug: string) => `${slug}@example.test` }));
vi.mock('../src/line/staffBind.js', () => ({ createStaffLineBindCode: vi.fn(), staffLineBindStatus: vi.fn() }));

import { apolloRoutes } from '../src/routes/apollo.js';

// A weekly Thursday series based 2026-07-16 (UTC weekday 4), owned by owner-1.
const seriesEvent = {
  agentId: 'owner-1',
  date: new Date('2026-07-16T00:00:00.000Z'),
  recurrenceRule: { freq: 'weekly', weekday: 4 },
  recurrenceUntil: null,
  skipDates: [] as string[],
};

async function buildApp() {
  const app = Fastify();
  await apolloRoutes(app);
  return app;
}

const skip = async (app: Awaited<ReturnType<typeof buildApp>>, date: unknown) =>
  app.inject({ method: 'POST', url: '/api/apollo/events/evt-1/skip', payload: { date } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.caller.id = 'owner-1';
  mocks.caller.role = 'staff';
  mocks.eventFindUnique.mockResolvedValue({ ...seriesEvent, skipDates: [...seriesEvent.skipDates] });
  mocks.eventUpdate.mockImplementation(async ({ data }: { data: { skipDates: string[] } }) => ({ id: 'evt-1', ...seriesEvent, ...data }));
});

describe('POST /api/apollo/events/:id/skip', () => {
  it('owner skips a real occurrence — the date is appended to skipDates', async () => {
    const app = await buildApp();
    const res = await skip(app, '2026-07-23');
    expect(res.statusCode).toBe(200);
    expect(mocks.eventUpdate).toHaveBeenCalledWith({ where: { id: 'evt-1' }, data: { skipDates: ['2026-07-23'] } });
  });

  it('dedupes an already-skipped date instead of appending it twice', async () => {
    mocks.eventFindUnique.mockResolvedValue({ ...seriesEvent, skipDates: ['2026-07-23'] });
    const app = await buildApp();
    const res = await skip(app, '2026-07-23');
    expect(res.statusCode).toBe(200);
    expect(mocks.eventUpdate).toHaveBeenCalledWith({ where: { id: 'evt-1' }, data: { skipDates: ['2026-07-23'] } });
  });

  it('400 not_an_occurrence for a date the series never falls on (wrong weekday / before base)', async () => {
    const app = await buildApp();
    expect((await skip(app, '2026-07-24')).statusCode).toBe(400); // a Friday
    expect((await skip(app, '2026-07-09')).statusCode).toBe(400); // Thursday BEFORE the base date
    expect(JSON.parse((await skip(app, '2026-07-24')).body)).toEqual({ error: 'not_an_occurrence' });
    expect(mocks.eventUpdate).not.toHaveBeenCalled();
  });

  it('400 invalid_body for a malformed date', async () => {
    const app = await buildApp();
    expect((await skip(app, 'ไม่ใช่วันที่')).statusCode).toBe(400);
    expect((await skip(app, undefined)).statusCode).toBe(400);
    expect(mocks.eventUpdate).not.toHaveBeenCalled();
  });

  it('404 when the event does not exist', async () => {
    mocks.eventFindUnique.mockResolvedValue(null);
    const app = await buildApp();
    const res = await skip(app, '2026-07-23');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
  });

  it("404 (same shape as missing — probe can't tell) when the event belongs to someone else", async () => {
    mocks.caller.id = 'someone-else';
    const app = await buildApp();
    const res = await skip(app, '2026-07-23');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(mocks.eventUpdate).not.toHaveBeenCalled();
  });

  it('no manager/CEO bypass: a supervisor skipping someone else\'s event still gets 404 (event CRUD stays owner-only)', async () => {
    mocks.caller.id = 'ceo-1';
    mocks.caller.role = 'supervisor';
    const app = await buildApp();
    const res = await skip(app, '2026-07-23');
    expect(res.statusCode).toBe(404);
    expect(mocks.eventUpdate).not.toHaveBeenCalled();
  });
});
