import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same mocking convention as ceresDailyOutflow.test.ts / ceresCategories.test.ts: mock
// db/prisma.js + env.js so importing the real routes/ceres/common.js (for thaiDayRange,
// reused per the endpoint spec) never touches a real DB or eagerly-parsed env schema.
type Expense = { category: string; amount: string; status: string; spentAt: Date };
type MoneyEvent = { id: string; requestId: string; kind: string; amount: string; reversesEventId: string | null; createdAt: Date };
type Request = { id: string; requestType: string; category: string };
type Category = { name: string; group: string };

const store = vi.hoisted(() => ({
  expenses: [] as Expense[],
  events: [] as MoneyEvent[],
  requests: [] as Request[],
  categories: [] as Category[],
}));

function inRange(d: Date, range?: { gte?: Date; lte?: Date }): boolean {
  if (!range) return true;
  if (range.gte && d < range.gte) return false;
  if (range.lte && d > range.lte) return false;
  return true;
}

const mocks = vi.hoisted(() => ({
  expenseFindMany: vi.fn(),
  eventFindMany: vi.fn(),
  requestFindMany: vi.fn(),
  categoryFindMany: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: {} }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    ceresExpense: { findMany: mocks.expenseFindMany },
    ceresRequestMoneyEvent: { findMany: mocks.eventFindMany },
    ceresPaymentRequest: { findMany: mocks.requestFindMany },
    ceresCategory: { findMany: mocks.categoryFindMany },
  },
}));

import { categoryReportsRoutes } from '../src/routes/ceres/reports.js';

function setupMockImplementations() {
  mocks.expenseFindMany.mockImplementation(async ({ where }: any) => {
    let rows = store.expenses;
    if (where?.status?.in) rows = rows.filter((r) => where.status.in.includes(r.status));
    if (where?.spentAt) rows = rows.filter((r) => inRange(r.spentAt, where.spentAt));
    return rows.map((r) => ({ category: r.category, amount: r.amount }));
  });
  mocks.eventFindMany.mockImplementation(async ({ where }: any) => {
    let rows = store.events;
    if (where?.kind?.in) rows = rows.filter((r) => where.kind.in.includes(r.kind));
    if (where?.kind === 'reversal') rows = rows.filter((r) => r.kind === 'reversal');
    if (where?.reversesEventId?.in) rows = rows.filter((r) => r.reversesEventId && where.reversesEventId.in.includes(r.reversesEventId));
    if (where?.createdAt) rows = rows.filter((r) => inRange(r.createdAt, where.createdAt));
    if (where?.kind === 'reversal') return rows.map((r) => ({ reversesEventId: r.reversesEventId }));
    return rows.map((r) => ({ id: r.id, requestId: r.requestId, amount: r.amount }));
  });
  mocks.requestFindMany.mockImplementation(async ({ where }: any) => {
    let rows = store.requests;
    if (where?.id?.in) rows = rows.filter((r) => where.id.in.includes(r.id));
    if (where?.requestType?.in) rows = rows.filter((r) => where.requestType.in.includes(r.requestType));
    return rows.map((r) => ({ id: r.id, category: r.category }));
  });
  mocks.categoryFindMany.mockImplementation(async () => store.categories.map((c) => ({ name: c.name, group: c.group })));
}

async function appAs(role: 'staff' | 'central' | 'gm' | 'supervisor') {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.agent = {
      id: 'agent-1', email: 'agent@example.test', name: 'Agent', role,
      apps: role === 'staff' || role === 'central' ? ['ceres'] : [], authVersion: 0,
    };
  });
  categoryReportsRoutes(app);
  return app;
}

const d = (s: string) => new Date(s);

beforeEach(() => {
  vi.clearAllMocks();
  store.expenses = [];
  store.events = [];
  store.requests = [];
  store.categories = [{ name: 'ค่าน้ำมัน', group: 'ยานพาหนะ/เดินทาง' }, { name: 'ค่าอาหาร', group: 'อาหาร/รับรอง' }];
  setupMockImplementations();
});

describe('GET /api/ceres/reports/category-summary', () => {
  it('rejects staff/messenger and non-ceres central, allows gm and ceo', async () => {
    const staff = await appAs('staff');
    const staffRes = await staff.inject({ method: 'GET', url: '/api/ceres/reports/category-summary' });
    expect(staffRes.statusCode).toBe(403);
    await staff.close();

    const gm = await appAs('gm');
    const gmRes = await gm.inject({ method: 'GET', url: '/api/ceres/reports/category-summary' });
    expect(gmRes.statusCode).toBe(200);
    await gm.close();

    const ceo = await appAs('supervisor');
    const ceoRes = await ceo.inject({ method: 'GET', url: '/api/ceres/reports/category-summary' });
    expect(ceoRes.statusCode).toBe(200);
    await ceo.close();
  });

  it('happy path: mixed approved/settled expenses + reimbursement/purchase payouts roll up by category and group', async () => {
    store.expenses = [
      { category: 'ค่าน้ำมัน', amount: '500.00', status: 'approved', spentAt: d('2026-07-10T05:00:00Z') },
      { category: 'ค่าน้ำมัน', amount: '250.50', status: 'settled', spentAt: d('2026-07-11T05:00:00Z') },
      { category: 'ค่าอาหาร', amount: '120.00', status: 'approved', spentAt: d('2026-07-12T05:00:00Z') },
    ];
    store.events = [
      { id: 'ev1', requestId: 'req1', kind: 'payment', amount: '1000.00', reversesEventId: null, createdAt: d('2026-07-10T06:00:00Z') },
      { id: 'ev2', requestId: 'req2', kind: 'purchase', amount: '300.00', reversesEventId: null, createdAt: d('2026-07-11T06:00:00Z') },
    ];
    store.requests = [
      { id: 'req1', requestType: 'reimbursement', category: 'ค่าอาหาร' },
      { id: 'req2', requestType: 'purchase', category: 'ค่าน้ำมัน' },
    ];

    const app = await appAs('gm');
    const res = await app.inject({ method: 'GET', url: '/api/ceres/reports/category-summary?from=2026-07-01&to=2026-07-31' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const fuel = body.rows.find((r: any) => r.category === 'ค่าน้ำมัน');
    const food = body.rows.find((r: any) => r.category === 'ค่าอาหาร');
    expect(fuel).toMatchObject({ group: 'ยานพาหนะ/เดินทาง', totalSatang: 500_00 + 250_50 + 300_00, count: 3 });
    expect(food).toMatchObject({ group: 'อาหาร/รับรอง', totalSatang: 120_00 + 1000_00, count: 2 });
    expect(body.grandTotal).toEqual({
      totalSatang: 500_00 + 250_50 + 300_00 + 120_00 + 1000_00,
      count: 5,
    });
    await app.close();
  });

  it('excludes an advance payment payout (its liquidation-child expense counts instead, not the float)', async () => {
    store.expenses = [
      { category: 'ค่าน้ำมัน', amount: '400.00', status: 'approved', spentAt: d('2026-07-10T05:00:00Z') },
    ];
    store.events = [
      // The advance's own float payout — must NOT appear in the rollup.
      { id: 'ev-advance', requestId: 'req-advance', kind: 'payment', amount: '2000.00', reversesEventId: null, createdAt: d('2026-07-09T06:00:00Z') },
    ];
    store.requests = [
      { id: 'req-advance', requestType: 'advance', category: 'ค่าน้ำมัน' },
    ];

    const app = await appAs('gm');
    const res = await app.inject({ method: 'GET', url: '/api/ceres/reports/category-summary?from=2026-07-01&to=2026-07-31' });
    const body = res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ category: 'ค่าน้ำมัน', totalSatang: 400_00, count: 1 });
    expect(body.grandTotal).toEqual({ totalSatang: 400_00, count: 1 });
    await app.close();
  });

  it('excludes a reversed reimbursement payout', async () => {
    store.events = [
      { id: 'ev1', requestId: 'req1', kind: 'payment', amount: '600.00', reversesEventId: null, createdAt: d('2026-07-10T06:00:00Z') },
      { id: 'ev1-rev', requestId: 'req1', kind: 'reversal', amount: '600.00', reversesEventId: 'ev1', createdAt: d('2026-07-10T07:00:00Z') },
    ];
    store.requests = [{ id: 'req1', requestType: 'reimbursement', category: 'ค่าอาหาร' }];

    const app = await appAs('supervisor');
    const res = await app.inject({ method: 'GET', url: '/api/ceres/reports/category-summary?from=2026-07-01&to=2026-07-31' });
    const body = res.json();
    expect(body.rows).toHaveLength(0);
    expect(body.grandTotal).toEqual({ totalSatang: 0, count: 0 });
    await app.close();
  });

  it('excludes a void expense', async () => {
    store.expenses = [
      { category: 'ค่าน้ำมัน', amount: '999.00', status: 'void', spentAt: d('2026-07-10T05:00:00Z') },
      { category: 'ค่าน้ำมัน', amount: '111.00', status: 'approved', spentAt: d('2026-07-10T05:00:00Z') },
    ];

    const app = await appAs('gm');
    const res = await app.inject({ method: 'GET', url: '/api/ceres/reports/category-summary?from=2026-07-01&to=2026-07-31' });
    const body = res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ totalSatang: 111_00, count: 1 });
    await app.close();
  });

  it('buckets a legacy/unknown category name under the fallback group', async () => {
    store.expenses = [
      { category: 'ค่าล้างรถเก่า (เลิกใช้)', amount: '80.00', status: 'approved', spentAt: d('2026-07-10T05:00:00Z') },
    ];

    const app = await appAs('gm');
    const res = await app.inject({ method: 'GET', url: '/api/ceres/reports/category-summary?from=2026-07-01&to=2026-07-31' });
    const body = res.json();
    expect(body.rows).toEqual([
      { category: 'ค่าล้างรถเก่า (เลิกใช้)', group: 'อื่นๆ (เดิม)', totalSatang: 80_00, count: 1 },
    ]);
    await app.close();
  });
});
