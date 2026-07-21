import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pins the per-person bills-CRUD lane granted to Mail (Central Office, 2026-07-21) alongside
// Nee/Noon (gm): mail@prominent.local rides the SAME BILL_ISSUER_EMAILS allowlist in
// api/src/routes/juno.ts + api/src/routes/finance.ts, regardless of her 'central' role. This
// mirrors the shape of junoWrongTransfer.test.ts's route-harness pattern but drives req.agent
// from a mutable fixture so each test can flip role/email and assert the resulting access.

const mocks = vi.hoisted(() => {
  const agent: { id: string; email: string; name: string; role: string; apps: string[] } = {
    id: 'agent-1', email: 'mail@prominent.local', name: 'Mail', role: 'central', apps: ['juno'],
  };
  const manualBill = { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() };
  const payment = { findMany: vi.fn(), count: vi.fn() };
  const product = { findMany: vi.fn() };
  const financeAudit = { findMany: vi.fn() };
  const reReceipt = { findMany: vi.fn() };
  return { agent, manualBill, payment, product, financeAudit, reReceipt };
});

vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: async (req: { agent?: unknown }) => {
    req.agent = { ...mocks.agent };
  },
  requireApp: () => async () => undefined,
  requireRole: () => async () => undefined,
}));
vi.mock('../src/db/prisma.js', () => ({
  prisma: (() => {
    const mocked = {
      manualBill: mocks.manualBill,
      payment: mocks.payment,
      product: mocks.product,
      financeAudit: mocks.financeAudit,
      reReceipt: mocks.reReceipt,
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(),
    };
    // Auto-numbered bill creation runs inside prisma.$transaction(async (tx) => {...}) — pass
    // the SAME mocked client back as `tx` so tx.manualBill.findMany/create hit our mocks too
    // (mirrors the pattern in junoWrongTransfer.test.ts).
    mocked.$transaction.mockImplementation((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(mocked),
    );
    return mocked;
  })(),
}));
vi.mock('../src/finance/slipLink.js', () => ({ buildSlipUrl: () => '' }));

import { junoRoutes } from '../src/routes/juno.js';
import { financeRoutes } from '../src/routes/finance.js';

async function junoServer() {
  const app = Fastify();
  await app.register(junoRoutes);
  await app.ready();
  return app;
}
async function financeServer() {
  const app = Fastify();
  await app.register(financeRoutes);
  await app.ready();
  return app;
}

const baseBill = () => ({
  id: 'bill-1', billNo: '9690001', billedAt: '', customerCode: '', buyerName: 'Buyer',
  buyerPhone: '', buyerAddress: '', items: [], amount: '0', note: '', status: 'open',
  voidedAt: null, voidedById: null, createdAt: new Date('2026-07-21T00:00:00Z'),
  updatedAt: new Date('2026-07-21T00:00:00Z'), createdById: null, createdByName: '',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agent.role = 'central';
  mocks.agent.email = 'mail@prominent.local';
  mocks.agent.apps = ['juno'];
  mocks.manualBill.findMany.mockResolvedValue([]);
  mocks.manualBill.findUnique.mockResolvedValue(baseBill());
  mocks.manualBill.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...baseBill(), ...data }));
  mocks.manualBill.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...baseBill(), ...data }));
  mocks.payment.findMany.mockResolvedValue([]);
  mocks.payment.count.mockResolvedValue(0);
  mocks.product.findMany.mockResolvedValue([]);
  mocks.financeAudit.findMany.mockResolvedValue([]);
  mocks.reReceipt.findMany.mockResolvedValue([]);
});

const newBillBody = () => ({
  billedAt: '2026-07-21', customerCode: '', buyerName: 'Buyer', buyerPhone: '', buyerAddress: '',
  items: [], amount: '0', note: '',
});

describe('Mail (per-person BILL_ISSUER_EMAILS) — juno bills-CRUD lane', () => {
  it('can list, create, edit, and void manual bills, and read the product picker', async () => {
    const app = await junoServer();

    const list = await app.inject({ method: 'GET', url: '/api/juno/bills' });
    expect(list.statusCode).toBe(200);

    const create = await app.inject({ method: 'POST', url: '/api/juno/bills', payload: newBillBody() });
    expect(create.statusCode).toBe(200);

    const edit = await app.inject({ method: 'PATCH', url: '/api/juno/bills/bill-1', payload: {} });
    expect(edit.statusCode).toBe(200);

    const void_ = await app.inject({ method: 'POST', url: '/api/juno/bills/bill-1/void', payload: { void: true } });
    expect(void_.statusCode).toBe(200);

    const products = await app.inject({ method: 'GET', url: '/api/juno/products' });
    expect(products.statusCode).toBe(200);
  });

  it.each([
    ['GET', '/api/juno/summary'],
    ['GET', '/api/juno/payments'],
    ['POST', '/api/juno/payments'],
    ['DELETE', '/api/juno/bills/bill-1'],
    ['GET', '/api/juno/discrepancies'],
    ['GET', '/api/juno/bank/summary'],
  ])('403s everywhere else in juno (%s %s)', async (method, url) => {
    const app = await junoServer();
    const res = await app.inject({ method: method as 'GET' | 'POST' | 'DELETE', url });
    expect(res.statusCode).toBe(403);
  });

  it('is denied FinanceAudit entirely, matching gm', async () => {
    const app = await financeServer();
    const res = await app.inject({ method: 'GET', url: '/api/finance/audits' });
    expect(res.statusCode).toBe(403);
  });
});

describe('gm (Nee/Noon) — unchanged by the Mail grant', () => {
  beforeEach(() => {
    mocks.agent.role = 'gm';
    mocks.agent.email = 'md@prominent.local';
  });

  it('keeps the same bills-CRUD lane', async () => {
    const app = await junoServer();
    const list = await app.inject({ method: 'GET', url: '/api/juno/bills' });
    expect(list.statusCode).toBe(200);
    const summary = await app.inject({ method: 'GET', url: '/api/juno/summary' });
    expect(summary.statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: '/api/juno/bills/bill-1' });
    expect(del.statusCode).toBe(403);
  });

  it('stays denied FinanceAudit', async () => {
    const app = await financeServer();
    const res = await app.inject({ method: 'GET', url: '/api/finance/audits' });
    expect(res.statusCode).toBe(403);
  });
});

describe('staff with a juno grant (e.g. Benz/Meow finance) — unchanged by the Mail grant', () => {
  beforeEach(() => {
    mocks.agent.role = 'staff';
    mocks.agent.email = 'benz@prominent.local';
  });

  it('keeps the broader FIN surface but not bill mutation or hard delete', async () => {
    const app = await junoServer();
    const summary = await app.inject({ method: 'GET', url: '/api/juno/summary' });
    expect(summary.statusCode).toBe(200);
    const create = await app.inject({ method: 'POST', url: '/api/juno/bills', payload: newBillBody() });
    expect(create.statusCode).toBe(403);
    const del = await app.inject({ method: 'DELETE', url: '/api/juno/bills/bill-1' });
    expect(del.statusCode).toBe(403);
  });

  it('keeps FinanceAudit read access', async () => {
    const app = await financeServer();
    const res = await app.inject({ method: 'GET', url: '/api/finance/audits' });
    expect(res.statusCode).toBe(200);
  });
});
