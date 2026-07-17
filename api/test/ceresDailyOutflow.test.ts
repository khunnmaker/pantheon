import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ moneyFindMany: vi.fn(), requestFindMany: vi.fn() }));

vi.mock('../src/db/prisma.js', () => ({ prisma: {
  ceresRequestMoneyEvent: { findMany: mocks.moneyFindMany },
  ceresPaymentRequest: { findMany: mocks.requestFindMany },
} }));
vi.mock('../src/env.js', () => ({ env: {} }));
vi.mock('../src/line/send.js', () => ({ sendLineText: vi.fn() }));
vi.mock('../src/routes/ceres/common.js', () => ({
  num: (value: string) => Number(value), computeBoard: vi.fn(), thaiDayKey: vi.fn(), thaiDayRange: vi.fn(), transferReconciliationStats: vi.fn(),
}));
vi.mock('../src/routes/ceres/requests.js', () => ({ computeTemplateDue: vi.fn() }));
vi.mock('../src/ceres/requestService.js', () => ({ ageStuckAIReviews: vi.fn() }));

import { dailyOutflowSummary } from '../src/ceres/nightlyDigest.js';

describe('Ceres CEO daily outflow', () => {
  it('groups active outflow by lane and request type and excludes reversals', async () => {
    mocks.moneyFindMany
      .mockResolvedValueOnce([
        { id: 'e1', requestId: 'r1', lane: 'cash', amount: '100.00' },
        { id: 'e2', requestId: 'r2', lane: 'transfer', amount: '250.00' },
        { id: 'e3', requestId: 'r3', lane: 'cash', amount: '80.00' },
      ])
      .mockResolvedValueOnce([{ reversesEventId: 'e3' }]);
    mocks.requestFindMany.mockResolvedValue([
      { id: 'r1', requestType: 'advance' }, { id: 'r2', requestType: 'purchase' }, { id: 'r3', requestType: 'reimbursement' },
    ]);
    await expect(dailyOutflowSummary({})).resolves.toEqual([
      { lane: 'cash', requestType: 'advance', count: 1, amount: '100.00' },
      { lane: 'transfer', requestType: 'purchase', count: 1, amount: '250.00' },
    ]);
  });
});
