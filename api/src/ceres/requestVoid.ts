import { prisma } from '../db/prisma.js';
import type { AuthedAgent } from '../auth/jwt.js';
import {
  activeEvents,
  liquidationSatang,
  reverseRequestMoneyEventInTx,
  type CeresTx,
} from './requestMoney.js';

// Owner directive (2026-07-21): "I and only CEO should have the ability to remove any
// transaction, any request — especially at this stage when a lot of people might record
// something wrong." This is the CEO's ANY-STATE void for a v2 payment request — separate
// from cancelStaffRequest (requester/manager self-service, only pre-fulfillment) and from
// the existing "reverse a money event" endpoint (money-only, doesn't touch approvalStatus).
//
// Terminal state: approvalStatus 'void'. Reachable from every other approvalStatus,
// including 'reversed'-fulfillment requests that cancelStaffRequest could never reach
// (managerMayCancel requires fulfillmentStatus === 'unfulfilled') — this closes that gap.
export class RequestVoidError extends Error {
  constructor(
    public readonly code: 'not_found' | 'already_void' | 'has_liquidation_children' | 'has_outstanding_balance',
    public readonly detail?: Record<string, unknown>,
  ) {
    super(code);
  }
}

export interface VoidStaffRequestInput {
  requestId: string;
  reason: string;
  agent: AuthedAgent;
}

export async function voidStaffRequest({ requestId, reason, agent }: VoidStaffRequestInput) {
  return prisma.$transaction(async (tx: CeresTx) => {
    // Same row lock every other request-mutating flow takes first (see
    // recordRequestMoneyEventInTx) — makes this safe against a concurrent fulfill/reverse.
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "CeresPaymentRequest" WHERE "id" = ${requestId} FOR UPDATE
    `;
    const existing = await tx.ceresPaymentRequest.findUnique({ where: { id: requestId } });
    if (!existing || existing.workflowVersion !== 2) throw new RequestVoidError('not_found');
    if (existing.approvalStatus === 'void') throw new RequestVoidError('already_void');

    const events = await tx.ceresRequestMoneyEvent.findMany({
      where: { requestId: existing.id },
      orderBy: { createdAt: 'asc' },
    });
    const live = activeEvents(events);
    // The one fulfillment event (payment or purchase) still standing, if any. Only ever
    // zero or one — recordRequestMoneyEventInTx enforces "at most one unreversed initial
    // fulfillment" for every v2 request.
    const liveFulfillment = live.find((event) => event.kind === 'payment' || event.kind === 'purchase');

    // Advances only: liquidation expenses hang off `advanceRequestId` — never cascade-void
    // them silently. A live (non-void) child, or unreturned money with none, blocks here so
    // the CEO handles the children consciously first (owner spec).
    if (existing.requestType === 'advance') {
      const children = await tx.ceresExpense.findMany({
        where: { advanceRequestId: existing.id, status: { not: 'void' } },
        select: { id: true, status: true, amount: true, category: true, partyName: true },
      });
      if (children.length > 0) {
        throw new RequestVoidError('has_liquidation_children', {
          blockers: children.map((c) => ({ id: c.id, status: c.status, amount: c.amount, category: c.category })),
        });
      }
      if (liveFulfillment) {
        // No live children (checked above) — expenses arg is empty, so this is purely
        // advanceAmount minus whatever's already been refunded.
        const totals = liquidationSatang(existing.amount, events, []);
        if (totals.remaining !== 0) {
          throw new RequestVoidError('has_outstanding_balance', {
            remainingOutstanding: (totals.remaining / 100).toFixed(2),
          });
        }
      }
    }

    // Reverse the live fulfillment IN THIS SAME transaction, using the exact reverse
    // mechanics the manual "reverse a money event" endpoint uses (requestMoney.ts) — money
    // comes back to the box/ledger exactly as a manual reverse would, same event rows. A
    // request with no live fulfillment (never paid, or already reversed) skips straight to
    // the void write below — this is what lets an already-'reversed' request reach 'void'.
    //
    // ADVANCES ARE THE EXCEPTION — they never reach this reversal, on purpose. The guard
    // above only lets an advance with a liveFulfillment fall through when
    // liquidationSatang(...).remaining === 0, and with zero live children (blocked earlier)
    // the ONLY way remaining can be 0 here is that refund events have already returned the
    // full advance amount. That refund already brought the cash back — reversing the
    // ORIGINAL payment on top would inject a second, phantom inflow (payment −1000,
    // refund +1000 nets the box to 0 already; reversing the payment adds another +1000,
    // overcrediting the box/transfer-recon by the full advance amount). So for
    // requestType 'advance' the void here is a pure status flip: the cash math was already
    // closed by the refund(s). A NOT-yet-refunded advance never reaches this line at all —
    // it's stopped by has_outstanding_balance above, and the CEO's route for that case is
    // the existing manual reverse-a-money-event endpoint (which asserts the cash physically
    // came back) run first, which flips fulfillmentStatus to 'reversed' — at which point
    // liveFulfillment is undefined and this whole block is skipped anyway.
    const shouldReverse = !!liveFulfillment && existing.requestType !== 'advance';
    if (shouldReverse) {
      await reverseRequestMoneyEventInTx(tx, {
        eventId: liveFulfillment!.id,
        reason: `ยกเลิกรายการโดย CEO: ${reason}`,
        createdById: agent.id,
        createdByName: agent.name,
      });
    }

    const before = { approvalStatus: existing.approvalStatus, fulfillmentStatus: existing.fulfillmentStatus };
    const voided = await tx.ceresPaymentRequest.update({
      where: { id: existing.id },
      data: {
        approvalStatus: 'void',
        voidedById: agent.id,
        voidedAt: new Date(),
        voidReason: reason,
        rowVersion: { increment: 1 },
      },
    });
    await tx.ceresRevision.create({
      data: {
        subjectType: 'paymentRequest',
        subjectId: existing.id,
        changedById: agent.id,
        changedByName: agent.name,
        before,
        after: { approvalStatus: 'void', voidReason: reason },
        reason,
      },
    });
    await tx.ceresRequestEvent.create({
      data: {
        requestId: existing.id,
        kind: 'voided',
        actorId: agent.id,
        actorName: agent.name,
        note: reason,
        payload: {
          priorApprovalStatus: before.approvalStatus,
          priorFulfillmentStatus: before.fulfillmentStatus,
          reversedFulfillment: shouldReverse,
        },
      },
    });
    return voided;
  });
}
