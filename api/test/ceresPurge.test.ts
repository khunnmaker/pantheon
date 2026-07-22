import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ceres alpha hard-purge (owner directive, 2026-07-22): CEO-only, env-gated HARD delete of
// a request/expense/cash-movement and its whole dependent graph — see api/src/ceres/purge.ts.
// Style: an in-memory fake Prisma tx (arrays/maps backing every model touched) so the graph
// deletion + box-balance-restoration claims are asserted against REAL state, not just call
// counts — plus Fastify-inject route-gating tests, same combined style as
// ceresRequestVoid.test.ts (unit + route in one file, only db/prisma + env mocked).

const envState = vi.hoisted(() => ({
  env: {
    JWT_SECRET: 'unit-test-placeholder',
    CERES_CEO_THRESHOLD: 5000,
    CERES_FLOOR: 3000,
    CERES_ALPHA_PURGE: '1',
  },
}));

vi.mock('../src/env.js', () => ({ get env() { return envState.env; } }));
vi.mock('../src/llm/anthropic.js', () => ({ llmAvailable: vi.fn(), callClaude: vi.fn() }));
vi.mock('../src/llm/readReceipt.js', () => ({ readReceiptImage: vi.fn() }));
vi.mock('../src/ceres/receiptStore.js', () => ({ readCeresReceiptMeta: vi.fn(), saveCeresReceipt: vi.fn(), saveCeresReceiptOcr: vi.fn() }));
vi.mock('../src/ceres/aiReview.js', () => ({ reviewExpensePostHoc: vi.fn(), reviewStaffRequest: vi.fn() }));
vi.mock('../src/ceres/notifyCeo.js', () => ({ notifyCeoEscalation: vi.fn() }));

// ─── In-memory fake Prisma store/tx ────────────────────────────────────────────────────
type Row = Record<string, unknown>;

function makeStore() {
  return {
    ceresPaymentRequest: new Map<string, Row>(),
    ceresExpense: new Map<string, Row>(),
    ceresRequestEvent: [] as Row[],
    ceresRequestMoneyEvent: [] as Row[],
    cashMovement: [] as Row[],
    ceresMediaLink: [] as Row[],
    ceresRevision: [] as Row[],
    ceresAIReview: [] as Row[],
    ceresFlag: [] as Row[],
  };
}
type Store = ReturnType<typeof makeStore>;

function matchWhere(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const op = v as Record<string, unknown>;
      if ('in' in op) return (op.in as unknown[]).includes(row[k]);
      if ('notIn' in op) return !(op.notIn as unknown[]).includes(row[k]);
      if ('not' in op) return row[k] !== op.not;
    }
    return row[k] === v;
  });
}

function arrayModel(store: Store, key: keyof Store) {
  return {
    findMany: async ({ where }: { where?: Row } = {}) => (store[key] as Row[]).filter((r) => matchWhere(r, where)),
    deleteMany: async ({ where }: { where?: Row } = {}) => {
      const list = store[key] as Row[];
      const before = list.length;
      const kept = list.filter((r) => !matchWhere(r, where));
      list.length = 0;
      list.push(...kept);
      return { count: before - list.length };
    },
    create: async ({ data }: { data: Row }) => {
      (store[key] as Row[]).push(data);
      return data;
    },
  };
}

function makeTx(store: Store) {
  return {
    $queryRaw: vi.fn(async () => [{ id: 'locked' }]),
    ceresPaymentRequest: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => store.ceresPaymentRequest.get(id) ?? null,
      update: async ({ where: { id }, data }: { where: { id: string }; data: Row }) => {
        const next = { ...(store.ceresPaymentRequest.get(id) ?? {}), ...data };
        store.ceresPaymentRequest.set(id, next);
        return next;
      },
      delete: async ({ where: { id } }: { where: { id: string } }) => {
        const row = store.ceresPaymentRequest.get(id);
        store.ceresPaymentRequest.delete(id);
        return row;
      },
    },
    ceresExpense: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => store.ceresExpense.get(id) ?? null,
      findMany: async ({ where }: { where?: Row } = {}) => [...store.ceresExpense.values()].filter((r) => matchWhere(r, where)),
      delete: async ({ where: { id } }: { where: { id: string } }) => {
        const row = store.ceresExpense.get(id);
        store.ceresExpense.delete(id);
        return row;
      },
    },
    ceresRequestEvent: arrayModel(store, 'ceresRequestEvent'),
    ceresRequestMoneyEvent: arrayModel(store, 'ceresRequestMoneyEvent'),
    ceresMediaLink: arrayModel(store, 'ceresMediaLink'),
    ceresRevision: arrayModel(store, 'ceresRevision'),
    ceresAIReview: arrayModel(store, 'ceresAIReview'),
    ceresFlag: arrayModel(store, 'ceresFlag'),
    cashMovement: {
      ...arrayModel(store, 'cashMovement'),
      findUnique: async ({ where: { id } }: { where: { id: string } }) => store.cashMovement.find((r) => r.id === id) ?? null,
      delete: async ({ where: { id } }: { where: { id: string } }) => {
        const idx = store.cashMovement.findIndex((r) => r.id === id);
        const [row] = store.cashMovement.splice(idx, 1);
        return row;
      },
    },
  };
}

let store: Store;
vi.mock('../src/db/prisma.js', () => ({
  prisma: { $transaction: (cb: (tx: unknown) => unknown) => cb(makeTx(store)) },
}));

import { cashBalanceFromMovements } from '../src/ceres/requestMoney.js';
import {
  CERES_PURGE_CONFIRM_PHRASE,
  CeresPurgeError,
  purgeCashMovement,
  purgeExpense,
  purgeStaffRequest,
} from '../src/ceres/purge.js';
import { p1Routes } from '../src/routes/ceres/p1.js';
import { requestsRoutes } from '../src/routes/ceres/requests.js';

const ceo = { id: 'ceo-1', email: 'ceo@example.test', name: 'CEO', role: 'supervisor' as const, apps: [], authVersion: 0 };

function seedRequestWithCashPayment(id: string, overrides: Row = {}) {
  store.ceresPaymentRequest.set(id, {
    id,
    workflowVersion: 2,
    requestType: 'reimbursement',
    approvalStatus: 'approved',
    fulfillmentStatus: 'paid',
    amount: '300.00',
    requesterPartyId: null,
    requestedByName: 'Staff',
    entity: 'PROM',
    rowVersion: 1,
    ...overrides,
  });
  store.ceresRequestMoneyEvent.push({
    id: `${id}-event-1`, requestId: id, kind: 'payment', lane: 'cash', amount: '300.00',
    cashMovementId: `${id}-movement-1`, reversesEventId: null, createdAt: new Date(),
  });
  store.cashMovement.push({
    id: `${id}-movement-1`, accountId: 'pettyCash', type: 'request_payment', direction: 'out',
    amount: '300.00', requestId: id, requestMoneyEventId: `${id}-event-1`, createdAt: new Date(),
  });
  store.ceresRequestEvent.push({ id: `${id}-revent-1`, requestId: id, kind: 'submitted', createdAt: new Date() });
  store.ceresMediaLink.push({ id: `${id}-link-1`, targetType: 'request', targetId: id, mediaId: 'media-1', purpose: 'request_photo' });
  store.ceresMediaLink.push({ id: `${id}-link-2`, targetType: 'money_event', targetId: `${id}-event-1`, mediaId: 'media-2', purpose: 'transfer_slip' });
  store.ceresRevision.push({ id: `${id}-rev-1`, subjectType: 'paymentRequest', subjectId: id });
  store.ceresAIReview.push({ id: `${id}-air-1`, subjectType: 'paymentRequest', subjectId: id });
  store.ceresFlag.push({ id: `${id}-flag-1`, targetType: 'request', targetId: id, status: 'open' });
}

// Mirrors requestMoney.ts's recordRequestMoneyEventInTx / reverseRequestMoneyEventInTx
// stamping: an advance paid out, PARTIALLY refunded, and that refund then reversed — every
// movement carries requestId + requestMoneyEventId, and the reversal movement additionally
// carries reversesMovementId pointing at the movement it reverses (exactly as
// recordRequestMoneyEventInTx writes `reversesMovementId: reversed.cashMovementId` and
// `type: 'reversal'`, direction flipped from the event it reverses — reversing a refund
// pushes cash back OUT). This is the exact path the "full graph + box balance" test above
// never exercised (adversarial review, 2026-07-22): a request whose money events include a
// refund AND a reversal, not just a single bare payment.
function seedAdvanceWithRefundAndReversal(id: string) {
  store.ceresPaymentRequest.set(id, {
    id, workflowVersion: 2, requestType: 'advance', approvalStatus: 'approved',
    fulfillmentStatus: 'settling', amount: '1000.00', requesterPartyId: null,
    requestedByName: 'Staff', entity: 'PROM', rowVersion: 1,
  });
  store.ceresRequestMoneyEvent.push(
    { id: `${id}-event-pay`, requestId: id, kind: 'payment', lane: 'cash', amount: '1000.00', cashMovementId: `${id}-movement-pay`, reversesEventId: null, createdAt: new Date() },
    { id: `${id}-event-refund`, requestId: id, kind: 'refund', lane: 'cash', amount: '300.00', cashMovementId: `${id}-movement-refund`, reversesEventId: null, createdAt: new Date() },
    { id: `${id}-event-reversal`, requestId: id, kind: 'reversal', lane: 'cash', amount: '300.00', cashMovementId: `${id}-movement-reversal`, reversesEventId: `${id}-event-refund`, createdAt: new Date() },
  );
  store.cashMovement.push(
    { id: `${id}-movement-pay`, accountId: 'pettyCash', type: 'advance', direction: 'out', amount: '1000.00', requestId: id, requestMoneyEventId: `${id}-event-pay`, reversesMovementId: null, createdAt: new Date() },
    { id: `${id}-movement-refund`, accountId: 'pettyCash', type: 'request_refund', direction: 'in', amount: '300.00', requestId: id, requestMoneyEventId: `${id}-event-refund`, reversesMovementId: null, createdAt: new Date() },
    // Reversing a refund pushes cash back OUT (see requestMoney.ts: `direction = reversed.kind === 'refund' ? 'out' : 'in'`).
    { id: `${id}-movement-reversal`, accountId: 'pettyCash', type: 'reversal', direction: 'out', amount: '300.00', requestId: id, requestMoneyEventId: `${id}-event-reversal`, reversesMovementId: `${id}-movement-refund`, createdAt: new Date() },
  );
  store.ceresRequestEvent.push({ id: `${id}-revent-1`, requestId: id, kind: 'paid', createdAt: new Date() });
}

function seedExpense(id: string, overrides: Row = {}) {
  store.ceresExpense.set(id, {
    id, partyId: 'party-1', partyName: 'Staff', amount: '100.00', status: 'approved',
    advanceRequestId: null, category: 'Travel', createdAt: new Date(), ...overrides,
  });
  store.ceresMediaLink.push({ id: `${id}-link`, targetType: 'expense', targetId: id, mediaId: 'media-x', purpose: 'receipt' });
  store.ceresRevision.push({ id: `${id}-rev`, subjectType: 'expense', subjectId: id });
  store.ceresAIReview.push({ id: `${id}-air`, subjectType: 'expense', subjectId: id });
  store.ceresFlag.push({ id: `${id}-flag`, targetType: 'expense', targetId: id, status: 'open' });
}

beforeEach(() => {
  vi.clearAllMocks();
  store = makeStore();
  envState.env.CERES_ALPHA_PURGE = '1';
  // A baseline deposit unrelated to anything being purged — proves the box balance settles
  // back to exactly this after the purge, not to zero and not to some other value.
  store.cashMovement.push({ id: 'baseline-deposit', accountId: 'pettyCash', type: 'deposit', direction: 'in', amount: '1000.00', createdAt: new Date() });
});

describe('purgeStaffRequest — full graph + box balance', () => {
  it('removes every dependent row and restores the box balance to its pre-entry value', async () => {
    seedRequestWithCashPayment('request-1');
    const balanceBefore = cashBalanceFromMovements(store.cashMovement as never);
    expect(balanceBefore).toBe(700); // 1000 baseline - 300 outgoing payment

    const result = await purgeStaffRequest('request-1', ceo);

    expect(result).toEqual({ requestId: 'request-1', purgedChildExpenseIds: [] });
    expect(store.ceresPaymentRequest.has('request-1')).toBe(false);
    expect(store.ceresRequestMoneyEvent).toHaveLength(0);
    expect(store.ceresRequestEvent).toHaveLength(0);
    expect(store.ceresMediaLink).toHaveLength(0);
    expect(store.ceresRevision).toHaveLength(0);
    expect(store.ceresAIReview).toHaveLength(0);
    expect(store.ceresFlag).toHaveLength(0);
    // Only the unrelated baseline deposit remains — the request's outgoing payment movement
    // (and any reversal it might have had) is gone.
    expect(store.cashMovement).toEqual([expect.objectContaining({ id: 'baseline-deposit' })]);
    expect(cashBalanceFromMovements(store.cashMovement as never)).toBe(1000);
  });

  it('purges an advance with liquidation children — cascades the full graph of each child in the same transaction', async () => {
    seedRequestWithCashPayment('adv-1', { requestType: 'advance', amount: '1000.00' });
    seedExpense('child-1', { advanceRequestId: 'adv-1', status: 'approved' });
    seedExpense('child-2', { advanceRequestId: 'adv-1', status: 'settled' });
    seedExpense('unrelated-3', { advanceRequestId: null, status: 'approved' });
    const balanceBefore = cashBalanceFromMovements(store.cashMovement as never);
    expect(balanceBefore).toBe(700); // 1000 baseline - 300 outgoing payment (children carry no cash of their own)

    const result = await purgeStaffRequest('adv-1', ceo);

    expect(result.purgedChildExpenseIds.sort()).toEqual(['child-1', 'child-2']);
    expect(store.ceresExpense.has('child-1')).toBe(false);
    expect(store.ceresExpense.has('child-2')).toBe(false);
    expect(store.ceresExpense.has('unrelated-3')).toBe(true); // untouched — not this advance's child
    expect(store.ceresPaymentRequest.has('adv-1')).toBe(false);
    // Each child's own dependents (media link / revision / AI review / flag) went with it.
    expect(store.ceresMediaLink.some((r) => r.targetId === 'child-1' || r.targetId === 'child-2')).toBe(false);
    expect(store.ceresRevision.some((r) => r.subjectId === 'child-1' || r.subjectId === 'child-2')).toBe(false);
    // Box balance restored to its exact pre-request value (baseline only) — the cascade
    // deletes the advance's own payment movement too, not just the children's rows.
    expect(cashBalanceFromMovements(store.cashMovement as never)).toBe(1000);
  });

  it('purges an advance with a refund AND a reversal of that refund — every movement the request produced is swept, box balance restored exactly', async () => {
    seedAdvanceWithRefundAndReversal('adv-refund-1');
    // 1000 baseline + (-1000 payment) + (+300 refund) + (-300 reversal-of-refund) = 0.
    const balanceBefore = cashBalanceFromMovements(store.cashMovement as never);
    expect(balanceBefore).toBe(0);

    await purgeStaffRequest('adv-refund-1', ceo);

    // (a) zero CashMovement rows remain for this requestId.
    expect(store.cashMovement.filter((r) => r.requestId === 'adv-refund-1')).toHaveLength(0);
    expect(store.cashMovement).toEqual([expect.objectContaining({ id: 'baseline-deposit' })]);
    // (b) the box balance over whatever remains equals the EXACT pre-request value — the
    // request's payment, its refund, AND the reversal of that refund are all gone, not just
    // the single payment (the case seedRequestWithCashPayment alone could never exercise).
    expect(cashBalanceFromMovements(store.cashMovement as never)).toBe(1000);
    expect(store.ceresRequestMoneyEvent).toHaveLength(0);
    expect(store.ceresPaymentRequest.has('adv-refund-1')).toBe(false);
  });

  it.each(['void', 'rejected'] as const)('purges a request in approvalStatus %s (any-state, alpha stance)', async (approvalStatus) => {
    seedRequestWithCashPayment('request-any', { approvalStatus, fulfillmentStatus: 'settled' });
    await expect(purgeStaffRequest('request-any', ceo)).resolves.toMatchObject({ requestId: 'request-any' });
    expect(store.ceresPaymentRequest.has('request-any')).toBe(false);
  });

  it('rejects an unknown request id with not_found', async () => {
    await expect(purgeStaffRequest('missing', ceo)).rejects.toMatchObject<Partial<CeresPurgeError>>({ code: 'not_found' });
  });

  it('refuses to run when CERES_ALPHA_PURGE is disabled', async () => {
    envState.env.CERES_ALPHA_PURGE = '0';
    seedRequestWithCashPayment('request-2');
    await expect(purgeStaffRequest('request-2', ceo)).rejects.toMatchObject<Partial<CeresPurgeError>>({ code: 'purge_disabled' });
    expect(store.ceresPaymentRequest.has('request-2')).toBe(true); // untouched
  });
});

describe('purgeExpense', () => {
  it('removes a standalone expense and its dependents', async () => {
    seedExpense('expense-1');
    await purgeExpense('expense-1', ceo);
    expect(store.ceresExpense.has('expense-1')).toBe(false);
    expect(store.ceresMediaLink).toHaveLength(0);
    expect(store.ceresRevision).toHaveLength(0);
    expect(store.ceresAIReview).toHaveLength(0);
    expect(store.ceresFlag).toHaveLength(0);
  });

  it('purges a settled expense (any-state) and re-syncs its still-live parent advance', async () => {
    seedRequestWithCashPayment('adv-2', { requestType: 'advance', amount: '500.00', fulfillmentStatus: 'settling' });
    seedExpense('liq-1', { advanceRequestId: 'adv-2', status: 'settled', amount: '500.00' });
    await purgeExpense('liq-1', ceo);
    expect(store.ceresExpense.has('liq-1')).toBe(false);
    // The purged expense was the ONLY liquidation against this advance — with zero
    // expenses/refunds left, syncAdvanceLiquidationProjection re-derives the advance back
    // to plain 'paid' (fully outstanding again) rather than leaving the stale 'settling'
    // status the deleted expense had produced.
    expect(store.ceresPaymentRequest.get('adv-2')).toMatchObject({ fulfillmentStatus: 'paid' });
  });

  it('rejects an unknown expense id with not_found', async () => {
    await expect(purgeExpense('missing', ceo)).rejects.toMatchObject<Partial<CeresPurgeError>>({ code: 'not_found' });
  });
});

describe('purgeCashMovement', () => {
  it('hard-deletes a bare deposit movement', async () => {
    store.cashMovement.push({ id: 'deposit-1', accountId: 'pettyCash', type: 'deposit', direction: 'in', amount: '200.00', requestId: null, requestMoneyEventId: null });
    await purgeCashMovement('deposit-1', ceo);
    expect(store.cashMovement.find((r) => r.id === 'deposit-1')).toBeUndefined();
  });

  it('refuses a movement created by a request money event (never orphans half a graph)', async () => {
    seedRequestWithCashPayment('request-3');
    await expect(purgeCashMovement('request-3-movement-1', ceo)).rejects.toMatchObject<Partial<CeresPurgeError>>({ code: 'purge_via_request' });
    // Untouched — still there, telling the caller to purge the request instead.
    expect(store.cashMovement.find((r) => r.id === 'request-3-movement-1')).toBeDefined();
  });

  it('rejects an unknown movement id with not_found', async () => {
    await expect(purgeCashMovement('missing', ceo)).rejects.toMatchObject<Partial<CeresPurgeError>>({ code: 'not_found' });
  });
});

// ─── Route gating (Fastify inject) ─────────────────────────────────────────────────────
function buildApp(role: 'staff' | 'gm' | 'supervisor', register: (app: ReturnType<typeof Fastify>) => void) {
  const app = Fastify();
  app.addHook('preHandler', async (req) => {
    req.agent = { id: `${role}-1`, email: `${role}@example.test`, name: role, role, apps: role === 'staff' ? ['ceres'] : [], authVersion: 0 };
  });
  register(app);
  return app;
}

describe('POST /api/ceres/requests/:id/purge — route gating', () => {
  it.each(['staff', 'gm'] as const)('rejects %s with 403 (ceo-only)', async (role) => {
    const app = buildApp(role, requestsRoutes);
    const response = await app.inject({ method: 'POST', url: '/api/ceres/requests/request-1/purge', payload: { confirm: CERES_PURGE_CONFIRM_PHRASE } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('rejects the wrong confirm string with 400', async () => {
    seedRequestWithCashPayment('request-4');
    const app = buildApp('supervisor', requestsRoutes);
    const response = await app.inject({ method: 'POST', url: '/api/ceres/requests/request-4/purge', payload: { confirm: 'ผิด' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'confirm_mismatch' });
    expect(store.ceresPaymentRequest.has('request-4')).toBe(true);
    await app.close();
  });

  it('403s purge_disabled when CERES_ALPHA_PURGE is off, even for the CEO', async () => {
    envState.env.CERES_ALPHA_PURGE = '0';
    seedRequestWithCashPayment('request-5');
    const app = buildApp('supervisor', requestsRoutes);
    const response = await app.inject({ method: 'POST', url: '/api/ceres/requests/request-5/purge', payload: { confirm: CERES_PURGE_CONFIRM_PHRASE } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'purge_disabled' });
    await app.close();
  });

  it('allows the CEO with the exact confirm phrase', async () => {
    seedRequestWithCashPayment('request-6');
    const app = buildApp('supervisor', requestsRoutes);
    const response = await app.inject({ method: 'POST', url: '/api/ceres/requests/request-6/purge', payload: { confirm: CERES_PURGE_CONFIRM_PHRASE } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, requestId: 'request-6' });
    await app.close();
  });
});

describe('POST /api/ceres/expenses/:id/purge — route gating', () => {
  it.each(['staff', 'gm'] as const)('rejects %s with 403 (ceo-only)', async (role) => {
    seedExpense('expense-2');
    const app = buildApp(role, p1Routes);
    const response = await app.inject({ method: 'POST', url: '/api/ceres/expenses/expense-2/purge', payload: { confirm: CERES_PURGE_CONFIRM_PHRASE } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('allows the CEO with the exact confirm phrase', async () => {
    seedExpense('expense-3');
    const app = buildApp('supervisor', p1Routes);
    const response = await app.inject({ method: 'POST', url: '/api/ceres/expenses/expense-3/purge', payload: { confirm: CERES_PURGE_CONFIRM_PHRASE } });
    expect(response.statusCode).toBe(200);
    expect(store.ceresExpense.has('expense-3')).toBe(false);
    await app.close();
  });
});

describe('POST /api/ceres/cash/:id/purge — route gating', () => {
  it('returns 409 purge_via_request for a request-linked movement', async () => {
    seedRequestWithCashPayment('request-7');
    const app = buildApp('supervisor', p1Routes);
    const response = await app.inject({ method: 'POST', url: '/api/ceres/cash/request-7-movement-1/purge', payload: { confirm: CERES_PURGE_CONFIRM_PHRASE } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'purge_via_request' });
    await app.close();
  });

  it('allows the CEO to purge a bare deposit', async () => {
    store.cashMovement.push({ id: 'deposit-9', accountId: 'pettyCash', type: 'deposit', direction: 'in', amount: '50.00', requestId: null, requestMoneyEventId: null });
    const app = buildApp('supervisor', p1Routes);
    const response = await app.inject({ method: 'POST', url: '/api/ceres/cash/deposit-9/purge', payload: { confirm: CERES_PURGE_CONFIRM_PHRASE } });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
