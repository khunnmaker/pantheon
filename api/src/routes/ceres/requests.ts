import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { ceresRole, requireCeresRole } from '../../ceres/auth.js';
import { reviewPaymentRequest } from '../../ceres/aiReview.js';
import { mediaCanBeAttachedBy } from '../../ceres/mediaAccess.js';
import { notifyCeoEscalation } from '../../ceres/notifyCeo.js';
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
import { notifyRequesterForMoneyEvent } from '../../ceres/notifyRequester.js';
import { isValidAmount, num, thaiDayKey, thaiDayRange, toStaffRequestRow } from './common.js';
import { GROUP_COMPANY_CODES } from '../../jupiter/companies.js';

const ENTITIES = GROUP_COMPANY_CODES; // 5 group companies (SSOT: jupiter/companies.ts)

interface RequestRow {
  id: string;
  requestedById: string | null;
  requestedByName: string;
  entity: string;
  payee: string;
  category: string;
  amount: string;
  detail: string;
  recurringTemplateId: string | null;
  billPeriod: string;
  status: string;
  aiReviewId: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string;
  paidById: string | null;
  paidAt: Date | null;
  paidRef: string;
  createdAt: Date;
}

// The row shape the Ceres UI consumes for a payment request (plus a derived numeric
// amount, ISO dates, and the attached AI review summary when one is loaded).
function toRequestRow(r: RequestRow, review?: { verdict: string; reasoning: string; createdAt: Date } | null) {
  return {
    id: r.id,
    requestedById: r.requestedById,
    requestedByName: r.requestedByName,
    entity: r.entity,
    payee: r.payee,
    category: r.category,
    amount: r.amount,
    amountNum: num(r.amount),
    detail: r.detail,
    recurringTemplateId: r.recurringTemplateId,
    billPeriod: r.billPeriod,
    status: r.status,
    aiReviewId: r.aiReviewId,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decisionNote: r.decisionNote,
    paidById: r.paidById,
    paidAt: r.paidAt ? r.paidAt.toISOString() : null,
    paidRef: r.paidRef,
    createdAt: r.createdAt.toISOString(),
    aiReview: review ? { verdict: review.verdict, reasoning: review.reasoning, createdAt: review.createdAt.toISOString() } : null,
  };
}

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
      : ['not_editable', 'not_cancellable', 'not_pending_nee', 'not_pending_ceo', 'conflict'].includes(err.code) ? 409
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
  const v2CreateBody = z.object({
    requestType: z.enum(V2_REQUEST_TYPES),
    entity: z.enum(ENTITIES),
    category: z.string().min(1).max(200),
    amount: z.string().refine(isValidAmount, 'invalid_amount'),
    reason: z.string().min(1).max(600),
    requestPhotoUploadId: z.string().min(1).nullable().optional(),
  }).strict();

  // POST /api/ceres/requests — GM submits a payment for pre-approval (P2/P3 step 1).
  // The AI gate runs SYNCHRONOUSLY: the GM needs the answer now, before paying.
  const createBody = z.object({
    entity: z.enum(ENTITIES),
    payee: z.string().min(1).max(200),
    category: z.string().min(1),
    amount: z.string().refine(isValidAmount, 'invalid_amount'),
    detail: z.string().max(600).optional(),
    recurringTemplateId: z.string().optional(),
    billPeriod: z.string().max(20).optional(),
  });
  app.post('/api/ceres/requests', { preHandler: requireCeresRole('messenger', 'gm', 'ceo') }, async (req, reply) => {
    const discriminator = req.body && typeof req.body === 'object' && 'requestType' in req.body
      ? (req.body as { requestType?: unknown }).requestType
      : undefined;
    if (typeof discriminator === 'string' && (V2_REQUEST_TYPES as readonly string[]).includes(discriminator)) {
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
        return { request: toStaffRequestRow(request, review) };
      } catch (err) {
        return requestError(reply, err);
      }
    }

    if (discriminator !== undefined) return reply.code(400).send({ error: 'invalid_body' });

    if (ceresRole(req.agent!) === 'messenger') return reply.code(403).send({ error: 'forbidden' });
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      const amountIssue = parsed.error.issues.some((i) => i.message === 'invalid_amount');
      return reply.code(400).send({ error: amountIssue ? 'invalid_amount' : 'invalid_body' });
    }
    const b = parsed.data;
    const agent = req.agent!;

    const created = await prisma.ceresPaymentRequest.create({
      data: {
        requestedById: agent.id,
        requestedByName: agent.name,
        entity: b.entity,
        payee: b.payee,
        category: b.category,
        amount: b.amount,
        detail: b.detail ?? '',
        recurringTemplateId: b.recurringTemplateId ?? null,
        billPeriod: b.billPeriod ?? '',
        status: 'requested',
      },
    });

    const result = await reviewPaymentRequest(created.id);
    const updated = await prisma.ceresPaymentRequest.update({
      where: { id: created.id },
      data: { status: result.verdict === 'approve' ? 'ai_approved' : 'escalated', aiReviewId: result.reviewId },
    });

    if (result.verdict === 'escalate') {
      void notifyCeoEscalation(
        { payee: updated.payee, amount: updated.amount, entity: updated.entity, requestedByName: updated.requestedByName },
        result.reasoning,
      );
    }

    const review = await prisma.ceresAIReview.findUnique({ where: { id: result.reviewId } });
    return { request: toRequestRow(updated, review) };
  });

  // GET /api/ceres/requests?status=&from=&to=&q=&limit=
  const listQuery = z.object({
    workflow: z.coerce.number().int().optional(),
    scope: z.enum(['mine', 'queue', 'all']).optional(),
    status: z.enum(['requested', 'ai_approved', 'escalated', 'ceo_approved', 'rejected', 'cancelled', 'paid']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    q: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });
  app.get('/api/ceres/requests', { preHandler: requireCeresRole('messenger', 'gm', 'ceo') }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const q = parsed.data;

    if (q.workflow === 2) {
      try {
        const rows = await listStaffRequests(req.agent!, q.scope ?? 'mine', q.limit ?? 200);
        const reviewMap = await loadReviewsByIds(rows.map((r) => r.aiReviewId));
        return {
          requests: rows.map((r) => toStaffRequestRow(r, r.aiReviewId ? reviewMap.get(r.aiReviewId) ?? null : null)),
        };
      } catch (err) {
        return requestError(reply, err);
      }
    }

    if (ceresRole(req.agent!) === 'messenger') return reply.code(403).send({ error: 'forbidden' });

    const where: Record<string, unknown> = { workflowVersion: 1 };
    if (q.status) where.status = q.status;
    const range = thaiDayRange(q.from, q.to);
    if (range) where.createdAt = range;
    if (q.q) {
      const needle = q.q;
      where.OR = [
        { payee: { contains: needle, mode: 'insensitive' } },
        { detail: { contains: needle, mode: 'insensitive' } },
        { category: { contains: needle, mode: 'insensitive' } },
        { amount: { contains: needle } },
      ];
    }

    const rows = await prisma.ceresPaymentRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: q.limit ?? 200,
    });
    const reviewMap = await loadReviewsByIds(rows.map((r) => r.aiReviewId));
    return { requests: rows.map((r) => toRequestRow(r, r.aiReviewId ? reviewMap.get(r.aiReviewId) ?? null : null)) };
  });

  // GET /api/ceres/requests/:id
  app.get<{ Params: { id: string } }>(
    '/api/ceres/requests/:id',
    { preHandler: requireCeresRole('messenger', 'gm', 'ceo') },
    async (req, reply) => {
      const existing = await prisma.ceresPaymentRequest.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.workflowVersion === 2) {
        try {
          const request = await getStaffRequest(existing.id, req.agent!);
          const review = request.aiReviewId
            ? await prisma.ceresAIReview.findUnique({ where: { id: request.aiReviewId } })
            : null;
          const [events, revisions, moneyEvents] = await Promise.all([
            prisma.ceresRequestEvent.findMany({ where: { requestId: request.id }, orderBy: { createdAt: 'asc' } }),
            prisma.ceresRevision.findMany({
              where: { subjectType: 'paymentRequest', subjectId: request.id },
              orderBy: { createdAt: 'asc' },
            }),
            prisma.ceresRequestMoneyEvent.findMany({ where: { requestId: request.id }, orderBy: { createdAt: 'asc' } }),
          ]);
          return { request: toStaffRequestRow(request, review), events, revisions, moneyEvents };
        } catch (err) {
          return requestError(reply, err);
        }
      }
      if (ceresRole(req.agent!) === 'messenger') return reply.code(404).send({ error: 'not_found' });
      const review = existing.aiReviewId ? await prisma.ceresAIReview.findUnique({ where: { id: existing.aiReviewId } }) : null;
      return { request: toRequestRow(existing, review) };
    },
  );

  const v2PatchBody = z.object({
    requestType: z.enum(V2_REQUEST_TYPES).optional(),
    entity: z.enum(ENTITIES).optional(),
    category: z.string().min(1).max(200).optional(),
    amount: z.string().refine(isValidAmount, 'invalid_amount').optional(),
    reason: z.string().min(1).max(600).optional(),
    requestPhotoUploadId: z.string().min(1).nullable().optional(),
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
      try {
        const request = await editStaffRequest(req.params.id, parsed.data, req.agent!);
        const review = request.aiReviewId
          ? await prisma.ceresAIReview.findUnique({ where: { id: request.aiReviewId } })
          : null;
        return { request: toStaffRequestRow(request, review) };
      } catch (err) {
        return requestError(reply, err);
      }
    },
  );

  // POST /api/ceres/requests/:id/decide — CEO-only escalation decision.
  const decideBody = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(600).optional() });
  app.post<{ Params: { id: string } }>(
    '/api/ceres/requests/:id/decide',
    { preHandler: requireCeresRole('ceo') },
    async (req, reply) => {
      const parsed = decideBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const existing = await prisma.ceresPaymentRequest.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.workflowVersion !== 1) return reply.code(409).send({ error: 'legacy_only' });
      if (existing.status !== 'escalated') return reply.code(409).send({ error: 'not_escalated' });

      const updated = await prisma.ceresPaymentRequest.update({
        where: { id: existing.id },
        data: {
          status: parsed.data.decision === 'approve' ? 'ceo_approved' : 'rejected',
          decidedById: req.agent!.id,
          decidedAt: new Date(),
          decisionNote: parsed.data.note ?? '',
        },
      });
      const review = updated.aiReviewId ? await prisma.ceresAIReview.findUnique({ where: { id: updated.aiReviewId } }) : null;
      return { request: toRequestRow(updated, review) };
    },
  );

  // POST /api/ceres/requests/:id/paid — THE GATE: only ai_approved/ceo_approved may pay.
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
        return { request: toStaffRequestRow(request, review) };
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
        return { request: toStaffRequestRow(request, review) };
      } catch (err) {
        return requestError(reply, err);
      }
    },
  );

  const paidBody = z.object({ paidRef: z.string().max(120).optional() });
  app.post<{ Params: { id: string } }>(
    '/api/ceres/requests/:id/paid',
    { preHandler: requireCeresRole('gm', 'ceo') },
    async (req, reply) => {
      const parsed = paidBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
      const existing = await prisma.ceresPaymentRequest.findUnique({ where: { id: req.params.id } });
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.workflowVersion !== 1 || !['ai_approved', 'ceo_approved'].includes(existing.status)) {
        return reply.code(409).send({ error: 'not_approved' });
      }
      const updated = await prisma.ceresPaymentRequest.update({
        where: { id: existing.id },
        data: { status: 'paid', paidById: req.agent!.id, paidAt: new Date(), paidRef: parsed.data.paidRef ?? '' },
      });
      const review = updated.aiReviewId ? await prisma.ceresAIReview.findUnique({ where: { id: updated.aiReviewId } }) : null;
      return { request: toRequestRow(updated, review) };
    },
  );

  const fulfillmentBody = z.object({
    lane: requestMoneyLaneSchema,
    transferSlipUploadId: z.string().min(1).optional(),
    purchaseReceiptUploadId: z.string().min(1).optional(),
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
      if (body.transferSlipUploadId) {
        const media = await mediaCanBeAttachedBy(body.transferSlipUploadId, req.agent!, ['transfer_slip']);
        if (!media) return reply.code(403).send({ error: 'media_not_owned' });
      }
      if (body.purchaseReceiptUploadId) {
        const media = await mediaCanBeAttachedBy(body.purchaseReceiptUploadId, req.agent!, ['purchase_receipt']);
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
        return { request: toStaffRequestRow(request), moneyEvent };
      } catch (err) {
        return moneyError(reply, err);
      }
    },
  );

  const refundBody = z.object({
    lane: requestMoneyLaneSchema,
    amount: z.string().refine(isValidAmount, 'invalid_amount'),
    transferSlipUploadId: z.string().min(1).optional(),
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
      if (body.transferSlipUploadId) {
        const media = await mediaCanBeAttachedBy(body.transferSlipUploadId, req.agent!, ['refund_slip']);
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
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      if (existing.workflowVersion === 2) {
        const parsed = z.object({ note: z.string().max(600).optional() }).safeParse(req.body ?? {});
        if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
        try {
          const request = await cancelStaffRequest(existing.id, parsed.data.note ?? '', req.agent!);
          const review = request.aiReviewId
            ? await prisma.ceresAIReview.findUnique({ where: { id: request.aiReviewId } })
            : null;
          return { request: toStaffRequestRow(request, review) };
        } catch (err) {
          return requestError(reply, err);
        }
      }
      if (ceresRole(req.agent!) === 'messenger') return reply.code(403).send({ error: 'forbidden' });
      if (!['requested', 'escalated'].includes(existing.status)) {
        return reply.code(409).send({ error: 'not_cancellable' });
      }
      const updated = await prisma.ceresPaymentRequest.update({ where: { id: existing.id }, data: { status: 'cancelled' } });
      const review = updated.aiReviewId ? await prisma.ceresAIReview.findUnique({ where: { id: updated.aiReviewId } }) : null;
      return { request: toRequestRow(updated, review) };
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
