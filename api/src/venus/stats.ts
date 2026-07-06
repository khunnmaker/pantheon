import { Prisma, type PrismaClient } from '@prisma/client';

// Venus analytics engine (VENUS_BRIEF.md §6): RFM scores + Thai segments, 90d trend, and
// per-product reorder cycles. Pure code, no AI, recomputed on-demand (POST
// /api/venus/recompute) or via the runnable script (venus-recompute-stats.ts) — intended
// to also run nightly once a scheduler is wired up. Reads non-void SaleDoc/SaleLine only
// (void docs are cancelled orders — they must never count as real purchase behavior).
//
// One CustomerStats row per customer, fully OVERWRITTEN each run (derived data, not
// append-only money — see the model comment in schema.prisma). Customers with zero
// non-void sales in the window are left with no row (nothing to compute yet) rather than
// a row full of nulls/zeros that could be misread as "definitely zero activity".

// ─── Configurable thresholds (env-overridable, documented defaults from the brief) ───

// RFM window: how far back "recent" purchase history counts. Brief: 365d.
export const RFM_WINDOW_DAYS = Number(process.env.VENUS_RFM_WINDOW_DAYS ?? 365);
// Trend windows: last N days vs the N days before that. Brief: 90d each.
export const TREND_WINDOW_DAYS = Number(process.env.VENUS_TREND_WINDOW_DAYS ?? 90);
// Reorder-due multiplier: flag when today - lastPurchase > multiplier * median gap. Brief: 1.25.
export const REORDER_DUE_MULTIPLIER = Number(process.env.VENUS_REORDER_DUE_MULTIPLIER ?? 1.25);
// Minimum purchases of a SKU (per customer) before a reorder cycle is computed at all. Brief: >=3.
export const REORDER_MIN_PURCHASES = Number(process.env.VENUS_REORDER_MIN_PURCHASES ?? 3);
// Equipment heuristic: a SKU bought exactly once by a customer, above this unit price, is
// treated as a one-off big-ticket purchase (excluded from reorder cycles) rather than a
// consumable that just hasn't repeated yet. Brief: "configurable threshold, e.g. 20000".
export const EQUIPMENT_PRICE_THRESHOLD = Number(process.env.VENUS_EQUIPMENT_PRICE_THRESHOLD ?? 20000);

// ─── Thai segment mapping (explicit rule, see brief §6) ───
//
// RFM quintile scores (1=worst, 5=best) are computed independently for R, F, M by ranking
// all customers with at least one non-void purchase in the window and splitting into 5
// equal-ish buckets (quintiles). Note: for Recency, a SMALLER "days since last purchase"
// is BETTER, so R is scored inverted (most-recent customers get R=5).
//
// Segment rule (checked in this order — first match wins):
//   1. ลูกค้าชั้นดี  (Champions)  — R>=4 AND F>=4 AND M>=4: buys often, recently, big spend.
//   2. หายไปแล้ว    (Lost)        — R<=2 AND F<=2: barely bought before AND long gone.
//   3. เสี่ยงหาย    (At-Risk)     — R<=2 AND F>=3: USED to buy a lot/often (real history),
//                                    but recency has stretched out — the "quietly fading"
//                                    case the brief calls out by name ("high F/M history,
//                                    R stretching").
//   4. มาใหม่       (New)         — F<=2 AND R>=4: few purchases so far, but recent — too
//                                    early to call loyal or lost.
//   5. ลูกค้าประจำ  (Loyal)       — everything else: steady, unremarkable middle.
export type Segment = 'ลูกค้าชั้นดี' | 'ลูกค้าประจำ' | 'มาใหม่' | 'เสี่ยงหาย' | 'หายไปแล้ว';

export function segmentFor(rScore: number, fScore: number, mScore: number): Segment {
  if (rScore >= 4 && fScore >= 4 && mScore >= 4) return 'ลูกค้าชั้นดี';
  if (rScore <= 2 && fScore <= 2) return 'หายไปแล้ว';
  if (rScore <= 2 && fScore >= 3) return 'เสี่ยงหาย';
  if (fScore <= 2 && rScore >= 4) return 'มาใหม่';
  return 'ลูกค้าประจำ';
}

// Quintile scoring: rank ascending values 1..5 across the whole customer base (ties share
// a bucket boundary — plain positional quantile, not a strict rank). `invert` flips the
// direction (used for Recency, where a SMALLER day-count is BETTER and should score higher).
export function quintileScores(values: number[], invert: boolean): number[] {
  const n = values.length;
  if (n === 0) return [];
  const sortedIdx = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v)
    .map((x) => x.i);
  const scores = new Array<number>(n);
  for (let rank = 0; rank < n; rank++) {
    const idx = sortedIdx[rank];
    // bucket 0..4 by position, then to 1..5 score (ascending-value = higher score by default)
    const bucket = Math.min(4, Math.floor((rank / n) * 5));
    const score = invert ? 5 - bucket : bucket + 1;
    scores[idx] = score;
  }
  return scores;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

function parseMoney(s: string | null | undefined): number {
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

export interface ReorderDueItem {
  sku: string;
  lastPurchase: string; // ISO date
  medianGapDays: number;
  dueSinceDays: number; // how many days past the due point (today - (lastPurchase + multiplier*median))
  purchaseCount: number;
}

export interface RecomputeStatsOptions {
  now?: Date; // injectable for tests
}

export interface RecomputeStatsResult {
  customersProcessed: number;
  segmentCounts: Record<string, number>;
  dataCoverage: { min: Date | null; max: Date | null };
}

export async function recomputeStats(
  prisma: PrismaClient,
  opts: RecomputeStatsOptions = {},
): Promise<RecomputeStatsResult> {
  const now = opts.now ?? new Date();

  // Data-coverage window across ALL non-void docs (not just the RFM window) — exposed so
  // the UI can show "your data covers X to Y" and nobody misreads a short window as a
  // real trend (brief §5 "no-silent-caps" / data-coverage requirement).
  const coverage = await prisma.saleDoc.aggregate({
    where: { void: false },
    _min: { date: true },
    _max: { date: true },
  });

  const rfmSince = new Date(now.getTime() - RFM_WINDOW_DAYS * 86400000);
  const trendCurStart = new Date(now.getTime() - TREND_WINDOW_DAYS * 86400000);
  const trendPrevStart = new Date(now.getTime() - 2 * TREND_WINDOW_DAYS * 86400000);

  // Pull every non-void doc within the RFM window (or the trend-previous window if that
  // extends further back — it doesn't, trend windows are inside the RFM window per the
  // brief, but we fetch the wider of the two defensively) with its lines, grouped by
  // customerCode. customerCode (not customerId) is the grouping key — an unmatched code
  // still gets stats; matching happens for display only.
  const earliestNeeded = trendPrevStart < rfmSince ? trendPrevStart : rfmSince;
  const docs = await prisma.saleDoc.findMany({
    where: { void: false, customerCode: { not: null }, date: { gte: earliestNeeded } },
    select: {
      customerCode: true,
      date: true,
      total: true,
      lines: { select: { sku: true, qty: true, unitPrice: true, amount: true } },
    },
  });

  interface CustAgg {
    code: string;
    docsInRfmWindow: { date: Date; total: number }[];
    lastPurchase: Date | null;
    revenueRfm: number;
    curWindowRevenue: number;
    curWindowOrders: number;
    prevWindowRevenue: number;
    prevWindowOrders: number;
    // per-SKU purchase dates + unit prices, for reorder cycles (all dates in RFM window)
    skuDates: Map<string, Date[]>;
    skuMaxUnitPrice: Map<string, number>;
  }
  const byCustomer = new Map<string, CustAgg>();

  function getAgg(code: string): CustAgg {
    let a = byCustomer.get(code);
    if (!a) {
      a = {
        code,
        docsInRfmWindow: [],
        lastPurchase: null,
        revenueRfm: 0,
        curWindowRevenue: 0,
        curWindowOrders: 0,
        prevWindowRevenue: 0,
        prevWindowOrders: 0,
        skuDates: new Map(),
        skuMaxUnitPrice: new Map(),
      };
      byCustomer.set(code, a);
    }
    return a;
  }

  for (const doc of docs) {
    const code = doc.customerCode;
    if (!code) continue;
    const date = doc.date;
    const total = parseMoney(doc.total);
    const agg = getAgg(code);

    if (date >= rfmSince) {
      agg.docsInRfmWindow.push({ date, total });
      agg.revenueRfm += total;
      if (!agg.lastPurchase || date > agg.lastPurchase) agg.lastPurchase = date;
      for (const line of doc.lines) {
        if (!line.sku) continue;
        const arr = agg.skuDates.get(line.sku) ?? [];
        arr.push(date);
        agg.skuDates.set(line.sku, arr);
        const up = parseMoney(line.unitPrice);
        const prevMax = agg.skuMaxUnitPrice.get(line.sku) ?? 0;
        if (up > prevMax) agg.skuMaxUnitPrice.set(line.sku, up);
      }
    }

    if (date >= trendCurStart) {
      agg.curWindowRevenue += total;
      agg.curWindowOrders += 1;
    } else if (date >= trendPrevStart) {
      agg.prevWindowRevenue += total;
      agg.prevWindowOrders += 1;
    }
  }

  const codes = Array.from(byCustomer.keys());
  const rValues: number[] = []; // days since last purchase (smaller = better -> inverted)
  const fValues: number[] = [];
  const mValues: number[] = [];
  for (const code of codes) {
    const a = byCustomer.get(code)!;
    const r = a.lastPurchase ? daysBetween(now, a.lastPurchase) : RFM_WINDOW_DAYS;
    rValues.push(r);
    fValues.push(a.docsInRfmWindow.length);
    mValues.push(a.revenueRfm);
  }
  const rScores = quintileScores(rValues, true);
  const fScores = quintileScores(fValues, false);
  const mScores = quintileScores(mValues, false);

  const segmentCounts: Record<string, number> = {};

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const a = byCustomer.get(code)!;
    const r = rValues[i];
    const f = fValues[i];
    const m = mValues[i];
    const rScore = rScores[i];
    const fScore = fScores[i];
    const mScore = mScores[i];
    const segment = segmentFor(rScore, fScore, mScore);
    segmentCounts[segment] = (segmentCounts[segment] ?? 0) + 1;

    const trendRevenueDelta = a.curWindowRevenue - a.prevWindowRevenue;
    const trendPct =
      a.prevWindowRevenue > 0
        ? (trendRevenueDelta / a.prevWindowRevenue) * 100
        : a.curWindowRevenue > 0
          ? 100
          : 0;
    const trendDir = trendRevenueDelta > 0.01 ? 'up' : trendRevenueDelta < -0.01 ? 'down' : 'flat';
    const trendOrders = a.curWindowOrders - a.prevWindowOrders;

    // Reorder cycles: per-SKU median gap between purchase dates, >=REORDER_MIN_PURCHASES,
    // excluding equipment (bought once + unit price above threshold).
    const reorderDue: ReorderDueItem[] = [];
    for (const [sku, dates] of a.skuDates) {
      const sorted = [...dates].sort((x, y) => x.getTime() - y.getTime());
      const purchaseCount = sorted.length;
      const maxUnitPrice = a.skuMaxUnitPrice.get(sku) ?? 0;
      if (purchaseCount === 1 && maxUnitPrice > EQUIPMENT_PRICE_THRESHOLD) {
        continue; // one-off big-ticket equipment — not a consumable reorder cycle
      }
      if (purchaseCount < REORDER_MIN_PURCHASES) continue;

      const gaps: number[] = [];
      for (let k = 1; k < sorted.length; k++) gaps.push(daysBetween(sorted[k], sorted[k - 1]));
      gaps.sort((x, y) => x - y);
      const mid = Math.floor(gaps.length / 2);
      const medianGap = gaps.length % 2 === 0 ? (gaps[mid - 1] + gaps[mid]) / 2 : gaps[mid];
      if (medianGap <= 0) continue;

      const lastPurchase = sorted[sorted.length - 1];
      const daysSinceLast = daysBetween(now, lastPurchase);
      const dueThreshold = medianGap * REORDER_DUE_MULTIPLIER;
      if (daysSinceLast > dueThreshold) {
        reorderDue.push({
          sku,
          lastPurchase: lastPurchase.toISOString(),
          medianGapDays: Math.round(medianGap * 10) / 10,
          dueSinceDays: Math.round(daysSinceLast - dueThreshold),
          purchaseCount,
        });
      }
    }
    reorderDue.sort((x, y) => y.dueSinceDays - x.dueSinceDays);

    await prisma.customerStats.upsert({
      where: { customerCode: code },
      create: {
        customerCode: code,
        r,
        f,
        m,
        rfmScore: `${rScore}${fScore}${mScore}`,
        segment,
        trendPct: Math.round(trendPct * 10) / 10,
        trendDir,
        trendOrders,
        reorderDue: reorderDue.length ? (reorderDue as unknown as object) : undefined,
        dataFrom: coverage._min.date,
        dataTo: coverage._max.date,
      },
      update: {
        r,
        f,
        m,
        rfmScore: `${rScore}${fScore}${mScore}`,
        segment,
        trendPct: Math.round(trendPct * 10) / 10,
        trendDir,
        trendOrders,
        reorderDue: reorderDue.length ? (reorderDue as unknown as object) : Prisma.JsonNull,
        dataFrom: coverage._min.date,
        dataTo: coverage._max.date,
        computedAt: now,
      },
    });
  }

  return {
    customersProcessed: codes.length,
    segmentCounts,
    dataCoverage: { min: coverage._min.date, max: coverage._max.date },
  };
}
