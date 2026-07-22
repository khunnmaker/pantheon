import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 4-button request chooser (owner-confirmed design, 2026-07-23): additive nullable
// CeresPaymentRequest.advanceVariant column. เบิกเงินไปซื้อ = requestType 'advance' +
// advanceVariant 'purchase' — rides every advance mechanic (no AI screen, liquidation
// cycle) but carries a single required category + required reason like reimbursement/
// purchase, instead of the float advance's optional-reason/multi-group shape. See
// api/src/ceres/requestService.ts and api/src/routes/ceres/requests.ts.

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
  createRevision: vi.fn(),
  llmAvailable: vi.fn(),
  callClaude: vi.fn(),
  findMedia: vi.fn(),
  readReceiptMeta: vi.fn(),
  findMediaLink: vi.fn(async () => []),
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
    },
    ceresExpense: { findFirst: mocks.findDuplicateExpense },
    ceresCategory: { findUnique: mocks.findCategory, findMany: mocks.findGroups },
    ceresParty: { findFirst: mocks.findParty },
    ceresAIReview: { create: mocks.createReview },
    ceresMedia: { findUnique: mocks.findMedia },
    ceresMediaLink: { findMany: mocks.findMediaLink },
  },
}));

import { createStaffRequest, editStaffRequest, neeApprovalTarget, CeresRequestError } from '../src/ceres/requestService.js';
import { requestsRoutes } from '../src/routes/ceres/requests.js';

const staffAgent = {
  id: 'staff-1', email: 'staff@example.test', name: 'Staff', role: 'staff' as const, apps: ['ceres'], authVersion: 0,
};

// A fully "advance" row shape at rest (workflowVersion 2) — advanceVariant defaults to null
// (plain float advance) unless a test overrides it.
const baseAdvance = {
  id: 'request-1', workflowVersion: 2, requestType: 'advance', advanceVariant: null,
  requestPhotoUploadId: null, requestPhotoSha: '', amount: '100.00', category: '', categoryGroups: '["Operations"]',
  entity: 'PROM', detail: '', requestedByName: 'Staff', requestedById: 'staff-1', requesterPartyId: 'party-staff',
  ocrAmount: '', ocrVendor: '', ocrDate: '', aiScreenStatus: 'clear', aiReviewId: null,
  approvalStatus: 'pending_nee', fulfillmentStatus: 'unfulfilled',
  neeDecidedById: null, neeDecidedByName: '', neeDecidedAt: null, neeDecisionNote: '',
  decidedById: null, decidedAt: null, decisionNote: '', rowVersion: 1,
  createdAt: new Date('2026-07-23T00:00:00Z'), updatedAt: new Date('2026-07-23T00:00:00Z'),
};

function buildApp() {
  const app = Fastify();
  app.addHook('preHandler', async (req) => { req.agent = staffAgent; });
  requestsRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findRequest.mockResolvedValue(baseAdvance);
  mocks.findDuplicateRequest.mockResolvedValue(null);
  mocks.findDuplicateExpense.mockResolvedValue(null);
  // Realistic-enough fake: only these two names resolve to an active category (matches a
  // real DB lookup returning null for an empty/unknown name) — several tests below rely on
  // an inherited-blank category actually failing the active-category check.
  mocks.findCategory.mockImplementation(async ({ where }: { where: { name: string } }) => {
    if (where.name === 'ค่าน้ำมัน') return { name: 'ค่าน้ำมัน', active: true, ceiling: '' };
    if (where.name === 'general') return { name: 'general', active: true, ceiling: '' };
    return null;
  });
  mocks.findGroups.mockResolvedValue([{ group: 'Operations' }, { group: 'Travel' }]);
  mocks.findParty.mockResolvedValue({ id: 'party-staff' });
  mocks.findMedia.mockResolvedValue(null);
  mocks.readReceiptMeta.mockResolvedValue(null);
  mocks.createReview.mockImplementation(async ({ data }) => ({ id: 'review-1', ...data }));
  mocks.createRequest.mockImplementation(async ({ data }) => ({
    ...baseAdvance, ...data, rowVersion: 1, aiReviewId: null, approvalStatus: 'pending_nee',
    fulfillmentStatus: 'unfulfilled', requestedById: data.requestedById,
  }));
  mocks.updateRequests.mockResolvedValue({ count: 1 });
  mocks.createEvent.mockResolvedValue({ id: 'event-1' });
  mocks.createRevision.mockResolvedValue({ id: 'revision-1' });
  mocks.deleteMediaLink.mockResolvedValue({ count: 0 });
  mocks.transaction.mockImplementation(async (callback) => callback({
    ceresPaymentRequest: { create: mocks.createRequest, updateMany: mocks.updateRequests, findUnique: mocks.findRequest },
    ceresRequestEvent: { create: mocks.createEvent },
    ceresRevision: { create: mocks.createRevision },
    ceresMediaLink: { createMany: mocks.createMediaLink, deleteMany: mocks.deleteMediaLink },
  }));
});

describe('Ceres 4-button chooser — เบิกเงินไปซื้อ (advance + advanceVariant "purchase")', () => {
  it('creates a variant-purchase advance with a real category, required reason, no AI screen, and no groups', async () => {
    const request = await createStaffRequest({
      requestType: 'advance', advanceVariant: 'purchase', entity: 'PROM',
      category: 'ค่าน้ำมัน', amount: '1500.00', reason: 'ซื้อน้ำมันเครื่องรถส่งของ',
    }, staffAgent);

    expect(request).toEqual(expect.objectContaining({ approvalStatus: 'pending_nee', aiScreenStatus: 'clear' }));
    expect(mocks.createRequest).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestType: 'advance', advanceVariant: 'purchase',
        category: 'ค่าน้ำมัน', categoryGroups: '', detail: 'ซื้อน้ำมันเครื่องรถส่งของ',
        aiScreenStatus: 'clear',
      }),
    });
    expect(mocks.createEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'submitted', payload: expect.objectContaining({ ai: 'skipped_by_policy', policyReason: 'advance' }),
      }),
    });
    // Same fast lane as a plain float advance — no LLM call, no AI review row.
    expect(mocks.createReview).not.toHaveBeenCalled();
    expect(mocks.callClaude).not.toHaveBeenCalled();
  });

  it('rejects a variant-purchase advance with a blank reason (unlike a float advance, reason is required)', async () => {
    await expect(createStaffRequest({
      requestType: 'advance', advanceVariant: 'purchase', entity: 'PROM',
      category: 'ค่าน้ำมัน', amount: '100.00', reason: '   ',
    }, staffAgent)).rejects.toMatchObject<CeresRequestError>({ code: 'invalid_reason' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects a variant-purchase advance with no category (needs one real category, not groups)', async () => {
    await expect(createStaffRequest({
      requestType: 'advance', advanceVariant: 'purchase', entity: 'PROM',
      amount: '100.00', reason: 'ซื้อของ',
    }, staffAgent)).rejects.toMatchObject<CeresRequestError>({ code: 'invalid_category' });
  });

  it('rejects a variant-purchase advance that still sends groups', async () => {
    await expect(createStaffRequest({
      requestType: 'advance', advanceVariant: 'purchase', entity: 'PROM',
      category: 'ค่าน้ำมัน', categoryGroups: ['Operations'], amount: '100.00', reason: 'ซื้อของ',
    }, staffAgent)).rejects.toMatchObject<CeresRequestError>({ code: 'invalid_group' });
  });

  it('escalates a variant-purchase advance strictly over the ฿5,000 CEO threshold, same as a float advance', () => {
    expect(neeApprovalTarget({ amount: '5000.00', aiScreenStatus: 'clear' })).toBe('approved');
    expect(neeApprovalTarget({ amount: '5000.01', aiScreenStatus: 'clear' })).toBe('pending_ceo');
  });

  it('stores a real category and empty categoryGroups — enables the liquidation defaultCategory prefill (RequestDetail.tsx keys off categoryGroups.length, unaffected by this feature)', async () => {
    await createStaffRequest({
      requestType: 'advance', advanceVariant: 'purchase', entity: 'PROM',
      category: 'ค่าน้ำมัน', amount: '2000.00', reason: 'ซื้อน้ำมัน',
    }, staffAgent);
    const data = mocks.createRequest.mock.calls[0]![0].data;
    expect(data.category).toBe('ค่าน้ำมัน');
    expect(data.categoryGroups).toBe('');
  });

  it('still requires an active category, same validation as reimbursement/purchase', async () => {
    mocks.findCategory.mockResolvedValue({ name: 'Retired', active: false });
    await expect(createStaffRequest({
      requestType: 'advance', advanceVariant: 'purchase', entity: 'PROM',
      category: 'Retired', amount: '100.00', reason: 'ซื้อของ',
    }, staffAgent)).rejects.toMatchObject<CeresRequestError>({ code: 'invalid_category' });
  });
});

describe('Ceres 4-button chooser — v2CreateBody route zod shape', () => {
  it('accepts advanceVariant "purchase" on the advance branch through the real route', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests',
      payload: {
        requestType: 'advance', advanceVariant: 'purchase', entity: 'PROM',
        category: 'ค่าน้ำมัน', amount: '100.00', reason: 'ซื้อน้ำมัน',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().request.advanceVariant).toBe('purchase');
    await app.close();
  });

  it('rejects advanceVariant on the reimbursement/purchase branches (strict schema, unknown key)', async () => {
    const app = buildApp();
    for (const requestType of ['reimbursement', 'purchase'] as const) {
      const response = await app.inject({
        method: 'POST', url: '/api/ceres/requests',
        payload: {
          requestType, advanceVariant: 'purchase', entity: 'PROM',
          category: 'general', amount: '100.00', reason: 'x',
          ...(requestType === 'reimbursement' ? { requestPhotoUploadId: 'photo-1' } : {}),
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid_body' });
    }
    await app.close();
  });

  it('rejects an unknown advanceVariant value', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests',
      payload: {
        requestType: 'advance', advanceVariant: 'not-a-real-variant', entity: 'PROM',
        category: 'ค่าน้ำมัน', amount: '100.00', reason: 'x',
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('Ceres 4-button chooser — reimbursement photo-required gate', () => {
  it('rejects a reimbursement create with no photo (already covered elsewhere; sanity-checked here alongside the conversion cases below)', async () => {
    await expect(createStaffRequest({
      requestType: 'reimbursement', entity: 'PROM', category: 'general', amount: '100.00', reason: 'taxi',
    }, staffAgent)).rejects.toMatchObject<CeresRequestError>({ code: 'receipt_required' });
  });

  it('rejects an edit that converts a float advance into reimbursement with no photo attached', async () => {
    mocks.findRequest.mockResolvedValue({ ...baseAdvance, categoryGroups: '["Operations"]' });
    await expect(editStaffRequest('request-1', {
      requestType: 'reimbursement', category: 'general', reason: 'taxi',
    }, staffAgent)).rejects.toMatchObject<CeresRequestError>({ code: 'receipt_required' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('400s at the route layer when a PATCH would convert into reimbursement with no photo (route-level pre-check)', async () => {
    mocks.findRequest.mockResolvedValue({ ...baseAdvance, categoryGroups: '["Operations"]' });
    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH', url: '/api/ceres/requests/request-1',
      payload: { requestType: 'reimbursement', category: 'general', reason: 'taxi' },
    });
    // The route-level guard only checks category/reason/groups shape (it doesn't know about
    // photos) — this reaches editStaffRequest, whose validateReferences throws the real
    // receipt_required 400 mapped by requestError().
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'receipt_required' });
    await app.close();
  });
});

describe('Ceres 4-button chooser — conversion matrix (editStaffRequest)', () => {
  it('converts reimbursement → เบิกเงินไปซื้อ (advance + variant "purchase"), validating the target requirements', async () => {
    // Real RequestSheet.tsx clears staged photos on any kind change (its own [kind] effect —
    // the old evidence purpose 'reimbursement_receipt' would never satisfy the target's
    // 'request_photo' requirement anyway), so this conversion always arrives with the photo
    // explicitly cleared — same as any other type conversion.
    const existing = {
      ...baseAdvance, requestType: 'reimbursement', advanceVariant: null,
      category: 'general', categoryGroups: '', detail: 'taxi receipt', requestPhotoUploadId: 'receipt-1',
    };
    mocks.findRequest.mockResolvedValue(existing);

    await editStaffRequest('request-1', {
      requestType: 'advance', advanceVariant: 'purchase', category: 'ค่าน้ำมัน', reason: 'ซื้อน้ำมันเครื่อง',
      requestPhotoUploadId: null,
    }, staffAgent);

    expect(mocks.findCategory).toHaveBeenCalledWith({ where: { name: 'ค่าน้ำมัน' } });
    expect(mocks.updateRequests).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        requestType: 'advance', advanceVariant: 'purchase',
        category: 'ค่าน้ำมัน', categoryGroups: '', detail: 'ซื้อน้ำมันเครื่อง',
        // Advance fast lane kicks back in on the target side — no AI re-screen.
        aiScreenStatus: 'clear',
      }),
    }));
  });

  it('converts เบิกเงินไปซื้อ → a plain float advance, requiring >=1 active group and clearing the stored category', async () => {
    const existing = { ...baseAdvance, advanceVariant: 'purchase', category: 'ค่าน้ำมัน', categoryGroups: '' };
    mocks.findRequest.mockResolvedValue(existing);

    await editStaffRequest('request-1', {
      advanceVariant: null, categoryGroups: ['Operations', 'Travel'],
    }, staffAgent);

    expect(mocks.findGroups).toHaveBeenCalled(); // groupsChanged (variant flip) re-validates active groups
    expect(mocks.updateRequests).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        requestType: 'advance', advanceVariant: null,
        category: '', categoryGroups: '["Operations","Travel"]',
      }),
    }));
  });

  it('rejects converting เบิกเงินไปซื้อ → float advance with zero groups', async () => {
    const existing = { ...baseAdvance, advanceVariant: 'purchase', category: 'ค่าน้ำมัน', categoryGroups: '' };
    mocks.findRequest.mockResolvedValue(existing);

    await expect(editStaffRequest('request-1', { advanceVariant: null }, staffAgent))
      .rejects.toMatchObject<CeresRequestError>({ code: 'invalid_group' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('converts a plain float advance → ขอให้บริษัทซื้อ (purchase), dropping the inherited groups and requiring a real category + reason', async () => {
    const existing = { ...baseAdvance, categoryGroups: '["Operations"]' };
    mocks.findRequest.mockResolvedValue(existing);

    await editStaffRequest('request-1', {
      requestType: 'purchase', category: 'general', reason: 'ซื้ออุปกรณ์สำนักงาน',
    }, staffAgent);

    expect(mocks.updateRequests).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        requestType: 'purchase', advanceVariant: null, category: 'general', categoryGroups: '',
      }),
    }));
  });

  it('rejects converting float advance → purchase without a fresh category (inherited "" from the advance side is not enough)', async () => {
    const existing = { ...baseAdvance, categoryGroups: '["Operations"]' };
    mocks.findRequest.mockResolvedValue(existing);

    await expect(editStaffRequest('request-1', { requestType: 'purchase', reason: 'buy stuff' }, staffAgent))
      .rejects.toMatchObject<CeresRequestError>({ code: 'invalid_category' });
  });

  it('route-level guard 400s a PATCH converting float advance → purchase with inherited empty category/groups', async () => {
    mocks.findRequest.mockResolvedValue({ ...baseAdvance, categoryGroups: '["Operations"]' });
    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH', url: '/api/ceres/requests/request-1',
      payload: { requestType: 'purchase' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_body' });
    await app.close();
  });

  it('route-level guard 400s a PATCH flipping float advance → เบิกเงินไปซื้อ with no category/reason sent', async () => {
    mocks.findRequest.mockResolvedValue({ ...baseAdvance, categoryGroups: '["Operations"]' });
    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH', url: '/api/ceres/requests/request-1',
      payload: { advanceVariant: 'purchase' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_body' });
    await app.close();
  });

  it('route-level guard allows a variant flip once category + reason are supplied, and drops the stale groups', async () => {
    mocks.findRequest.mockResolvedValue({ ...baseAdvance, categoryGroups: '["Operations"]' });
    const app = buildApp();
    const response = await app.inject({
      method: 'PATCH', url: '/api/ceres/requests/request-1',
      payload: { advanceVariant: 'purchase', category: 'ค่าน้ำมัน', reason: 'ซื้อน้ำมัน' },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('leaves an untouched variant-purchase advance edit (amount only) with its category/reason/AI-skip intact', async () => {
    const existing = { ...baseAdvance, advanceVariant: 'purchase', category: 'ค่าน้ำมัน', categoryGroups: '', detail: 'ซื้อน้ำมัน' };
    mocks.findRequest.mockResolvedValue(existing);

    await editStaffRequest('request-1', { amount: '2000.00' }, staffAgent);

    // Amount-only edit shouldn't re-hit the category-active check (categoryChanged=false).
    expect(mocks.findCategory).not.toHaveBeenCalled();
    expect(mocks.updateRequests).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        advanceVariant: 'purchase', category: 'ค่าน้ำมัน', categoryGroups: '', amount: '2000.00', aiScreenStatus: 'clear',
      }),
    }));
  });
});
