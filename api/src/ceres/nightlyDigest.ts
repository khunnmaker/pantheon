import { prisma } from '../db/prisma.js';
import { env } from '../env.js';
import { sendLineText } from '../line/send.js';
import { computeBoard, num, thaiDayKey, thaiDayRange } from '../routes/ceres/common.js';
import { computeTemplateDue } from '../routes/ceres/requests.js';
import { ageStuckAIReviews } from './requestService.js';

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

  const [escalatedRows, flaggedCount, board, templateDue, settlementToday, pendingCount, pendingNeeCount, v2AiEscalatedCount] = await Promise.all([
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

  return [
    `🌙 Ceres สรุปประจำวัน ${dateStr}`,
    `รออนุมัติจากคุณ: ${escalatedCount} รายการ (฿${escalatedSum.toFixed(2)})`,
    `รอนีตรวจคำขอใหม่: ${pendingNeeCount} รายการ`,
    `รายการติดธง AI วันนี้: ${flaggedCount + v2AiEscalatedCount}`,
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
async function fireDigest(log: { info: Function; error: Function }): Promise<void> {
  // Suite-wide CEO_LINE_USER_ID, with the old Ceres-scoped name as a deprecated fallback
  // (same fallback pattern as ceres/notifyCeo.ts).
  const ceoLineUserId = env.CEO_LINE_USER_ID || env.CERES_CEO_LINE_USER_ID;
  if (!ceoLineUserId) {
    log.info('[ceres digest] CEO_LINE_USER_ID not configured — skipping nightly digest');
    return;
  }
  try {
    await sendLineText(ceoLineUserId, await buildCeresDigest());
    log.info('[ceres digest] sent nightly CEO digest');
  } catch (err) {
    log.error({ err }, '[ceres digest] failed to send nightly CEO digest');
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
