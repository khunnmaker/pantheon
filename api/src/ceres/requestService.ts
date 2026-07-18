import type { Prisma } from '@prisma/client';
import type { AuthedAgent } from '../auth/jwt.js';
import { prisma } from '../db/prisma.js';
import { env } from '../env.js';
import { GROUP_COMPANY_CODES } from '../jupiter/companies.js';
import { readCeresReceiptMeta } from './receiptStore.js';
import { mediaCanBeAttachedBy, type CeresMediaPurpose } from './mediaAccess.js';
import {
  AI_MODEL,
  POLICY_VERSION,
  reviewStaffRequest,
} from './aiReview.js';
import { ceresRole } from './auth.js';
import { notifyCeoEscalation } from './notifyCeo.js';
import { num } from '../routes/ceres/common.js';
import { notifyRequesterForEvent } from './notifyRequester.js';

export const V2_REQUEST_TYPES = ['advance', 'reimbursement', 'purchase'] as const;
export type V2RequestType = (typeof V2_REQUEST_TYPES)[number];
export type V2RequestScope = 'mine' | 'queue' | 'all';
export const STUCK_AI_REVIEW_MS = 5 * 60 * 1000;

export class CeresRequestError extends Error {
  constructor(
    public code:
      | 'not_found'
      | 'forbidden'
      | 'invalid_entity'
      | 'invalid_category'
      | 'no_party'
      | 'receipt_required'
      | 'media_not_owned'
      | 'not_editable'
      | 'not_cancellable'
      | 'ai_review_pending'
      | 'not_pending_nee'
      | 'not_pending_ceo'
      | 'conflict',
  ) {
    super(code);
  }
}

export interface V2RequestInput {
  requestType: V2RequestType;
  entity: string;
  category: string;
  amount: string;
  reason: string;
  requestPhotoUploadId?: string | null;
}

type RequestRow = NonNullable<Awaited<ReturnType<typeof prisma.ceresPaymentRequest.findUnique>>>;

function evidencePurposes(type: V2RequestType): readonly CeresMediaPurpose[] {
  return type === 'reimbursement' ? ['reimbursement_receipt'] : ['request_photo'];
}

async function validateReferences(input: V2RequestInput, agent: AuthedAgent, validateCategory = true) {
  if (!(GROUP_COMPANY_CODES as readonly string[]).includes(input.entity)) {
    throw new CeresRequestError('invalid_entity');
  }
  if (validateCategory) {
    const category = await prisma.ceresCategory.findUnique({ where: { name: input.category } });
    if (!category?.active) throw new CeresRequestError('invalid_category');
  }
  if (input.requestType === 'reimbursement' && !input.requestPhotoUploadId) {
    throw new CeresRequestError('receipt_required');
  }

  let media: Awaited<ReturnType<typeof mediaCanBeAttachedBy>> = null;
  let receiptMeta: Awaited<ReturnType<typeof readCeresReceiptMeta>> = null;
  if (input.requestPhotoUploadId) {
    media = await mediaCanBeAttachedBy(input.requestPhotoUploadId, agent, evidencePurposes(input.requestType));
    if (!media) throw new CeresRequestError('media_not_owned');
    receiptMeta = await readCeresReceiptMeta(input.requestPhotoUploadId);
  }
  return { media, receiptMeta };
}

function snapshot(row: RequestRow): Prisma.InputJsonObject {
  return {
    requestType: row.requestType,
    entity: row.entity,
    category: row.category,
    amount: row.amount,
    reason: row.detail,
    requestPhotoUploadId: row.requestPhotoUploadId,
    requestPhotoSha: row.requestPhotoSha,
    aiScreenStatus: row.aiScreenStatus,
    approvalStatus: row.approvalStatus,
    rowVersion: row.rowVersion,
  };
}

async function applyAIResult(requestId: string, expectedRowVersion: number) {
  const result = await reviewStaffRequest(requestId);
  await prisma.$transaction(async (tx) => {
    const changed = await tx.ceresPaymentRequest.updateMany({
      where: {
        id: requestId,
        workflowVersion: 2,
        rowVersion: expectedRowVersion,
        aiScreenStatus: 'pending',
      },
      data: {
        aiScreenStatus: result.verdict,
        aiReviewId: result.reviewId,
        rowVersion: { increment: 1 },
      },
    });
    if (changed.count === 1) {
      await tx.ceresRequestEvent.create({
        data: {
          requestId,
          kind: 'ai_screened',
          note: result.reasoning,
          payload: { verdict: result.verdict, reviewId: result.reviewId },
        },
      });
    }
  });
  const request = await prisma.ceresPaymentRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new CeresRequestError('not_found');
  return request;
}

export async function createStaffRequest(input: V2RequestInput, agent: AuthedAgent) {
  const { media, receiptMeta } = await validateReferences(input, agent);
  const party = await prisma.ceresParty.findFirst({ where: { agentEmail: agent.email, active: true } });
  if (ceresRole(agent) === 'messenger' && !party) throw new CeresRequestError('no_party');

  const created = await prisma.$transaction(async (tx) => {
    const request = await tx.ceresPaymentRequest.create({
      data: {
        requestedById: agent.id,
        requestedByName: agent.name,
        requesterPartyId: party?.id ?? null,
        entity: input.entity,
        payee: agent.name,
        category: input.category,
        amount: input.amount,
        detail: input.reason,
        workflowVersion: 2,
        requestType: input.requestType,
        approvalStatus: 'pending_nee',
        fulfillmentStatus: 'unfulfilled',
        requestPhotoUploadId: input.requestPhotoUploadId ?? null,
        requestPhotoSha: media?.sha256 ?? '',
        ocrAmount: receiptMeta?.ocrAmount ?? '',
        ocrVendor: receiptMeta?.ocrVendor ?? '',
        ocrDate: receiptMeta?.ocrDate ?? '',
        aiScreenStatus: 'pending',
      },
    });
    await tx.ceresRequestEvent.create({
      data: {
        requestId: request.id,
        kind: 'submitted',
        actorId: agent.id,
        actorName: agent.name,
        payload: snapshot(request),
      },
    });
    return request;
  });
  return applyAIResult(created.id, created.rowVersion);
}

export async function editStaffRequest(
  requestId: string,
  patch: Partial<V2RequestInput>,
  agent: AuthedAgent,
) {
  const existing = await prisma.ceresPaymentRequest.findUnique({ where: { id: requestId } });
  if (!existing || existing.workflowVersion !== 2) throw new CeresRequestError('not_found');
  if (existing.requestedById !== agent.id) throw new CeresRequestError('forbidden');
  if (existing.approvalStatus !== 'pending_nee') throw new CeresRequestError('not_editable');

  const merged: V2RequestInput = {
    requestType: (patch.requestType ?? existing.requestType) as V2RequestType,
    entity: patch.entity ?? existing.entity,
    category: patch.category ?? existing.category,
    amount: patch.amount ?? existing.amount,
    reason: patch.reason ?? existing.detail,
    requestPhotoUploadId: patch.requestPhotoUploadId === undefined
      ? existing.requestPhotoUploadId
      : patch.requestPhotoUploadId,
  };
  const { media, receiptMeta } = await validateReferences(merged, agent, merged.category !== existing.category);

  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.ceresPaymentRequest.updateMany({
      where: { id: existing.id, workflowVersion: 2, approvalStatus: 'pending_nee', rowVersion: existing.rowVersion },
      data: {
        requestType: merged.requestType,
        entity: merged.entity,
        category: merged.category,
        amount: merged.amount,
        detail: merged.reason,
        payee: agent.name,
        requestPhotoUploadId: merged.requestPhotoUploadId ?? null,
        requestPhotoSha: media?.sha256 ?? '',
        ocrAmount: receiptMeta?.ocrAmount ?? '',
        ocrVendor: receiptMeta?.ocrVendor ?? '',
        ocrDate: receiptMeta?.ocrDate ?? '',
        aiScreenStatus: 'pending',
        aiReviewId: null,
        rowVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new CeresRequestError('conflict');
    const request = await tx.ceresPaymentRequest.findUnique({ where: { id: existing.id } });
    if (!request) throw new CeresRequestError('not_found');
    await Promise.all([
      tx.ceresRevision.create({
        data: {
          subjectType: 'paymentRequest',
          subjectId: request.id,
          changedById: agent.id,
          changedByName: agent.name,
          before: snapshot(existing),
          after: snapshot(request),
          reason: 'requester_edit',
        },
      }),
      tx.ceresRequestEvent.create({
        data: {
          requestId: request.id,
          kind: 'edited',
          actorId: agent.id,
          actorName: agent.name,
          payload: { before: snapshot(existing), after: snapshot(request) },
        },
      }),
    ]);
    return request;
  });
  return applyAIResult(updated.id, updated.rowVersion);
}

export function neeApprovalTarget(request: Pick<RequestRow, 'amount' | 'aiScreenStatus'>): 'pending_ceo' | 'approved' {
  return num(request.amount) > env.CERES_CEO_THRESHOLD || request.aiScreenStatus !== 'clear'
    ? 'pending_ceo'
    : 'approved';
}

export async function decideStaffRequestByNee(
  requestId: string,
  decision: 'approve' | 'reject',
  note: string,
  agent: AuthedAgent,
) {
  const existing = await prisma.ceresPaymentRequest.findUnique({ where: { id: requestId } });
  if (!existing || existing.workflowVersion !== 2) throw new CeresRequestError('not_found');
  if (existing.approvalStatus !== 'pending_nee') throw new CeresRequestError('not_pending_nee');
  if (existing.aiScreenStatus !== 'clear' && existing.aiScreenStatus !== 'escalate') {
    throw new CeresRequestError('ai_review_pending');
  }
  const next = decision === 'reject' ? 'rejected' : neeApprovalTarget(existing);
  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.ceresPaymentRequest.updateMany({
      where: { id: existing.id, approvalStatus: 'pending_nee', rowVersion: existing.rowVersion },
      data: {
        approvalStatus: next,
        neeDecidedById: agent.id,
        neeDecidedByName: agent.name,
        neeDecidedAt: new Date(),
        neeDecisionNote: note,
        rowVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new CeresRequestError('conflict');
    const event = await tx.ceresRequestEvent.create({
      data: {
        requestId: existing.id,
        kind: decision === 'approve' ? 'nee_approved' : 'nee_rejected',
        actorId: agent.id,
        actorName: agent.name,
        note,
        payload: { approvalStatus: next },
      },
    });
    const request = await tx.ceresPaymentRequest.findUniqueOrThrow({ where: { id: existing.id } });
    return { request, eventId: event.id };
  });

  const updated = result.request;
  await notifyRequesterForEvent(result.eventId);

  // Notifications are deliberately after commit and best-effort inside notifyCeoEscalation.
  if (updated.approvalStatus === 'pending_ceo') {
    const review = updated.aiReviewId
      ? await prisma.ceresAIReview.findUnique({ where: { id: updated.aiReviewId } })
      : null;
    void notifyCeoEscalation(
      { payee: updated.payee, amount: updated.amount, entity: updated.entity, requestedByName: updated.requestedByName },
      review?.reasoning || `ยอดเกินเกณฑ์ ${env.CERES_CEO_THRESHOLD} บาท`,
    );
  }
  return updated;
}

export async function decideStaffRequestByCeo(
  requestId: string,
  decision: 'approve' | 'reject',
  note: string,
  agent: AuthedAgent,
) {
  const existing = await prisma.ceresPaymentRequest.findUnique({ where: { id: requestId } });
  if (!existing || existing.workflowVersion !== 2) throw new CeresRequestError('not_found');
  if (existing.approvalStatus !== 'pending_ceo') throw new CeresRequestError('not_pending_ceo');
  const next = decision === 'approve' ? 'approved' : 'rejected';
  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.ceresPaymentRequest.updateMany({
      where: { id: existing.id, approvalStatus: 'pending_ceo', rowVersion: existing.rowVersion },
      data: {
        approvalStatus: next,
        decidedById: agent.id,
        decidedAt: new Date(),
        decisionNote: note,
        rowVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new CeresRequestError('conflict');
    const event = await tx.ceresRequestEvent.create({
      data: {
        requestId: existing.id,
        kind: decision === 'approve' ? 'ceo_approved' : 'ceo_rejected',
        actorId: agent.id,
        actorName: agent.name,
        note,
        payload: { approvalStatus: next },
      },
    });
    const request = await tx.ceresPaymentRequest.findUniqueOrThrow({ where: { id: existing.id } });
    return { request, eventId: event.id };
  });
  await notifyRequesterForEvent(result.eventId);
  return result.request;
}

export async function cancelStaffRequest(requestId: string, note: string, agent: AuthedAgent) {
  const existing = await prisma.ceresPaymentRequest.findUnique({ where: { id: requestId } });
  if (!existing || existing.workflowVersion !== 2) throw new CeresRequestError('not_found');
  const manager = ceresRole(agent) === 'gm' || ceresRole(agent) === 'ceo';
  const requesterMayCancel = existing.requestedById === agent.id && existing.approvalStatus === 'pending_nee';
  const managerMayCancel = manager
    && existing.fulfillmentStatus === 'unfulfilled'
    && !['rejected', 'cancelled', 'void'].includes(existing.approvalStatus);
  if (!requesterMayCancel && !managerMayCancel) throw new CeresRequestError('not_cancellable');

  return prisma.$transaction(async (tx) => {
    const changed = await tx.ceresPaymentRequest.updateMany({
      where: { id: existing.id, rowVersion: existing.rowVersion },
      data: { approvalStatus: 'cancelled', rowVersion: { increment: 1 } },
    });
    if (changed.count !== 1) throw new CeresRequestError('conflict');
    await tx.ceresRequestEvent.create({
      data: {
        requestId: existing.id,
        kind: 'cancelled',
        actorId: agent.id,
        actorName: agent.name,
        note,
        payload: { priorApprovalStatus: existing.approvalStatus },
      },
    });
    return tx.ceresPaymentRequest.findUniqueOrThrow({ where: { id: existing.id } });
  });
}

// Lazy fail-closed timeout: any request left in `pending` (process crash, lost response,
// deployment) becomes an explicit escalation on the next read instead of disappearing.
export async function ageStuckAIReviews(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_AI_REVIEW_MS);
  const stuck = await prisma.ceresPaymentRequest.findMany({
    where: { workflowVersion: 2, aiScreenStatus: 'pending', updatedAt: { lt: cutoff } },
    select: { id: true, rowVersion: true },
  });
  let aged = 0;
  for (const request of stuck) {
    await prisma.$transaction(async (tx) => {
      const review = await tx.ceresAIReview.create({
        data: {
          subjectType: 'paymentRequest',
          subjectId: request.id,
          verdict: 'escalate',
          reasoning: 'AI ตรวจไม่เสร็จภายในเวลาที่กำหนด — ส่งต่อผู้บริหาร (fail-closed)',
          policyVersion: POLICY_VERSION,
          model: AI_MODEL,
        },
      });
      const changed = await tx.ceresPaymentRequest.updateMany({
        where: { id: request.id, rowVersion: request.rowVersion, aiScreenStatus: 'pending' },
        data: { aiScreenStatus: 'escalate', aiReviewId: review.id, rowVersion: { increment: 1 } },
      });
      if (changed.count === 1) {
        aged += 1;
        await tx.ceresRequestEvent.create({
          data: {
            requestId: request.id,
            kind: 'ai_screen_timeout',
            note: review.reasoning,
            payload: { verdict: 'escalate', reviewId: review.id },
          },
        });
      }
    });
  }
  return aged;
}

export async function listStaffRequests(agent: AuthedAgent, scope: V2RequestScope, limit = 200) {
  await ageStuckAIReviews();
  const role = ceresRole(agent);
  const where: Prisma.CeresPaymentRequestWhereInput = { workflowVersion: 2 };
  if (scope === 'mine') {
    where.requestedById = agent.id;
  } else if (scope === 'queue') {
    if (role === 'gm') where.approvalStatus = 'pending_nee';
    else if (role === 'ceo') where.approvalStatus = 'pending_ceo';
    else throw new CeresRequestError('forbidden');
  } else if (role !== 'gm' && role !== 'ceo') {
    throw new CeresRequestError('forbidden');
  }
  return prisma.ceresPaymentRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
}

export async function getStaffRequest(requestId: string, agent: AuthedAgent) {
  await ageStuckAIReviews();
  const request = await prisma.ceresPaymentRequest.findUnique({ where: { id: requestId } });
  if (!request || request.workflowVersion !== 2) throw new CeresRequestError('not_found');
  const role = ceresRole(agent);
  if (request.requestedById !== agent.id && role !== 'gm' && role !== 'ceo') {
    // Ownership failures intentionally look like absence to avoid leaking ids.
    throw new CeresRequestError('not_found');
  }
  return request;
}
