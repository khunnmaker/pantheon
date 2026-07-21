import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Category = {
  id: string;
  name: string;
  group: string;
  kind: string;
  ceiling: string;
  needsCustomerNote: boolean;
  active: boolean;
  sortOrder: number;
};

const mocks = vi.hoisted(() => ({
  categories: [] as Category[],
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  transaction: vi.fn(),
  partyFindFirst: vi.fn(),
  partyFindMany: vi.fn(),
}));

vi.mock('../src/env.js', () => ({
  env: { CERES_CEO_THRESHOLD: 5000, CERES_FLOOR: 3000 },
}));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    ceresCategory: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      create: mocks.create,
      update: mocks.update,
      count: mocks.count,
    },
    ceresParty: { findFirst: mocks.partyFindFirst, findMany: mocks.partyFindMany },
  },
}));

import { categoryAdminRoutes } from '../src/routes/ceres/categories.js';
import { p1Routes } from '../src/routes/ceres/p1.js';

const category = (id: string, name: string, group: string, sortOrder: number): Category => ({
  id, name, group, sortOrder, kind: 'general', ceiling: '', needsCustomerNote: false, active: true,
});

function rowForWhere(where: { id?: string; name?: string }) {
  return mocks.categories.find((row) => (where.id ? row.id === where.id : row.name === where.name)) ?? null;
}

function mockCategoryStore() {
  mocks.findMany.mockImplementation(async () => [...mocks.categories].sort((a, b) => a.sortOrder - b.sortOrder));
  mocks.findUnique.mockImplementation(async ({ where }) => rowForWhere(where));
  mocks.findFirst.mockImplementation(async ({ where, orderBy }) => {
    let rows = [...mocks.categories];
    if (where?.group) rows = rows.filter((row) => row.group === where.group);
    if (where?.sortOrder?.lt !== undefined) rows = rows.filter((row) => row.sortOrder < where.sortOrder.lt);
    if (where?.sortOrder?.gt !== undefined) rows = rows.filter((row) => row.sortOrder > where.sortOrder.gt);
    rows.sort((a, b) => orderBy.sortOrder === 'desc' ? b.sortOrder - a.sortOrder : a.sortOrder - b.sortOrder);
    return rows[0] ?? null;
  });
  mocks.create.mockImplementation(async ({ data }) => {
    const created = category(`cat-${mocks.categories.length + 1}`, data.name, data.group, data.sortOrder);
    Object.assign(created, data);
    mocks.categories.push(created);
    return created;
  });
  mocks.update.mockImplementation(async ({ where, data }) => {
    const existing = rowForWhere(where);
    if (!existing) throw new Error('missing category');
    Object.assign(existing, data);
    return { ...existing };
  });
  mocks.count.mockImplementation(async ({ where }) => mocks.categories.filter((row) => !where?.active || row.active).length);
  mocks.transaction.mockImplementation(async (callback) => callback({
    ceresCategory: { findUnique: mocks.findUnique, findFirst: mocks.findFirst, update: mocks.update },
  }));
}

async function adminApp(role: 'staff' | 'gm' | 'supervisor') {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.agent = {
      id: 'agent-1', email: 'agent@example.test', name: 'Agent', role,
      apps: role === 'staff' ? ['ceres'] : [], authVersion: 0,
    };
  });
  categoryAdminRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.categories = [
    category('cat-a', 'Category A', 'Group A', 10),
    category('cat-b', 'Category B', 'Group A', 20),
    category('cat-c', 'Category C', 'Group B', 110),
  ];
  mockCategoryStore();
  mocks.partyFindFirst.mockResolvedValue(null);
  mocks.partyFindMany.mockResolvedValue([]);
});

describe('Ceres category admin routes', () => {
  it('rejects messenger access and lets a GM list all rows', async () => {
    mocks.categories[2]!.active = false;
    const messenger = await adminApp('staff');
    const denied = await messenger.inject({ method: 'GET', url: '/api/ceres/admin/categories' });
    expect(denied.statusCode).toBe(403);
    await messenger.close();

    const gm = await adminApp('gm');
    const allowed = await gm.inject({ method: 'GET', url: '/api/ceres/admin/categories' });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().categories).toHaveLength(3);
    expect(allowed.json().categories[2].active).toBe(false);
    await gm.close();
  });

  it('creates, renames, detects duplicate names, deactivates, and moves within a group', async () => {
    const app = await adminApp('gm');
    const created = await app.inject({
      method: 'POST', url: '/api/ceres/admin/categories',
      payload: { name: '  Category D  ', group: '  Group A  ', ceiling: '250.50', needsCustomerNote: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().category).toMatchObject({ name: 'Category D', group: 'Group A', sortOrder: 30 });

    const renamed = await app.inject({
      method: 'PATCH', url: '/api/ceres/admin/categories/cat-a', payload: { name: 'Category A renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().category.name).toBe('Category A renamed');

    const duplicate = await app.inject({
      method: 'PATCH', url: '/api/ceres/admin/categories/cat-a', payload: { name: 'Category B' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: 'duplicate_name' });

    const deactivated = await app.inject({
      method: 'PATCH', url: '/api/ceres/admin/categories/cat-a', payload: { active: false },
    });
    expect(deactivated.statusCode).toBe(200);
    expect(deactivated.json().category.active).toBe(false);

    const moved = await app.inject({
      method: 'POST', url: '/api/ceres/admin/categories/cat-b/move', payload: { direction: 'up' },
    });
    expect(moved.statusCode).toBe(200);
    expect(rowForWhere({ id: 'cat-b' })?.sortOrder).toBe(10);
    expect(rowForWhere({ id: 'cat-a' })?.sortOrder).toBe(20);
    await app.close();
  });

  it('refuses to deactivate the last active category', async () => {
    mocks.categories[1]!.active = false;
    mocks.categories[2]!.active = false;
    const app = await adminApp('supervisor');
    const response = await app.inject({
      method: 'PATCH', url: '/api/ceres/admin/categories/cat-a', payload: { active: false },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'last_active_category' });
    await app.close();
  });
});

describe('Ceres bootstrap categories', () => {
  it('serializes the category group field', async () => {
    mocks.categories = [category('cat-food', 'ค่าอาหารและเครื่องดื่ม', 'อาหาร/รับรอง', 410)];
    const app = Fastify();
    app.addHook('preHandler', async (req) => {
      req.agent = {
        id: 'gm-1', email: 'gm@example.test', name: 'GM', role: 'gm', apps: [], authVersion: 0,
      };
    });
    p1Routes(app);
    const response = await app.inject({ method: 'GET', url: '/api/ceres/bootstrap' });
    expect(response.statusCode).toBe(200);
    expect(response.json().categories[0]).toMatchObject({ group: 'อาหาร/รับรอง' });
    await app.close();
  });
});
