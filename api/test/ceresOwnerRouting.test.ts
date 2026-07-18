import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendOwnerLineText: vi.fn(),
  paymentFindMany: vi.fn(),
  paymentCount: vi.fn(),
  expenseCount: vi.fn(),
  settlementFindUnique: vi.fn(),
  reviewFindMany: vi.fn(),
  moneyFindMany: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: { CERES_DIGEST_HOUR: 21 } }));
vi.mock('../src/line/owner.js', () => ({ getProminentOwnerLineUserId: () => 'U-owner-prominent' }));
vi.mock('../src/line/send.js', () => ({ sendOwnerLineText: mocks.sendOwnerLineText }));
vi.mock('../src/db/prisma.js', () => ({ prisma: {
  ceresPaymentRequest: { findMany: mocks.paymentFindMany, count: mocks.paymentCount },
  ceresExpense: { count: mocks.expenseCount },
  ceresSettlement: { findUnique: mocks.settlementFindUnique },
  ceresAIReview: { findMany: mocks.reviewFindMany },
  ceresRequestMoneyEvent: { findMany: mocks.moneyFindMany },
} }));
vi.mock('../src/routes/ceres/common.js', () => ({
  computeBoard: vi.fn(async () => ({ box: { belowFloor: false, balance: 50000, suggestedTopup: 0 } })),
  num: (value: string) => Number(value),
  thaiDayKey: () => '2026-07-18',
  thaiDayRange: () => ({}),
  transferReconciliationStats: vi.fn(async () => ({ unmatched: 0, reversalExceptions: 0 })),
}));
vi.mock('../src/routes/ceres/requests.js', () => ({ computeTemplateDue: vi.fn(async () => []) }));
vi.mock('../src/ceres/requestService.js', () => ({ ageStuckAIReviews: vi.fn(async () => undefined) }));

import { fireDigest } from '../src/ceres/nightlyDigest.js';
import { notifyCeoEscalation } from '../src/ceres/notifyCeo.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.paymentFindMany.mockResolvedValue([]);
  mocks.paymentCount.mockResolvedValue(0);
  mocks.expenseCount.mockResolvedValue(0);
  mocks.settlementFindUnique.mockResolvedValue(null);
  mocks.reviewFindMany.mockResolvedValue([]);
  mocks.moneyFindMany.mockResolvedValue([]);
  mocks.sendOwnerLineText.mockResolvedValue({ sent: true, dryRun: false });
});

describe('Ceres owner routing', () => {
  it('fires the nightly digest through the appdent owner sender', async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    await fireDigest(log);
    expect(mocks.sendOwnerLineText).toHaveBeenCalledWith('U-owner-prominent', expect.stringContaining('Ceres'));
    expect(log.info).toHaveBeenCalledWith(
      { event: 'owner_digest_sent', kind: 'ceres_nightly' },
      expect.any(String),
    );
  });

  it('routes immediate CEO escalations through the appdent owner sender', async () => {
    await notifyCeoEscalation(
      { payee: 'Vendor', amount: '5000.00', entity: 'PROM', requestedByName: 'Requester' },
      'Needs approval',
    );
    expect(mocks.sendOwnerLineText).toHaveBeenCalledWith(
      'U-owner-prominent',
      expect.stringContaining('Needs approval'),
    );
  });
});
