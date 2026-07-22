import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Backend leg of Ceres multi-image attachments (2026-07-22): additive receiptUploadIds
// array alongside the existing singular receiptUploadId on expense create/patch. See
// ceres/mediaLinks.ts for the shared write/read helpers exercised through these routes.

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findParty: vi.fn(),
  findMedia: vi.fn(),
  findExpense: vi.fn(),
  createExpense: vi.fn(),
  updateExpense: vi.fn(),
  createMediaLink: vi.fn(),
  deleteMediaLink: vi.fn(),
  findMediaLink: vi.fn(),
  readReceiptMeta: vi.fn(),
}));

vi.mock('../src/env.js', () => ({
  env: { JWT_SECRET: 'unit-test-placeholder', CERES_CEO_THRESHOLD: 5000, CERES_FLOOR: 3000 },
}));
vi.mock('../src/ceres/receiptStore.js', () => ({
  saveCeresReceipt: vi.fn(),
  readCeresReceiptMeta: mocks.readReceiptMeta,
  saveCeresReceiptOcr: vi.fn(),
}));
vi.mock('../src/llm/readReceipt.js', () => ({ readReceiptImage: vi.fn() }));
vi.mock('../src/ceres/aiReview.js', () => ({ reviewExpensePostHoc: vi.fn(async () => undefined) }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    ceresParty: { findFirst: mocks.findParty },
    ceresMedia: { findUnique: mocks.findMedia },
    ceresExpense: { findUnique: mocks.findExpense },
    ceresMediaLink: { findMany: mocks.findMediaLink },
  },
}));

import { p1Routes } from '../src/routes/ceres/p1.js';

const agent = {
  id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff' as const,
  apps: ['ceres'], authVersion: 0,
};

function expenseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'expense-1', partyId: 'party-1', partyName: 'Staff', enteredById: agent.id, enteredByName: agent.name,
    entity: 'PROM', category: 'Travel', customerNote: '', amount: '100.00', spentAt: new Date('2026-07-19T04:00:00.000Z'),
    receiptUploadId: null, receiptSha: '', ocrAmount: '', ocrVendor: '', ocrDate: '',
    status: 'pending', approvedById: null, approvedAt: null, rejectReason: '',
    voidedById: null, voidedAt: null, voidReason: '', settlementId: null,
    advanceRequestId: null, fundingLane: 'cash', aiVerdict: '', note: '', createdAt: new Date('2026-07-19T04:00:00.000Z'),
    ...overrides,
  };
}

function media(id: string, purpose = 'legacy_receipt') {
  return { id, purpose, sha256: `sha-${id}`, uploadedById: agent.id, uploadedByName: agent.name, createdAt: new Date() };
}

function buildApp() {
  const app = Fastify();
  app.addHook('preHandler', async (req) => { req.agent = agent; });
  p1Routes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findParty.mockResolvedValue({ id: 'party-1', name: 'Staff', active: true });
  mocks.readReceiptMeta.mockResolvedValue(null);
  mocks.findMediaLink.mockResolvedValue([]);
  mocks.findMedia.mockImplementation(async ({ where }: { where: { id: string } }) => media(where.id));
  mocks.createExpense.mockImplementation(async ({ data }: any) => expenseRow(data));
  mocks.updateExpense.mockImplementation(async ({ data }: any) => expenseRow(data));
  mocks.createMediaLink.mockImplementation(async ({ data }: any) => ({ count: data.length }));
  mocks.deleteMediaLink.mockResolvedValue({ count: 0 });
  mocks.transaction.mockImplementation(async (callback) => callback({
    $queryRaw: vi.fn(async () => []),
    ceresExpense: { create: mocks.createExpense, update: mocks.updateExpense },
    ceresRequestEvent: { create: vi.fn() },
    ceresMediaLink: { createMany: mocks.createMediaLink, deleteMany: mocks.deleteMediaLink },
  }));
});

describe('Ceres expense multi-image attachments', () => {
  it('creates an expense with 3 receiptUploadIds: link rows for all three + singular = element 0 + sha of element 0', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/expenses',
      payload: {
        entity: 'PROM', category: 'Travel', amount: '100.00',
        receiptUploadIds: ['receipt-1', 'receipt-2', 'receipt-3'],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.expense.receiptUploadId).toBe('receipt-1');
    expect(body.expense.receiptUploadIds).toEqual(['receipt-1', 'receipt-2', 'receipt-3']);
    expect(mocks.createExpense).toHaveBeenCalledWith({
      data: expect.objectContaining({ receiptUploadId: 'receipt-1', receiptSha: 'sha-receipt-1' }),
    });
    expect(mocks.createMediaLink).toHaveBeenCalledWith({
      data: [
        { targetType: 'expense', targetId: 'expense-1', mediaId: 'receipt-1', purpose: 'receipt', sortOrder: 0 },
        { targetType: 'expense', targetId: 'expense-1', mediaId: 'receipt-2', purpose: 'receipt', sortOrder: 1 },
        { targetType: 'expense', targetId: 'expense-1', mediaId: 'receipt-3', purpose: 'receipt', sortOrder: 2 },
      ],
    });
    await app.close();
  });

  it('accepts an old-style singular receiptUploadId payload and still writes one link row', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/expenses',
      payload: { entity: 'PROM', category: 'Travel', amount: '50.00', receiptUploadId: 'receipt-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().expense.receiptUploadIds).toEqual(['receipt-1']);
    expect(mocks.createMediaLink).toHaveBeenCalledWith({
      data: [{ targetType: 'expense', targetId: 'expense-1', mediaId: 'receipt-1', purpose: 'receipt', sortOrder: 0 }],
    });
    await app.close();
  });

  it('lets the array win over the singular field when both are sent', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/expenses',
      payload: {
        entity: 'PROM', category: 'Travel', amount: '75.00',
        receiptUploadId: 'ignored-receipt', receiptUploadIds: ['receipt-1', 'receipt-2'],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.expense.receiptUploadId).toBe('receipt-1');
    expect(body.expense.receiptUploadIds).toEqual(['receipt-1', 'receipt-2']);
    expect(mocks.findMedia).not.toHaveBeenCalledWith({ where: { id: 'ignored-receipt' } });
    await app.close();
  });

  it('silently de-duplicates repeated ids within the array', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/expenses',
      payload: {
        entity: 'PROM', category: 'Travel', amount: '10.00',
        receiptUploadIds: ['receipt-1', 'receipt-1', 'receipt-2'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().expense.receiptUploadIds).toEqual(['receipt-1', 'receipt-2']);
    await app.close();
  });

  it('rejects more than 10 receiptUploadIds with 400 before any write', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/expenses',
      payload: {
        entity: 'PROM', category: 'Travel', amount: '10.00',
        receiptUploadIds: Array.from({ length: 11 }, (_, i) => `receipt-${i}`),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_body' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects the whole array when one element has the wrong purpose (mediaCanBeAttachedBy)', async () => {
    mocks.findMedia.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'receipt-bad' ? media('receipt-bad', 'transfer_slip') : media(where.id));
    const app = buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/expenses',
      payload: {
        entity: 'PROM', category: 'Travel', amount: '10.00',
        receiptUploadIds: ['receipt-1', 'receipt-bad'],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'media_not_owned' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('PATCH replaces the full link set when receiptUploadIds is sent', async () => {
    mocks.findExpense.mockResolvedValue(expenseRow({ receiptUploadId: 'old-receipt', receiptSha: 'old-sha' }));
    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH', url: '/api/ceres/expenses/expense-1',
      payload: { receiptUploadIds: ['receipt-1', 'receipt-2'] },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.updateExpense).toHaveBeenCalledWith({
      where: { id: 'expense-1' },
      data: expect.objectContaining({ receiptUploadId: 'receipt-1', receiptSha: 'sha-receipt-1' }),
    });
    expect(mocks.deleteMediaLink).toHaveBeenCalledWith({
      where: { targetType: 'expense', targetId: 'expense-1', purpose: 'receipt' },
    });
    expect(mocks.createMediaLink).toHaveBeenCalledWith({
      data: [
        { targetType: 'expense', targetId: 'expense-1', mediaId: 'receipt-1', purpose: 'receipt', sortOrder: 0 },
        { targetType: 'expense', targetId: 'expense-1', mediaId: 'receipt-2', purpose: 'receipt', sortOrder: 1 },
      ],
    });
    expect(response.json().expense.receiptUploadIds).toEqual(['receipt-1', 'receipt-2']);
    await app.close();
  });

  it('PATCH on an unrelated field preserves the existing link set untouched', async () => {
    mocks.findExpense.mockResolvedValue(expenseRow({ receiptUploadId: 'old-receipt', receiptSha: 'old-sha' }));
    mocks.findMediaLink.mockResolvedValue([{ mediaId: 'old-receipt-1' }, { mediaId: 'old-receipt-2' }]);
    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH', url: '/api/ceres/expenses/expense-1',
      payload: { note: 'updated note' },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.deleteMediaLink).not.toHaveBeenCalled();
    expect(mocks.createMediaLink).not.toHaveBeenCalled();
    expect(response.json().expense.receiptUploadIds).toEqual(['old-receipt-1', 'old-receipt-2']);
    await app.close();
  });

  it('serializes a legacy row with no link rows by falling back to [receiptUploadId] on approve', async () => {
    const legacy = expenseRow({ receiptUploadId: 'legacy-receipt', receiptSha: 'legacy-sha' });
    mocks.findExpense.mockResolvedValue(legacy);
    mocks.findMediaLink.mockResolvedValue([]); // no CeresMediaLink rows for this legacy expense
    mocks.updateExpense.mockImplementation(async ({ data }: any) => ({ ...legacy, ...data }));
    mocks.transaction.mockImplementation(async (callback) => callback({
      $queryRaw: vi.fn(async () => []),
      ceresExpense: { create: mocks.createExpense, update: mocks.updateExpense },
      ceresRequestEvent: { create: vi.fn() },
      ceresPaymentRequest: { findUnique: vi.fn(async () => null) },
      ceresMediaLink: { createMany: mocks.createMediaLink, deleteMany: mocks.deleteMediaLink },
    }));
    const gmApp = Fastify();
    gmApp.addHook('preHandler', async (req) => {
      req.agent = { id: 'gm-1', email: 'gm@example.test', name: 'GM', role: 'gm', apps: [], authVersion: 0 };
    });
    p1Routes(gmApp);

    const response = await gmApp.inject({ method: 'POST', url: '/api/ceres/expenses/expense-1/approve' });

    expect(response.statusCode).toBe(200);
    expect(response.json().expense.receiptUploadIds).toEqual(['legacy-receipt']);
    await gmApp.close();
  });
});
