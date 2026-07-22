import type { Prisma } from '@prisma/client';
import type { AuthedAgent } from '../auth/jwt.js';
import { prisma } from '../db/prisma.js';
import { env } from '../env.js';
import { GROUP_COMPANY_CODES } from '../jupiter/companies.js';
import { readCeresReceiptMeta } from './receiptStore.js';
import { mediaCanBeAttachedBy, type CeresMediaPurpose } from './mediaAccess.js';
import {
  resolveMediaIdList,
  singleTargetLinkIds,
  writeMediaLinksInTx,
  replaceMediaLinksInTx,
} from './mediaLinks.js';
import {
  AI_MODEL,
  POLICY_VERSION,
  reviewStaffRequest,
} from './aiReview.js';
import { ceresRole } from './auth.js';
import { notifyCeoEscalation } from './notifyCeo.js';
import { num, parseRequestCategoryGroups } from '../routes/ceres/common.js';
import { notifyRequesterForEvent } from './notifyRequester.js';

export const V2_REQUEST_TYPES = ['advance', 'reimbursement', 'purchase'] as const;
export type V2RequestType = (typeof V2_REQUEST_TYPES)[number];
export type V2RequestScope = 'mine' | 'queue' | 'all';
export const STUCK_AI_REVIEW_MS = 5 * 60 * 1000;

// Owner policy: below this amount (baht, `amount` is already stored/parsed in baht — see
// `num()` in routes/ceres/common.ts) the AI pre-screen is skipped regardless of request type,
// same as the advance fast lane. Strictly-less-than: exactly ฿500.00 still gets screened.
export const AI_SCREEN_FLOOR_BAHT = 500;

// Why the AI screen is being skipped for this request, or null if it isn't skipped.
// Both reasons use the same `clear` + `skipped_by_policy` event mechanics as the pre-existing
// advance fast lane; the payload's `policyReason` distinguishes them without new schema.
function aiSkipReason(type: V2RequestType, amount: string): 'advance' | 'below_floor' | null {
  if (type === 'advance') return 'advance';
  if (num(amount) < AI_SCREEN_FLOOR_BAHT) return 'below_floor';
  return null;
}

export class CeresRequestError extends Error {
  constructor(
    public code:
      | 'not_found'
      | 'forbidden'
      | 'invalid_entity'
      | 'invalid_category'
      | 'invalid_group'
      | 'invalid_reason'
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
  category?: string;
  categoryGroups?: string[];
  amount: string;
  reason?: string;
  requestPhotoUploadId?: string | null;
  requestPhotoUploadIds?: string[];
}

interface NormalizedV2RequestInput {
  requestType: V2RequestType;
  entity: string;
  category: string;
  categoryGroups: string[];
  amount: string;
  reason: string;
  requestPhotoUploadId?: string | null;
  requestPhotoUploadIds?: string[];
}

type RequestRow = NonNullable<Awaited<ReturnType<typeof prisma.ceresPaymentRequest.findUnique>>>;

function evidencePurposes(type: V2RequestType): readonly CeresMediaPurpose[] {
  return type === 'reimbursement' ? ['reimbursement_receipt'] : ['request_photo'];
}

function normalizeRequestInput(input: V2RequestInput): NormalizedV2RequestInput {
  const advance = input.requestType === 'advance';
  return {
    ...input,
    category: advance ? (input.category ?? '').trim() : (input.category ?? ''),
    categoryGroups: [...new Set((input.categoryGroups ?? []).map((group) => group.trim()))],
    reason: advance ? (input.reason ?? '').trim() : (input.reason ?? ''),
  };
}

function sameGroups(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((group, index) => group === right[index]);
}

async function validateReferences(
  input: NormalizedV2RequestInput,
  mediaIds: readonly string[],
  agent: AuthedAgent,
  validateCategory = true,
  validateGroups = true,
) {
  if (!(GROUP_COMPANY_CODES as readonly string[]).includes(input.entity)) {
    throw new CeresRequestError('invalid_entity');
  }
  if (input.requestType === 'advance') {
    if (input.categoryGroups.length < 1 || input.categoryGroups.length > 7 || input.categoryGroups.some((group) => !group)) {
      throw new CeresRequestError('invalid_group');
    }
    if (validateGroups) {
      const activeGroups = await prisma.ceresCategory.findMany({
        where: { active: true },
        select: { group: true },
        distinct: ['group'],
      });
      const valid = new Set(activeGroups.map((row) => row.group));
      if (input.categoryGroups.some((group) => !valid.has(group))) {
        throw new CeresRequestError('invalid_group');
      }
    }
  } else {
    if (input.categoryGroups.length > 0) throw new CeresRequestError('invalid_group');
    if (!input.reason) throw new CeresRequestError('invalid_reason');
  }
  if (input.requestType !== 'advance' && validateCategory) {
    const category = await prisma.ceresCategory.findUnique({ where: { name: input.category } });
    if (!category?.active) throw new CeresRequestError('invalid_category');
  }
  if (input.requestType === 'reimbursement' && mediaIds.length === 0) {
    throw new CeresRequestError('receipt_required');
  }

  let media: Awaited<ReturnType<typeof mediaCanBeAttachedBy>> = null;
  let receiptMeta: Awaited<ReturnType<typeof readCeresReceiptMeta>> = null;
  for (let i = 0; i < mediaIds.length; i++) {
    const m = await mediaCanBeAttachedBy(mediaIds[i], agent, evidencePurposes(input.requestType));
    if (!m) throw new CeresRequestError('media_not_owned');
    if (i === 0) {
      media = m;
      receiptMeta = await readCeresReceiptMeta(mediaIds[i]);
    }
  }
  return { media, receiptMeta };
}

function snapshot(row: RequestRow): Prisma.InputJsonObject {
  return {
    requestType: row.requestType,
    entity: row.entity,
    category: row.category,
    categoryGroups: parseRequestCategoryGroups(row.categoryGroups),
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
  const normalized = normalizeRequestInput(input);
  // Array wins over singular when both are sent (silently de-duplicated); element 0 stays
  // the "primary" value on the existing requestPhotoUploadId/requestPhotoSha columns.
  const mediaIds = resolveMediaIdList(normalized.requestPhotoUploadId, normalized.requestPhotoUploadIds);
  const { media, receiptMeta } = await validateReferences(normalized, mediaIds, agent);
  const party = await prisma.ceresParty.findFirst({ where: { agentEmail: agent.email, active: true } });
  if (ceresRole(agent) === 'messenger' && !party) throw new CeresRequestError('no_party');
  const skipReason = aiSkipReason(normalized.requestType, normalized.amount);

  const created = await prisma.$transaction(async (tx) => {
    const request = await tx.ceresPaymentRequest.create({
      data: {
        requestedById: agent.id,
        requestedByName: agent.name,
        requesterPartyId: party?.id ?? null,
        entity: normalized.entity,
        payee: agent.name,
        category: normalized.requestType === 'advance' ? '' : normalized.category,
        categoryGroups: normalized.requestType === 'advance' ? JSON.stringify(normalized.categoryGroups) : '',
        amount: normalized.amount,
        detail: normalized.reason,
        workflowVersion: 2,
        requestType: normalized.requestType,
        approvalStatus: 'pending_nee',
        fulfillmentStatus: 'unfulfilled',
        requestPhotoUploadId: mediaIds[0] ?? null,
        requestPhotoSha: media?.sha256 ?? '',
        ocrAmount: receiptMeta?.ocrAmount ?? '',
        ocrVendor: receiptMeta?.ocrVendor ?? '',
        ocrDate: receiptMeta?.ocrDate ?? '',
        aiScreenStatus: skipReason ? 'clear' : 'pending',
      },
    });
    await writeMediaLinksInTx(tx, 'request', request.id, 'request_photo', mediaIds);
    await tx.ceresRequestEvent.create({
      data: {
        requestId: request.id,
        kind: 'submitted',
        actorId: agent.id,
        actorName: agent.name,
        payload: skipReason
          ? { ...snapshot(request), ai: 'skipped_by_policy', policyReason: skipReason }
          : snapshot(request),
      },
    });
    return request;
  });
  return skipReason
    ? created
    : applyAIResult(created.id, created.rowVersion);
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

  const existingGroups = parseRequestCategoryGroups(existing.categoryGroups);
  // Array wins over singular when both are sent. Neither sent = untouched: preserve
  // whatever's already attached (link rows, else the singular column) rather than
  // dropping it on an edit that only changes some other field.
  const photoTouched = patch.requestPhotoUploadId !== undefined || patch.requestPhotoUploadIds !== undefined;
  const mediaIds = photoTouched
    ? resolveMediaIdList(patch.requestPhotoUploadId ?? null, patch.requestPhotoUploadIds)
    : await (async () => {
      const existingLinkIds = await singleTargetLinkIds('request', existing.id, 'request_photo');
      return existingLinkIds.length > 0 ? existingLinkIds : resolveMediaIdList(existing.requestPhotoUploadId, undefined);
    })();
  const merged = normalizeRequestInput({
    requestType: (patch.requestType ?? existing.requestType) as V2RequestType,
    entity: patch.entity ?? existing.entity,
    category: patch.category ?? existing.category,
    categoryGroups: patch.categoryGroups
      ?? ((patch.requestType ?? existing.requestType) === existing.requestType ? existingGroups : []),
    amount: patch.amount ?? existing.amount,
    reason: patch.reason ?? existing.detail,
    requestPhotoUploadId: mediaIds[0] ?? null,
  });
  const categoryChanged = merged.requestType !== existing.requestType || merged.category !== existing.category;
  const groupsChanged = merged.requestType !== existing.requestType || !sameGroups(merged.categoryGroups, existingGroups);
  const { media, receiptMeta } = await validateReferences(merged, mediaIds, agent, categoryChanged, groupsChanged);
  const skipReason = aiSkipReason(merged.requestType, merged.amount);

  const updated = await prisma.$transaction(async (tx) => {
    const changed = await tx.ceresPaymentRequest.updateMany({
      where: { id: existing.id, workflowVersion: 2, approvalStatus: 'pending_nee', rowVersion: existing.rowVersion },
      data: {
        requestType: merged.requestType,
        entity: merged.entity,
        category: merged.category,
        categoryGroups: merged.requestType === 'advance' ? JSON.stringify(merged.categoryGroups) : '',
        amount: merged.amount,
        detail: merged.reason,
        payee: agent.name,
        requestPhotoUploadId: mediaIds[0] ?? null,
        requestPhotoSha: media?.sha256 ?? '',
        ocrAmount: receiptMeta?.ocrAmount ?? '',
        ocrVendor: receiptMeta?.ocrVendor ?? '',
        ocrDate: receiptMeta?.ocrDate ?? '',
        aiScreenStatus: skipReason ? 'clear' : 'pending',
        aiReviewId: null,
        rowVersion: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new CeresRequestError('conflict');
    const request = await tx.ceresPaymentRequest.findUnique({ where: { id: existing.id } });
    if (!request) throw new CeresRequestError('not_found');
    if (photoTouched) {
      await replaceMediaLinksInTx(tx, 'request', request.id, 'request_photo', mediaIds);
    }
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
          payload: skipReason
            ? { before: snapshot(existing), after: snapshot(request), ai: 'skipped_by_policy', policyReason: skipReason }
            : { before: snapshot(existing), after: snapshot(request) },
        },
      }),
    ]);
    return request;
  });
  return skipReason
    ? updated
    : applyAIResult(updated.id, updated.rowVersion);
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
