import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  request: {} as Record<string, unknown>,
  events: [] as Array<Record<string, any>>,
  movements: [] as Array<Record<string, any>>,
  expenses: [] as Array<Record<string, any>>,
  requestEvents: [] as Array<Record<string, any>>,
  failMovement: false,
}));

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));

function matchesKind(event: Record<string, any>, kind: unknown): boolean {
  if (typeof kind === 'string') return event.kind === kind;
  if (kind && typeof kind === 'object' && 'in' in kind) return kind.in.includes(event.kind);
  return true;
}

function transactionClient() {
  return {
    $queryRaw: vi.fn(async () => [{ id: state.request.id }]),
    ceresPaymentRequest: {
      findUnique: vi.fn(async () => ({ ...state.request })),
      update: vi.fn(async ({ data }: any) => {
        state.request = {
          ...state.request,
          ...data,
          rowVersion: typeof data.rowVersion === 'object'
            ? Number(state.request.rowVersion ?? 0) + Number(data.rowVersion.increment ?? 0)
            : state.request.rowVersion,
        };
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
        const event = { createdAt: new Date('2026-07-17T00:00:00Z'), ...data };
        state.events.push(event);
        return event;
      }),
    },
    cashMovement: {
      findMany: vi.fn(async () => [
        { type: 'deposit', direction: 'in', amount: '1000.00' },
        ...state.movements,
      ]),
      create: vi.fn(async ({ data }: any) => {
        if (state.failMovement) throw new Error('db_write_failed');
        state.movements.push(data);
        return data;
      }),
    },
    ceresExpense: {
      findMany: vi.fn(async ({ where }: any) => state.expenses.filter((expense) =>
        expense.advanceRequestId === where.advanceRequestId && ['approved', 'settled'].includes(expense.status),
      )),
      findUnique: vi.fn(async ({ where }: any) => state.expenses.find((expense) => expense.id === where.id) ?? null),
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
    ceresRequestMoneyEvent: {
      findUnique: vi.fn(async ({ where }: any) => state.events.find((event) => event.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: any) => state.events.filter((event) => event.requestId === where.requestId)),
    },
    ceresExpense: {
      findMany: vi.fn(async ({ where }: any) => state.expenses.filter((expense) =>
        expense.advanceRequestId === where.advanceRequestId && ['approved', 'settled'].includes(expense.status),
      )),
    },
  },
}));

import {
  fulfillRequest,
  getAdvanceLiquidation,
  recordRequestMoneyEvent,
  refundAdvance,
  reverseRequestMoneyEvent,
} from '../src/ceres/requestMoney.js';

beforeEach(() => {
  vi.clearAllMocks();
  state.request = {
    id: 'request-1', workflowVersion: 2, requestType: 'advance', approvalStatus: 'approved',
    fulfillmentStatus: 'unfulfilled', amount: '100.00', requesterPartyId: 'party-1',
    requestedByName: 'Staff', entity: 'PROM', rowVersion: 1,
  };
  state.events.length = 0;
  state.movements.length = 0;
  state.expenses.length = 0;
  state.requestEvents.length = 0;
  state.failMovement = false;
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

describe('Ceres Phase 3 fulfillment', () => {
  it('serializes a concurrent double tap into exactly one event and movement', async () => {
    const results = await Promise.allSettled([
      fulfillRequest({ requestId: 'request-1', lane: 'cash' }),
      fulfillRequest({ requestId: 'request-1', lane: 'cash' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(state.events.filter((event) => event.kind === 'payment')).toHaveLength(1);
    expect(state.movements).toHaveLength(1);
    expect(state.movements[0]).toMatchObject({ type: 'advance', direction: 'out', partyId: 'party-1' });
  });

  it('requires transfer evidence and a purchase receipt before any write', async () => {
    await expect(fulfillRequest({ requestId: 'request-1', lane: 'transfer' }))
      .rejects.toMatchObject({ code: 'invalid_evidence' });
    state.request.requestType = 'purchase';
    await expect(fulfillRequest({ requestId: 'request-1', lane: 'cash' }))
      .rejects.toMatchObject({ code: 'invalid_evidence' });
    expect(state.events).toHaveLength(0);
    expect(state.movements).toHaveLength(0);
  });

  it('keeps transfer fulfillment out of the physical cash ledger', async () => {
    await fulfillRequest({ requestId: 'request-1', lane: 'transfer', transferSlipUploadId: 'slip-1' });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ lane: 'transfer', transferSlipUploadId: 'slip-1', cashMovementId: null });
    expect(state.movements).toHaveLength(0);
  });

  it('rolls back the event projection when the paired cash write fails', async () => {
    state.failMovement = true;
    await expect(fulfillRequest({ requestId: 'request-1', lane: 'cash' })).rejects.toThrow('db_write_failed');
    expect(state.events).toHaveLength(0);
    expect(state.movements).toHaveLength(0);
    expect(state.request.fulfillmentStatus).toBe('unfulfilled');
  });

  it('liquidates an advance with approved expenses and returns, then appends settled', async () => {
    await recordRequestMoneyEvent({ requestId: 'request-1', kind: 'payment', lane: 'cash', amount: '100.00' });
    state.expenses.push({ id: 'expense-1', advanceRequestId: 'request-1', status: 'approved', amount: '60.00' });
    await refundAdvance({ requestId: 'request-1', lane: 'cash', amount: '40.00' });
    const liquidation = await getAdvanceLiquidation('request-1');
    expect(liquidation.totals).toEqual({
      approvedExpenses: '60.00', returned: '40.00', remainingOutstanding: '0.00', settled: true,
    });
    expect(state.requestEvents.some((event) => event.kind === 'settled')).toBe(true);
  });

  it('reverses a transfer append-only without requiring a fictional second slip', async () => {
    const initial = await fulfillRequest({ requestId: 'request-1', lane: 'transfer', transferSlipUploadId: 'slip-1' });
    await reverseRequestMoneyEvent({ eventId: initial.id, reason: 'wrong beneficiary' });
    expect(state.events).toHaveLength(2);
    expect(state.events[0]).toMatchObject({ kind: 'payment', transferSlipUploadId: 'slip-1' });
    expect(state.events[1]).toMatchObject({ kind: 'reversal', reversesEventId: initial.id, transferSlipUploadId: null });
  });
});
