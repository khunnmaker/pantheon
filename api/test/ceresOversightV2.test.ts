import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRequests: vi.fn(),
  countRequests: vi.fn(),
  groupRequests: vi.fn(),
  findReviews: vi.fn(),
  findFlaggedExpenses: vi.fn(),
  countExpenses: vi.fn(),
  findSettlement: vi.fn(),
  findMoneyEvents: vi.fn(),
  ageReviews: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: { CERES_DIGEST_HOUR: 21 } }));
vi.mock('../src/ceres/auth.js', () => ({ requireCeresRole: () => async () => {} }));
vi.mock('../src/ceres/requestService.js', () => ({ ageStuckAIReviews: mocks.ageReviews }));
vi.mock('../src/ceres/notifyRequester.js', () => ({ notifyRequesterForMoneyEvent: vi.fn() }));
vi.mock('../src/ceres/mediaAccess.js', () => ({ mediaCanBeAttachedBy: vi.fn() }));
vi.mock('../src/line/owner.js', () => ({ getProminentOwnerLineUserId: vi.fn() }));
vi.mock('../src/line/send.js', () => ({ sendOwnerLineText: vi.fn() }));
vi.mock('../src/routes/ceres/requests.js', () => ({ computeTemplateDue: vi.fn(async () => []) }));
vi.mock('../src/routes/ceres/common.js', () => ({
  computeBoard: vi.fn(async () => ({
    box: { balance: 1000, floor: 400, belowFloor: false, suggestedTopup: 0 },
    parties: [],
  })),
  num: (value: string | number) => Number(value),
  thaiDayKey: () => '2026-07-20',
  thaiDayRange: () => ({
    gte: new Date('2026-07-19T17:00:00.000Z'),
    lte: new Date('2026-07-20T16:59:59.999Z'),
  }),
  toExpenseRow: (row: unknown) => row,
  toStaffRequestRow: (row: Record<string, unknown>) => ({
    id: row.id,
    workflowVersion: row.workflowVersion,
    approvalStatus: row.approvalStatus,
  }),
  transferReconciliationStats: vi.fn(async () => ({ unmatched: 0, reversalExceptions: 0 })),
}));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    ceresPaymentRequest: {
      findMany: mocks.findRequests,
      count: mocks.countRequests,
      groupBy: mocks.groupRequests,
    },
    ceresAIReview: { findMany: mocks.findReviews },
    ceresExpense: { findMany: mocks.findFlaggedExpenses, count: mocks.countExpenses },
    ceresSettlement: { findUnique: mocks.findSettlement },
    ceresRequestMoneyEvent: { findMany: mocks.findMoneyEvents },
  },
}));

import { buildCeresDigest } from '../src/ceres/nightlyDigest.js';
import { ceoRoutes } from '../src/routes/ceres/ceo.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRequests.mockResolvedValue([]);
  mocks.countRequests.mockResolvedValue(0);
  mocks.groupRequests.mockResolvedValue([]);
  mocks.findReviews.mockResolvedValue([]);
  mocks.findFlaggedExpenses.mockResolvedValue([]);
  mocks.countExpenses.mockResolvedValue(0);
  mocks.findSettlement.mockResolvedValue(null);
  mocks.findMoneyEvents.mockResolvedValue([]);
  mocks.ageReviews.mockResolvedValue(undefined);
});

describe('Ceres v2-only CEO oversight', () => {
  it('returns only the v2 request-count shape and queries only v2 escalations', async () => {
    mocks.findRequests.mockResolvedValueOnce([{
      id: 'request-v2', workflowVersion: 2, approvalStatus: 'pending_ceo', aiReviewId: null,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
    }]);
    mocks.groupRequests.mockResolvedValue([
      { approvalStatus: 'pending_nee', _count: { _all: 2 } },
      { approvalStatus: 'approved', _count: { _all: 1 } },
    ]);

    const app = Fastify();
    ceoRoutes(app);
    const response = await app.inject({ method: 'GET', url: '/api/ceres/ceo/overview?date=2026-07-20' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.escalations).toEqual([{ id: 'request-v2', workflowVersion: 2, approvalStatus: 'pending_ceo' }]);
    expect(body).not.toHaveProperty('requestCounts');
    expect(body.v2RequestCounts).toEqual({ pending_nee: 2, approved: 1 });
    expect(mocks.findRequests).toHaveBeenCalledWith({
      where: { workflowVersion: 2, approvalStatus: 'pending_ceo' },
      orderBy: { createdAt: 'asc' },
    });
    expect(mocks.groupRequests).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('keeps the digest text contract while sourcing CEO-pending totals from v2 only', async () => {
    mocks.findRequests.mockResolvedValue([{ amount: '125.00' }]);
    mocks.countRequests.mockResolvedValue(3);
    mocks.countExpenses.mockImplementation(async ({ where }) => where.aiVerdict === 'flagged' ? 2 : 4);

    const digest = await buildCeresDigest();

    expect(digest).toContain('รออนุมัติจากคุณ: 1 รายการ (฿125.00)');
    expect(digest).toContain('รอนีตรวจคำขอใหม่: 3 รายการ');
    expect(mocks.findRequests).toHaveBeenCalledWith({
      where: { workflowVersion: 2, approvalStatus: 'pending_ceo' },
      select: { amount: true },
    });
  });
});
