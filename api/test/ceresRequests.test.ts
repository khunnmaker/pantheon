import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRequest: vi.fn(),
  findDuplicateRequest: vi.fn(),
  findDuplicateExpense: vi.fn(),
  findCategory: vi.fn(),
  findGroups: vi.fn(),
  createReview: vi.fn(),
  transaction: vi.fn(),
  findParty: vi.fn(),
  createRequest: vi.fn(),
  updateRequests: vi.fn(),
  createEvent: vi.fn(),
  llmAvailable: vi.fn(),
  callClaude: vi.fn(),
  findMedia: vi.fn(),
  readReceiptMeta: vi.fn(),
}));

vi.mock('../src/env.js', () => ({
  env: { CERES_CEO_THRESHOLD: 5000, CERES_FLOOR: 3000 },
}));
vi.mock('../src/llm/anthropic.js', () => ({
  llmAvailable: mocks.llmAvailable,
  callClaude: mocks.callClaude,
}));
vi.mock('../src/ceres/receiptStore.js', () => ({
  readCeresReceiptMeta: mocks.readReceiptMeta,
}));
vi.mock('../src/ceres/notifyCeo.js', () => ({ notifyCeoEscalation: vi.fn() }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    ceresPaymentRequest: {
      findUnique: mocks.findRequest,
      findFirst: mocks.findDuplicateRequest,
    },
    ceresExpense: { findFirst: mocks.findDuplicateExpense },
    ceresCategory: { findUnique: mocks.findCategory, findMany: mocks.findGroups },
    ceresParty: { findFirst: mocks.findParty },
    ceresAIReview: { create: mocks.createReview },
    ceresMedia: { findUnique: mocks.findMedia },
  },
}));

import { reviewStaffRequest } from '../src/ceres/aiReview.js';
import { CeresRequestError, createStaffRequest } from '../src/ceres/requestService.js';
import { requestsRoutes } from '../src/routes/ceres/requests.js';

const baseRequest = {
  id: 'request-1', workflowVersion: 2, requestType: 'purchase', requestPhotoUploadId: null,
  requestPhotoSha: '', amount: '500.00', category: 'general', categoryGroups: '', entity: 'PROM', detail: 'work supplies',
  requestedByName: 'Staff', ocrAmount: '', ocrVendor: '', ocrDate: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRequest.mockResolvedValue(baseRequest);
  mocks.findDuplicateRequest.mockResolvedValue(null);
  mocks.findDuplicateExpense.mockResolvedValue(null);
  mocks.findCategory.mockResolvedValue({ name: 'general', active: true, ceiling: '' });
  mocks.findGroups.mockResolvedValue([{ group: 'Operations' }, { group: 'Travel' }]);
  mocks.findParty.mockResolvedValue({ id: 'party-staff' });
  mocks.findMedia.mockResolvedValue(null);
  mocks.readReceiptMeta.mockResolvedValue(null);
  mocks.createReview.mockImplementation(async ({ data }) => ({ id: 'review-1', ...data }));
  mocks.createRequest.mockImplementation(async ({ data }) => ({
    ...baseRequest, ...data, rowVersion: 1, aiReviewId: null, approvalStatus: 'pending_nee',
    fulfillmentStatus: 'unfulfilled', requestedById: data.requestedById,
  }));
  mocks.updateRequests.mockResolvedValue({ count: 1 });
  mocks.createEvent.mockResolvedValue({ id: 'event-1' });
  mocks.transaction.mockImplementation(async (callback) => callback({
    ceresPaymentRequest: { create: mocks.createRequest, updateMany: mocks.updateRequests },
    ceresRequestEvent: { create: mocks.createEvent },
  }));
});

describe('Ceres v2 request submission and AI pre-screen', () => {
  it('rejects another user\'s upload through the real route and media ownership check', async () => {
    mocks.findMedia.mockResolvedValue({
      id: 'upload-other', purpose: 'reimbursement_receipt', sha256: 'hash',
      uploadedById: 'staff-2', uploadedByName: 'Other Staff', createdAt: new Date(),
    });
    const app = Fastify();
    app.addHook('preHandler', async (req) => {
      req.agent = {
        id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff', apps: ['ceres'], authVersion: 0,
      };
    });
    requestsRoutes(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/ceres/requests',
      payload: {
        requestType: 'reimbursement', entity: 'PROM', category: 'general', amount: '100.00', reason: 'taxi',
        requestPhotoUploadId: 'upload-other',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'media_not_owned' });
    expect(mocks.findMedia).toHaveBeenCalledWith({ where: { id: 'upload-other' } });
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('requires a receipt before a reimbursement can be submitted', async () => {
    await expect(createStaffRequest({
      requestType: 'reimbursement', entity: 'PROM', category: 'general', amount: '100.00', reason: 'taxi',
    }, {
      id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff', apps: ['ceres'], authVersion: 0,
    })).rejects.toMatchObject<CeresRequestError>({ code: 'receipt_required' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('derives requester identity and party server-side despite forged extra fields', async () => {
    await createStaffRequest({
      requestType: 'advance', entity: 'PROM', categoryGroups: ['Operations'], amount: '100.00', reason: 'taxi',
      requestedById: 'forged-user', requestedByName: 'Forged Name', requesterPartyId: 'forged-party',
    } as never, {
      id: 'staff-1', email: 'staff@example.test', name: 'Real Staff', role: 'staff', apps: ['ceres'], authVersion: 0,
    });
    expect(mocks.createRequest).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestedById: 'staff-1', requestedByName: 'Real Staff', requesterPartyId: 'party-staff', payee: 'Real Staff',
      }),
    });
    expect(mocks.createRequest.mock.calls[0]![0].data).not.toEqual(expect.objectContaining({ requestedById: 'forged-user' }));
  });

  it('creates a two-group advance directly in the GM queue with optional blank reason and no AI row', async () => {
    mocks.findParty.mockResolvedValue(null);

    const request = await createStaffRequest({
      requestType: 'advance', entity: 'PROM', categoryGroups: [' Operations ', 'Travel'], amount: '5000.00', reason: '   ',
    }, {
      id: 'gm-1', email: 'gm@example.test', name: 'GM', role: 'gm', apps: [], authVersion: 0,
    });

    expect(request).toEqual(expect.objectContaining({ approvalStatus: 'pending_nee', aiScreenStatus: 'clear' }));
    expect(mocks.createRequest).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestedById: 'gm-1', requestedByName: 'GM', requesterPartyId: null,
        category: '', categoryGroups: '["Operations","Travel"]', detail: '', aiScreenStatus: 'clear',
      }),
    });
    expect(mocks.createEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'submitted', payload: expect.objectContaining({ ai: 'skipped_by_policy' }),
      }),
    });
    expect(mocks.createReview).not.toHaveBeenCalled();
    expect(mocks.updateRequests).not.toHaveBeenCalled();
    expect(mocks.callClaude).not.toHaveBeenCalled();
  });

  it('creates an advance below the AI floor and tags the skip reason "advance", not "below_floor"', async () => {
    const request = await createStaffRequest({
      requestType: 'advance', entity: 'PROM', categoryGroups: ['Operations'], amount: '100.00', reason: '',
    }, {
      id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff', apps: ['ceres'], authVersion: 0,
    });

    expect(request).toEqual(expect.objectContaining({ aiScreenStatus: 'clear' }));
    expect(mocks.createEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'submitted',
        payload: expect.objectContaining({ ai: 'skipped_by_policy', policyReason: 'advance' }),
      }),
    });
    expect(mocks.createReview).not.toHaveBeenCalled();
    expect(mocks.updateRequests).not.toHaveBeenCalled();
    expect(mocks.callClaude).not.toHaveBeenCalled();
  });

  it('skips the AI screen for a ฿499 reimbursement below the ฿500 floor, regardless of type', async () => {
    mocks.findMedia.mockResolvedValue({
      id: 'receipt-1', purpose: 'reimbursement_receipt', sha256: 'receipt-hash',
      uploadedById: 'staff-1', uploadedByName: 'Staff', createdAt: new Date(),
    });

    const request = await createStaffRequest({
      requestType: 'reimbursement', entity: 'PROM', category: 'general', amount: '499.00', reason: 'taxi',
      requestPhotoUploadId: 'receipt-1',
    }, {
      id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff', apps: ['ceres'], authVersion: 0,
    });

    expect(request).toEqual(expect.objectContaining({ approvalStatus: 'pending_nee', aiScreenStatus: 'clear' }));
    expect(mocks.createRequest).toHaveBeenCalledWith({
      data: expect.objectContaining({ requestType: 'reimbursement', amount: '499.00', aiScreenStatus: 'clear' }),
    });
    expect(mocks.createEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'submitted',
        payload: expect.objectContaining({ ai: 'skipped_by_policy', policyReason: 'below_floor' }),
      }),
    });
    // Never touches ai_review_pending: no AI review row, no verdict-apply update, no LLM call.
    expect(mocks.createReview).not.toHaveBeenCalled();
    expect(mocks.updateRequests).not.toHaveBeenCalled();
    expect(mocks.callClaude).not.toHaveBeenCalled();
  });

  it('still screens a ฿500.00 reimbursement (floor is strictly-less-than, not inclusive)', async () => {
    mocks.findMedia.mockResolvedValue({
      id: 'receipt-1', purpose: 'reimbursement_receipt', sha256: 'receipt-hash',
      uploadedById: 'staff-1', uploadedByName: 'Staff', createdAt: new Date(),
    });
    mocks.llmAvailable.mockReturnValue(false);

    await createStaffRequest({
      requestType: 'reimbursement', entity: 'PROM', category: 'general', amount: '500.00', reason: 'taxi',
      requestPhotoUploadId: 'receipt-1',
    }, {
      id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff', apps: ['ceres'], authVersion: 0,
    });

    // Enters the normal pre-screen path at creation time, same as any other reimbursement
    // with no LLM key configured: pending → fail-closed escalate via applyAIResult.
    expect(mocks.createRequest).toHaveBeenCalledWith({
      data: expect.objectContaining({ requestType: 'reimbursement', amount: '500.00', aiScreenStatus: 'pending' }),
    });
    expect(mocks.createReview).toHaveBeenCalled();
    expect(mocks.updateRequests).toHaveBeenCalled();
  });

  it('accepts a newly added active category name', async () => {
    mocks.findCategory.mockResolvedValue({
      name: 'ค่าอาหารและเครื่องดื่ม', active: true, ceiling: '',
    });
    mocks.llmAvailable.mockReturnValue(false);

    await createStaffRequest({
      requestType: 'purchase', entity: 'PROM', category: 'ค่าอาหารและเครื่องดื่ม',
      amount: '500.00', reason: 'อาหารประชุมทีม',
    }, {
      id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff', apps: ['ceres'], authVersion: 0,
    });

    expect(mocks.createRequest).toHaveBeenCalledWith({
      data: expect.objectContaining({ category: 'ค่าอาหารและเครื่องดื่ม' }),
    });
  });

  it.each([
    ['an inactive category', { name: 'Inactive', active: false }],
    ['an unknown category', null],
  ])('rejects %s with invalid_category', async (_label, categoryRow) => {
    mocks.findCategory.mockResolvedValue(categoryRow);
    await expect(createStaffRequest({
      requestType: 'purchase', entity: 'PROM', category: 'Unavailable', amount: '100.00', reason: 'test',
    }, {
      id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff', apps: ['ceres'], authVersion: 0,
    })).rejects.toMatchObject<CeresRequestError>({ code: 'invalid_category' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', [{ group: 'Operations' }]],
    ['inactive-only', [{ group: 'Travel' }]],
  ])('rejects an %s advance group with invalid_group', async (_label, activeGroups) => {
    mocks.findGroups.mockResolvedValue(activeGroups);
    await expect(createStaffRequest({
      requestType: 'advance', entity: 'PROM', categoryGroups: ['Unavailable'], amount: '100.00', reason: '',
    }, {
      id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff', apps: ['ceres'], authVersion: 0,
    })).rejects.toMatchObject<CeresRequestError>({ code: 'invalid_group' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('keeps purchase reason required at the v2 route', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (req) => {
      req.agent = {
        id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff', apps: ['ceres'], authVersion: 0,
      };
    });
    requestsRoutes(app);
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests',
      payload: { requestType: 'purchase', entity: 'PROM', category: 'general', amount: '100.00', reason: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_body' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('still sends a reimbursement into AI review pending before applying the verdict', async () => {
    mocks.findMedia.mockResolvedValue({
      id: 'receipt-1', purpose: 'reimbursement_receipt', sha256: 'receipt-hash',
      uploadedById: 'staff-1', uploadedByName: 'Staff', createdAt: new Date(),
    });
    mocks.llmAvailable.mockReturnValue(false);
    await createStaffRequest({
      // Amount is deliberately above the ฿500 AI-skip floor so this still exercises the
      // normal pre-screen path (see the floor-specific tests above for the <฿500 behavior).
      requestType: 'reimbursement', entity: 'PROM', category: 'general', amount: '600.00', reason: 'taxi',
      requestPhotoUploadId: 'receipt-1',
    }, {
      id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff', apps: ['ceres'], authVersion: 0,
    });
    expect(mocks.createRequest).toHaveBeenCalledWith({
      data: expect.objectContaining({ requestType: 'reimbursement', aiScreenStatus: 'pending' }),
    });
    expect(mocks.createReview).toHaveBeenCalled();
    expect(mocks.updateRequests).toHaveBeenCalled();
  });

  it('guards reviewStaffRequest against advance AI review calls', async () => {
    mocks.findRequest.mockResolvedValue({ ...baseRequest, requestType: 'advance', categoryGroups: '["Operations"]' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(reviewStaffRequest('request-1')).resolves.toEqual({
      verdict: 'clear', reasoning: 'skipped_by_policy', reviewId: null,
    });
    expect(warn).toHaveBeenCalled();
    expect(mocks.createReview).not.toHaveBeenCalled();
    expect(mocks.callClaude).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('turns an AI outage into escalation and never approval', async () => {
    mocks.llmAvailable.mockReturnValue(false);
    await expect(reviewStaffRequest('request-1')).resolves.toMatchObject({ verdict: 'escalate' });
    expect(mocks.createReview).toHaveBeenCalledWith({
      data: expect.objectContaining({ subjectId: 'request-1', verdict: 'escalate' }),
    });
  });

  it('treats approve or malformed model output as escalation', async () => {
    mocks.llmAvailable.mockReturnValue(true);
    mocks.callClaude.mockResolvedValue('{"verdict":"approve","reasoning":"looks fine"}');
    await expect(reviewStaffRequest('request-1')).resolves.toMatchObject({ verdict: 'escalate' });
    expect(mocks.createReview).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ verdict: 'escalate' }),
    });
  });

  it('escalates duplicate evidence without asking the model', async () => {
    mocks.findRequest.mockResolvedValue({ ...baseRequest, requestPhotoUploadId: 'photo-1', requestPhotoSha: 'same-sha' });
    mocks.findDuplicateRequest.mockResolvedValue({ id: 'request-older' });
    await expect(reviewStaffRequest('request-1')).resolves.toMatchObject({ verdict: 'escalate' });
    expect(mocks.callClaude).not.toHaveBeenCalled();
  });

  it('uses clear—not approve—for a clean model result', async () => {
    mocks.llmAvailable.mockReturnValue(true);
    mocks.callClaude.mockResolvedValue('{"verdict":"clear","reasoning":"ผ่านการตรวจเบื้องต้น"}');
    await expect(reviewStaffRequest('request-1')).resolves.toMatchObject({ verdict: 'clear' });
    expect(mocks.createReview).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ verdict: 'clear' }),
    });
  });
});
