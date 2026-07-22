import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { ceresRole, requireCeresRole } from '../../ceres/auth.js';
import { mediaCanBeAttachedBy } from '../../ceres/mediaAccess.js';
import {
  CashLedgerError,
  fulfillRequest,
  getAdvanceLiquidation,
  refundAdvance,
  RequestMoneyError,
  requestMoneyLaneSchema,
  reverseRequestMoneyEvent,
} from '../../ceres/requestMoney.js';
import {
  cancelStaffRequest,
  CeresRequestError,
  createStaffRequest,
  decideStaffRequestByCeo,
  decideStaffRequestByNee,
  editStaffRequest,
  getStaffRequest,
  listStaffRequests,
  V2_REQUEST_TYPES,
} from '../../ceres/requestService.js';
import { RequestVoidError, voidStaffRequest } from '../../ceres/requestVoid.js';
import { notifyRequesterForMoneyEvent } from '../../ceres/notifyRequester.js';
import { isValidAmount, parseRequestCategoryGroups, thaiDayKey, toStaffRequestRow, toMoneyEventRow } from './common.js';
import { GROUP_COMPANY_CODES } from '../../jupiter/companies.js';
import { loadLinkMap, idsWithFallback, resolveIdsWithFallback, resolveMediaIdList } from '../../ceres/mediaLinks.js';

const ENTITIES = GROUP_COMPANY_CODES; // 5 group companies (SSOT: jupiter/companies.ts)

// Batch-load CeresAIReview rows by id (no N+1) and return a Map keyed by review id.
async function loadReviewsByIds(ids: (string | null)[]): Promise<Map<string, { verdict: string; reasoning: string; createdAt: Date }>> {
  const set = [...new Set(ids.filter((id): id is string => !!id))];
  if (set.length === 0) return new Map();
  const reviews = await prisma.ceresAIReview.findMany({ where: { id: { in: set } } });
  return new Map(reviews.map((r) => [r.id, r]));
}

function requestError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, err: unknown) {
  if (!(err instanceof CeresRequestError)) throw err;
  const status = err.code === 'not_found' ? 404
    : err.code === 'forbidden' || err.code === 'no_party' || err.code === 'media_not_owned' ? 403
      : ['not_editable', 'not_cancellable', 'ai_review_pending', 'not_pending_nee', 'not_pending_ceo', 'conflict'].includes(err.code) ? 409
        : 400;
  return reply.code(status).send({ error: err.code });
}

function moneyError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, err: unknown) {
  if (err instanceof CashLedgerError) {
    return reply.code(409).send({ error: err.code, balance: err.balance.toFixed(2) });
  }
  if (!(err instanceof RequestMoneyError)) throw err;
  const status = err.code === 'not_found' ? 404
    : ['not_approved', 'already_fulfilled', 'not_paid_advance', 'refund_exceeds_outstanding'].includes(err.code) ? 409
      : 400;
  return reply.code(status).send({ error: err.code });
}

// CEO-void error mapper — RequestVoidError carries an optional `detail` object (blocking
// liquidation children / outstanding balance) that the UI needs to list what's in the way
// (owner spec: "ต้องจัดการรายการลูกก่อน" listing what blocks it), so it's spread onto the
// body rather than collapsed to a bare {error} like the other mappers above. Falls through
// to moneyError for the (defensive, not expected in practice — see requestVoid.ts's report
// notes) case where the composed reversal itself refuses.
function voidError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, err: unknown) {
  if (err instanceof RequestVoidError) {
    const status = err.code === 'not_found' ? 404 : 409;
    return reply.code(status).send({ error: err.code, ...(err.detail ?? {}) });
  }
  return moneyError(reply, err);
}

// Last day of the given month (1-indexed month, in the Thai/local calendar sense —
// callers pass Thai-shifted y/m so this only needs plain calendar math).
function lastDayOfMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}

export interface TemplateDue {
  template: {
    id: string;
    payee: string;
    entity: string;
    category: string;
    expectedAmount: string;
    tolerancePct: number;
    period: string;
    dueDay: number;
    graceDays: number;
    active: boolean;
    note: string;
  };
  periodKey: string;
  dueDate: string; // ISO date (YYYY-MM-DD)
  state: 'paid' | 'pending' | 'missing' | 'overdue';
}

// Per-ACTIVE-template due computation (Thai time) shared by GET /templates/due and the
// CEO overview's missed-bills section.
export async function computeTemplateDue(): Promise<TemplateDue[]> {
  const templates = await prisma.ceresRecurringTemplate.findMany({ where: { active: true }, orderBy: { payee: 'asc' } });
  if (templates.length === 0) return [];

  const now = new Date();
  const thaiNow = new Date(now.getTime() + 7 * 3600 * 1000);
  const y = thaiNow.getUTCFullYear();
  const m = thaiNow.getUTCMonth() + 1; // 1-12
  const todayKey = thaiDayKey(now);

  const results: TemplateDue[] = [];
  for (const t of templates) {
    let periodKey: string;
    let dueYear = y;
    let dueMonth = m;
    if (t.period === 'quarterly') {
      const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
      const q = Math.floor((m - 1) / 3) + 1;
      periodKey = `${y}-Q${q}`;
      dueMonth = qStartMonth;
    } else if (t.period === 'yearly') {
      periodKey = `${y}`;
      dueMonth = 1;
    } else {
      periodKey = `${y}-${String(m).padStart(2, '0')}`;
      dueMonth = m;
    }
    const clampedDay = Math.min(t.dueDay, lastDayOfMonth(dueYear, dueMonth));
    const dueDateStr = `${dueYear}-${String(dueMonth).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;

    const existing = await prisma.ceresPaymentRequest.findFirst({
      where: { recurringTemplateId: t.id, billPeriod: periodKey },
      orderBy: { createdAt: 'desc' },
    });

    let state: TemplateDue['state'];
    if (existing && ['ai_approved', 'ceo_approved', 'paid'].includes(existing.status)) {
      state = 'paid';
    } else if (existing && ['requested', 'escalated'].includes(existing.status)) {
      state = 'pending';
    } else {
      const graceEnd = new Date(`${dueDateStr}T00:00:00+07:00`);
      graceEnd.setUTCDate(graceEnd.getUTCDate() + t.graceDays);
      const graceEndKey = thaiDayKey(graceEnd);
      state = todayKey > graceEndKey ? 'overdue' : 'missing';
    }

    results.push({
      template: {
        id: t.id,
        payee: t.payee,
        entity: t.entity,
        category: t.category,
        expectedAmount: t.expectedAmount,
        tolerancePct: t.tolerancePct,
        period: t.period,
        dueDay: t.dueDay,
        graceDays: t.graceDays,
        active: t.active,
        note: t.note,
      },
      periodKey,
      dueDate: dueDateStr,
      state,
    });
  }
  return results;
}

// P2/P3 routes — GM's pre-approval payment requests + recurring templates. Mounted
// inside the requireCeresAuth scope (see routes/ceres/index.ts).
export function requestsRoutes(app: FastifyInstance) {
  const v2CreateBody = z.discriminatedUnion('requestType', [
    z.object({
      requestType: z.literal('advance'),
      entity: z.enum(ENTITIES),
      category: z.string().max(200).optional(),
      categoryGroups: z.array(z.string().trim().min(1).max(200)).min(1).max(7),
      amount: z.string().refine(isValidAmount, 'invalid_amount'),
      reason: z.string().max(600).optional(),
      requestPhotoUploadId: z.string().min(1).nullable().optional(),
      requestPhotoUploadIds: z.array(z.string().min(1)).max(10).optional(),
    }).strict(),
    z.object({
      requestType: z.literal('reimbursement'),
      entity: z.enum(ENTITIES),
      category: z.string().min(1).max(200),
      categoryGroups: z.array(z.string()).max(0).optional(),
      amount: z.string().refine(isValidAmount, 'invalid_amount'),
      reason: z.string().min(1).max(600),
      requestPhotoUploadId: z.string().min(1).nullable().optional(),
      requestPhotoUploadIds: z.array(z.string().min(1)).max(10).optional(),
    }).strict(),
    z.object({
      requestType: z.literal('purchase'),
      entity: z.enum(ENTITIES),
      category: z.string().min(1).max(200),
      categoryGroups: z.array(z.string()).max(0).optional(),
      amount: z.string().refine(isValidAmount, 'invalid_amount'),
      reason: z.string().min(1).max(600),
      requestPhotoUploadId: z.string().min(1).nullable().optional(),
      requestPhotoUploadIds: z.array(z.string().min(1)).max(10).optional(),
    }).strict(),
  ]);

  // POST /api/ceres/requests — staff submits a workflow-v2 money request.
  app.post('/api/ceres/requests', { preHandler: requireCeresRole('messenger', 'gm', 'ceo') }, async (req, reply) => {
    const parsed = v2CreateBody.safeParse(req.body);
    if (!parsed.success) {
      const amountIssue = parsed.error.issues.some((i) => i.message === 'invalid_amount');
      return reply.code(400).send({ error: amountIssue ? 'invalid_amount' : 'invalid_body' });
    }
    try {
      const request = await createStaffRequest(parsed.data, req.agent!);
      const review = request.aiReviewId
        ? await prisma.ceresAIReview.findUnique({ where: { id: request.aiReviewId } })
        : null;
      const requestPhotoUploadIds = await resolveIdsWithFallback('request', request.id, 'request_photo', request.requestPhotoUploadId);
      return { request: toStaffRequestRow(request, review, requestPhotoUploadIds) };
    } catch (err) {
      return requestError(reply, err);
    }
  });

  // GET /api/ceres/requests?scope=&limit= (the old workflow query is tolerated and ignored).
  const listQuery = z.object({
    workflow: z.coerce.number().int().optional(),
    scope: z.enum(['mine', 'queue', 'all']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });
  app.get('/api/ceres/requests', { preHandler: requireCeresRole('messenger', 'gm', 'ceo') }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const q = parsed.data;

    try {
      const rows = await listStaffRequests(req.agent!, q.scope ?? 'mine', q.limit ?? 200);
      const reviewMap = await loadReviewsByIds(rows.map((r) => r.aiReviewId));
      // Batched multi-image lookup (no N+1): one findMany across every row's id.
      const linkMap = await loadLinkMap('request', rows.map((r) => r.id), 'request_photo');
      return {
        requests: rows.map((r) => toStaffRequestRow(
          r,
          r.aiReviewId ? reviewMap.get(r.aiReviewId) ?? null : null,
          idsWithFallback(linkMap, r.id, r.requestPhotoUploadId),
        )),
      };
    } catch (err) {
      return requestError(reply, err);
    }
  });

  // GET /api/ceres/requests/:id
  app.get<{ Params: { id: string } }>(
    '/api/ceres/requests/:id',
    { preHandler: requireCeresRole('messenger', 'gm', 'ceo') },
    async (req, reply) => {
      const existing = await prisma.ceresPaymentRequest.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.workflowVersion !== 2) return reply.code(404).send({ error: 'not_found' });
      try {
        const request = await getStaffRequest(existing.id, req.agent!);
        const review = request.aiReviewId
          ? await prisma.ceresAIReview.findUnique({ where: { id: request.aiReviewId } })
          : null;
        const [events, revisions, moneyEvents, requestPhotoUploadIds] = await Promise.all([
          prisma.ceresRequestEvent.findMany({ where: { requestId: request.id }, orderBy: { createdAt: 'asc' } }),
          prisma.ceresRevision.findMany({
            where: { subjectType: 'paymentRequest', subjectId: request.id },
            orderBy: { createdAt: 'asc' },
          }),
          prisma.ceresRequestMoneyEvent.findMany({ where: { requestId: request.id }, orderBy: { createdAt: 'asc' } }),
          resolveIdsWithFallback('request', request.id, 'request_photo', request.requestPhotoUploadId),
        ]);
        // Batched multi-image lookup for the money events on this one request (no N+1
        // across the two evidence purposes).
        const eventIds = moneyEvents.map((e) => e.id);
        const [transferMap, purchaseMap] = await Promise.all([
          loadLinkMap('money_event', eventIds, 'transfer_slip'),
          loadLinkMap('money_event', eventIds, 'purchase_receipt'),
        ]);
        const moneyEventRows = moneyEvents.map((e) => toMoneyEventRow(
          e,
          idsWithFallback(transferMap, e.id, e.transferSlipUploadId),
          idsWithFallback(purchaseMap, e.id, e.purchaseReceiptUploadId),
        ));
        return {
          request: toStaffRequestRow(request, review, requestPhotoUploadIds),
          events,
          revisions,
          moneyEvents: moneyEventRows,
        };
      } catch (err) {
        return requestError(reply, err);
      }
    },
  );

  const v2PatchBody = z.object({
    requestType: z.enum(V2_REQUEST_TYPES).optional(),
    entity: z.enum(ENTITIES).optional(),
    category: z.string().max(200).optional(),
    categoryGroups: z.array(z.string().trim().min(1).max(200)).max(7).optional(),
    amount: z.string().refine(isValidAmount, 'invalid_amount').optional(),
    reason: z.string().max(600).optional(),
    requestPhotoUploadId: z.string().min(1).nullable().optional(),
    requestPhotoUploadIds: z.array(z.string().min(1)).max(10).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0);
  app.patch<{ Params: { id: string } }>(
    '/api/ceres/requests/:id',
    { preHandler: requireCeresRole('messenger', 'gm', 'ceo') },
    async (req, reply) => {
      const parsed = v2PatchBody.safeParse(req.body);
      if (!parsed.success) {
        const amountIssue = parsed.error.issues.some((i) => i.message === 'invalid_amount');
        return reply.code(400).send({ error: amountIssue ? 'invalid_amount' : 'invalid_body' });
      }
      const existing = await prisma.ceresPaymentRequest.findUnique({ where: { id: req.params.id } });
      if (existing) {
        const finalType = parsed.data.requestType ?? existing.requestType;
        if (finalType !== 'advance') {
          const finalCategory = parsed.data.category ?? existing.category;
          const finalReason = parsed.data.reason ?? existing.detail;
          // Type change away from advance: stored groups are dropped, not inherited —
          // otherwise converting a group-based advance to purchase/reimbursement can never pass.
          const finalGroups = parsed.data.categoryGroups
            ?? (finalType === existing.requestType ? parseRequestCategoryGroups(existing.categoryGroups) : []);
          if (!finalCategory || !finalReason || finalGroups.length > 0) {
            return reply.code(400).send({ error: 'invalid_body' });
          }
        }
      }
      try {
        const request = await editStaffRequest(req.params.id, parsed.data, req.agent!);
        const review = request.aiReviewId
          ? await prisma.ceresAIReview.findUnique({ where: { id: request.aiReviewId } })
          : null;
        const requestPhotoUploadIds = await resolveIdsWithFallback('request', request.id, 'request_photo', request.requestPhotoUploadId);
        return { request: toStaffRequestRow(request, review, requestPhotoUploadIds) };
      } catch (err) {
        return requestError(reply, err);
      }
    },
  );

  const decideBody = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(600).optional() });
  app.post<{ Params: { id: string } }>(
    '/api/ceres/requests/:id/nee-decision',
    { preHandler: requireCeresRole('gm') },
    async (req, reply) => {
      const parsed = decideBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      try {
        const request = await decideStaffRequestByNee(req.params.id, parsed.data.decision, parsed.data.note ?? '', req.agent!);
        const review = request.aiReviewId
          ? await prisma.ceresAIReview.findUnique({ where: { id: request.aiReviewId } })
          : null;
        const requestPhotoUploadIds = await resolveIdsWithFallback('request', request.id, 'request_photo', request.requestPhotoUploadId);
        return { request: toStaffRequestRow(request, review, requestPhotoUploadIds) };
      } catch (err) {
        return requestError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/ceres/requests/:id/ceo-decision',
    { preHandler: requireCeresRole('ceo') },
    async (req, reply) => {
      const parsed = decideBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      try {
        const request = await decideStaffRequestByCeo(req.params.id, parsed.data.decision, parsed.data.note ?? '', req.agent!);
        const review = request.aiReviewId
          ? await prisma.ceresAIReview.findUnique({ where: { id: request.aiReviewId } })
          : null;
        const requestPhotoUploadIds = await resolveIdsWithFallback('request', request.id, 'request_photo', request.requestPhotoUploadId);
        return { request: toStaffRequestRow(request, review, requestPhotoUploadIds) };
      } catch (err) {
        return requestError(reply, err);
      }
    },
  );

  const fulfillmentBody = z.object({
    lane: requestMoneyLaneSchema,
    transferSlipUploadId: z.string().min(1).optional(),
    transferSlipUploadIds: z.array(z.string().min(1)).max(10).optional(),
    purchaseReceiptUploadId: z.string().min(1).optional(),
    purchaseReceiptUploadIds: z.array(z.string().min(1)).max(10).optional(),
    note: z.string().max(600).optional(),
    idempotencyKey: z.string().min(1).max(160).optional(),
  }).strict();
  app.post<{ Params: { id: string } }>(
    '/api/ceres/requests/:id/fulfill',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const parsed = fulfillmentBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const body = parsed.data;
      // Array wins over singular when both are sent — validate ownership+purpose of EVERY
      // element before any write (matches the existing singular-field check below).
      const transferSlipIds = resolveMediaIdList(body.transferSlipUploadId, body.transferSlipUploadIds);
      const purchaseReceiptIds = resolveMediaIdList(body.purchaseReceiptUploadId, body.purchaseReceiptUploadIds);
      for (const id of transferSlipIds) {
        const media = await mediaCanBeAttachedBy(id, req.agent!, ['transfer_slip']);
        if (!media) return reply.code(403).send({ error: 'media_not_owned' });
      }
      for (const id of purchaseReceiptIds) {
        const media = await mediaCanBeAttachedBy(id, req.agent!, ['purchase_receipt']);
        if (!media) return reply.code(403).send({ error: 'media_not_owned' });
      }
      try {
        const moneyEvent = await fulfillRequest({
          requestId: req.params.id,
          ...body,
          createdById: req.agent!.id,
          createdByName: req.agent!.name,
        });
        await notifyRequesterForMoneyEvent(moneyEvent.id);
        const request = await prisma.ceresPaymentRequest.findUniqueOrThrow({ where: { id: req.params.id } });
        const requestPhotoUploadIds = await resolveIdsWithFallback('request', request.id, 'request_photo', request.requestPhotoUploadId);
        return { request: toStaffRequestRow(request, null, requestPhotoUploadIds), moneyEvent };
      } catch (err) {
        return moneyError(reply, err);
      }
    },
  );

  const refundBody = z.object({
    lane: requestMoneyLaneSchema,
    amount: z.string().refine(isValidAmount, 'invalid_amount'),
    transferSlipUploadId: z.string().min(1).optional(),
    transferSlipUploadIds: z.array(z.string().min(1)).max(10).optional(),
    note: z.string().max(600).optional(),
    idempotencyKey: z.string().min(1).max(160).optional(),
  }).strict();
  app.post<{ Params: { id: string } }>(
    '/api/ceres/requests/:id/refund',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const parsed = refundBody.safeParse(req.body);
      if (!parsed.success) {
        const amountIssue = parsed.error.issues.some((issue) => issue.message === 'invalid_amount');
        return reply.code(400).send({ error: amountIssue ? 'invalid_amount' : 'invalid_body' });
      }
      const body = parsed.data;
      const transferSlipIds = resolveMediaIdList(body.transferSlipUploadId, body.transferSlipUploadIds);
      for (const id of transferSlipIds) {
        const media = await mediaCanBeAttachedBy(id, req.agent!, ['refund_slip']);
        if (!media) return reply.code(403).send({ error: 'media_not_owned' });
      }
      try {
        const moneyEvent = await refundAdvance({
          requestId: req.params.id,
          ...body,
          createdById: req.agent!.id,
          createdByName: req.agent!.name,
        });
        const liquidation = await getAdvanceLiquidation(req.params.id);
        return { moneyEvent, liquidation };
      } catch (err) {
        return moneyError(reply, err);
      }
    },
  );

  const reverseBody = z.object({
    reason: z.string().min(1).max(600),
    idempotencyKey: z.string().min(1).max(160).optional(),
  }).strict();
  app.post<{ Params: { id: string } }>(
    '/api/ceres/request-money-events/:id/reverse',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const parsed = reverseBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      try {
        const moneyEvent = await reverseRequestMoneyEvent({
          eventId: req.params.id,
          reason: parsed.data.reason,
          idempotencyKey: parsed.data.idempotencyKey,
          createdById: req.agent!.id,
          createdByName: req.agent!.name,
        });
        return { moneyEvent };
      } catch (err) {
        return moneyError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/ceres/requests/:id/liquidation',
    { preHandler: requireCeresRole('messenger', 'gm', 'ceo') },
    async (req, reply) => {
      const request = await prisma.ceresPaymentRequest.findUnique({ where: { id: req.params.id } });
      if (!request) return reply.code(404).send({ error: 'not_found' });
      if (ceresRole(req.agent!) === 'messenger' && request.requestedById !== req.agent!.id) {
        return reply.code(404).send({ error: 'not_found' });
      }
      try {
        return { liquidation: await getAdvanceLiquidation(request.id) };
      } catch (err) {
        return moneyError(reply, err);
      }
    },
  );

  // POST /api/ceres/requests/:id/cancel — requested/escalated only.
  app.post<{ Params: { id: string } }>(
    '/api/ceres/requests/:id/cancel',
    { preHandler: requireCeresRole('messenger', 'gm', 'ceo') },
    async (req, reply) => {
      const existing = await prisma.ceresPaymentRequest.findUnique({ where: { id: req.params.id } });
      if (!existing || existing.workflowVersion !== 2) return reply.code(404).send({ error: 'not_found' });
      const parsed = z.object({ note: z.string().max(600).optional() }).safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      try {
        const request = await cancelStaffRequest(existing.id, parsed.data.note ?? '', req.agent!);
        const review = request.aiReviewId
          ? await prisma.ceresAIReview.findUnique({ where: { id: request.aiReviewId } })
          : null;
        const requestPhotoUploadIds = await resolveIdsWithFallback('request', request.id, 'request_photo', request.requestPhotoUploadId);
        return { request: toStaffRequestRow(request, review, requestPhotoUploadIds) };
      } catch (err) {
        return requestError(reply, err);
      }
    },
  );

  // POST /api/ceres/requests/:id/void { reason } — CEO-ONLY, ANY approvalStatus (owner
  // directive, 2026-07-21: "I and only CEO should have the ability to remove any... request").
  // Separate from /cancel (requester/manager self-service, pre-fulfillment only) and from
  // /request-money-events/:id/reverse (money-only, doesn't flip approvalStatus) — see
  // requestVoid.ts for exactly how a paid request's reversal composes into this same write.
  const voidBody = z.object({ reason: z.string().min(1).max(300) });
  app.post<{ Params: { id: string } }>(
    '/api/ceres/requests/:id/void',
    { preHandler: requireCeresRole('ceo') },
    async (req, reply) => {
      const parsed = voidBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      try {
        const request = await voidStaffRequest({ requestId: req.params.id, reason: parsed.data.reason, agent: req.agent! });
        const review = request.aiReviewId
          ? await prisma.ceresAIReview.findUnique({ where: { id: request.aiReviewId } })
          : null;
        const requestPhotoUploadIds = await resolveIdsWithFallback('request', request.id, 'request_photo', request.requestPhotoUploadId);
        return { request: toStaffRequestRow(request, review, requestPhotoUploadIds) };
      } catch (err) {
        return voidError(reply, err);
      }
    },
  );

  // ─── Templates (P3) ───

  // GET /api/ceres/templates
  app.get('/api/ceres/templates', { preHandler: requireCeresRole('gm', 'ceo') }, async () => {
    const templates = await prisma.ceresRecurringTemplate.findMany({ orderBy: { payee: 'asc' } });
    return { templates };
  });

  // POST /api/ceres/templates
  const templateBody = z.object({
    payee: z.string().min(1).max(200),
    entity: z.enum(ENTITIES),
    category: z.string().min(1),
    expectedAmount: z.string().refine(isValidAmount, 'invalid_amount'),
    tolerancePct: z.number().min(0).max(100).default(15),
    period: z.enum(['monthly', 'quarterly', 'yearly']),
    dueDay: z.number().int().min(1).max(31),
    graceDays: z.number().int().min(0).max(30),
    note: z.string().max(600).optional(),
  });
  app.post('/api/ceres/templates', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const parsed = templateBody.safeParse(req.body);
    if (!parsed.success) {
      const amountIssue = parsed.error.issues.some((i) => i.message === 'invalid_amount');
      return reply.code(400).send({ error: amountIssue ? 'invalid_amount' : 'invalid_body' });
    }
    const b = parsed.data;
    const template = await prisma.ceresRecurringTemplate.create({
      data: {
        payee: b.payee,
        entity: b.entity,
        category: b.category,
        expectedAmount: b.expectedAmount,
        tolerancePct: b.tolerancePct,
        period: b.period,
        dueDay: b.dueDay,
        graceDays: b.graceDays,
        note: b.note ?? '',
      },
    });
    return { template };
  });

  // PATCH /api/ceres/templates/:id — any subset incl. active.
  const templatePatchBody = z.object({
    payee: z.string().min(1).max(200).optional(),
    entity: z.enum(ENTITIES).optional(),
    category: z.string().min(1).optional(),
    expectedAmount: z.string().refine(isValidAmount, 'invalid_amount').optional(),
    tolerancePct: z.number().min(0).max(100).optional(),
    period: z.enum(['monthly', 'quarterly', 'yearly']).optional(),
    dueDay: z.number().int().min(1).max(31).optional(),
    graceDays: z.number().int().min(0).max(30).optional(),
    note: z.string().max(600).optional(),
    active: z.boolean().optional(),
  });
  app.patch<{ Params: { id: string } }>(
    '/api/ceres/templates/:id',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const parsed = templatePatchBody.safeParse(req.body);
      if (!parsed.success) {
        const amountIssue = parsed.error.issues.some((i) => i.message === 'invalid_amount');
        return reply.code(400).send({ error: amountIssue ? 'invalid_amount' : 'invalid_body' });
      }
      const existing = await prisma.ceresRecurringTemplate.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      const template = await prisma.ceresRecurringTemplate.update({ where: { id: existing.id }, data: parsed.data });
      return { template };
    },
  );

  // GET /api/ceres/templates/due — missed-payment / due-status board (P3 bonus).
  app.get('/api/ceres/templates/due', { preHandler: requireCeresRole('gm', 'ceo') }, async () => {
    const due = await computeTemplateDue();
    return { due };
  });
}
