import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';

export type CeresTx = Prisma.TransactionClient;

export type CashDirection = 'in' | 'out';
export interface BalanceMovement {
  amount: string;
  direction: string | null;
  type: string;
}

export function legacyCashDirection(type: string): CashDirection | null {
  if (type === 'advance') return 'out';
  if (type === 'deposit' || type === 'topup' || type === 'refund') return 'in';
  return null;
}

function amountToSatang(value: string): number {
  const normalized = (value || '').replace(/[^\d.-]/g, '');
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

export function cashBalanceFromMovements(rows: readonly BalanceMovement[]): number {
  return rows.reduce((total, row) => {
    const direction = row.direction === 'in' || row.direction === 'out' ? row.direction : legacyCashDirection(row.type);
    if (!direction) return total;
    const amount = Number.parseFloat((row.amount || '').replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(amount)) return total;
    return total + (direction === 'in' ? amount : -amount);
  }, 0);
}

export class CashLedgerError extends Error {
  constructor(
    public readonly code: 'cash_account_missing' | 'insufficient_cash',
    public readonly balance = 0,
  ) {
    super(code);
  }
}

// Every close and cash-out takes this singleton lock first. PostgreSQL holds it to
// transaction end, serializing balance reads and inserts without changing v1 math.
export async function lockPettyCash(tx: CeresTx): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "CashAccount" WHERE "id" = 'pettyCash' FOR UPDATE
  `;
  if (rows.length !== 1) throw new CashLedgerError('cash_account_missing');
}

export async function pettyCashBalance(tx: CeresTx, cutoff?: Date): Promise<number> {
  const rows = await tx.cashMovement.findMany({
    where: { accountId: 'pettyCash', ...(cutoff ? { createdAt: { lte: cutoff } } : {}) },
    select: { amount: true, direction: true, type: true },
  });
  return cashBalanceFromMovements(rows);
}

export interface OutgoingCashMovementInput {
  type: 'advance' | 'request_payment';
  amount: string;
  partyId?: string | null;
  partyName?: string;
  entity?: string;
  note?: string;
  createdById?: string | null;
  createdByName?: string;
  requestId?: string | null;
  requestMoneyEventId?: string | null;
}

export async function createOutgoingCashMovement(input: OutgoingCashMovementInput) {
  return prisma.$transaction(async (tx) => {
    await lockPettyCash(tx);
    const balance = await pettyCashBalance(tx);
    if (amountToSatang(input.amount) > amountToSatang(balance.toFixed(2))) {
      throw new CashLedgerError('insufficient_cash', balance);
    }
    return tx.cashMovement.create({
      data: {
        accountId: 'pettyCash',
        type: input.type,
        direction: 'out',
        partyId: input.partyId ?? null,
        partyName: input.partyName ?? '',
        entity: input.entity ?? '',
        amount: input.amount,
        note: input.note ?? '',
        createdById: input.createdById ?? null,
        createdByName: input.createdByName ?? '',
        requestId: input.requestId ?? null,
        requestMoneyEventId: input.requestMoneyEventId ?? null,
      },
    });
  });
}

export const requestMoneyKindSchema = z.enum(['payment', 'purchase', 'refund', 'reversal']);
export const requestMoneyLaneSchema = z.enum(['cash', 'transfer']);

export interface RecordRequestMoneyInput {
  requestId: string;
  kind: z.infer<typeof requestMoneyKindSchema>;
  lane: z.infer<typeof requestMoneyLaneSchema>;
  amount: string;
  transferSlipUploadId?: string;
  purchaseReceiptUploadId?: string;
  reversesEventId?: string;
  createdById?: string | null;
  createdByName?: string;
  note?: string;
  idempotencyKey?: string;
}

export class RequestMoneyError extends Error {
  constructor(public readonly code:
    | 'not_found'
    | 'not_approved'
    | 'already_fulfilled'
    | 'invalid_evidence'
    | 'invalid_request_type'
    | 'not_paid_advance'
    | 'refund_exceeds_outstanding') {
    super(code);
  }
}

type MoneyEventRow = {
  id: string;
  requestId: string;
  kind: string;
  lane: string;
  amount: string;
  cashMovementId: string | null;
  reversesEventId: string | null;
  createdAt: Date;
};

function activeEvents(events: readonly MoneyEventRow[]): MoneyEventRow[] {
  const reversed = new Set(events.filter((event) => event.kind === 'reversal' && event.reversesEventId).map((event) => event.reversesEventId));
  return events.filter((event) => event.kind !== 'reversal' && !reversed.has(event.id));
}

function liquidationSatang(
  advanceAmount: string,
  events: readonly MoneyEventRow[],
  expenses: readonly { amount: string }[],
): { returned: number; spent: number; remaining: number } {
  const active = activeEvents(events);
  const returned = active.filter((event) => event.kind === 'refund').reduce((sum, event) => sum + amountToSatang(event.amount), 0);
  const spent = expenses.reduce((sum, expense) => sum + amountToSatang(expense.amount), 0);
  return { returned, spent, remaining: amountToSatang(advanceAmount) - returned - spent };
}

export async function syncAdvanceLiquidationProjection(tx: CeresTx, request: {
  id: string;
  amount: string;
  fulfillmentStatus: string;
}, actor: { id?: string | null; name?: string } = {}): Promise<void> {
  const [events, expenses] = await Promise.all([
    tx.ceresRequestMoneyEvent.findMany({ where: { requestId: request.id }, orderBy: { createdAt: 'asc' } }),
    tx.ceresExpense.findMany({
      where: { advanceRequestId: request.id, status: { in: ['approved', 'settled'] } },
      select: { amount: true },
    }),
  ]);
  const initial = activeEvents(events).find((event) => event.kind === 'payment');
  if (!initial) {
    if (request.fulfillmentStatus !== 'reversed') {
      await tx.ceresPaymentRequest.update({
        where: { id: request.id },
        data: { fulfillmentStatus: 'reversed', rowVersion: { increment: 1 } },
      });
    }
    return;
  }
  const totals = liquidationSatang(request.amount, events, expenses);
  const nextStatus = totals.remaining === 0 ? 'settled' : (totals.returned > 0 || totals.spent > 0 ? 'settling' : 'paid');
  if (request.fulfillmentStatus !== nextStatus) {
    await tx.ceresPaymentRequest.update({
      where: { id: request.id },
      data: { fulfillmentStatus: nextStatus, rowVersion: { increment: 1 } },
    });
    if (request.fulfillmentStatus === 'settled' && nextStatus !== 'settled') {
      await tx.ceresRequestEvent.create({
        data: {
          requestId: request.id,
          kind: 'liquidation_reopened',
          actorId: actor.id ?? null,
          actorName: actor.name ?? '',
          payload: { remainingOutstanding: (totals.remaining / 100).toFixed(2) },
        },
      });
    }
    if (nextStatus === 'settled') {
      await tx.ceresRequestEvent.create({
        data: {
          requestId: request.id,
          kind: 'settled',
          actorId: actor.id ?? null,
          actorName: actor.name ?? '',
          payload: {
            advanceAmount: request.amount,
            approvedExpenses: (totals.spent / 100).toFixed(2),
            returned: (totals.returned / 100).toFixed(2),
          },
        },
      });
    }
  }
}

// Append-only event, cash movement, request timeline, and request projection are one
// transaction. The request-row lock makes a double tap safe even without an explicit
// idempotency key; a supplied key additionally turns retries into a replay.
export async function recordRequestMoneyEvent(input: RecordRequestMoneyInput) {
  if (!/^\d+(\.\d{1,2})?$/.test(input.amount) || amountToSatang(input.amount) <= 0) {
    throw new RequestMoneyError('invalid_evidence');
  }
  return prisma.$transaction(async (tx) => {
    if (input.lane === 'cash') await lockPettyCash(tx);
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "CeresPaymentRequest" WHERE "id" = ${input.requestId} FOR UPDATE
    `;

    if (input.idempotencyKey) {
      const replay = await tx.ceresRequestMoneyEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (replay) return replay;
    }
    const request = await tx.ceresPaymentRequest.findUnique({ where: { id: input.requestId } });
    if (!request) throw new RequestMoneyError('not_found');
    if (request.workflowVersion !== 2 || request.approvalStatus !== 'approved') {
      throw new RequestMoneyError('not_approved');
    }
    if ((input.kind === 'payment' && !['advance', 'reimbursement'].includes(request.requestType)) ||
        (input.kind === 'purchase' && request.requestType !== 'purchase') ||
        (input.kind === 'refund' && request.requestType !== 'advance')) {
      throw new RequestMoneyError('invalid_request_type');
    }

    if (input.kind !== 'refund' && input.kind !== 'reversal') {
      const initialEvents = await tx.ceresRequestMoneyEvent.findMany({
        where: { requestId: request.id, kind: { in: ['payment', 'purchase'] } },
        select: { id: true },
      });
      if (initialEvents.length > 0) {
        const reversals = await tx.ceresRequestMoneyEvent.findMany({
          where: { requestId: request.id, kind: 'reversal', reversesEventId: { in: initialEvents.map((event) => event.id) } },
          select: { reversesEventId: true },
        });
        const reversedIds = new Set(reversals.map((event) => event.reversesEventId));
        if (initialEvents.some((event) => !reversedIds.has(event.id))) {
          throw new RequestMoneyError('already_fulfilled');
        }
      }
    }
    if ((input.lane === 'transfer' && input.kind !== 'reversal' && !input.transferSlipUploadId) ||
        (input.kind === 'purchase' && !input.purchaseReceiptUploadId)) {
      throw new RequestMoneyError('invalid_evidence');
    }

    if (input.kind === 'refund') {
      const [events, expenses] = await Promise.all([
        tx.ceresRequestMoneyEvent.findMany({ where: { requestId: request.id }, orderBy: { createdAt: 'asc' } }),
        tx.ceresExpense.findMany({
          where: { advanceRequestId: request.id, status: { in: ['approved', 'settled'] } },
          select: { amount: true },
        }),
      ]);
      if (!activeEvents(events).some((event) => event.kind === 'payment')) {
        throw new RequestMoneyError('not_paid_advance');
      }
      if (amountToSatang(input.amount) > liquidationSatang(request.amount, events, expenses).remaining) {
        throw new RequestMoneyError('refund_exceeds_outstanding');
      }
    }

    const reversed = input.kind === 'reversal' && input.reversesEventId
      ? await tx.ceresRequestMoneyEvent.findUnique({ where: { id: input.reversesEventId } })
      : null;
    if (input.kind === 'reversal') {
      if (!reversed || reversed.requestId !== request.id || reversed.lane !== input.lane || reversed.kind === 'reversal' ||
          amountToSatang(reversed.amount) !== amountToSatang(input.amount)) {
        throw new RequestMoneyError('invalid_evidence');
      }
      const priorReversal = await tx.ceresRequestMoneyEvent.findFirst({
        where: { requestId: request.id, kind: 'reversal', reversesEventId: reversed.id },
        select: { id: true },
      });
      if (priorReversal) throw new RequestMoneyError('invalid_evidence');
    }

    let direction: CashDirection | null = null;
    let reversesMovementId: string | null = null;
    if (input.lane === 'cash') {
      direction = input.kind === 'refund' ? 'in' : 'out';
      if (reversed) {
        direction = reversed.kind === 'refund' ? 'out' : 'in';
        reversesMovementId = reversed.cashMovementId;
      }
      if (direction === 'out') {
        const balance = await pettyCashBalance(tx);
        if (amountToSatang(input.amount) > amountToSatang(balance.toFixed(2))) {
          throw new CashLedgerError('insufficient_cash', balance);
        }
      }
    }

    const eventId = randomUUID();
    const movementId = direction ? randomUUID() : null;
    const isAdvance = request.requestType === 'advance';
    const partyId = isAdvance && (input.kind === 'payment' || input.kind === 'refund' || input.kind === 'reversal')
      ? request.requesterPartyId
      : null;
    const partyName = partyId ? request.requestedByName : '';
    const event = await tx.ceresRequestMoneyEvent.create({
      data: {
        id: eventId,
        requestId: request.id,
        kind: input.kind,
        lane: input.lane,
        amount: input.amount,
        transferSlipUploadId: input.transferSlipUploadId ?? null,
        purchaseReceiptUploadId: input.purchaseReceiptUploadId ?? null,
        cashMovementId: movementId,
        reversesEventId: input.reversesEventId ?? null,
        createdById: input.createdById ?? null,
        createdByName: input.createdByName ?? '',
        note: input.note ?? '',
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });
    if (direction && movementId) {
      await tx.cashMovement.create({
        data: {
          id: movementId,
          accountId: 'pettyCash',
          type: input.kind === 'refund'
            ? 'request_refund'
            : input.kind === 'reversal'
              ? 'reversal'
              : isAdvance ? 'advance' : 'request_payment',
          direction,
          partyId,
          partyName,
          entity: request.entity,
          amount: input.amount,
          requestId: request.id,
          requestMoneyEventId: event.id,
          reversesMovementId,
          note: input.note ?? '',
          createdById: input.createdById ?? null,
          createdByName: input.createdByName ?? '',
        },
      });
    }

    if (input.kind === 'payment' || input.kind === 'purchase') {
      const fulfillmentStatus = input.kind === 'purchase' ? 'bought' : 'paid';
      await tx.ceresPaymentRequest.update({
        where: { id: request.id },
        data: {
          fulfillmentStatus,
          paidById: input.createdById ?? null,
          paidAt: event.createdAt,
          rowVersion: { increment: 1 },
        },
      });
      await tx.ceresRequestEvent.create({
        data: {
          requestId: request.id,
          kind: fulfillmentStatus,
          actorId: input.createdById ?? null,
          actorName: input.createdByName ?? '',
          note: input.note ?? '',
          payload: { moneyEventId: event.id, lane: input.lane, amount: input.amount },
          idempotencyKey: input.idempotencyKey ? `request:${input.idempotencyKey}` : null,
        },
      });
    } else {
      await tx.ceresRequestEvent.create({
        data: {
          requestId: request.id,
          kind: input.kind === 'refund' ? 'refund_recorded' : 'reversed',
          actorId: input.createdById ?? null,
          actorName: input.createdByName ?? '',
          note: input.note ?? '',
          payload: {
            moneyEventId: event.id,
            lane: input.lane,
            amount: input.amount,
            ...(input.reversesEventId ? { reversesEventId: input.reversesEventId } : {}),
          },
          idempotencyKey: input.idempotencyKey ? `request:${input.idempotencyKey}` : null,
        },
      });
      if (request.requestType === 'advance') {
        await syncAdvanceLiquidationProjection(tx, request, { id: input.createdById, name: input.createdByName });
      } else if (input.kind === 'reversal') {
        await tx.ceresPaymentRequest.update({
          where: { id: request.id },
          data: { fulfillmentStatus: 'reversed', rowVersion: { increment: 1 } },
        });
      }
    }
    return event;
  });
}

export async function fulfillRequest(input: {
  requestId: string;
  lane: z.infer<typeof requestMoneyLaneSchema>;
  transferSlipUploadId?: string;
  purchaseReceiptUploadId?: string;
  createdById?: string | null;
  createdByName?: string;
  note?: string;
  idempotencyKey?: string;
}) {
  const request = await prisma.ceresPaymentRequest.findUnique({ where: { id: input.requestId } });
  if (!request) throw new RequestMoneyError('not_found');
  if (!['advance', 'reimbursement', 'purchase'].includes(request.requestType)) {
    throw new RequestMoneyError('invalid_request_type');
  }
  return recordRequestMoneyEvent({
    ...input,
    amount: request.amount,
    kind: request.requestType === 'purchase' ? 'purchase' : 'payment',
  });
}

export async function refundAdvance(input: Omit<RecordRequestMoneyInput, 'kind'>) {
  return recordRequestMoneyEvent({ ...input, kind: 'refund' });
}

export async function reverseRequestMoneyEvent(input: {
  eventId: string;
  reason: string;
  createdById?: string | null;
  createdByName?: string;
  idempotencyKey?: string;
}) {
  const event = await prisma.ceresRequestMoneyEvent.findUnique({ where: { id: input.eventId } });
  if (!event) throw new RequestMoneyError('not_found');
  return recordRequestMoneyEvent({
    requestId: event.requestId,
    kind: 'reversal',
    lane: requestMoneyLaneSchema.parse(event.lane),
    amount: event.amount,
    reversesEventId: event.id,
    createdById: input.createdById,
    createdByName: input.createdByName,
    note: input.reason,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function getAdvanceLiquidation(requestId: string) {
  const request = await prisma.ceresPaymentRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new RequestMoneyError('not_found');
  if (request.workflowVersion !== 2 || request.requestType !== 'advance') {
    throw new RequestMoneyError('invalid_request_type');
  }
  const [events, expenses] = await Promise.all([
    prisma.ceresRequestMoneyEvent.findMany({ where: { requestId }, orderBy: { createdAt: 'asc' } }),
    prisma.ceresExpense.findMany({
      where: { advanceRequestId: requestId, status: { in: ['approved', 'settled'] } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const initial = activeEvents(events).find((event) => event.kind === 'payment');
  if (!initial) throw new RequestMoneyError('not_paid_advance');
  const totals = liquidationSatang(request.amount, events, expenses);
  return {
    request,
    fundingLane: initial.lane,
    advanceAmount: request.amount,
    approvedExpenses: expenses,
    returns: activeEvents(events).filter((event) => event.kind === 'refund'),
    totals: {
      approvedExpenses: (totals.spent / 100).toFixed(2),
      returned: (totals.returned / 100).toFixed(2),
      remainingOutstanding: (totals.remaining / 100).toFixed(2),
      settled: totals.remaining === 0,
    },
  };
}
