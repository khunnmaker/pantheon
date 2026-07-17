import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  pendingCount: vi.fn(),
  updateExpenses: vi.fn(),
  createSettlementLine: vi.fn(),
  createRequestLine: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: { CERES_FLOOR: 3000, CERES_CEO_THRESHOLD: 5000 } }));
vi.mock('../src/ceres/receiptStore.js', () => ({
  saveCeresReceipt: vi.fn(), readCeresReceiptMeta: vi.fn(), saveCeresReceiptOcr: vi.fn(),
}));
vi.mock('../src/llm/readReceipt.js', () => ({ readReceiptImage: vi.fn() }));
vi.mock('../src/ceres/aiReview.js', () => ({ reviewExpensePostHoc: vi.fn() }));

const cutoffEvent = {
  id: 'event-cash-direct', requestId: 'request-direct', kind: 'payment', lane: 'cash', amount: '100.00',
  transferSlipUploadId: null, purchaseReceiptUploadId: null, cashMovementId: 'movement-request',
  reversesEventId: null, createdById: 'gm-1', createdByName: 'GM', note: '',
  createdAt: new Date('2026-07-17T01:00:00Z'), idempotencyKey: null,
};

function txClient() {
  return {
    $queryRaw: vi.fn(async () => [{ id: 'pettyCash' }]),
    ceresSettlement: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => ({ id: 'settlement-1', ...data })),
    },
    ceresExpense: {
      count: mocks.pendingCount,
      findMany: vi.fn(async ({ where, select }: any) => {
        if (where.status === 'approved' && select?.id) return [{ id: 'expense-cash' }];
        if (where.status === 'approved') return [{ partyId: 'party-1', amount: '50.00' }];
        return [];
      }),
      updateMany: mocks.updateExpenses,
    },
    ceresParty: { findMany: vi.fn(async () => [{ id: 'party-1', name: 'Messenger', active: true, sortOrder: 1 }]) },
    cashMovement: {
      findMany: vi.fn(async ({ where, select }: any) => {
        if (select) return [
          { type: 'deposit', direction: 'in', amount: '500.00' },
          { type: 'request_payment', direction: 'out', amount: '100.00' },
        ];
        if (where.OR) return [];
        return [];
      }),
    },
    ceresSettlementLine: { create: mocks.createSettlementLine },
    ceresSettlementRequestLine: {
      findMany: vi.fn(async () => []),
      create: mocks.createRequestLine,
    },
    ceresRequestMoneyEvent: { findMany: vi.fn(async ({ where }: any) => where.lane === 'cash' ? [cutoffEvent] : []) },
    ceresPaymentRequest: {
      findMany: vi.fn(async () => [{ id: 'request-direct', requestedByName: 'Requester' }]),
    },
  };
}

vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    ceresSettlementLine: { findMany: vi.fn(async () => []) },
    ceresSettlementRequestLine: { findMany: vi.fn(async () => []) },
  },
}));

import { p1Routes } from '../src/routes/ceres/p1.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pendingCount.mockResolvedValue(0);
  mocks.updateExpenses.mockResolvedValue({ count: 1 });
  mocks.createSettlementLine.mockResolvedValue({ id: 'line-1' });
  mocks.createRequestLine.mockResolvedValue({ id: 'request-line-1' });
  mocks.transaction.mockImplementation(async (callback) => callback(txClient()));
});

describe('Ceres Phase 3 daily close', () => {
  it('keeps messenger math intact, excludes transfer expenses, and snapshots cash request events', async () => {
    const server = Fastify();
    server.addHook('preHandler', async (req) => {
      req.agent = { id: 'gm-1', email: 'gm@example.test', name: 'GM', role: 'gm', apps: [], authVersion: 0 };
    });
    p1Routes(server);
    const response = await server.inject({ method: 'POST', url: '/api/ceres/close', payload: {} });
    expect(response.statusCode).toBe(200);
    expect(mocks.pendingCount).toHaveBeenCalledWith({
      where: { status: 'pending', fundingLane: { not: 'transfer' } },
    });
    expect(mocks.createSettlementLine).toHaveBeenCalledWith({ data: expect.objectContaining({
      partyId: 'party-1', expenses: '50.00', outstanding: '-50.00',
    }) });
    expect(mocks.updateExpenses).toHaveBeenCalledWith({
      where: { id: { in: ['expense-cash'] } }, data: { settlementId: 'settlement-1', status: 'settled' },
    });
    expect(mocks.createRequestLine).toHaveBeenCalledWith({ data: expect.objectContaining({
      settlementId: 'settlement-1', requestId: 'request-direct', moneyEventId: 'event-cash-direct', amount: '100.00',
    }) });
    expect(response.json().settlement).toMatchObject({ boxBefore: '400.00', boxAfter: '400.00' });
    await server.close();
  });
});
