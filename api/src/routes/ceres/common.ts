import { prisma } from '../../db/prisma.js';
import { env } from '../../env.js';
import { CERES_EMBEDDED_MEDIA_URL_TTL_SECONDS, ceresReceiptUrl } from '../../ceres/receiptLink.js';
import { cashBalanceFromMovements } from '../../ceres/requestMoney.js';

// All Ceres day-math is Thai business time (UTC+7) regardless of server TZ — same
// convention as Juno (see routes/juno.ts).
const TH_OFFSET_MS = 7 * 3600 * 1000;
export const thaiDayKey = (d: Date): string => new Date(d.getTime() + TH_OFFSET_MS).toISOString().slice(0, 10);

// "YYYY-MM-DD" (from the UI date inputs) → an inclusive UTC instant range for the Thai day.
export function thaiDayRange(from?: string, to?: string): { gte?: Date; lte?: Date } | null {
  const range: { gte?: Date; lte?: Date } = {};
  if (from) { const d = new Date(`${from}T00:00:00+07:00`); if (!Number.isNaN(d.getTime())) range.gte = d; }
  if (to)   { const d = new Date(`${to}T23:59:59.999+07:00`); if (!Number.isNaN(d.getTime())) range.lte = d; }
  return range.gte || range.lte ? range : null;
}

// A parsed baht number for summing/sorting; free-text/blank amounts → 0.
export function num(s: string): number {
  const n = parseFloat((s || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Amounts are accepted as strings matching this pattern (whole baht or up to 2 decimal
// places) and must be > 0 — reject anything else (free text, negative, zero) with 400.
export const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
export function isValidAmount(s: string): boolean {
  return AMOUNT_RE.test(s) && num(s) > 0;
}

export function parseRequestCategoryGroups(value: string): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((group) => typeof group === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export function requestCategoryLabel(request: {
  requestType: string;
  category: string;
  categoryGroups: string;
}): string {
  const groups = request.requestType === 'advance'
    ? parseRequestCategoryGroups(request.categoryGroups)
    : [];
  return groups.length > 0 ? groups.join(' · ') : request.category;
}

// Workflow-v2 projection. Keep this separate from the legacy mapper in requests.ts:
// old clients continue to read `status`, while v2 clients read the split approval,
// fulfillment, and AI-screen fields below.
export function toStaffRequestRow(
  r: {
    id: string; requestedById: string | null; requestedByName: string; requesterPartyId: string | null;
    entity: string; payee: string; category: string; categoryGroups: string; amount: string; detail: string;
    requestType: string; approvalStatus: string; fulfillmentStatus: string;
    requestPhotoUploadId: string | null; ocrAmount: string; ocrVendor: string; ocrDate: string;
    aiScreenStatus: string; aiReviewId: string | null; neeDecidedById: string | null;
    neeDecidedByName: string; neeDecidedAt: Date | null; neeDecisionNote: string;
    decidedById: string | null; decidedAt: Date | null; decisionNote: string;
    voidedById: string | null; voidedAt: Date | null; voidReason: string;
    rowVersion: number; createdAt: Date; updatedAt: Date;
  },
  review?: { verdict: string; reasoning: string; createdAt: Date } | null,
  // The full CeresMediaLink-backed attachment list ("request_photo" purpose), ordered by
  // sortOrder. Callers that already know it (batched list reads, or a write path that just
  // computed it) pass it in; omitted, it falls back to [requestPhotoUploadId] / [] — correct
  // for a legacy row with no link rows, but callers holding a real multi-image set MUST pass
  // it explicitly or the extra images silently vanish from the response.
  requestPhotoUploadIds?: string[],
) {
  return {
    id: r.id,
    workflowVersion: 2,
    requestType: r.requestType,
    requestedById: r.requestedById,
    requestedByName: r.requestedByName,
    requesterPartyId: r.requesterPartyId,
    entity: r.entity,
    payee: r.payee,
    category: requestCategoryLabel(r),
    categoryGroups: parseRequestCategoryGroups(r.categoryGroups),
    amount: r.amount,
    amountNum: num(r.amount),
    reason: r.detail,
    requestPhotoUploadId: r.requestPhotoUploadId,
    requestPhotoUploadIds: requestPhotoUploadIds ?? (r.requestPhotoUploadId ? [r.requestPhotoUploadId] : []),
    ocr: { amount: r.ocrAmount, vendor: r.ocrVendor, date: r.ocrDate },
    aiScreenStatus: r.aiScreenStatus,
    aiReviewId: r.aiReviewId,
    aiReview: review ? {
      verdict: review.verdict,
      reasoning: review.reasoning,
      createdAt: review.createdAt.toISOString(),
    } : null,
    approvalStatus: r.approvalStatus,
    fulfillmentStatus: r.fulfillmentStatus,
    neeDecision: r.neeDecidedAt ? {
      byId: r.neeDecidedById,
      byName: r.neeDecidedByName,
      at: r.neeDecidedAt.toISOString(),
      note: r.neeDecisionNote,
    } : null,
    ceoDecision: r.decidedAt ? {
      byId: r.decidedById,
      at: r.decidedAt.toISOString(),
      note: r.decisionNote,
    } : null,
    voidedById: r.voidedById,
    voidedAt: r.voidedAt ? r.voidedAt.toISOString() : null,
    voidReason: r.voidReason,
    rowVersion: r.rowVersion,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// The row shape the Ceres UI consumes for an expense (the stored CeresExpense plus
// a derived numeric amount + tokenized receipt url when a receipt is attached).
export function toExpenseRow(
  e: {
    id: string; partyId: string | null; partyName: string; enteredById: string | null;
    enteredByName: string; entity: string; category: string; customerNote: string;
    amount: string; spentAt: Date; receiptUploadId: string | null; receiptSha: string;
    ocrAmount: string; ocrVendor: string; ocrDate: string; status: string;
    approvedById: string | null; approvedAt: Date | null; rejectReason: string;
    voidedById: string | null; voidedAt: Date | null; voidReason: string;
    settlementId: string | null; aiVerdict: string; note: string; createdAt: Date;
    advanceRequestId: string | null; fundingLane: string;
  },
  base: string,
  // Whether another (non-rejected/void) expense shares this one's receiptSha — batch-computed
  // by callers that list multiple rows (see GET /api/ceres/expenses); defaults to false so
  // every other call site (single-expense responses, CEO overview, CSV export) still gets the
  // field on its row without having to compute it.
  duplicateReceipt = false,
  // The full CeresMediaLink-backed attachment list ("receipt" purpose), ordered by sortOrder.
  // Same contract as toStaffRequestRow's requestPhotoUploadIds param above — pass it whenever
  // it's already known, or a multi-image set silently collapses to just its primary element.
  receiptUploadIds?: string[],
) {
  return {
    id: e.id,
    partyId: e.partyId,
    partyName: e.partyName,
    enteredById: e.enteredById,
    enteredByName: e.enteredByName,
    entity: e.entity,
    category: e.category,
    customerNote: e.customerNote,
    amount: e.amount,
    amountNum: num(e.amount),
    spentAt: e.spentAt.toISOString(),
    receiptUploadId: e.receiptUploadId,
    receiptUploadIds: receiptUploadIds ?? (e.receiptUploadId ? [e.receiptUploadId] : []),
    receiptUrl: e.receiptUploadId
      ? ceresReceiptUrl(base, e.receiptUploadId, Date.now(), CERES_EMBEDDED_MEDIA_URL_TTL_SECONDS)
      : null,
    ocrAmount: e.ocrAmount,
    ocrVendor: e.ocrVendor,
    ocrDate: e.ocrDate,
    status: e.status,
    approvedById: e.approvedById,
    approvedAt: e.approvedAt ? e.approvedAt.toISOString() : null,
    rejectReason: e.rejectReason,
    voidedById: e.voidedById,
    voidedAt: e.voidedAt ? e.voidedAt.toISOString() : null,
    voidReason: e.voidReason,
    settlementId: e.settlementId,
    advanceRequestId: e.advanceRequestId,
    fundingLane: e.fundingLane,
    aiVerdict: e.aiVerdict,
    note: e.note,
    createdAt: e.createdAt.toISOString(),
    duplicateReceipt,
  };
}

// CeresRequestMoneyEvent projection — adds the array form of both evidence fields
// alongside the existing singular columns. Same optional-param/fallback contract as
// toExpenseRow/toStaffRequestRow above.
export function toMoneyEventRow<
  T extends { transferSlipUploadId: string | null; purchaseReceiptUploadId: string | null },
>(
  e: T,
  transferSlipUploadIds?: string[],
  purchaseReceiptUploadIds?: string[],
): T & { transferSlipUploadIds: string[]; purchaseReceiptUploadIds: string[] } {
  return {
    ...e,
    transferSlipUploadIds: transferSlipUploadIds ?? (e.transferSlipUploadId ? [e.transferSlipUploadId] : []),
    purchaseReceiptUploadIds: purchaseReceiptUploadIds ?? (e.purchaseReceiptUploadId ? [e.purchaseReceiptUploadId] : []),
  };
}

// Re-exported here so route files only need one import for the row mapper + url builder.
export { ceresReceiptUrl } from '../../ceres/receiptLink.js';

export async function lastSettlement() {
  return prisma.ceresSettlement.findFirst({ orderBy: { createdAt: 'desc' } });
}

export async function transferReconciliationStats(): Promise<{ unmatched: number; reversalExceptions: number }> {
  const [events, links] = await Promise.all([
    prisma.ceresRequestMoneyEvent.findMany({ where: { lane: 'transfer' }, select: { id: true, kind: true } }),
    prisma.ceresStatementLine.findMany({
      where: { matchedType: 'requestMoneyEvent', matchedId: { not: '' } },
      select: { matchedId: true },
    }),
  ]);
  const linkedIds = new Set(links.map((link) => link.matchedId));
  const unmatched = events.filter((event) => !linkedIds.has(event.id));
  return {
    unmatched: unmatched.length,
    reversalExceptions: unmatched.filter((event) => event.kind === 'reversal').length,
  };
}

export interface PartyBoard {
  partyId: string;
  partyName: string;
  active: boolean;
  outstandingBefore: number;
  advancesSince: number;
  refundsSince: number;
  approvedSince: number;
  pendingCount: number;
  pendingSum: number;
  expectedChange: number;
}

// A Prisma client OR an interactive-transaction client — computeBoard can run inside
// POST /close's transaction so the settlement snapshot and the reads it is built from
// are one consistent view.
type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// Per-party "expected change" board — everything measured SINCE THE LAST SETTLEMENT
// (not calendar-day), so a skipped daily close never corrupts the math (CERES_BRIEF
// P1 step 3/4). Options (used by POST /close):
//   tx     — run every read on this transaction client instead of the global prisma.
//   cutoff — upper bound (lte) on every CashMovement read. The close stamps the new
//            settlement's createdAt to the SAME instant, so a movement landing
//            mid-close can never fall between this settlement's lines and the next
//            board's "since last settlement" window.
export async function computeBoard(opts?: { tx?: Db; cutoff?: Date }): Promise<{
  settlement: Awaited<ReturnType<typeof lastSettlement>>;
  parties: PartyBoard[];
  box: { balance: number; floor: number; belowFloor: boolean; suggestedTopup: number };
}> {
  const db = opts?.tx ?? prisma;
  const cutoff = opts?.cutoff;
  const settlement = await db.ceresSettlement.findFirst({ orderBy: { createdAt: 'desc' } });
  const since = settlement?.createdAt;

  // Movement windows: "since the last settlement" for the per-party sums, all-time for
  // the box balance — both clipped to the cutoff instant when one is given.
  const sinceWindow =
    since || cutoff ? { createdAt: { ...(since ? { gt: since } : {}), ...(cutoff ? { lte: cutoff } : {}) } } : {};
  const allTimeWindow = cutoff ? { createdAt: { lte: cutoff } } : {};

  // ALL parties — including deactivated ones: a party switched off while still owing
  // money must keep appearing on the board and in settlement lines until its balance
  // clears, or its outstanding would be silently written off. The inclusion filter
  // below drops only inactive parties with no balance and no activity.
  const [parties, lines, advances, refunds, approved, pending, allMovements] =
    await Promise.all([
      db.ceresParty.findMany({ orderBy: { sortOrder: 'asc' } }),
      settlement
        ? db.ceresSettlementLine.findMany({ where: { settlementId: settlement.id } })
        : Promise.resolve([] as Awaited<ReturnType<typeof prisma.ceresSettlementLine.findMany>>),
      db.cashMovement.findMany({
        where: {
          accountId: 'pettyCash',
          ...sinceWindow,
          OR: [
            { type: 'advance' },
            { type: 'reversal', direction: 'out', partyId: { not: null } },
          ],
        },
      }),
      db.cashMovement.findMany({
        where: {
          accountId: 'pettyCash',
          ...sinceWindow,
          OR: [
            { type: { in: ['refund', 'request_refund'] } },
            { type: 'reversal', direction: 'in', partyId: { not: null } },
          ],
        },
      }),
      db.ceresExpense.findMany({ where: { status: 'approved', settlementId: null, fundingLane: { not: 'transfer' } } }),
      db.ceresExpense.findMany({ where: { status: 'pending', fundingLane: { not: 'transfer' } } }),
      db.cashMovement.findMany({
        where: { accountId: 'pettyCash', ...allTimeWindow },
        select: { amount: true, direction: true, type: true },
      }),
    ]);

  const outstandingByParty = new Map<string, number>();
  for (const l of lines) {
    if (l.partyId) outstandingByParty.set(l.partyId, num(l.outstanding));
  }
  const sumByParty = (rows: { partyId: string | null; amount: string }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (!r.partyId) continue;
      m.set(r.partyId, (m.get(r.partyId) ?? 0) + num(r.amount));
    }
    return m;
  };
  const advancesByParty = sumByParty(advances);
  const refundsByParty = sumByParty(refunds);
  const approvedByParty = sumByParty(approved);
  const pendingCountByParty = new Map<string, number>();
  const pendingSumByParty = new Map<string, number>();
  for (const e of pending) {
    if (!e.partyId) continue;
    pendingCountByParty.set(e.partyId, (pendingCountByParty.get(e.partyId) ?? 0) + 1);
    pendingSumByParty.set(e.partyId, (pendingSumByParty.get(e.partyId) ?? 0) + num(e.amount));
  }

  const partyBoards: PartyBoard[] = [];
  for (const p of parties) {
    const outstandingBefore = outstandingByParty.get(p.id) ?? 0;
    const advancesSince = advancesByParty.get(p.id) ?? 0;
    const refundsSince = refundsByParty.get(p.id) ?? 0;
    const approvedSince = approvedByParty.get(p.id) ?? 0;
    const pendingCount = pendingCountByParty.get(p.id) ?? 0;
    const pendingSum = pendingSumByParty.get(p.id) ?? 0;
    const expectedChange = outstandingBefore + advancesSince - approvedSince - refundsSince;
    const hasActivity = advancesSince !== 0 || refundsSince !== 0 || approvedSince !== 0 || pendingCount > 0;
    if (hasActivity || outstandingBefore !== 0 || p.active) {
      partyBoards.push({
        partyId: p.id,
        partyName: p.name,
        active: p.active,
        outstandingBefore,
        advancesSince,
        refundsSince,
        approvedSince,
        pendingCount,
        pendingSum,
        expectedChange,
      });
    }
  }

  const balance = cashBalanceFromMovements(allMovements);
  const floor = env.CERES_FLOOR;
  const belowFloor = balance < floor;
  const suggestedTopup = belowFloor ? Math.ceil((floor - balance + 1000) / 1000) * 1000 : 0;

  return {
    settlement,
    parties: partyBoards,
    box: { balance, floor, belowFloor, suggestedTopup },
  };
}
