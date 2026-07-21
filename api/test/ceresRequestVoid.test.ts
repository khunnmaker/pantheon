import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Owner directive (2026-07-21): CEO-only void for a v2 payment request in ANY state — see
// api/src/ceres/requestVoid.ts. These tests exercise voidStaffRequest() directly (unit,
// mocked Prisma — same style as ceresCashLedger.test.ts) for every state transition, plus
// the route (ceo-only gate, mandatory reason) via Fastify inject.

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  findRequest: vi.fn(),
  updateRequest: vi.fn(),
  findMoneyEvents: vi.fn(),
  findMoneyEvent: vi.fn(),
  findFirstMoneyEvent: vi.fn(),
  createMoneyEvent: vi.fn(),
  findExpenses: vi.fn(),
  createMovement: vi.fn(),
  createRequestEvent: vi.fn(),
  createRevision: vi.fn(),
}));

// requests.ts (route gating tests below) pulls in requestService.js/aiReview.js/
// notifyCeo.js transitively — same mock set ceresRequests.test.ts uses to import that
// same route file safely.
vi.mock('../src/env.js', () => ({
  env: { CERES_CEO_THRESHOLD: 5000, CERES_FLOOR: 3000 },
}));
vi.mock('../src/llm/anthropic.js', () => ({ llmAvailable: vi.fn(), callClaude: vi.fn() }));
vi.mock('../src/ceres/receiptStore.js', () => ({ readCeresReceiptMeta: vi.fn() }));
vi.mock('../src/ceres/notifyCeo.js', () => ({ notifyCeoEscalation: vi.fn() }));
vi.mock('../src/db/prisma.js', () => ({
  prisma: { $transaction: mocks.transaction },
}));

function tx() {
  return {
    $queryRaw: mocks.queryRaw,
    ceresPaymentRequest: { findUnique: mocks.findRequest, update: mocks.updateRequest },
    ceresRequestMoneyEvent: {
      findMany: mocks.findMoneyEvents,
      findUnique: mocks.findMoneyEvent,
      findFirst: mocks.findFirstMoneyEvent,
      create: mocks.createMoneyEvent,
    },
    ceresExpense: { findMany: mocks.findExpenses },
    cashMovement: { findMany: vi.fn().mockResolvedValue([]), create: mocks.createMovement },
    ceresRequestEvent: { create: mocks.createRequestEvent },
    ceresRevision: { create: mocks.createRevision },
  };
}

import { RequestVoidError, voidStaffRequest } from '../src/ceres/requestVoid.js';
import { requestsRoutes } from '../src/routes/ceres/requests.js';

const agent = { id: 'ceo-1', email: 'ceo@example.test', name: 'CEO', role: 'supervisor' as const, apps: [], authVersion: 0 };

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'request-1',
    workflowVersion: 2,
    requestType: 'purchase',
    approvalStatus: 'pending_nee',
    fulfillmentStatus: 'unfulfilled',
    amount: '500.00',
    requesterPartyId: null,
    requestedByName: 'Staff',
    entity: 'PROM',
    rowVersion: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRaw.mockResolvedValue([{ id: 'request-1' }]);
  mocks.findMoneyEvents.mockResolvedValue([]);
  mocks.findExpenses.mockResolvedValue([]);
  mocks.updateRequest.mockImplementation(async ({ data }) => ({ ...baseRequest(), ...data }));
  mocks.createMoneyEvent.mockImplementation(async ({ data }) => data);
  mocks.createMovement.mockImplementation(async ({ data }) => ({ id: 'movement-2', ...data }));
  mocks.createRequestEvent.mockResolvedValue({ id: 'request-event-1' });
  mocks.createRevision.mockResolvedValue({ id: 'revision-1' });
  mocks.findFirstMoneyEvent.mockResolvedValue(null);
  mocks.transaction.mockImplementation(async (callback) => callback(tx()));
});

describe('voidStaffRequest — state transitions', () => {
  it('voids a not-yet-approved (pending GM) request with no reversal', async () => {
    mocks.findRequest.mockResolvedValue(baseRequest({ approvalStatus: 'pending_nee' }));

    const result = await voidStaffRequest({ requestId: 'request-1', reason: 'พิมพ์ผิด', agent });

    expect(result).toMatchObject({ approvalStatus: 'void', voidedById: 'ceo-1', voidReason: 'พิมพ์ผิด' });
    expect(mocks.createMoneyEvent).not.toHaveBeenCalled();
    expect(mocks.createMovement).not.toHaveBeenCalled();
    expect(mocks.createRevision).toHaveBeenCalledWith({
      data: expect.objectContaining({ subjectType: 'paymentRequest', subjectId: 'request-1' }),
    });
    expect(mocks.createRequestEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'voided', requestId: 'request-1' }),
    });
  });

  it('voids an approved-but-unfulfilled request', async () => {
    mocks.findRequest.mockResolvedValue(baseRequest({ approvalStatus: 'approved', fulfillmentStatus: 'unfulfilled' }));

    const result = await voidStaffRequest({ requestId: 'request-1', reason: 'ไม่ต้องจ่ายแล้ว', agent });

    expect(result.approvalStatus).toBe('void');
    expect(mocks.createMoneyEvent).not.toHaveBeenCalled();
  });

  it('voids a rejected request', async () => {
    mocks.findRequest.mockResolvedValue(baseRequest({ approvalStatus: 'rejected', fulfillmentStatus: 'unfulfilled' }));

    const result = await voidStaffRequest({ requestId: 'request-1', reason: 'บันทึกผิดคน', agent });

    expect(result.approvalStatus).toBe('void');
  });

  it('auto-reverses a paid (cash) purchase then voids it — movements net to zero via exactly one reversal', async () => {
    mocks.findRequest.mockResolvedValue(
      baseRequest({ approvalStatus: 'approved', fulfillmentStatus: 'bought', requestType: 'purchase' }),
    );
    const paymentEvent = {
      id: 'purchase-event-1',
      requestId: 'request-1',
      kind: 'purchase',
      lane: 'cash',
      amount: '500.00',
      cashMovementId: 'movement-1',
      reversesEventId: null,
      createdAt: new Date('2026-07-20T03:00:00.000Z'),
    };
    mocks.findMoneyEvents.mockResolvedValue([paymentEvent]);
    mocks.findMoneyEvent.mockResolvedValue(paymentEvent);

    const result = await voidStaffRequest({ requestId: 'request-1', reason: 'สั่งซื้อผิดรายการ', agent });

    // Exactly ONE compensating movement, crediting the box back (direction 'in') for the
    // exact amount, explicitly linked back to the original outgoing movement it reverses.
    expect(mocks.createMovement).toHaveBeenCalledTimes(1);
    const reversalMovement = mocks.createMovement.mock.calls[0]![0].data;
    expect(reversalMovement).toMatchObject({
      direction: 'in',
      amount: '500.00',
      reversesMovementId: 'movement-1',
      type: 'reversal',
    });
    // A real reversal event was recorded (not a second/invented mechanism) reversing the
    // exact original event.
    expect(mocks.createMoneyEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'reversal', reversesEventId: 'purchase-event-1', amount: '500.00' }),
    });
    // Net cash for this request (original outgoing movement + the one reversal) is exactly
    // zero — the box ends up exactly where it started.
    const originalMovement = { direction: 'out', amount: '500.00' };
    const net = [originalMovement, reversalMovement].reduce(
      (sum, m) => sum + (m.direction === 'in' ? Number(m.amount) : -Number(m.amount)), 0,
    );
    expect(net).toBe(0);
    // Final state: void, fulfillment flipped to reversed by the composed reverse mechanics.
    expect(mocks.updateRequest).toHaveBeenLastCalledWith({
      where: { id: 'request-1' },
      data: expect.objectContaining({ approvalStatus: 'void' }),
    });
    expect(mocks.createRequestEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'voided', payload: expect.objectContaining({ reversedFulfillment: true }) }),
    });
  });

  it('auto-reverses a paid (cash) reimbursement then voids it — movements net to zero via exactly one reversal', async () => {
    mocks.findRequest.mockResolvedValue(
      baseRequest({ approvalStatus: 'approved', fulfillmentStatus: 'paid', requestType: 'reimbursement', amount: '300.00' }),
    );
    const paymentEvent = {
      id: 'payment-event-2',
      requestId: 'request-1',
      kind: 'payment',
      lane: 'cash',
      amount: '300.00',
      cashMovementId: 'movement-5',
      reversesEventId: null,
      createdAt: new Date('2026-07-20T03:00:00.000Z'),
    };
    mocks.findMoneyEvents.mockResolvedValue([paymentEvent]);
    mocks.findMoneyEvent.mockResolvedValue(paymentEvent);

    const result = await voidStaffRequest({ requestId: 'request-1', reason: 'จ่ายผิดคน', agent });

    expect(result.approvalStatus).toBe('void');
    expect(mocks.createMovement).toHaveBeenCalledTimes(1);
    const reversalMovement = mocks.createMovement.mock.calls[0]![0].data;
    expect(reversalMovement).toMatchObject({
      direction: 'in',
      amount: '300.00',
      reversesMovementId: 'movement-5',
      type: 'reversal',
    });
    expect(mocks.createMoneyEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'reversal', reversesEventId: 'payment-event-2', amount: '300.00' }),
    });
    const originalMovement = { direction: 'out', amount: '300.00' };
    const net = [originalMovement, reversalMovement].reduce(
      (sum, m) => sum + (m.direction === 'in' ? Number(m.amount) : -Number(m.amount)), 0,
    );
    expect(net).toBe(0);
    expect(mocks.createRequestEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'voided', payload: expect.objectContaining({ reversedFulfillment: true }) }),
    });
  });

  it('voids an already-reversed request without attempting a second reversal (closes the known gap)', async () => {
    mocks.findRequest.mockResolvedValue(
      baseRequest({ approvalStatus: 'approved', fulfillmentStatus: 'reversed', requestType: 'reimbursement' }),
    );
    const paymentEvent = {
      id: 'payment-event-1', requestId: 'request-1', kind: 'payment', lane: 'cash', amount: '200.00',
      cashMovementId: 'movement-1', reversesEventId: null, createdAt: new Date('2026-07-19T03:00:00.000Z'),
    };
    const reversalEvent = {
      id: 'reversal-event-1', requestId: 'request-1', kind: 'reversal', lane: 'cash', amount: '200.00',
      cashMovementId: 'movement-2', reversesEventId: 'payment-event-1', createdAt: new Date('2026-07-19T04:00:00.000Z'),
    };
    mocks.findMoneyEvents.mockResolvedValue([paymentEvent, reversalEvent]);

    const result = await voidStaffRequest({ requestId: 'request-1', reason: 'ปิดรายการที่ย้อนกลับไปแล้ว', agent });

    expect(result.approvalStatus).toBe('void');
    expect(mocks.createMoneyEvent).not.toHaveBeenCalled();
    expect(mocks.createMovement).not.toHaveBeenCalled();
    expect(mocks.findMoneyEvent).not.toHaveBeenCalled();
  });

  it('refuses to void an advance with live (non-void) liquidation children, listing the blockers', async () => {
    mocks.findRequest.mockResolvedValue(
      baseRequest({ requestType: 'advance', approvalStatus: 'approved', fulfillmentStatus: 'paid', amount: '1000.00' }),
    );
    mocks.findMoneyEvents.mockResolvedValue([
      { id: 'payment-event-1', requestId: 'request-1', kind: 'payment', lane: 'cash', amount: '1000.00', cashMovementId: 'movement-1', reversesEventId: null, createdAt: new Date() },
    ]);
    mocks.findExpenses.mockResolvedValue([{ id: 'expense-1', status: 'approved', amount: '300.00', category: 'Travel', partyName: 'Staff' }]);

    await expect(voidStaffRequest({ requestId: 'request-1', reason: 'ทดสอบ', agent }))
      .rejects.toMatchObject({ code: 'has_liquidation_children', detail: { blockers: [expect.objectContaining({ id: 'expense-1' })] } });
    expect(mocks.updateRequest).not.toHaveBeenCalled();
    expect(mocks.createMoneyEvent).not.toHaveBeenCalled();
    expect(mocks.createRevision).not.toHaveBeenCalled();
  });

  it('refuses to void a paid advance with no children but an unreturned outstanding balance', async () => {
    mocks.findRequest.mockResolvedValue(
      baseRequest({ requestType: 'advance', approvalStatus: 'approved', fulfillmentStatus: 'paid', amount: '1000.00' }),
    );
    mocks.findMoneyEvents.mockResolvedValue([
      { id: 'payment-event-1', requestId: 'request-1', kind: 'payment', lane: 'cash', amount: '1000.00', cashMovementId: 'movement-1', reversesEventId: null, createdAt: new Date() },
    ]);
    mocks.findExpenses.mockResolvedValue([]); // no live children

    await expect(voidStaffRequest({ requestId: 'request-1', reason: 'ทดสอบ', agent }))
      .rejects.toMatchObject({ code: 'has_outstanding_balance', detail: { remainingOutstanding: '1000.00' } });
    expect(mocks.updateRequest).not.toHaveBeenCalled();
  });

  // REGRESSION GUARD (adversarial review, 2026-07-21) — the ONLY way voidStaffRequest
  // reaches this line for an advance is liquidationSatang(...).remaining === 0 with zero
  // live children, which can only be true because refund event(s) already returned the
  // full advance amount to the box. Reversing the original payment ON TOP of that refund
  // would inject a second, phantom inflow (payment −1000, refund +1000 already nets the box
  // to 0; a reversal would add another +1000, overcrediting the box by the full advance).
  // So this case must NOT reverse — voiding is a pure status flip once the refund already
  // closed the cash math. This test fails loudly (extra reversal event/movement, net !== 0)
  // if that regresses.
  it('voids a fully-refunded advance WITHOUT reversing the payment (no double-credit)', async () => {
    mocks.findRequest.mockResolvedValue(
      baseRequest({ requestType: 'advance', approvalStatus: 'approved', fulfillmentStatus: 'settling', amount: '1000.00' }),
    );
    const paymentEvent = { id: 'payment-event-1', requestId: 'request-1', kind: 'payment', lane: 'cash', amount: '1000.00', cashMovementId: 'movement-1', reversesEventId: null, createdAt: new Date('2026-07-19T00:00:00.000Z') };
    const refundEvent = { id: 'refund-event-1', requestId: 'request-1', kind: 'refund', lane: 'cash', amount: '1000.00', cashMovementId: 'movement-9', reversesEventId: null, createdAt: new Date('2026-07-19T01:00:00.000Z') };
    mocks.findMoneyEvents.mockResolvedValue([paymentEvent, refundEvent]);
    mocks.findExpenses.mockResolvedValue([]);

    const result = await voidStaffRequest({ requestId: 'request-1', reason: 'คืนครบแล้ว ปิดคำขอ', agent });

    expect(result.approvalStatus).toBe('void');
    // No reversal event, no compensating movement, and reverseRequestMoneyEventInTx's own
    // event lookup never even ran — the reversal path is skipped entirely for advances.
    expect(mocks.createMoneyEvent).not.toHaveBeenCalled();
    expect(mocks.createMovement).not.toHaveBeenCalled();
    expect(mocks.findMoneyEvent).not.toHaveBeenCalled();

    // Net cash for this request — the payment (out 1000) and the refund that already
    // happened (in 1000), plus anything the void call itself created (nothing) — is
    // exactly zero. A regression that re-adds the reversal would push this to +1000.
    const existingMovements = [
      { direction: 'out', amount: '1000.00' }, // the original payment
      { direction: 'in', amount: '1000.00' },  // the refund that already closed it out
    ];
    const createdMovements = mocks.createMovement.mock.calls.map((c) => c[0].data);
    const net = [...existingMovements, ...createdMovements].reduce(
      (sum, m) => sum + (m.direction === 'in' ? Number(m.amount) : -Number(m.amount)), 0,
    );
    expect(net).toBe(0);

    expect(mocks.createRequestEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'voided', payload: expect.objectContaining({ reversedFulfillment: false }) }),
    });
  });

  it('rejects an already-void request', async () => {
    mocks.findRequest.mockResolvedValue(baseRequest({ approvalStatus: 'void' }));
    await expect(voidStaffRequest({ requestId: 'request-1', reason: 'x', agent }))
      .rejects.toMatchObject<Partial<RequestVoidError>>({ code: 'already_void' });
    expect(mocks.updateRequest).not.toHaveBeenCalled();
  });

  it('rejects an unknown request id', async () => {
    mocks.findRequest.mockResolvedValue(null);
    await expect(voidStaffRequest({ requestId: 'missing', reason: 'x', agent }))
      .rejects.toMatchObject<Partial<RequestVoidError>>({ code: 'not_found' });
  });
});

describe('POST /api/ceres/requests/:id/void — route gating', () => {
  function buildApp(role: 'staff' | 'gm' | 'supervisor') {
    const app = Fastify();
    app.addHook('preHandler', async (req) => {
      req.agent = { id: `${role}-1`, email: `${role}@example.test`, name: role, role, apps: role === 'staff' ? ['ceres'] : [], authVersion: 0 };
    });
    return app;
  }

  it.each(['staff', 'gm'] as const)('rejects %s with 403 (ceo-only)', async (role) => {
    const app = buildApp(role);
    requestsRoutes(app);
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests/request-1/void', payload: { reason: 'test' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('rejects a missing/blank reason with 400 for the CEO', async () => {
    const app = buildApp('supervisor');
    requestsRoutes(app);
    const response = await app.inject({
      method: 'POST', url: '/api/ceres/requests/request-1/void', payload: { reason: '' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_body' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    await app.close();
  });
});
