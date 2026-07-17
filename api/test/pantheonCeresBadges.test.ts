import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestCount: vi.fn(), expenseCount: vi.fn(), findParty: vi.fn(), age: vi.fn() }));

vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    ceresPaymentRequest: { count: mocks.requestCount },
    ceresExpense: { count: mocks.expenseCount },
    ceresParty: { findFirst: mocks.findParty },
  },
}));
vi.mock('../src/ceres/requestService.js', () => ({ ageStuckAIReviews: mocks.age }));
vi.mock('../src/auth/middleware.js', () => ({ requireAnyAuth: vi.fn() }));
vi.mock('../src/auth/jwt.js', () => ({ hasAppAccess: vi.fn() }));

import { ceresCeoAwaiting, ceresMdAwaiting, ceresMessengerAwaiting } from '../src/routes/pantheon.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.age.mockResolvedValue(0);
});

describe('Pantheon Ceres role badges', () => {
  it('staff counts only own rejected and open advance action-needed requests', async () => {
    mocks.findParty.mockResolvedValue({ id: 'party-1' });
    mocks.expenseCount.mockResolvedValue(2);
    mocks.requestCount.mockResolvedValue(3);
    await expect(ceresMessengerAwaiting('staff-1', 'staff@example.test')).resolves.toBe(5);
    expect(mocks.findParty).toHaveBeenCalledWith({ where: { agentEmail: 'staff@example.test' }, select: { id: true } });
    expect(mocks.expenseCount).toHaveBeenCalledWith({ where: {
      partyId: 'party-1', status: { in: ['pending', 'rejected'] },
    } });
    expect(mocks.requestCount).toHaveBeenCalledWith({ where: {
      workflowVersion: 2,
      requestedById: 'staff-1',
      OR: [
        { approvalStatus: 'rejected' },
        { approvalStatus: 'approved', requestType: 'advance', fulfillmentStatus: { in: ['paid', 'settling'] } },
      ],
    } });
  });

  it('GM counts pending Nee decisions plus final-approved requests awaiting fulfillment', async () => {
    mocks.expenseCount.mockResolvedValue(2);
    mocks.requestCount.mockResolvedValue(5);
    await expect(ceresMdAwaiting()).resolves.toBe(7);
    expect(mocks.expenseCount).toHaveBeenCalledWith({ where: { status: 'pending' } });
    expect(mocks.requestCount).toHaveBeenCalledWith({ where: {
      workflowVersion: 2,
      OR: [
        { approvalStatus: 'pending_nee' },
        { approvalStatus: 'approved', fulfillmentStatus: 'unfulfilled' },
      ],
    } });
  });

  it('CEO counts pending CEO decisions', async () => {
    mocks.requestCount.mockResolvedValue(2);
    await expect(ceresCeoAwaiting()).resolves.toBe(2);
    expect(mocks.requestCount).toHaveBeenCalledWith({ where: { OR: [
      { workflowVersion: 1, status: 'escalated' },
      { workflowVersion: 2, approvalStatus: 'pending_ceo' },
    ] } });
  });
});
