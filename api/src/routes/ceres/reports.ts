import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { requireCeresRole } from '../../ceres/auth.js';
import { thaiDayRange } from './common.js';

// สรุปรายหมวด (category spend rollup) — gm|ceo only, read-only. Combines the two places
// Ceres money actually leaves the company into one per-category total over a Thai-day
// date range:
//
//   1. CeresExpense rows with status approved|settled, spentAt in range. This INCLUDES
//      liquidation children of an advance (they carry advanceRequestId, but their own
//      `category` column already holds the real spend category — same column every other
//      expense uses — so no special-casing is needed to pull them in).
//   2. CeresPaymentRequest payouts for requestType reimbursement|purchase: derived from
//      CeresRequestMoneyEvent rows (kind payment|purchase, createdAt in range) that are
//      still ACTIVE — i.e. no `reversal` event points its reversesEventId at them. This
//      mirrors the exact reversed-set check ceres/nightlyDigest.ts's dailyOutflowSummary
//      already uses for the nightly digest's outflow line (batch: load the candidate
//      events, batch-load any reversals that target them, subtract).
//
//      Advance requests are EXCLUDED here on purpose: fulfillRequest() (see
//      ceres/requestMoney.ts) records an advance's initial payout with kind:'payment' too
//      (advance and reimbursement share that kind) — that payout is the float going OUT,
//      not the real spend. The real spend is exactly the liquidation-child expenses
//      already counted in (1). Counting the float payout as well would double-count it.
//      This is done by never loading advance rows into the requestId→category map below —
//      an event whose request isn't in the map (because it wasn't fetched) is simply
//      skipped. It also automatically covers whatever new `advanceVariant` rows a parallel
//      session is adding, since those rows stay requestType 'advance'.
//
// Money: every Ceres amount column (CeresExpense.amount, CeresPaymentRequest.amount,
// CeresRequestMoneyEvent.amount) is a decimal-string BAHT value — there is no satang
// column anywhere in this schema (see prisma/schema.prisma). Summed here in integer
// satang (same rounding as ceres/requestMoney.ts's own amountToSatang, kept as a local
// copy rather than an export from that file to avoid touching it) to keep many small
// additions exact, then exposed as `totalSatang` on each row.

const FALLBACK_GROUP = 'อื่นๆ (เดิม)';
const UNSET_CATEGORY_LABEL = '(ไม่ระบุหมวดหมู่)';

function amountToSatang(value: string): number {
  const normalized = (value || '').replace(/[^\d.-]/g, '');
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

const querySchema = z.object({ from: z.string().optional(), to: z.string().optional() });

export interface CategorySummaryRow {
  category: string;
  group: string;
  totalSatang: number;
  count: number;
}

export function categoryReportsRoutes(app: FastifyInstance) {
  // GET /api/ceres/reports/category-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
  app.get('/api/ceres/reports/category-summary', { preHandler: requireCeresRole('gm', 'ceo') }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const range = thaiDayRange(parsed.data.from, parsed.data.to);

    const [expenses, categories] = await Promise.all([
      prisma.ceresExpense.findMany({
        where: {
          status: { in: ['approved', 'settled'] },
          ...(range ? { spentAt: range } : {}),
        },
        select: { category: true, amount: true },
      }),
      prisma.ceresCategory.findMany({ select: { name: true, group: true } }),
    ]);

    // Request payouts — payment|purchase money events in range, minus any that a
    // `reversal` event (kind:'reversal', reversesEventId -> this event's id) has reversed.
    const payoutEvents = await prisma.ceresRequestMoneyEvent.findMany({
      where: {
        kind: { in: ['payment', 'purchase'] },
        ...(range ? { createdAt: range } : {}),
      },
      select: { id: true, requestId: true, amount: true },
    });

    let activePayouts: { requestId: string; amount: string }[] = [];
    if (payoutEvents.length > 0) {
      const reversals = await prisma.ceresRequestMoneyEvent.findMany({
        where: { kind: 'reversal', reversesEventId: { in: payoutEvents.map((e) => e.id) } },
        select: { reversesEventId: true },
      });
      const reversedIds = new Set(reversals.map((r) => r.reversesEventId));
      activePayouts = payoutEvents
        .filter((e) => !reversedIds.has(e.id))
        .map((e) => ({ requestId: e.requestId, amount: e.amount }));
    }

    // Only reimbursement|purchase requests are ever loaded here — an advance's payment
    // event has no entry in this map (see the file-header note above), so it's silently
    // skipped by the `undefined` check in the loop below rather than needing its own filter.
    const requestIds = [...new Set(activePayouts.map((p) => p.requestId))];
    const payoutRequests = requestIds.length > 0
      ? await prisma.ceresPaymentRequest.findMany({
          where: { id: { in: requestIds }, requestType: { in: ['reimbursement', 'purchase'] } },
          select: { id: true, category: true },
        })
      : [];
    const categoryByRequestId = new Map(payoutRequests.map((r) => [r.id, r.category]));

    // Unknown/legacy category names (renamed, deleted, or free-text from before the
    // CeresCategory table existed) fall back to one shared group so they still show up
    // in the rollup instead of silently vanishing.
    const groupByName = new Map(categories.map((c) => [c.name, c.group]));
    const groupFor = (name: string): string => groupByName.get(name) || FALLBACK_GROUP;

    const buckets = new Map<string, CategorySummaryRow>();
    function add(rawCategory: string, amount: string) {
      const label = rawCategory || UNSET_CATEGORY_LABEL;
      const bucket = buckets.get(label) ?? { category: label, group: groupFor(rawCategory), totalSatang: 0, count: 0 };
      bucket.totalSatang += amountToSatang(amount);
      bucket.count += 1;
      buckets.set(label, bucket);
    }

    for (const e of expenses) add(e.category, e.amount);
    for (const payout of activePayouts) {
      const category = categoryByRequestId.get(payout.requestId);
      if (category === undefined) continue; // not a reimbursement|purchase request (e.g. an advance) — excluded by design
      add(category, payout.amount);
    }

    const rows = [...buckets.values()].sort(
      (a, b) => a.group.localeCompare(b.group, 'th') || a.category.localeCompare(b.category, 'th'),
    );
    const grandTotal = {
      totalSatang: rows.reduce((s, r) => s + r.totalSatang, 0),
      count: rows.reduce((s, r) => s + r.count, 0),
    };

    return { rows, grandTotal };
  });
}
