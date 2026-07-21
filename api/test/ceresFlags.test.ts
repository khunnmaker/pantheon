import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner directive (2026-07-21): "each person should be able to flag any transaction for
// review" — POST /api/ceres/flags (any Ceres persona, own-visibility enforced server-side),
// GET /api/ceres/flags (gm/ceo review queue), POST /api/ceres/flags/:id/resolve (gm/ceo).

const mocks = vi.hoisted(() => ({
  findRequest: vi.fn(),
  findManyRequests: vi.fn(),
  findExpense: vi.fn(),
  findManyExpenses: vi.fn(),
  findParty: vi.fn(),
  findFirstFlag: vi.fn(),
  createFlag: vi.fn(),
  findManyFlags: vi.fn(),
  findUniqueFlag: vi.fn(),
  updateFlag: vi.fn(),
  groupByFlags: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: { CERES_CEO_THRESHOLD: 5000, CERES_FLOOR: 3000 } }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    ceresPaymentRequest: { findUnique: mocks.findRequest, findMany: mocks.findManyRequests },
    ceresExpense: { findUnique: mocks.findExpense, findMany: mocks.findManyExpenses },
    ceresParty: { findFirst: mocks.findParty },
    ceresFlag: {
      findFirst: mocks.findFirstFlag,
      create: mocks.createFlag,
      findMany: mocks.findManyFlags,
      findUnique: mocks.findUniqueFlag,
      update: mocks.updateFlag,
      groupBy: mocks.groupByFlags,
    },
  },
}));

import { flagsRoutes } from '../src/routes/ceres/flags.js';

function agentFor(role: 'staff' | 'gm' | 'supervisor', id = `${role}-1`) {
  return { id, email: `${id}@example.test`, name: id, role, apps: role === 'staff' ? ['ceres'] : [], authVersion: 0 };
}

function buildApp(agent: ReturnType<typeof agentFor>) {
  const app = Fastify();
  app.addHook('preHandler', async (req) => { req.agent = agent; });
  flagsRoutes(app);
  return app;
}

const staffRequest = {
  id: 'request-1', workflowVersion: 2, requestedById: 'staff-1', requestedByName: 'Staff',
  requesterPartyId: 'party-1', entity: 'PROM', payee: 'Staff', category: 'general', categoryGroups: '',
  amount: '100.00', detail: 'test', requestType: 'purchase', approvalStatus: 'pending_nee',
  fulfillmentStatus: 'unfulfilled', requestPhotoUploadId: null, ocrAmount: '', ocrVendor: '', ocrDate: '',
  aiScreenStatus: 'clear', aiReviewId: null, neeDecidedById: null, neeDecidedByName: '', neeDecidedAt: null,
  neeDecisionNote: '', decidedById: null, decidedAt: null, decisionNote: '', voidedById: null, voidedAt: null,
  voidReason: '', rowVersion: 1, createdAt: new Date(), updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findManyRequests.mockResolvedValue([]); // ageStuckAIReviews() no-op / filterVisibleToMessenger default
  mocks.findManyExpenses.mockResolvedValue([]);
  mocks.findFirstFlag.mockResolvedValue(null);
  mocks.createFlag.mockImplementation(async ({ data }) => ({ id: 'flag-1', createdAt: new Date(), resolvedAt: null, resolvedById: null, resolvedByName: '', resolutionNote: '', ...data }));
});

describe('POST /api/ceres/flags — visibility-enforced create', () => {
  it('lets a staff member flag their own request', async () => {
    mocks.findRequest.mockResolvedValue(staffRequest);
    const app = buildApp(agentFor('staff', 'staff-1'));
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/flags',
      payload: { targetType: 'request', targetId: 'request-1', note: 'ยอดดูแปลกๆ' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().flag).toMatchObject({ targetType: 'request', targetId: 'request-1', flaggedById: 'staff-1' });
    await app.close();
  });

  it('refuses to let a different staff member flag someone else\'s request (404, not leaking existence)', async () => {
    mocks.findRequest.mockResolvedValue(staffRequest); // owned by staff-1
    const app = buildApp(agentFor('staff', 'staff-2'));
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/flags',
      payload: { targetType: 'request', targetId: 'request-1', note: 'สงสัย' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
    expect(mocks.createFlag).not.toHaveBeenCalled();
    await app.close();
  });

  it('lets a staff member flag an expense tied to their own party', async () => {
    mocks.findExpense.mockResolvedValue({ id: 'expense-1', partyId: 'party-1' });
    mocks.findParty.mockResolvedValue({ id: 'party-1', agentEmail: 'staff-1@example.test' });
    const app = buildApp(agentFor('staff', 'staff-1'));
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/flags',
      payload: { targetType: 'expense', targetId: 'expense-1', note: 'ยอดผิด' },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('refuses to let a staff member flag another party\'s expense (404)', async () => {
    mocks.findExpense.mockResolvedValue({ id: 'expense-1', partyId: 'party-1' });
    // This caller's own party lookup resolves to a DIFFERENT party than the expense's.
    mocks.findParty.mockResolvedValue({ id: 'party-2', agentEmail: 'other-1@example.test' });
    const app = buildApp(agentFor('staff', 'other-1'));
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/flags',
      payload: { targetType: 'expense', targetId: 'expense-1', note: 'ยอดผิด' },
    });
    expect(response.statusCode).toBe(404);
    expect(mocks.createFlag).not.toHaveBeenCalled();
    await app.close();
  });

  it('gm/ceo can flag any visible request without an owned-party check', async () => {
    mocks.findRequest.mockResolvedValue(staffRequest);
    const app = buildApp(agentFor('gm'));
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/flags',
      payload: { targetType: 'request', targetId: 'request-1', note: 'ตรวจสอบ' },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('rejects re-flagging the same target while an open flag from this person already exists (409)', async () => {
    mocks.findRequest.mockResolvedValue(staffRequest);
    mocks.findFirstFlag.mockResolvedValue({ id: 'flag-existing', status: 'open' });
    const app = buildApp(agentFor('staff', 'staff-1'));
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/flags',
      payload: { targetType: 'request', targetId: 'request-1', note: 'ซ้ำ' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'already_flagged' });
    expect(mocks.createFlag).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a blank note with 400', async () => {
    const app = buildApp(agentFor('staff', 'staff-1'));
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/flags',
      payload: { targetType: 'request', targetId: 'request-1', note: '' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /api/ceres/flags — gm/ceo only', () => {
  it('rejects a staff/messenger caller with 403', async () => {
    const app = buildApp(agentFor('staff', 'staff-1'));
    const response = await app.inject({ method: 'GET', url: '/api/ceres/flags' });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('lets the GM list open flags', async () => {
    mocks.findManyFlags.mockResolvedValue([
      { id: 'flag-1', targetType: 'request', targetId: 'request-1', flaggedById: 'staff-1', flaggedByName: 'Staff', note: 'สงสัย', status: 'open', createdAt: new Date(), resolvedById: null, resolvedByName: '', resolvedAt: null, resolutionNote: '' },
    ]);
    const app = buildApp(agentFor('gm'));
    const response = await app.inject({ method: 'GET', url: '/api/ceres/flags?status=open' });
    expect(response.statusCode).toBe(200);
    expect(response.json().flags).toHaveLength(1);
    await app.close();
  });
});

describe('POST /api/ceres/flags/:id/resolve — gm/ceo', () => {
  it('rejects a staff caller with 403', async () => {
    const app = buildApp(agentFor('staff', 'staff-1'));
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/flags/flag-1/resolve', payload: { resolutionNote: 'ตรวจแล้วถูกต้อง' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('lets the GM resolve an open flag with a note', async () => {
    mocks.findUniqueFlag.mockResolvedValue({ id: 'flag-1', status: 'open' });
    mocks.updateFlag.mockImplementation(async ({ data }) => ({ id: 'flag-1', status: 'resolved', ...data }));
    const app = buildApp(agentFor('gm'));
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/flags/flag-1/resolve', payload: { resolutionNote: 'ตรวจแล้วถูกต้อง' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().flag).toMatchObject({ status: 'resolved', resolutionNote: 'ตรวจแล้วถูกต้อง' });
    await app.close();
  });
});

// IDOR fix (adversarial review, 2026-07-21): GET /flags/counts used to return open-flag
// counts for ANY id the caller passed, with no visibility check — a messenger could probe
// whether some other person's request/expense had an open flag by just guessing/enumerating
// ids. Now a messenger's ids are narrowed server-side to what they can actually see BEFORE
// counting; filtered-out ids simply don't appear (no error, no existence signal).
describe('GET /api/ceres/flags/counts — visibility-filtered for messengers', () => {
  it("a messenger requesting another staff member's request id gets no count back (id filtered out, not an error)", async () => {
    // request-1 is owned by staff-1 (see `staffRequest` above). Requesting caller is
    // staff-2 — filterVisibleToMessenger's ceresPaymentRequest.findMany(where: requestedById:
    // 'staff-2') finds nothing, so the id is dropped before groupBy ever runs.
    mocks.findManyRequests.mockResolvedValue([]);
    const app = buildApp(agentFor('staff', 'staff-2'));
    const response = await app.inject({
      method: 'GET', url: '/api/ceres/flags/counts?targetType=request&targetIds=request-1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().counts).toEqual({});
    expect(mocks.groupByFlags).not.toHaveBeenCalled();
    await app.close();
  });

  it('the request\'s own owner (staff-1) gets the real count for their own request', async () => {
    mocks.findManyRequests.mockResolvedValue([{ id: 'request-1' }]); // staff-1 owns it
    mocks.groupByFlags.mockResolvedValue([{ targetId: 'request-1', _count: { _all: 2 } }]);
    const app = buildApp(agentFor('staff', 'staff-1'));
    const response = await app.inject({
      method: 'GET', url: '/api/ceres/flags/counts?targetType=request&targetIds=request-1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().counts).toEqual({ 'request-1': 2 });
    await app.close();
  });

  it('the GM gets the real count without any ownership filtering', async () => {
    mocks.groupByFlags.mockResolvedValue([{ targetId: 'request-1', _count: { _all: 2 } }]);
    const app = buildApp(agentFor('gm'));
    const response = await app.inject({
      method: 'GET', url: '/api/ceres/flags/counts?targetType=request&targetIds=request-1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().counts).toEqual({ 'request-1': 2 });
    // GM never triggers the messenger ownership lookup at all.
    expect(mocks.findManyRequests).not.toHaveBeenCalled();
    await app.close();
  });

  it("a messenger requesting another party's expense id gets no count back", async () => {
    mocks.findParty.mockResolvedValue({ id: 'party-other', agentEmail: 'staff-2@example.test' });
    mocks.findManyExpenses.mockResolvedValue([]); // expense-1 belongs to a different party
    const app = buildApp(agentFor('staff', 'staff-2'));
    const response = await app.inject({
      method: 'GET', url: '/api/ceres/flags/counts?targetType=expense&targetIds=expense-1',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().counts).toEqual({});
    expect(mocks.groupByFlags).not.toHaveBeenCalled();
    await app.close();
  });
});
