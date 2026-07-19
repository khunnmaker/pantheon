import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(), findUnique: vi.fn(), transaction: vi.fn(), createReview: vi.fn(), updateMany: vi.fn(), createEvent: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: { CERES_CEO_THRESHOLD: 5000, CERES_FLOOR: 3000 } }));
vi.mock('../src/ceres/aiReview.js', () => ({
  AI_MODEL: 'test-model', POLICY_VERSION: 'test-policy', reviewStaffRequest: vi.fn(),
}));
vi.mock('../src/ceres/notifyCeo.js', () => ({ notifyCeoEscalation: vi.fn() }));
vi.mock('../src/ceres/mediaAccess.js', () => ({ mediaCanBeAttachedBy: vi.fn() }));
vi.mock('../src/ceres/receiptStore.js', () => ({ readCeresReceiptMeta: vi.fn() }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    ceresPaymentRequest: { findMany: mocks.findMany, findUnique: mocks.findUnique },
  },
}));

import { ageStuckAIReviews, getStaffRequest } from '../src/ceres/requestService.js';
import { requestsRoutes } from '../src/routes/ceres/requests.js';

const employee = (id: string) => ({
  id, email: `${id}@example.test`, name: id, role: 'employee' as const, apps: ['ceres'], authVersion: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]); // no stuck AI rows to age
  mocks.findUnique.mockResolvedValue({ id: 'request-1', workflowVersion: 2, requestedById: 'staff-1' });
  mocks.createReview.mockResolvedValue({ id: 'review-timeout', reasoning: 'timeout' });
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.createEvent.mockResolvedValue({ id: 'event-timeout' });
  mocks.transaction.mockImplementation(async (callback) => callback({
    ceresAIReview: { create: mocks.createReview },
    ceresPaymentRequest: { updateMany: mocks.updateMany },
    ceresRequestEvent: { create: mocks.createEvent },
  }));
});

describe('Ceres v2 request access', () => {
  it('rejects employee and Central Office callers at both human-decision routes', async () => {
    for (const role of ['employee', 'central'] as const) {
      const app = Fastify();
      app.addHook('preHandler', async (req) => {
        req.agent = { ...employee(`${role}-1`), role };
      });
      requestsRoutes(app);
      for (const suffix of ['nee-decision', 'ceo-decision']) {
        const response = await app.inject({
          method: 'POST', url: `/api/ceres/requests/request-1/${suffix}`, payload: { decision: 'approve' },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: 'forbidden' });
      }
      await app.close();
    }
  });

  it('lets an employee read their own request', async () => {
    await expect(getStaffRequest('request-1', employee('staff-1'))).resolves.toMatchObject({ id: 'request-1' });
  });

  it('hides another employee request as not found', async () => {
    await expect(getStaffRequest('request-1', employee('staff-2'))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets management read a staff request', async () => {
    const gm = { ...employee('gm-1'), role: 'gm' as const, apps: [] };
    await expect(getStaffRequest('request-1', gm)).resolves.toMatchObject({ id: 'request-1' });
  });

  it('ages a stuck pending AI screen into explicit escalation on read', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'request-stuck', rowVersion: 3 }]);
    await expect(ageStuckAIReviews(new Date('2026-07-17T12:00:00Z'))).resolves.toBe(1);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'request-stuck', rowVersion: 3, aiScreenStatus: 'pending' },
      data: { aiScreenStatus: 'escalate', aiReviewId: 'review-timeout', rowVersion: { increment: 1 } },
    });
  });
});
