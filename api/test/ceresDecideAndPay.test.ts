import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner directive (2026-07-22): "อนุมัติ = จ่าย" — the composite decide-and-pay endpoint
// (api/src/ceres/requestDecideAndPay.ts) runs the GM/CEO decision AND the cash/transfer
// payment inside ONE transaction. These tests exercise decideAndPayStaffRequest() directly
// with an in-memory stateful mock of Prisma (same style as ceresFulfillment.test.ts's
// transactionClient — rich enough to prove real box arithmetic and real rollback), plus a
// thin route-wiring pass via Fastify inject (same style as ceresRequestVoid.test.ts).

const state = vi.hoisted(() => ({
  request: {} as Record<string, any>,
  events: [] as Array<Record<string, any>>,
  movements: [] as Array<Record<string, any>>,
  expenses: [] as Array<Record<string, any>>,
  requestEvents: [] as Array<Record<string, any>>,
}));

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  notifyRequesterForEvent: vi.fn(),
  notifyRequesterForMoneyEvent: vi.fn(),
  notifyCeoEscalation: vi.fn(),
}));

vi.mock('../src/env.js', () => ({ env: { CERES_CEO_THRESHOLD: 5000, CERES_FLOOR: 3000 } }));
vi.mock('../src/llm/anthropic.js', () => ({ llmAvailable: vi.fn(() => false), callClaude: vi.fn() }));
vi.mock('../src/ceres/receiptStore.js', () => ({ readCeresReceiptMeta: vi.fn() }));
vi.mock('../src/ceres/notifyCeo.js', () => ({ notifyCeoEscalation: mocks.notifyCeoEscalation }));
vi.mock('../src/ceres/notifyRequester.js', () => ({
  notifyRequesterForEvent: mocks.notifyRequesterForEvent,
  notifyRequesterForMoneyEvent: mocks.notifyRequesterForMoneyEvent,
}));
vi.mock('../src/ceres/mediaAccess.js', () => ({ mediaCanBeAttachedBy: vi.fn(async () => ({ sha256: 'slip-hash' })) }));

function applyRowVersionIncrement(current: number, data: any): number {
  return typeof data?.rowVersion === 'object' ? current + Number(data.rowVersion.increment ?? 0) : current;
}

function matchesKind(event: Record<string, any>, kind: unknown): boolean {
  if (typeof kind === 'string') return event.kind === kind;
  if (kind && typeof kind === 'object' && 'in' in kind) return kind.in.includes(event.kind);
  return true;
}

function transactionClient() {
  return {
    $queryRaw: vi.fn(async () => [{ id: state.request.id ?? 'pettyCash' }]),
    ceresPaymentRequest: {
      findUnique: vi.fn(async ({ where }: any) => (where.id === state.request.id ? { ...state.request } : null)),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        if (where.id !== state.request.id) throw new Error('not_found');
        return { ...state.request };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (where.id !== state.request.id) return { count: 0 };
        if ('approvalStatus' in where && where.approvalStatus !== state.request.approvalStatus) return { count: 0 };
        if ('rowVersion' in where && where.rowVersion !== state.request.rowVersion) return { count: 0 };
        state.request = { ...state.request, ...data, rowVersion: applyRowVersionIncrement(state.request.rowVersion, data) };
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: any) => {
        state.request = { ...state.request, ...data, rowVersion: applyRowVersionIncrement(state.request.rowVersion, data) };
        return { ...state.request };
      }),
    },
    ceresRequestMoneyEvent: {
      findUnique: vi.fn(async ({ where }: any) => state.events.find((event) =>
        where.id ? event.id === where.id : event.idempotencyKey === where.idempotencyKey,
      ) ?? null),
      findFirst: vi.fn(async ({ where }: any) => state.events.find((event) =>
        event.requestId === where.requestId && event.kind === where.kind && event.reversesEventId === where.reversesEventId,
      ) ?? null),
      findMany: vi.fn(async ({ where }: any) => state.events.filter((event) =>
        (!where.requestId || event.requestId === where.requestId) && matchesKind(event, where.kind),
      )),
      create: vi.fn(async ({ data }: any) => {
        const event = { createdAt: new Date('2026-07-22T00:00:00Z'), ...data };
        state.events.push(event);
        return event;
      }),
    },
    cashMovement: {
      findMany: vi.fn(async () => [...state.movements]),
      create: vi.fn(async ({ data }: any) => {
        state.movements.push(data);
        return data;
      }),
    },
    ceresExpense: {
      findMany: vi.fn(async () => [...state.expenses]),
    },
    ceresRequestEvent: {
      create: vi.fn(async ({ data }: any) => {
        state.requestEvents.push(data);
        return data;
      }),
    },
  };
}

vi.mock('../src/db/prisma.js', () => ({
  prisma: {
    $transaction: mocks.transaction,
    ceresPaymentRequest: { findUnique: vi.fn(async () => ({ ...state.request })) },
    ceresAIReview: { findUnique: vi.fn(async () => null) },
  },
}));

import { decideAndPayStaffRequest } from '../src/ceres/requestDecideAndPay.js';
import { cashBalanceFromMovements } from '../src/ceres/requestMoney.js';
import { requestsRoutes } from '../src/routes/ceres/requests.js';

const gmAgent = { id: 'gm-1', email: 'gm@example.test', name: 'GM', role: 'gm' as const, apps: [], authVersion: 0 };
const ceoAgent = { id: 'ceo-1', email: 'ceo@example.test', name: 'CEO', role: 'supervisor' as const, apps: [], authVersion: 0 };

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-1', workflowVersion: 2, requestType: 'reimbursement', category: 'general', categoryGroups: '',
    amount: '300.00', detail: 'taxi', entity: 'PROM', payee: 'Staff', requestedById: 'staff-1', requestedByName: 'Staff',
    requesterPartyId: 'party-1', requestPhotoUploadId: null, requestPhotoSha: '', ocrAmount: '', ocrVendor: '', ocrDate: '',
    aiScreenStatus: 'clear', aiReviewId: null, approvalStatus: 'pending_nee', fulfillmentStatus: 'unfulfilled',
    neeDecidedById: null, neeDecidedByName: '', neeDecidedAt: null, neeDecisionNote: '',
    decidedById: null, decidedAt: null, decisionNote: '', voidedById: null, voidedAt: null, voidReason: '',
    rowVersion: 1, createdAt: new Date('2026-07-22T00:00:00Z'), updatedAt: new Date('2026-07-22T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.request = baseRequest();
  state.events.length = 0;
  state.movements.length = 0;
  state.movements.push({ type: 'deposit', direction: 'in', amount: '1000.00' });
  state.expenses.length = 0;
  state.requestEvents.length = 0;

  // Same "snapshot before, restore on throw" wrapper as ceresFulfillment.test.ts — proves a
  // thrown error really does roll back EVERYTHING the callback touched, matching a real
  // Postgres transaction abort.
  let tail = Promise.resolve();
  mocks.transaction.mockImplementation(async (callback) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const eventLength = state.events.length;
    const movementLength = state.movements.length;
    const timelineLength = state.requestEvents.length;
    const requestBefore = { ...state.request };
    try {
      return await callback(transactionClient());
    } catch (error) {
      state.events.length = eventLength;
      state.movements.length = movementLength;
      state.requestEvents.length = timelineLength;
      state.request = requestBefore;
      throw error;
    } finally {
      release();
    }
  });
});

describe('decideAndPayStaffRequest — GM cash/transfer one-flow', () => {
  it('composite cash approve-and-pay: decision + payment commit atomically with exact box arithmetic', async () => {
    const result = await decideAndPayStaffRequest({ requestId: 'request-1', lane: 'cash', agent: gmAgent });

    expect(result.outcome).toBe('paid');
    if (result.outcome !== 'paid') throw new Error('expected paid');
    expect(result.request).toMatchObject({ approvalStatus: 'approved', fulfillmentStatus: 'paid' });
    expect(result.request.neeDecidedById).toBe('gm-1');

    // Both the decision and the payment left a timeline event, in that order, and the
    // decision event is flagged as coming from the one-flow (additive, not a new kind).
    expect(state.requestEvents.map((e) => e.kind)).toEqual(['nee_approved', 'paid']);
    expect(state.requestEvents[0]).toMatchObject({ payload: { approvalStatus: 'approved', oneFlow: true } });

    // Exact box arithmetic: 1000 (opening) − 300 (this payment) = 700, via the SAME
    // production arithmetic function the board/close screens use.
    expect(state.movements).toHaveLength(2);
    expect(cashBalanceFromMovements(state.movements)).toBe(700);
  });

  it('transfer lane requires a slip before any write commits — decision rolls back with it', async () => {
    await expect(decideAndPayStaffRequest({ requestId: 'request-1', lane: 'transfer', agent: gmAgent }))
      .rejects.toMatchObject({ code: 'invalid_evidence' });

    expect(state.request.approvalStatus).toBe('pending_nee');
    expect(state.request.neeDecidedById).toBeNull();
    expect(state.requestEvents).toHaveLength(0);
    expect(state.movements).toHaveLength(1);
  });

  it('transfer lane succeeds with a slip id and never touches the physical cash box', async () => {
    const result = await decideAndPayStaffRequest({
      requestId: 'request-1', lane: 'transfer', transferSlipUploadId: 'slip-1', agent: gmAgent,
    });

    expect(result.outcome).toBe('paid');
    if (result.outcome !== 'paid') throw new Error('expected paid');
    expect(result.moneyEvent).toMatchObject({ lane: 'transfer', transferSlipUploadId: 'slip-1', cashMovementId: null });
    expect(state.movements).toHaveLength(1); // unchanged — no cash movement for a transfer
  });

  it('insufficient_cash rolls back the DECISION too — request stays pending_nee (key atomicity assertion)', async () => {
    state.movements.length = 0;
    state.movements.push({ type: 'deposit', direction: 'in', amount: '100.00' }); // less than the ฿300 request

    await expect(decideAndPayStaffRequest({ requestId: 'request-1', lane: 'cash', agent: gmAgent }))
      .rejects.toMatchObject({ code: 'insufficient_cash', balance: 100 });

    expect(state.request.approvalStatus).toBe('pending_nee');
    expect(state.request.neeDecidedById).toBeNull();
    expect(state.requestEvents).toHaveLength(0);
    expect(state.events).toHaveLength(0);
    expect(state.movements).toHaveLength(1); // untouched
  });

  it('a strictly-over-threshold GM call escalates: decision commits, NO money moves', async () => {
    state.request = baseRequest({ amount: '6000.00' });

    const result = await decideAndPayStaffRequest({ requestId: 'request-1', lane: 'cash', agent: gmAgent });

    expect(result.outcome).toBe('escalated');
    if (result.outcome !== 'escalated') throw new Error('expected escalated');
    expect(result.request.approvalStatus).toBe('pending_ceo');
    expect(state.events).toHaveLength(0);
    expect(state.movements).toHaveLength(1);
    expect(state.requestEvents).toEqual([
      expect.objectContaining({ kind: 'nee_approved', payload: { approvalStatus: 'pending_ceo', oneFlow: true } }),
    ]);
  });

  it('an AI-flagged (escalate) request also escalates even under the ฿5,000 threshold', async () => {
    state.request = baseRequest({ aiScreenStatus: 'escalate', amount: '100.00' });

    const result = await decideAndPayStaffRequest({ requestId: 'request-1', lane: 'cash', agent: gmAgent });
    expect(result.outcome).toBe('escalated');
  });

  it('refuses a purchase request — the receipt-mandatory two-step stays the only path', async () => {
    state.request = baseRequest({ requestType: 'purchase', category: 'general' });

    await expect(decideAndPayStaffRequest({ requestId: 'request-1', lane: 'cash', agent: gmAgent }))
      .rejects.toMatchObject({ code: 'invalid_request_type' });
    expect(state.requestEvents).toHaveLength(0);
    expect(state.request.approvalStatus).toBe('pending_nee');
  });

  it('blocks the decision while the AI review is still pending', async () => {
    state.request = baseRequest({ aiScreenStatus: 'pending' });
    await expect(decideAndPayStaffRequest({ requestId: 'request-1', lane: 'cash', agent: gmAgent }))
      .rejects.toMatchObject({ code: 'ai_review_pending' });
  });

  it('idempotent replay returns the SAME result without double-paying', async () => {
    const idempotencyKey = 'gm-idem-1';
    const first = await decideAndPayStaffRequest({ requestId: 'request-1', lane: 'cash', idempotencyKey, agent: gmAgent });
    expect(first.outcome).toBe('paid');
    if (first.outcome !== 'paid') throw new Error('expected paid');
    expect(state.movements).toHaveLength(2);
    expect(state.requestEvents.map((e) => e.kind)).toEqual(['nee_approved', 'paid']);

    const second = await decideAndPayStaffRequest({ requestId: 'request-1', lane: 'cash', idempotencyKey, agent: gmAgent });
    expect(second.outcome).toBe('paid');
    if (second.outcome !== 'paid') throw new Error('expected paid');
    expect(second.moneyEvent.id).toBe(first.moneyEvent.id);
    expect(second.decisionEventId).toBeNull(); // short-circuited before any second decision write

    // No second payment, no second decision event — the replay touched nothing new.
    expect(state.movements).toHaveLength(2);
    expect(state.events).toHaveLength(1);
    expect(state.requestEvents).toHaveLength(2);
  });
});

describe('decideAndPayStaffRequest — CEO variant', () => {
  it('CEO approve-and-pay on an already-escalated request', async () => {
    state.movements.length = 0;
    state.movements.push({ type: 'deposit', direction: 'in', amount: '10000.00' });
    state.request = baseRequest({ approvalStatus: 'pending_ceo', amount: '6000.00' });

    const result = await decideAndPayStaffRequest({ requestId: 'request-1', lane: 'cash', agent: ceoAgent });

    expect(result.outcome).toBe('paid');
    if (result.outcome !== 'paid') throw new Error('expected paid');
    expect(result.request).toMatchObject({ approvalStatus: 'approved', fulfillmentStatus: 'paid', decidedById: 'ceo-1' });
    expect(state.requestEvents.map((e) => e.kind)).toEqual(['ceo_approved', 'paid']);
    expect(cashBalanceFromMovements(state.movements)).toBe(10000 - 6000);
  });

  it('rejects a CEO call on a request that is not pending_ceo', async () => {
    await expect(decideAndPayStaffRequest({ requestId: 'request-1', lane: 'cash', agent: ceoAgent }))
      .rejects.toMatchObject({ code: 'not_pending_ceo' });
  });

  it('rejects a GM call on a request that already escalated to pending_ceo', async () => {
    state.request = baseRequest({ approvalStatus: 'pending_ceo' });
    await expect(decideAndPayStaffRequest({ requestId: 'request-1', lane: 'cash', agent: gmAgent }))
      .rejects.toMatchObject({ code: 'not_pending_nee' });
  });
});

describe('POST /api/ceres/requests/:id/decide-and-pay — route wiring', () => {
  function buildApp(role: 'staff' | 'gm' | 'supervisor') {
    const app = Fastify();
    app.addHook('preHandler', async (req) => {
      req.agent = { id: `${role}-1`, email: `${role}@example.test`, name: role, role, apps: role === 'staff' ? ['ceres'] : [], authVersion: 0 };
    });
    requestsRoutes(app);
    return app;
  }

  it('rejects staff with 403 (gm/ceo only)', async () => {
    const app = buildApp('staff');
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests/request-1/decide-and-pay', payload: { decision: 'approve', lane: 'cash' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a non-approve decision with 400 (only approve is a one-flow — reject stays plain)', async () => {
    const app = buildApp('gm');
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests/request-1/decide-and-pay', payload: { decision: 'reject', lane: 'cash' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_body' });
    await app.close();
  });

  it('GM cash approve-and-pay via the real route returns 200 with outcome paid', async () => {
    const app = buildApp('gm');
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests/request-1/decide-and-pay', payload: { decision: 'approve', lane: 'cash' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: 'paid',
      request: { approvalStatus: 'approved', fulfillmentStatus: 'paid' },
    });
    expect(mocks.notifyRequesterForMoneyEvent).toHaveBeenCalled();
    await app.close();
  });

  it('a purchase request is rejected with 400 through the route too', async () => {
    state.request = baseRequest({ requestType: 'purchase', category: 'general' });
    const app = buildApp('gm');
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests/request-1/decide-and-pay', payload: { decision: 'approve', lane: 'cash' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_request_type' });
    await app.close();
  });

  it('insufficient_cash surfaces the balance in the 409 body (คงเหลือ) through the route', async () => {
    state.movements.length = 0;
    state.movements.push({ type: 'deposit', direction: 'in', amount: '50.00' });
    const app = buildApp('gm');
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests/request-1/decide-and-pay', payload: { decision: 'approve', lane: 'cash' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'insufficient_cash', balance: '50.00' });
    await app.close();
  });

  it('escalation notifies the CEO exactly once and reports outcome escalated', async () => {
    state.request = baseRequest({ amount: '6000.00' });
    const app = buildApp('gm');
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests/request-1/decide-and-pay', payload: { decision: 'approve', lane: 'cash' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'escalated', request: { approvalStatus: 'pending_ceo' } });
    expect(mocks.notifyCeoEscalation).toHaveBeenCalledOnce();
    expect(mocks.notifyRequesterForMoneyEvent).not.toHaveBeenCalled();
    await app.close();
  });
});
