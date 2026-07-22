import type { Prisma } from '@prisma/client';
import type { AuthedAgent } from '../auth/jwt.js';
import { prisma } from '../db/prisma.js';
import { ceresRole } from './auth.js';
import { CeresRequestError, neeApprovalTarget } from './requestService.js';
import {
  lockPettyCash,
  recordRequestMoneyEventInTx,
  requestMoneyLaneSchema,
  type CeresTx,
} from './requestMoney.js';
import { z } from 'zod';

// Owner directive (2026-07-22): "อนุมัติ = จ่าย" — GM/CEO approval of an advance or
// reimbursement no longer has a separate "อนุมัติและจ่ายเลย" step; อนุมัติ itself asks
// cash/transfer and records BOTH the decision and the payment in ONE server transaction.
// This is the composable core the route (routes/ceres/requests.ts's decide-and-pay
// endpoint) calls — mirrors requestVoid.ts's shape (decision + money composed in one tx,
// reusing requestMoney.ts's InTx primitives) rather than forking a second money-writing path.

type RequestRow = NonNullable<Awaited<ReturnType<typeof prisma.ceresPaymentRequest.findUnique>>>;
type MoneyEventRow = Awaited<ReturnType<typeof recordRequestMoneyEventInTx>>;

export interface DecideAndPayInput {
  requestId: string;
  lane: z.infer<typeof requestMoneyLaneSchema>;
  transferSlipUploadId?: string;
  note?: string;
  idempotencyKey?: string;
  agent: AuthedAgent;
}

export type DecideAndPayResult =
  // GM path only — the request escalated to pending_ceo (over threshold or AI-flagged).
  // The decision alone is committed; NO money moves. decisionEventId is null only for the
  // idempotent-replay short-circuit below (nothing was decided on THIS call).
  | { outcome: 'escalated'; request: RequestRow; decisionEventId: string }
  | { outcome: 'paid'; request: RequestRow; moneyEvent: MoneyEventRow; decisionEventId: string | null };

// Same row-lock ORDER every other money-writing flow uses (see requestMoney.ts's
// recordRequestMoneyEventInTx doc comment): pettyCash first, then the request row —
// avoids a lock-order deadlock against a concurrent plain fulfill/refund/reverse call.
async function lockRequestRow(tx: CeresTx, requestId: string): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "CeresPaymentRequest" WHERE "id" = ${requestId} FOR UPDATE
  `;
}

export async function decideAndPayStaffRequest(input: DecideAndPayInput): Promise<DecideAndPayResult> {
  const role = ceresRole(input.agent);
  if (role !== 'gm' && role !== 'ceo') throw new CeresRequestError('forbidden');

  return prisma.$transaction(async (tx: CeresTx): Promise<DecideAndPayResult> => {
    // Idempotent replay: a retried tap (network flake, double-submit) after the FIRST
    // attempt already committed decision+payment must return that SAME result rather than
    // re-attempt the decision write — which would now fail (`approvalStatus` already moved
    // on from pending_nee/pending_ceo). The money event's idempotencyKey is the durable
    // record of "this composite call already happened" — same idea as
    // recordRequestMoneyEventInTx's own replay check, just hoisted up a level so it can
    // short-circuit the decision half too.
    if (input.idempotencyKey) {
      const replay = await tx.ceresRequestMoneyEvent.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (replay) {
        const request = await tx.ceresPaymentRequest.findUniqueOrThrow({ where: { id: replay.requestId } });
        return { outcome: 'paid', request, moneyEvent: replay, decisionEventId: null };
      }
    }

    if (input.lane === 'cash') await lockPettyCash(tx);
    await lockRequestRow(tx, input.requestId);

    const existing = await tx.ceresPaymentRequest.findUnique({ where: { id: input.requestId } });
    if (!existing || existing.workflowVersion !== 2) throw new CeresRequestError('not_found');
    // Purchases keep the receipt-mandatory two-step (plain decide, then fulfill with a
    // purchase receipt) — this composite endpoint never handles them.
    if (existing.requestType !== 'advance' && existing.requestType !== 'reimbursement') {
      throw new CeresRequestError('invalid_request_type');
    }

    if (role === 'gm') {
      if (existing.approvalStatus !== 'pending_nee') throw new CeresRequestError('not_pending_nee');
      if (existing.aiScreenStatus !== 'clear' && existing.aiScreenStatus !== 'escalate') {
        throw new CeresRequestError('ai_review_pending');
      }
      const target = neeApprovalTarget(existing);
      const changed = await tx.ceresPaymentRequest.updateMany({
        where: { id: existing.id, approvalStatus: 'pending_nee', rowVersion: existing.rowVersion },
        data: {
          approvalStatus: target,
          neeDecidedById: input.agent.id,
          neeDecidedByName: input.agent.name,
          neeDecidedAt: new Date(),
          neeDecisionNote: input.note ?? '',
          rowVersion: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new CeresRequestError('conflict');
      // Additive payload flag only — same event `kind` a plain nee-approve would create,
      // so every existing consumer (notifyRequesterForEvent's claim query, timelines,
      // CSV export) keeps working unchanged; `oneFlow` just marks where it came from.
      const decisionEvent = await tx.ceresRequestEvent.create({
        data: {
          requestId: existing.id,
          kind: 'nee_approved',
          actorId: input.agent.id,
          actorName: input.agent.name,
          note: input.note ?? '',
          payload: { approvalStatus: target, oneFlow: true } as Prisma.InputJsonObject,
        },
      });
      const decided = await tx.ceresPaymentRequest.findUniqueOrThrow({ where: { id: existing.id } });
      if (target === 'pending_ceo') {
        // Escalation: commit the decision alone. No payment — the CEO decides next, via
        // either the plain ceo-decision endpoint or this same composite one.
        return { outcome: 'escalated', request: decided, decisionEventId: decisionEvent.id };
      }
      const moneyEvent = await recordRequestMoneyEventInTx(tx, {
        requestId: decided.id,
        kind: 'payment',
        lane: input.lane,
        amount: decided.amount,
        transferSlipUploadId: input.transferSlipUploadId,
        createdById: input.agent.id,
        createdByName: input.agent.name,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
      });
      const paid = await tx.ceresPaymentRequest.findUniqueOrThrow({ where: { id: existing.id } });
      return { outcome: 'paid', request: paid, moneyEvent, decisionEventId: decisionEvent.id };
    }

    // role === 'ceo' — the CEO is always the final authority; a successful approve never
    // escalates further (mirrors decideStaffRequestByCeo in requestService.ts).
    if (existing.approvalStatus !== 'pending_ceo') throw new CeresRequestError('not_pending_ceo');
    const changed = await tx.ceresPaymentRequest.updateMany({
      where: { id: existing.id, approvalStatus: 'pending_ceo', rowVersion: existing.rowVersion },
      data: {
        approvalStatus: 'approved',
        decidedById: input.agent.id,
        decidedAt: new Date(),
        decisionNote: input.note ?? '',
        rowVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new CeresRequestError('conflict');
    const decisionEvent = await tx.ceresRequestEvent.create({
      data: {
        requestId: existing.id,
        kind: 'ceo_approved',
        actorId: input.agent.id,
        actorName: input.agent.name,
        note: input.note ?? '',
        payload: { approvalStatus: 'approved', oneFlow: true } as Prisma.InputJsonObject,
      },
    });
    const decided = await tx.ceresPaymentRequest.findUniqueOrThrow({ where: { id: existing.id } });
    const moneyEvent = await recordRequestMoneyEventInTx(tx, {
      requestId: decided.id,
      kind: 'payment',
      lane: input.lane,
      amount: decided.amount,
      transferSlipUploadId: input.transferSlipUploadId,
      createdById: input.agent.id,
      createdByName: input.agent.name,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
    });
    const paid = await tx.ceresPaymentRequest.findUniqueOrThrow({ where: { id: existing.id } });
    return { outcome: 'paid', request: paid, moneyEvent, decisionEventId: decisionEvent.id };
  });
}
