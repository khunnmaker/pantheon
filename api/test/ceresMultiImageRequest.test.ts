import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Backend leg of Ceres multi-image attachments (2026-07-22): additive
// requestPhotoUploadIds array alongside the existing singular requestPhotoUploadId on
// v2 request create/patch. See ceres/mediaLinks.ts for the shared write/read helpers.

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
  findMediaLink: vi.fn(),
  createMediaLink: vi.fn(),
  deleteMediaLink: vi.fn(),
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
vi.mock('../src/ceres/notifyRequester.js', () => ({
  notifyRequesterForEvent: vi.fn(),
  notifyRequesterForMoneyEvent: vi.fn(),
}));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    ceresPaymentRequest: {
      findUnique: mocks.findRequest,
      findFirst: mocks.findDuplicateRequest,
      findUniqueOrThrow: mocks.findRequest,
    },
    ceresExpense: { findFirst: mocks.findDuplicateExpense },
    ceresCategory: { findUnique: mocks.findCategory, findMany: mocks.findGroups },
    ceresParty: { findFirst: mocks.findParty },
    ceresAIReview: { create: mocks.createReview },
    ceresMedia: { findUnique: mocks.findMedia },
    ceresMediaLink: { findMany: mocks.findMediaLink },
  },
}));

import { createStaffRequest, editStaffRequest } from '../src/ceres/requestService.js';
import { requestsRoutes } from '../src/routes/ceres/requests.js';

const staffAgent = {
  id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff' as const, apps: ['ceres'], authVersion: 0,
};

const baseRequest = {
  id: 'request-1', workflowVersion: 2, requestType: 'reimbursement', requestPhotoUploadId: null,
  requestPhotoSha: '', amount: '499.00', category: 'general', categoryGroups: '', entity: 'PROM', detail: 'taxi',
  requestedByName: 'Staff', requestedById: 'staff-1', ocrAmount: '', ocrVendor: '', ocrDate: '',
  approvalStatus: 'pending_nee', rowVersion: 1,
};

function media(id: string, purpose = 'reimbursement_receipt') {
  return { id, purpose, sha256: `sha-${id}`, uploadedById: staffAgent.id, uploadedByName: staffAgent.name, createdAt: new Date() };
}

function buildApp() {
  const app = Fastify();
  app.addHook('preHandler', async (req) => { req.agent = staffAgent; });
  requestsRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRequest.mockResolvedValue(baseRequest);
  mocks.findDuplicateRequest.mockResolvedValue(null);
  mocks.findDuplicateExpense.mockResolvedValue(null);
  mocks.findCategory.mockResolvedValue({ name: 'general', active: true, ceiling: '' });
  mocks.findGroups.mockResolvedValue([{ group: 'Operations' }]);
  mocks.findParty.mockResolvedValue({ id: 'party-staff' });
  mocks.findMedia.mockImplementation(async ({ where }: { where: { id: string } }) => media(where.id));
  mocks.readReceiptMeta.mockResolvedValue(null);
  mocks.findMediaLink.mockResolvedValue([]);
  mocks.createMediaLink.mockImplementation(async ({ data }: any) => ({ count: data.length }));
  mocks.deleteMediaLink.mockResolvedValue({ count: 0 });
  mocks.createReview.mockImplementation(async ({ data }) => ({ id: 'review-1', ...data }));
  mocks.createRequest.mockImplementation(async ({ data }) => ({
    ...baseRequest, ...data, rowVersion: 1, aiReviewId: null, approvalStatus: 'pending_nee',
    fulfillmentStatus: 'unfulfilled', requestedById: data.requestedById,
  }));
  mocks.updateRequests.mockResolvedValue({ count: 1 });
  mocks.createEvent.mockResolvedValue({ id: 'event-1' });
  mocks.transaction.mockImplementation(async (callback) => callback({
    ceresPaymentRequest: { create: mocks.createRequest, updateMany: mocks.updateRequests, findUnique: mocks.findRequest },
    ceresRequestEvent: { create: mocks.createEvent },
    ceresMediaLink: { createMany: mocks.createMediaLink, deleteMany: mocks.deleteMediaLink },
    ceresRevision: { create: vi.fn() },
  }));
});

describe('Ceres request multi-image attachments', () => {
  it('creates a reimbursement with 3 requestPhotoUploadIds: link rows for all three + singular = element 0', async () => {
    const request = await createStaffRequest({
      requestType: 'reimbursement', entity: 'PROM', category: 'general', amount: '499.00', reason: 'taxi',
      requestPhotoUploadIds: ['photo-1', 'photo-2', 'photo-3'],
    }, staffAgent);

    expect(request.requestPhotoUploadId).toBe('photo-1');
    expect(mocks.createRequest).toHaveBeenCalledWith({
      data: expect.objectContaining({ requestPhotoUploadId: 'photo-1', requestPhotoSha: 'sha-photo-1' }),
    });
    expect(mocks.createMediaLink).toHaveBeenCalledWith({
      data: [
        { targetType: 'request', targetId: 'request-1', mediaId: 'photo-1', purpose: 'request_photo', sortOrder: 0 },
        { targetType: 'request', targetId: 'request-1', mediaId: 'photo-2', purpose: 'request_photo', sortOrder: 1 },
        { targetType: 'request', targetId: 'request-1', mediaId: 'photo-3', purpose: 'request_photo', sortOrder: 2 },
      ],
    });
  });

  it('accepts an old-style singular requestPhotoUploadId and still writes one link row', async () => {
    await createStaffRequest({
      requestType: 'reimbursement', entity: 'PROM', category: 'general', amount: '499.00', reason: 'taxi',
      requestPhotoUploadId: 'photo-1',
    }, staffAgent);

    expect(mocks.createMediaLink).toHaveBeenCalledWith({
      data: [{ targetType: 'request', targetId: 'request-1', mediaId: 'photo-1', purpose: 'request_photo', sortOrder: 0 }],
    });
  });

  it('lets the array win over the singular field when both are sent', async () => {
    const request = await createStaffRequest({
      requestType: 'reimbursement', entity: 'PROM', category: 'general', amount: '499.00', reason: 'taxi',
      requestPhotoUploadId: 'ignored-photo', requestPhotoUploadIds: ['photo-1', 'photo-2'],
    }, staffAgent);

    expect(request.requestPhotoUploadId).toBe('photo-1');
    expect(mocks.findMedia).not.toHaveBeenCalledWith({ where: { id: 'ignored-photo' } });
  });

  it('rejects the array when one element has the wrong purpose', async () => {
    mocks.findMedia.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'wrong-purpose' ? media('wrong-purpose', 'transfer_slip') : media(where.id));

    await expect(createStaffRequest({
      requestType: 'reimbursement', entity: 'PROM', category: 'general', amount: '499.00', reason: 'taxi',
      requestPhotoUploadIds: ['photo-1', 'wrong-purpose'],
    }, staffAgent)).rejects.toMatchObject({ code: 'media_not_owned' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects more than 10 requestPhotoUploadIds at the route with 400 before any write', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests',
      payload: {
        requestType: 'purchase', entity: 'PROM', category: 'general', amount: '100.00', reason: 'supplies',
        requestPhotoUploadIds: Array.from({ length: 11 }, (_, i) => `photo-${i}`),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_body' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('PATCH replaces the full link set when requestPhotoUploadIds is sent', async () => {
    const existing = { ...baseRequest, requestPhotoUploadId: 'old-photo', amount: '499.00' };
    mocks.findRequest.mockResolvedValue(existing);
    let mergedAfterUpdate = existing;
    mocks.updateRequests.mockImplementation(async ({ data }: any) => {
      mergedAfterUpdate = { ...existing, ...data };
      return { count: 1 };
    });
    mocks.transaction.mockImplementation(async (callback) => callback({
      ceresPaymentRequest: {
        updateMany: mocks.updateRequests,
        findUnique: vi.fn(async () => mergedAfterUpdate),
      },
      ceresRequestEvent: { create: mocks.createEvent },
      ceresMediaLink: { createMany: mocks.createMediaLink, deleteMany: mocks.deleteMediaLink },
      ceresRevision: { create: vi.fn() },
    }));

    const request = await editStaffRequest('request-1', {
      requestPhotoUploadIds: ['photo-1', 'photo-2'],
    }, staffAgent);

    expect(request.requestPhotoUploadId).toBe('photo-1');
    expect(mocks.deleteMediaLink).toHaveBeenCalledWith({
      where: { targetType: 'request', targetId: 'request-1', purpose: 'request_photo' },
    });
    expect(mocks.createMediaLink).toHaveBeenCalledWith({
      data: [
        { targetType: 'request', targetId: 'request-1', mediaId: 'photo-1', purpose: 'request_photo', sortOrder: 0 },
        { targetType: 'request', targetId: 'request-1', mediaId: 'photo-2', purpose: 'request_photo', sortOrder: 1 },
      ],
    });
  });

  it('preserves the existing link set when a PATCH does not touch the photo fields', async () => {
    const existing = { ...baseRequest, requestPhotoUploadId: 'old-photo', amount: '499.00' };
    mocks.findRequest.mockResolvedValue(existing);
    mocks.findMediaLink.mockResolvedValue([{ mediaId: 'old-photo-1' }, { mediaId: 'old-photo-2' }]);
    let mergedAfterUpdate = existing;
    mocks.updateRequests.mockImplementation(async ({ data }: any) => {
      mergedAfterUpdate = { ...existing, ...data };
      return { count: 1 };
    });
    mocks.transaction.mockImplementation(async (callback) => callback({
      ceresPaymentRequest: {
        updateMany: mocks.updateRequests,
        findUnique: vi.fn(async () => mergedAfterUpdate),
      },
      ceresRequestEvent: { create: mocks.createEvent },
      ceresMediaLink: { createMany: mocks.createMediaLink, deleteMany: mocks.deleteMediaLink },
      ceresRevision: { create: vi.fn() },
    }));

    await editStaffRequest('request-1', { reason: 'updated reason' }, staffAgent);

    expect(mocks.deleteMediaLink).not.toHaveBeenCalled();
    expect(mocks.createMediaLink).not.toHaveBeenCalled();
  });
});
