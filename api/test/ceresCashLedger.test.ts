import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  findMovements: vi.fn(),
  createMovement: vi.fn(),
  findRequest: vi.fn(),
  findMoneyEvent: vi.fn(),
  findFirstMoneyEvent: vi.fn(),
  findManyMoneyEvents: vi.fn(),
  createMoneyEvent: vi.fn(),
  updateRequest: vi.fn(),
  createRequestEvent: vi.fn(),
  findExpenses: vi.fn(),
}));

vi.mock('../src/db/prisma.js', () => ({
  prisma: { $transaction: mocks.transaction },
}));

import {
  CashLedgerError,
  cashBalanceFromMovements,
  createOutgoingCashMovement,
  lockPettyCash,
  recordRequestMoneyEvent,
} from '../src/ceres/requestMoney.js';

function tx() {
  return {
    $queryRaw: mocks.queryRaw,
    cashMovement: { findMany: mocks.findMovements, create: mocks.createMovement },
    ceresPaymentRequest: { findUnique: mocks.findRequest, update: mocks.updateRequest },
    ceresExpense: { findMany: mocks.findExpenses },
    ceresRequestEvent: { create: mocks.createRequestEvent },
    ceresRequestMoneyEvent: {
      findUnique: mocks.findMoneyEvent,
      findFirst: mocks.findFirstMoneyEvent,
      findMany: mocks.findManyMoneyEvents,
      create: mocks.createMoneyEvent,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRaw.mockResolvedValue([{ id: 'pettyCash' }]);
  mocks.createMovement.mockImplementation(async ({ data }) => ({ id: 'movement-1', ...data }));
  mocks.findFirstMoneyEvent.mockResolvedValue(null);
  mocks.findManyMoneyEvents.mockResolvedValue([]);
  mocks.createMoneyEvent.mockImplementation(async ({ data }) => data);
  mocks.updateRequest.mockResolvedValue({});
  mocks.createRequestEvent.mockResolvedValue({ id: 'request-event-1' });
  mocks.findExpenses.mockResolvedValue([]);
  mocks.transaction.mockImplementation(async (callback) => callback(tx()));
});

describe('Ceres cash ledger safety', () => {
  it('keeps the legacy balance while preferring direction on new rows', () => {
    expect(cashBalanceFromMovements([
      { type: 'deposit', direction: null, amount: '1000.00' },
      { type: 'advance', direction: null, amount: '300.25' },
      { type: 'refund', direction: null, amount: '50.25' },
      { type: 'request_payment', direction: 'out', amount: '100.00' },
      { type: 'request_refund', direction: 'in', amount: '20.00' },
      { type: 'unknown', direction: null, amount: '9999' },
    ])).toBe(670);
  });

  it('takes a FOR UPDATE lock on the singleton cash-account row', async () => {
    await lockPettyCash(tx() as never);
    const sql = mocks.queryRaw.mock.calls[0]![0] as TemplateStringsArray;
    expect(sql.join(' ')).toContain('CashAccount');
    expect(sql.join(' ')).toContain('FOR UPDATE');
  });

  it('rejects an overdrawing v2 cash payout and writes nothing', async () => {
    mocks.findMovements.mockResolvedValue([{ type: 'deposit', direction: 'in', amount: '100.00' }]);
    await expect(createOutgoingCashMovement({
      type: 'request_payment',
      partyId: 'party-1',
      partyName: 'Staff',
      amount: '100.01',
      createdById: 'gm-1',
      createdByName: 'GM',
    })).rejects.toMatchObject<CashLedgerError>({ code: 'insufficient_cash', balance: 100 });
    expect(mocks.createMovement).not.toHaveBeenCalled();
  });

  it('writes a permitted v2 cash payout as an explicit outgoing movement after the balance read', async () => {
    mocks.findMovements.mockResolvedValue([{ type: 'deposit', direction: null, amount: '100.00' }]);
    await createOutgoingCashMovement({
      type: 'request_payment',
      partyId: 'party-1',
      partyName: 'Staff',
      amount: '40.00',
      createdById: 'gm-1',
      createdByName: 'GM',
    });
    expect(mocks.createMovement).toHaveBeenCalledWith({
      data: expect.objectContaining({ accountId: 'pettyCash', type: 'request_payment', direction: 'out', amount: '40.00' }),
    });
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.findMovements.mock.invocationCallOrder[0]!);
    expect(mocks.findMovements.mock.invocationCallOrder[0]).toBeLessThan(mocks.createMovement.mock.invocationCallOrder[0]!);
  });

  it('serializes simultaneous payouts so only one spends the remaining balance', async () => {
    const movements = [{ type: 'deposit', direction: 'in', amount: '100.00' }];
    const inserts: string[] = [];
    let tail = Promise.resolve();

    mocks.transaction.mockImplementation(async (callback) => {
      let release: (() => void) | undefined;
      const previous = tail;
      tail = new Promise<void>((resolve) => { release = resolve; });
      const lockedTx = {
        ...tx(),
        $queryRaw: vi.fn(async () => {
          await previous;
          return [{ id: 'pettyCash' }];
        }),
        cashMovement: {
          findMany: vi.fn(async () => movements.map((row) => ({ ...row }))),
          create: vi.fn(async ({ data }: { data: { type: string; direction: string; amount: string } }) => {
            movements.push({ type: data.type, direction: data.direction, amount: data.amount });
            inserts.push(data.amount);
            return data;
          }),
        },
      };
      try {
        return await callback(lockedTx);
      } finally {
        release?.();
      }
    });

    const results = await Promise.allSettled([
      createOutgoingCashMovement({ type: 'request_payment', amount: '80.00' }),
      createOutgoingCashMovement({ type: 'request_payment', amount: '80.00' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(inserts).toEqual(['80.00']);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'insufficient_cash', balance: 20 });
  });

  it('allows at most one unreversed initial request fulfillment', async () => {
    const events: Array<Record<string, unknown>> = [];
    mocks.findRequest.mockResolvedValue({
      id: 'request-1', workflowVersion: 2, approvalStatus: 'approved', requestType: 'advance',
      requesterPartyId: 'party-1', requestedByName: 'Staff', entity: 'PROM', fulfillmentStatus: 'unfulfilled', amount: '10.00',
    });
    mocks.findMovements.mockResolvedValue([{ type: 'deposit', direction: 'in', amount: '100.00' }]);
    mocks.findManyMoneyEvents.mockImplementation(async ({ where }) => {
      if (where.kind === 'reversal') return [];
      return events.filter((event) => event.kind === 'payment' || event.kind === 'purchase');
    });
    mocks.createMoneyEvent.mockImplementation(async ({ data }) => {
      events.push(data);
      return data;
    });

    await recordRequestMoneyEvent({ requestId: 'request-1', kind: 'payment', lane: 'cash', amount: '10.00' });
    await expect(recordRequestMoneyEvent({
      requestId: 'request-1', kind: 'payment', lane: 'cash', amount: '5.00',
    })).rejects.toMatchObject({ code: 'already_fulfilled' });
    expect(mocks.createMoneyEvent).toHaveBeenCalledTimes(1);
    expect(mocks.createMovement).toHaveBeenCalledTimes(1);
  });

  it('reverses a cash fulfillment with a compensating movement', async () => {
    const events = new Map<string, Record<string, unknown>>();
    mocks.findRequest.mockResolvedValue({
      id: 'request-1', workflowVersion: 2, approvalStatus: 'approved', requestType: 'advance',
      requesterPartyId: 'party-1', requestedByName: 'Staff', entity: 'PROM', fulfillmentStatus: 'unfulfilled', amount: '25.00',
    });
    mocks.findMovements.mockResolvedValue([{ type: 'deposit', direction: 'in', amount: '100.00' }]);
    mocks.findMoneyEvent.mockImplementation(async ({ where }) => {
      if (where.id) return events.get(where.id) ?? null;
      return null;
    });
    mocks.createMoneyEvent.mockImplementation(async ({ data }) => {
      events.set(data.id, data);
      return data;
    });

    const initial = await recordRequestMoneyEvent({
      requestId: 'request-1', kind: 'payment', lane: 'cash', amount: '25.00',
    });
    await recordRequestMoneyEvent({
      requestId: 'request-1', kind: 'reversal', lane: 'cash', amount: '25.00', reversesEventId: initial.id,
    });

    const initialMovement = mocks.createMovement.mock.calls[0]![0].data;
    expect(initialMovement).toMatchObject({ direction: 'out', requestMoneyEventId: initial.id });
    expect(mocks.createMovement.mock.calls[1]![0].data).toMatchObject({
      direction: 'in',
      reversesMovementId: initial.cashMovementId,
    });
  });

  it('rejects a cash request payment above the box balance and writes nothing', async () => {
    mocks.findRequest.mockResolvedValue({
      id: 'request-1', workflowVersion: 2, approvalStatus: 'approved', requestType: 'advance',
      requesterPartyId: 'party-1', requestedByName: 'Staff', entity: 'PROM', fulfillmentStatus: 'unfulfilled', amount: '20.01',
    });
    mocks.findMovements.mockResolvedValue([{ type: 'deposit', direction: 'in', amount: '20.00' }]);

    await expect(recordRequestMoneyEvent({
      requestId: 'request-1', kind: 'payment', lane: 'cash', amount: '20.01',
    })).rejects.toMatchObject<CashLedgerError>({ code: 'insufficient_cash', balance: 20 });
    expect(mocks.createMoneyEvent).not.toHaveBeenCalled();
    expect(mocks.createMovement).not.toHaveBeenCalled();
  });
});
