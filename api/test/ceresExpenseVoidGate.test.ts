import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner directive (2026-07-21): expense void tightened from gm/ceo to CEO-ONLY — "I and
// only CEO should have the ability to remove any transaction" (see routes/ceres/p1.ts's
// POST /api/ceres/expenses/:id/void preHandler). GM keeps nothing destructive now.

const mocks = vi.hoisted(() => ({
  findExpense: vi.fn(),
  transaction: vi.fn(),
  updateExpense: vi.fn(),
  createRevision: vi.fn(),
  findMediaLink: vi.fn(async () => []),
}));

vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    ceresExpense: { findUnique: mocks.findExpense },
    ceresMediaLink: { findMany: mocks.findMediaLink },
  },
}));
vi.mock('../src/llm/readReceipt.js', () => ({ readReceiptImage: vi.fn() }));
vi.mock('../src/ceres/aiReview.js', () => ({ reviewExpensePostHoc: vi.fn() }));

import { p1Routes } from '../src/routes/ceres/p1.js';

function expenseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'expense-1', partyId: 'party-1', partyName: 'Staff', enteredById: 'staff-1', enteredByName: 'Staff',
    entity: 'PROM', category: 'Travel', customerNote: '', amount: '100.00', spentAt: new Date(),
    receiptUploadId: null, receiptSha: '', ocrAmount: '', ocrVendor: '', ocrDate: '',
    status: 'approved', approvedById: 'gm-1', approvedAt: new Date(), rejectReason: '',
    voidedById: null, voidedAt: null, voidReason: '', settlementId: null,
    advanceRequestId: null, fundingLane: 'cash', aiVerdict: '', note: '', createdAt: new Date(),
    ...overrides,
  };
}

function buildApp(role: 'staff' | 'gm' | 'supervisor') {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.agent = { id: `${role}-1`, email: `${role}@example.test`, name: role, role, apps: role === 'staff' ? ['ceres'] : [], authVersion: 0 };
  });
  p1Routes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findExpense.mockResolvedValue(expenseRow());
  mocks.updateExpense.mockImplementation(async ({ data }) => expenseRow(data));
  mocks.createRevision.mockResolvedValue({ id: 'revision-1' });
  mocks.transaction.mockImplementation(async (callback) => callback({
    ceresExpense: { update: mocks.updateExpense },
    ceresRevision: { create: mocks.createRevision },
  }));
});

describe('POST /api/ceres/expenses/:id/void — CEO-only gate', () => {
  it('rejects a GM with 403 (was allowed before the 2026-07-21 tightening)', async () => {
    const app = buildApp('gm');
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/expenses/expense-1/void', payload: { reason: 'บันทึกผิด' },
    });
    expect(response.statusCode).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a messenger/staff with 403', async () => {
    const app = buildApp('staff');
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/expenses/expense-1/void', payload: { reason: 'บันทึกผิด' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('allows the CEO to void', async () => {
    const app = buildApp('supervisor');
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/expenses/expense-1/void', payload: { reason: 'บันทึกผิด' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().expense).toMatchObject({ status: 'void', voidReason: 'บันทึกผิด' });
    await app.close();
  });
});
