import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { requireCeresRole } from '../../ceres/auth.js';
import { ageStuckAIReviews } from '../../ceres/requestService.js';
import { computeBoard, num, thaiDayKey, thaiDayRange, toExpenseRow, toStaffRequestRow, transferReconciliationStats } from './common.js';
import { computeTemplateDue } from './requests.js';

function reqBase(req: { headers: Record<string, unknown> }): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
  return `${proto}://${req.headers.host}`;
}

// P4 — CEO nightly oversight: escalation queue, every AI decision with its reasoning,
// flagged P1 expenses, the day's cash picture, missed bills, today's settlement, and
// request counts. Mounted inside the requireCeresAuth scope (see routes/ceres/index.ts).
export function ceoRoutes(app: FastifyInstance) {
  // GET /api/ceres/ceo/overview?date=YYYY-MM-DD — CEO-only.
  app.get('/api/ceres/ceo/overview', { preHandler: requireCeresRole('ceo') }, async (req, reply) => {
    const parsed = z.object({ date: z.string().optional() }).safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const dayKey = parsed.data.date ?? thaiDayKey(new Date());
    const range = thaiDayRange(dayKey, dayKey);
    if (!range) return reply.code(400).send({ error: 'invalid_date' });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    await ageStuckAIReviews();

    const [escalatedRows, aiReviewRows, flaggedExpenseRows, board, templateDue, settlement, statusCounts, v2ApprovalCounts, transferReconciliation] = await Promise.all([
      prisma.ceresPaymentRequest.findMany({
        where: {
          OR: [
            { workflowVersion: 1, status: 'escalated' },
            { workflowVersion: 2, approvalStatus: 'pending_ceo' },
          ],
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.ceresAIReview.findMany({ where: { createdAt: range }, orderBy: { createdAt: 'desc' } }),
      prisma.ceresExpense.findMany({ where: { aiVerdict: 'flagged', createdAt: { gte: sevenDaysAgo } }, orderBy: { createdAt: 'desc' } }),
      computeBoard(),
      computeTemplateDue(),
      prisma.ceresSettlement.findUnique({ where: { dayKey }, include: { lines: true } }),
      prisma.ceresPaymentRequest.groupBy({
        by: ['status'],
        where: { workflowVersion: 1, createdAt: range },
        _count: { _all: true },
      }),
      prisma.ceresPaymentRequest.groupBy({
        by: ['approvalStatus'],
        where: { workflowVersion: 2, createdAt: range },
        _count: { _all: true },
      }),
      transferReconciliationStats(),
    ]);

    // Escalation review ids are already loaded above only for THIS day's reviews; the
    // escalation queue itself can span older days, so batch-load its reviews separately.
    const escReviewIds = [...new Set(escalatedRows.map((r) => r.aiReviewId).filter((id): id is string => !!id))];
    const escReviews = escReviewIds.length
      ? new Map((await prisma.ceresAIReview.findMany({ where: { id: { in: escReviewIds } } })).map((r) => [r.id, r]))
      : new Map<string, { verdict: string; reasoning: string; createdAt: Date }>();

    const escalations = escalatedRows.map((r) => {
      const review = r.aiReviewId ? escReviews.get(r.aiReviewId) : undefined;
      if (r.workflowVersion === 2) return toStaffRequestRow(r, review);
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
    });

    // Batch-load subject summaries for the day's AI reviews (expense → partyName/amount/
    // category; paymentRequest → payee/amount/status) — one findMany per subject type.
    const expenseIds = [...new Set(aiReviewRows.filter((r) => r.subjectType === 'expense').map((r) => r.subjectId))];
    const requestIds = [...new Set(aiReviewRows.filter((r) => r.subjectType === 'paymentRequest').map((r) => r.subjectId))];
    const [expenseSubjects, requestSubjects] = await Promise.all([
      expenseIds.length
        ? prisma.ceresExpense.findMany({ where: { id: { in: expenseIds } }, select: { id: true, partyName: true, amount: true, category: true } })
        : Promise.resolve([]),
      requestIds.length
        ? prisma.ceresPaymentRequest.findMany({
          where: { id: { in: requestIds } },
          select: { id: true, payee: true, amount: true, status: true, workflowVersion: true, approvalStatus: true },
        })
        : Promise.resolve([]),
    ]);
    const expenseSubjectMap = new Map(expenseSubjects.map((e) => [e.id, { partyName: e.partyName, amount: e.amount, category: e.category }]));
    const requestSubjectMap = new Map(requestSubjects.map((r) => [r.id, {
      payee: r.payee,
      amount: r.amount,
      workflowVersion: r.workflowVersion,
      status: r.workflowVersion === 2 ? r.approvalStatus : r.status,
    }]));

    const aiReviews = aiReviewRows.map((r) => ({
      id: r.id,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      verdict: r.verdict,
      reasoning: r.reasoning,
      policyVersion: r.policyVersion,
      model: r.model,
      createdAt: r.createdAt.toISOString(),
      subject:
        r.subjectType === 'expense'
          ? expenseSubjectMap.get(r.subjectId) ?? null
          : r.subjectType === 'paymentRequest'
            ? requestSubjectMap.get(r.subjectId) ?? null
            : null,
    }));

    const base = reqBase(req);
    const flaggedExpenses = flaggedExpenseRows.map((e) => toExpenseRow(e, base));

    const outstandingTotal = board.parties.reduce((s, p) => s + p.expectedChange, 0);
    const missedBills = templateDue.filter((d) => d.state === 'overdue');

    const requestCounts: Record<string, number> = {};
    for (const row of statusCounts) {
      requestCounts[row.status] = row._count._all;
    }
    const v2RequestCounts: Record<string, number> = {};
    for (const row of v2ApprovalCounts) {
      v2RequestCounts[row.approvalStatus] = row._count._all;
    }

    return {
      dayKey,
      escalations,
      aiReviews,
      flaggedExpenses,
      cash: { box: board.box, outstandingTotal },
      missedBills,
      settlementToday: settlement ?? null,
      requestCounts,
      v2RequestCounts,
      transferReconciliation,
    };
  });

  // GET /api/ceres/revisions?subjectType=&subjectId=&limit= — audit trail (gm|ceo).
  app.get('/api/ceres/revisions', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const parsed = z
      .object({ subjectType: z.string().optional(), subjectId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional() })
      .safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const q = parsed.data;
    const where: Record<string, unknown> = {};
    if (q.subjectType) where.subjectType = q.subjectType;
    if (q.subjectId) where.subjectId = q.subjectId;
    const revisions = await prisma.ceresRevision.findMany({ where, orderBy: { createdAt: 'desc' }, take: q.limit ?? 200 });
    return { revisions };
  });
}
