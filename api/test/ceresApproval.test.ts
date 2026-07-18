import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRequest: vi.fn(), findCategory: vi.fn(), transaction: vi.fn(), updateMany: vi.fn(), txFindRequest: vi.fn(),
  createRevision: vi.fn(), createEvent: vi.fn(), reviewStaffRequest: vi.fn(), findReview: vi.fn(),
  notifyRequester: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: { CERES_CEO_THRESHOLD: 5000, CERES_FLOOR: 3000 } }));
vi.mock('../src/ceres/aiReview.js', () => ({
  AI_MODEL: 'test-model', POLICY_VERSION: 'test-policy', reviewStaffRequest: mocks.reviewStaffRequest,
}));
vi.mock('../src/ceres/notifyCeo.js', () => ({ notifyCeoEscalation: vi.fn() }));
vi.mock('../src/ceres/notifyRequester.js', () => ({
  notifyRequesterForEvent: mocks.notifyRequester,
  notifyRequesterForMoneyEvent: vi.fn(),
}));
vi.mock('../src/ceres/mediaAccess.js', () => ({ mediaCanBeAttachedBy: vi.fn() }));
vi.mock('../src/ceres/receiptStore.js', () => ({ readCeresReceiptMeta: vi.fn() }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    ceresPaymentRequest: { findUnique: mocks.findRequest },
    ceresCategory: { findUnique: mocks.findCategory },
    ceresAIReview: { findUnique: mocks.findReview },
  },
}));

import { CeresRequestError, editStaffRequest, neeApprovalTarget } from '../src/ceres/requestService.js';
import { requestsRoutes } from '../src/routes/ceres/requests.js';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pendingRequest = {
  id: 'request-race', workflowVersion: 2, requestedById: 'staff-1', requestedByName: 'Staff', requesterPartyId: 'party-1',
  requestType: 'advance', entity: 'PROM', category: 'general', amount: '100.00', detail: 'supplies', payee: 'Staff',
  requestPhotoUploadId: null, requestPhotoSha: '', ocrAmount: '', ocrVendor: '', ocrDate: '',
  aiScreenStatus: 'clear', aiReviewId: null, approvalStatus: 'pending_nee', fulfillmentStatus: 'unfulfilled',
  neeDecidedById: null, neeDecidedByName: '', neeDecidedAt: null, neeDecisionNote: '',
  decidedById: null, decidedAt: null, decisionNote: '', rowVersion: 7,
  createdAt: new Date('2026-07-17T00:00:00Z'), updatedAt: new Date('2026-07-17T00:00:00Z'),
};

async function approvalApp() {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.agent = {
      id: 'gm-1', email: 'gm@example.test', name: 'GM', role: 'gm', apps: [], authVersion: 0,
    };
  });
  requestsRoutes(app);
  return app;
}

describe('Ceres v2 approval binding', () => {
  it('blocks every Nee decision while the AI review is pending', async () => {
    vi.clearAllMocks();
    mocks.findRequest.mockResolvedValue({ ...pendingRequest, aiScreenStatus: 'pending' });
    const app = await approvalApp();

    for (const decision of ['approve', 'reject'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ceres/requests/request-race/nee-decision',
        payload: { decision, ...(decision === 'reject' ? { note: 'not yet' } : {}) },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: 'ai_review_pending' });
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('lets a GM approve their own clear request at exactly 5,000 THB', async () => {
    vi.clearAllMocks();
    const ownRequest = { ...pendingRequest, requestedById: 'gm-1', requestedByName: 'GM', amount: '5000.00' };
    mocks.findRequest.mockResolvedValue(ownRequest);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.createEvent.mockResolvedValue({ id: 'event-own' });
    mocks.transaction.mockImplementation(async (callback) => callback({
      ceresPaymentRequest: {
        updateMany: mocks.updateMany,
        findUniqueOrThrow: vi.fn(async () => ({ ...ownRequest, approvalStatus: 'approved', rowVersion: 8 })),
      },
      ceresRequestEvent: { create: mocks.createEvent },
    }));
    const app = await approvalApp();
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests/request-race/nee-decision', payload: { decision: 'approve' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().request.approvalStatus).toBe('approved');
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ approvalStatus: 'approved', neeDecidedById: 'gm-1' }),
    }));
    await app.close();
  });

  it.each([
    ['a clear GM-authored request strictly over 5,000 THB', { amount: '5000.01', aiScreenStatus: 'clear' }],
    ['a GM-authored AI escalation at any amount', { amount: '100.00', aiScreenStatus: 'escalate' }],
  ])('routes %s to the CEO when the GM approves', async (_label, overrides) => {
    vi.clearAllMocks();
    const ownRequest = { ...pendingRequest, requestedById: 'gm-1', requestedByName: 'GM', ...overrides };
    mocks.findRequest.mockResolvedValue(ownRequest);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.createEvent.mockResolvedValue({ id: 'event-escalated' });
    mocks.transaction.mockImplementation(async (callback) => callback({
      ceresPaymentRequest: {
        updateMany: mocks.updateMany,
        findUniqueOrThrow: vi.fn(async () => ({ ...ownRequest, approvalStatus: 'pending_ceo', rowVersion: 8 })),
      },
      ceresRequestEvent: { create: mocks.createEvent },
    }));
    const app = await approvalApp();
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests/request-race/nee-decision', payload: { decision: 'approve' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().request.approvalStatus).toBe('pending_ceo');
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ approvalStatus: 'pending_ceo' }),
    }));
    await app.close();
  });

  it('maps a stale rowVersion double-decision to one success and one conflict', async () => {
    vi.clearAllMocks();
    mocks.findRequest.mockResolvedValue(pendingRequest);
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    mocks.createEvent.mockResolvedValue({ id: 'event-1' });
    mocks.transaction.mockImplementation(async (callback) => callback({
      ceresPaymentRequest: {
        updateMany: mocks.updateMany,
        findUniqueOrThrow: vi.fn(async () => ({ ...pendingRequest, approvalStatus: 'approved', rowVersion: 8 })),
      },
      ceresRequestEvent: { create: mocks.createEvent },
    }));
    const app = await approvalApp();
    const responses = await Promise.all([1, 2].map(() => app.inject({
      method: 'POST', url: '/api/ceres/requests/request-race/nee-decision', payload: { decision: 'approve' },
    })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json()).toEqual({ error: 'conflict' });
    expect(mocks.notifyRequester).toHaveBeenCalledOnce();
    expect(mocks.notifyRequester).toHaveBeenCalledWith('event-1');
    await app.close();
  });

  it('maps a cancel-vs-decide rowVersion race to a conflict', async () => {
    vi.clearAllMocks();
    mocks.findRequest.mockResolvedValue(pendingRequest);
    mocks.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    mocks.createEvent.mockResolvedValue({ id: 'event-1' });
    mocks.transaction.mockImplementation(async (callback) => callback({
      ceresPaymentRequest: {
        updateMany: mocks.updateMany,
        findUniqueOrThrow: vi.fn(async () => ({ ...pendingRequest, approvalStatus: 'cancelled', rowVersion: 8 })),
      },
      ceresRequestEvent: { create: mocks.createEvent },
    }));
    const app = await approvalApp();
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/ceres/requests/request-race/cancel', payload: {} }),
      app.inject({
        method: 'POST', url: '/api/ceres/requests/request-race/nee-decision', payload: { decision: 'approve' },
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json()).toEqual({ error: 'conflict' });
    await app.close();
  });

  it('keeps the exact threshold with Nee only, and sends strictly-over to CEO', () => {
    expect(neeApprovalTarget({ amount: '5000.00', aiScreenStatus: 'clear' })).toBe('approved');
    expect(neeApprovalTarget({ amount: '5000.01', aiScreenStatus: 'clear' })).toBe('pending_ceo');
  });

  it('sends a below-threshold AI escalation to CEO after Nee approval', () => {
    expect(neeApprovalTarget({ amount: '100.00', aiScreenStatus: 'escalate' })).toBe('pending_ceo');
    expect(neeApprovalTarget({ amount: '100.00', aiScreenStatus: 'pending' })).toBe('pending_ceo');
  });

  it('accepts an unchanged now-inactive category, invalidates AI, and appends audit records', async () => {
    const now = new Date('2026-07-17T00:00:00Z');
    const existing = {
      id: 'request-1', workflowVersion: 2, requestedById: 'staff-1', requestedByName: 'Staff', requesterPartyId: 'party-1',
      requestType: 'advance', entity: 'PROM', category: 'general', amount: '100.00', detail: 'before', payee: 'Staff',
      requestPhotoUploadId: null, requestPhotoSha: '', ocrAmount: '', ocrVendor: '', ocrDate: '',
      aiScreenStatus: 'clear', aiReviewId: 'old-review', approvalStatus: 'pending_nee', fulfillmentStatus: 'unfulfilled',
      neeDecidedById: null, neeDecidedByName: '', neeDecidedAt: null, neeDecisionNote: '',
      decidedById: null, decidedAt: null, decisionNote: '', rowVersion: 1, createdAt: now, updatedAt: now,
    };
    const edited = { ...existing, amount: '200.00', detail: 'after', aiScreenStatus: 'pending', aiReviewId: null, rowVersion: 2 };
    const screened = { ...edited, aiScreenStatus: 'clear', aiReviewId: 'review-new', rowVersion: 3 };
    mocks.findRequest.mockReset().mockResolvedValueOnce(existing).mockResolvedValueOnce(screened);
    mocks.findCategory.mockResolvedValue({ name: 'general', active: false });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.txFindRequest.mockResolvedValue(edited);
    mocks.createRevision.mockResolvedValue({ id: 'revision-1' });
    mocks.createEvent.mockResolvedValue({ id: 'event-1' });
    mocks.reviewStaffRequest.mockResolvedValue({ verdict: 'clear', reasoning: 'clear', reviewId: 'review-new' });
    mocks.transaction.mockImplementation(async (callback) => callback({
      ceresPaymentRequest: { updateMany: mocks.updateMany, findUnique: mocks.txFindRequest },
      ceresRevision: { create: mocks.createRevision },
      ceresRequestEvent: { create: mocks.createEvent },
    }));

    await editStaffRequest('request-1', { amount: '200.00', reason: 'after' }, {
      id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'employee', apps: ['ceres'], authVersion: 0,
    });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amount: '200.00', detail: 'after', aiScreenStatus: 'pending', aiReviewId: null }),
    }));
    expect(mocks.createRevision).toHaveBeenCalledOnce();
    expect(mocks.createEvent).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'edited' }) });
    expect(mocks.reviewStaffRequest).toHaveBeenCalledWith('request-1');
    expect(mocks.findCategory).not.toHaveBeenCalled();
  });

  it.each([
    ['inactive', { name: 'Unavailable', active: false }],
    ['unknown', null],
  ])('rejects a changed %s category with invalid_category', async (_label, categoryRow) => {
    vi.clearAllMocks();
    mocks.findRequest.mockResolvedValue({ ...pendingRequest, id: 'request-edit', requestedById: 'staff-1' });
    mocks.findCategory.mockResolvedValue(categoryRow);

    await expect(editStaffRequest('request-edit', { category: 'Unavailable' }, {
      id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'employee', apps: ['ceres'], authVersion: 0,
    })).rejects.toMatchObject<CeresRequestError>({ code: 'invalid_category' });
    expect(mocks.findCategory).toHaveBeenCalledWith({ where: { name: 'Unavailable' } });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('keeps the legacy decision alias workflow-v1 only and adds both human v2 decisions', async () => {
    const source = await readFile(path.join(apiRoot, 'src/routes/ceres/requests.ts'), 'utf8');
    expect(source).toContain("'/api/ceres/requests/:id/decide'");
    expect(source).toContain('existing.workflowVersion !== 1');
    expect(source).toContain("'/api/ceres/requests/:id/nee-decision'");
    expect(source).toContain("'/api/ceres/requests/:id/ceo-decision'");
    expect(source).toContain('const where: Record<string, unknown> = { workflowVersion: 1 }');
  });
});
