import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findParty: vi.fn(),
  findAdvance: vi.fn(),
  findEvents: vi.fn(),
  findMedia: vi.fn(),
  findExpense: vi.fn(),
  createExpense: vi.fn(),
  updateExpense: vi.fn(),
  createRequestEvent: vi.fn(),
  queryRaw: vi.fn(),
  readReceiptMeta: vi.fn(),
  findMediaLink: vi.fn(async () => []),
  createMediaLink: vi.fn(),
  deleteMediaLink: vi.fn(),
}));

vi.mock('../src/env.js', () => ({
  env: {
    JWT_SECRET: 'unit-test-placeholder',
    CERES_CEO_THRESHOLD: 5000,
    CERES_FLOOR: 3000,
  },
}));
vi.mock('../src/ceres/receiptStore.js', () => ({
  saveCeresReceipt: vi.fn(),
  readCeresReceiptMeta: mocks.readReceiptMeta,
  saveCeresReceiptOcr: vi.fn(),
}));
vi.mock('../src/llm/readReceipt.js', () => ({ readReceiptImage: vi.fn() }));
vi.mock('../src/ceres/aiReview.js', () => ({ reviewExpensePostHoc: vi.fn() }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    ceresParty: { findFirst: mocks.findParty },
    ceresPaymentRequest: { findUnique: mocks.findAdvance },
    ceresRequestMoneyEvent: { findMany: mocks.findEvents },
    ceresMedia: { findUnique: mocks.findMedia },
    ceresExpense: { findUnique: mocks.findExpense },
    ceresMediaLink: { findMany: mocks.findMediaLink },
  },
}));

import { p1Routes } from '../src/routes/ceres/p1.js';

const agent = {
  id: 'staff-1',
  email: 'staff@example.test',
  name: 'Staff',
  role: 'staff' as const,
  apps: ['ceres'],
  authVersion: 0,
};

const payment = {
  id: 'payment-1',
  requestId: 'advance-1',
  kind: 'payment',
  lane: 'cash',
  reversesEventId: null,
  createdAt: new Date('2026-07-19T03:00:00.000Z'),
};

function expenseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'expense-1',
    partyId: 'party-1',
    partyName: 'Staff',
    enteredById: agent.id,
    enteredByName: agent.name,
    entity: 'PROM',
    category: 'Travel',
    customerNote: '',
    amount: '100.00',
    spentAt: new Date('2026-07-19T04:00:00.000Z'),
    receiptUploadId: 'receipt-1',
    receiptSha: 'receipt-sha',
    ocrAmount: '',
    ocrVendor: '',
    ocrDate: '',
    status: 'pending',
    approvedById: null,
    approvedAt: null,
    rejectReason: '',
    voidedById: null,
    voidedAt: null,
    voidReason: '',
    settlementId: null,
    advanceRequestId: 'advance-1',
    fundingLane: 'cash',
    aiVerdict: '',
    note: '',
    createdAt: new Date('2026-07-19T04:00:00.000Z'),
    ...overrides,
  };
}

function buildApp() {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.agent = agent;
  });
  p1Routes(app);
  return app;
}

function createPayload(receiptUploadId?: string) {
  return {
    entity: 'PROM',
    category: 'Travel',
    amount: '100.00',
    advanceRequestId: 'advance-1',
    ...(receiptUploadId ? { receiptUploadId } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findParty.mockResolvedValue({ id: 'party-1', name: 'Staff', active: true });
  mocks.findAdvance.mockResolvedValue({
    id: 'advance-1',
    workflowVersion: 2,
    requestType: 'advance',
    requestedById: agent.id,
    requesterPartyId: 'party-1',
  });
  mocks.findEvents.mockResolvedValue([payment]);
  mocks.findExpense.mockResolvedValue(expenseRow());
  mocks.readReceiptMeta.mockResolvedValue(null);
  mocks.queryRaw.mockResolvedValue([{ id: 'advance-1' }]);
  mocks.createExpense.mockImplementation(async ({ data }) => expenseRow(data));
  mocks.updateExpense.mockImplementation(async ({ data }) => expenseRow(data));
  mocks.createRequestEvent.mockResolvedValue({ id: 'event-1' });
  mocks.transaction.mockImplementation(async (callback) => callback({
    $queryRaw: mocks.queryRaw,
    ceresRequestMoneyEvent: { findMany: mocks.findEvents },
    ceresExpense: { create: mocks.createExpense, update: mocks.updateExpense },
    ceresRequestEvent: { create: mocks.createRequestEvent },
    ceresMediaLink: { createMany: mocks.createMediaLink, deleteMany: mocks.deleteMediaLink },
  }));
});

describe('Ceres advance liquidation expense receipts', () => {
  it('leaves the removed manual advance and refund routes unregistered', async () => {
    const app = buildApp();
    for (const route of ['/api/ceres/advances', '/api/ceres/refunds']) {
      const response = await app.inject({ method: 'POST', url: route, payload: {} });
      expect(response.statusCode).toBe(404);
    }
    await app.close();
  });

  it.each(['legacy_receipt', 'reimbursement_receipt'] as const)(
    'creates a liquidation expense with requester-owned %s media',
    async (purpose) => {
      mocks.findMedia.mockResolvedValue({
        id: 'receipt-1', purpose, sha256: 'receipt-sha',
        uploadedById: agent.id, uploadedByName: agent.name, createdAt: new Date(),
      });
      const app = buildApp();

      const response = await app.inject({
        method: 'POST', url: '/api/ceres/expenses', payload: createPayload('receipt-1'),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().expense).toMatchObject({
        receiptUploadId: 'receipt-1', advanceRequestId: 'advance-1',
      });
      expect(mocks.createExpense).toHaveBeenCalledWith({
        data: expect.objectContaining({ receiptUploadId: 'receipt-1', receiptSha: 'receipt-sha' }),
      });
      await app.close();
    },
  );

  it.each(['legacy_receipt', 'reimbursement_receipt'] as const)(
    'updates a liquidation expense with requester-owned %s media',
    async (purpose) => {
      mocks.findMedia.mockResolvedValue({
        id: 'receipt-2', purpose, sha256: 'replacement-sha',
        uploadedById: agent.id, uploadedByName: agent.name, createdAt: new Date(),
      });
      const app = buildApp();

      const response = await app.inject({
        method: 'PATCH', url: '/api/ceres/expenses/expense-1', payload: { receiptUploadId: 'receipt-2' },
      });

      expect(response.statusCode).toBe(200);
      expect(mocks.updateExpense).toHaveBeenCalledWith({
        where: { id: 'expense-1' },
        data: expect.objectContaining({ receiptUploadId: 'receipt-2', receiptSha: 'replacement-sha' }),
      });
      await app.close();
    },
  );

  it('rejects liquidation media owned by a different agent', async () => {
    mocks.findMedia.mockResolvedValue({
      id: 'receipt-other', purpose: 'legacy_receipt', sha256: 'receipt-sha',
      uploadedById: 'staff-2', uploadedByName: 'Other Staff', createdAt: new Date(),
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST', url: '/api/ceres/expenses', payload: createPayload('receipt-other'),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'media_not_owned' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires a receipt when creating an advance liquidation expense', async () => {
    const app = buildApp();

    const response = await app.inject({
      method: 'POST', url: '/api/ceres/expenses', payload: createPayload(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'receipt_required' });
    expect(mocks.findMedia).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('blocks clearing a liquidation expense to zero receipts on edit (receipt_required)', async () => {
    const app = buildApp();

    const response = await app.inject({
      method: 'PATCH', url: '/api/ceres/expenses/expense-1', payload: { receiptUploadIds: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'receipt_required' });
    expect(mocks.updateExpense).not.toHaveBeenCalled();
    await app.close();
  });

  it('satisfies the receipt_required liquidation gate with an array-only payload (no singular field)', async () => {
    mocks.findMedia.mockResolvedValue({
      id: 'receipt-1', purpose: 'legacy_receipt', sha256: 'receipt-sha',
      uploadedById: agent.id, uploadedByName: agent.name, createdAt: new Date(),
    });
    const app = buildApp();

    const response = await app.inject({
      method: 'POST', url: '/api/ceres/expenses',
      payload: { ...createPayload(), receiptUploadIds: ['receipt-1', 'receipt-2'] },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.createExpense).toHaveBeenCalledWith({
      data: expect.objectContaining({ receiptUploadId: 'receipt-1', receiptSha: 'receipt-sha', advanceRequestId: 'advance-1' }),
    });
    await app.close();
  });
});
