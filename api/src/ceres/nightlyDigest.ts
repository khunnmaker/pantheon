import { prisma } from '../db/prisma.js';
import { env } from '../env.js';
import { getProminentOwnerLineUserId } from '../line/owner.js';
import { sendOwnerLineText } from '../line/send.js';
import { computeBoard, num, thaiDayKey, thaiDayRange, transferReconciliationStats } from '../routes/ceres/common.js';
import { computeTemplateDue } from '../routes/ceres/requests.js';
import { ageStuckAIReviews } from './requestService.js';

export interface DailyOutflowBucket {
  lane: string;
  requestType: string;
  count: number;
  amount: string;
}

export async function dailyOutflowSummary(createdAt: { gte?: Date; lte?: Date }): Promise<DailyOutflowBucket[]> {
  const events = await prisma.ceresRequestMoneyEvent.findMany({
    where: { kind: { in: ['payment', 'purchase'] }, createdAt },
    select: { id: true, requestId: true, lane: true, amount: true },
  });
  if (events.length === 0) return [];
  const [reversals, requests] = await Promise.all([
    prisma.ceresRequestMoneyEvent.findMany({
      where: { kind: 'reversal', reversesEventId: { in: events.map((event) => event.id) } },
      select: { reversesEventId: true },
    }),
    prisma.ceresPaymentRequest.findMany({
      where: { id: { in: [...new Set(events.map((event) => event.requestId))] } },
      select: { id: true, requestType: true },
    }),
  ]);
  const reversed = new Set(reversals.map((event) => event.reversesEventId));
  const requestTypes = new Map(requests.map((request) => [request.id, request.requestType]));
  const buckets = new Map<string, { lane: string; requestType: string; count: number; amount: number }>();
  for (const event of events) {
    if (reversed.has(event.id)) continue;
    const requestType = requestTypes.get(event.requestId) ?? 'unknown';
    const key = `${event.lane}:${requestType}`;
    const bucket = buckets.get(key) ?? { lane: event.lane, requestType, count: 0, amount: 0 };
    bucket.count += 1;
    bucket.amount += num(event.amount);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => a.lane.localeCompare(b.lane) || a.requestType.localeCompare(b.requestType))
    .map((bucket) => ({ ...bucket, amount: bucket.amount.toFixed(2) }));
}

async function countV2AiEscalations(createdAt: { gte?: Date; lte?: Date }): Promise<number> {
  const reviews = await prisma.ceresAIReview.findMany({
    where: { subjectType: 'paymentRequest', createdAt },
    orderBy: [{ subjectId: 'asc' }, { createdAt: 'desc' }],
    select: { subjectId: true, verdict: true },
  });
  const seen = new Set<string>();
  const escalatedRequestIds = reviews.flatMap((review) => {
    if (seen.has(review.subjectId)) return [];
    seen.add(review.subjectId);
    return review.verdict === 'escalate' ? [review.subjectId] : [];
  });
  if (escalatedRequestIds.length === 0) return 0;
  return prisma.ceresPaymentRequest.count({
    where: { id: { in: escalatedRequestIds }, workflowVersion: 2 },
  });
}

// Nightly CEO digest — a once-a-day LINE push (see startCeresDigestScheduler) that gives
// the CEO the same signal Ceres shows live: what's waiting on him, what the AI flagged,
// the box balance, overdue bills, and whether today's close happened. Sent EVERY night
// (an all-clear digest is itself the signal that the system is alive — CERES_BRIEF §10).
export async function buildCeresDigest(): Promise<string> {
  const now = new Date();
  const todayKey = thaiDayKey(now);
  // thaiDayKey always yields a "YYYY-MM-DD" thaiDayRange can parse, so this is never
  // null in practice; the `?? {}` is only a type-safe fallback (no createdAt filter).
  const todayRange = thaiDayRange(todayKey, todayKey) ?? {};
  await ageStuckAIReviews(now);

  const [escalatedRows, flaggedCount, board, templateDue, settlementToday, pendingCount, pendingNeeCount, v2AiEscalatedCount, transferRecon, dailyOutflow] = await Promise.all([
    prisma.ceresPaymentRequest.findMany({
      where: {
        OR: [
          { workflowVersion: 1, status: 'escalated' },
          { workflowVersion: 2, approvalStatus: 'pending_ceo' },
        ],
      },
      select: { amount: true },
    }),
    prisma.ceresExpense.count({ where: { aiVerdict: 'flagged', createdAt: todayRange } }),
    computeBoard(),
    computeTemplateDue(),
    prisma.ceresSettlement.findUnique({ where: { dayKey: todayKey } }),
    prisma.ceresExpense.count({ where: { status: 'pending' } }),
    prisma.ceresPaymentRequest.count({ where: { workflowVersion: 2, approvalStatus: 'pending_nee' } }),
    countV2AiEscalations(todayRange),
    transferReconciliationStats(),
    dailyOutflowSummary(todayRange),
  ]);

  const escalatedCount = escalatedRows.length;
  const escalatedSum = escalatedRows.reduce((s, r) => s + num(r.amount), 0);
  const overdueCount = templateDue.filter((d) => d.state === 'overdue').length;

  // D/M/YYYY in Thai local time (UTC+7, no DST) — same shift convention as thaiDayKey.
  const thaiNow = new Date(now.getTime() + 7 * 3600 * 1000);
  const dateStr = `${thaiNow.getUTCDate()}/${thaiNow.getUTCMonth() + 1}/${thaiNow.getUTCFullYear()}`;

  const boxLine = board.box.belowFloor
    ? `เงินกล่อง: ฿${board.box.balance.toFixed(2)} ⚠️ ต่ำกว่าเกณฑ์ — แนะนำเติม ฿${board.box.suggestedTopup.toFixed(2)}`
    : `เงินกล่อง: ฿${board.box.balance.toFixed(2)}`;
  const closeLine = settlementToday
    ? 'ปิดยอดวันนี้: ✅ ปิดแล้ว'
    : `ปิดยอดวันนี้: ⚠️ ยังไม่ปิด (ค้างตรวจ ${pendingCount})`;

  const laneLabels: Record<string, string> = { cash: 'เงินสด', transfer: 'โอน' };
  const typeLabels: Record<string, string> = { advance: 'ทดรอง', reimbursement: 'เบิกคืน', purchase: 'จัดซื้อ' };
  const outflowLine = dailyOutflow.length
    ? `รายจ่ายวันนี้: ${dailyOutflow.map((bucket) => `${laneLabels[bucket.lane] ?? bucket.lane}/${typeLabels[bucket.requestType] ?? bucket.requestType} ฿${bucket.amount} (${bucket.count})`).join(' · ')}`
    : 'รายจ่ายวันนี้: ไม่มี';

  return [
    `🌙 Ceres สรุปประจำวัน ${dateStr}`,
    `รออนุมัติจากคุณ: ${escalatedCount} รายการ (฿${escalatedSum.toFixed(2)})`,
    `รอนีตรวจคำขอใหม่: ${pendingNeeCount} รายการ`,
    `รายการติดธง AI วันนี้: ${flaggedCount + v2AiEscalatedCount}`,
    `Transfer reconciliation exceptions: ${transferRecon.unmatched} (reversals ${transferRecon.reversalExceptions})`,
    outflowLine,
    boxLine,
    `บิลเลยกำหนด: ${overdueCount}`,
    closeLine,
  ].join('\n');
}

// ms from now until the next CERES_DIGEST_HOUR:00 Thai time. Thai time is UTC+7 with no
// DST, so "Thai hour H" is always UTC hour (H-7 mod 24) — we work entirely in UTC to
// stay correct regardless of the server's own TZ (same convention as thaiDayKey/computeTemplateDue).
function msUntilNextDigest(): number {
  const now = new Date();
  const targetUtcHour = (env.CERES_DIGEST_HOUR - 7 + 24) % 24;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetUtcHour, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

// One firing: resolve the CEO's LINE id, send tonight's digest. Never throws — a missing
// id or a LINE failure only logs, so the caller's reschedule always runs.
export async function fireDigest(log: { info: Function; error: Function }): Promise<void> {
  const ceoLineUserId = getProminentOwnerLineUserId();
  if (!ceoLineUserId) {
    log.error(
      { event: 'owner_digest_skipped', kind: 'ceres_nightly', reason: 'owner_id_unset' },
      '[ceres digest] owner ID not configured — skipping nightly digest',
    );
    return;
  }
  try {
    const result = await sendOwnerLineText(ceoLineUserId, await buildCeresDigest());
    if (result.skipped) {
      log.error(
        { event: 'owner_digest_skipped', kind: 'ceres_nightly', reason: result.skipReason },
        '[ceres digest] appdent unavailable — skipped nightly owner digest',
      );
    } else if (result.dryRun) {
      log.info({ event: 'owner_digest_dry_run', kind: 'ceres_nightly' }, '[ceres digest] nightly owner digest dry-run');
    } else {
      log.info({ event: 'owner_digest_sent', kind: 'ceres_nightly' }, '[ceres digest] sent nightly owner digest');
    }
  } catch {
    log.error(
      { event: 'owner_push_failed', kind: 'ceres_nightly', reason: 'line_api_error' },
      '[ceres digest] failed to send nightly owner digest',
    );
  }
}

// Starts the nightly-digest loop. A self-rechaining setTimeout (not setInterval, so a slow
// send can never overlap the next one) that fires once at the next CERES_DIGEST_HOUR:00
// Thai instant, then reschedules itself for 24h later — every path (unconfigured CEO id,
// successful send, or a caught send failure) reschedules, so the loop never dies. The timer
// is .unref()'d so it can never by itself keep the process alive (same pattern as the idle-
// session sweep in index.ts).
export function startCeresDigestScheduler(log: { info: Function; error: Function }): void {
  const scheduleNext = () => {
    const timer = setTimeout(() => {
      void fireDigest(log).finally(scheduleNext);
    }, msUntilNextDigest());
    timer.unref();
  };
  scheduleNext();
}
