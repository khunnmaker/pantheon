import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { sendLineText } from '../line/send.js';

const CERES_DEEP_LINK = 'https://ceres.prominentdental.com';

type NotifyRow = {
  eventId: string;
  kind: string;
  note: string;
  requestId: string;
  requestType: string;
  amount: string;
  lineUserId: string | null;
};

const typeLabels: Record<string, string> = {
  advance: 'เบิกเงินทดรอง',
  reimbursement: 'เบิกคืนค่าใช้จ่าย',
  purchase: 'ขอจัดซื้อ',
};

const statusLabels: Record<string, string> = {
  nee_approved: '✅ คำขอได้รับอนุมัติแล้ว',
  ceo_approved: '✅ คำขอได้รับอนุมัติแล้ว',
  nee_rejected: '❌ คำขอถูกปฏิเสธ',
  ceo_rejected: '❌ คำขอถูกปฏิเสธ',
  paid: '💸 จ่ายเงินให้แล้ว',
  bought: '🛒 ดำเนินการจัดซื้อแล้ว',
};

function shortSafeText(value: string): string {
  return value
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\/content\/(?:ceres-receipt|slip)\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function messageFor(row: NotifyRow): string {
  const lines = [
    statusLabels[row.kind],
    `ประเภท: ${typeLabels[row.requestType] ?? row.requestType}`,
    `ยอดเงิน: ฿${row.amount}`,
  ];
  if (row.kind.endsWith('_rejected')) {
    const note = shortSafeText(row.note);
    if (note) lines.push(`เหตุผล: ${note}`);
  }
  lines.push(`${CERES_DEEP_LINK}/?request=${encodeURIComponent(row.requestId)}`);
  return lines.join('\n');
}

async function claimNotification(where: Prisma.Sql): Promise<NotifyRow | null> {
  const rows = await prisma.$queryRaw<NotifyRow[]>(Prisma.sql`
    UPDATE "CeresRequestEvent" AS event
    SET "payload" = event."payload" || jsonb_build_object('requesterLineNotificationClaimedAt', NOW())
    FROM "CeresPaymentRequest" AS request
    LEFT JOIN "Agent" AS agent ON agent."id" = request."requestedById"
    WHERE event."requestId" = request."id"
      AND ${where}
      AND (
        (event."kind" = 'nee_approved' AND event."payload"->>'approvalStatus' = 'approved')
        OR event."kind" IN ('ceo_approved', 'nee_rejected', 'ceo_rejected', 'paid', 'bought')
      )
      AND NOT (event."payload" ? 'requesterLineNotificationClaimedAt')
    RETURNING
      event."id" AS "eventId",
      event."kind",
      event."note",
      request."id" AS "requestId",
      request."requestType",
      request."amount",
      agent."lineUserId"
  `);
  return rows[0] ?? null;
}

async function notifyClaimed(row: NotifyRow | null): Promise<void> {
  if (!row?.lineUserId) return;
  await sendLineText(row.lineUserId, messageFor(row));
}

// The claim is an atomic update on the already-committed request event. It makes the
// event itself the notification idempotency record: a replay finds the same event but
// cannot claim it twice. Every failure is swallowed so request state is never affected.
export async function notifyRequesterForEvent(eventId: string): Promise<void> {
  try {
    await notifyClaimed(await claimNotification(Prisma.sql`event."id" = ${eventId}`));
  } catch {
    // Best-effort only. The request transition committed before this function was called.
  }
}

export async function notifyRequesterForMoneyEvent(moneyEventId: string): Promise<void> {
  try {
    await notifyClaimed(await claimNotification(
      Prisma.sql`event."payload"->>'moneyEventId' = ${moneyEventId}`,
    ));
  } catch {
    // Best-effort only. The fulfillment transaction committed before this function was called.
  }
}
