import { prisma } from '../db/prisma.js';

type AuditRow = { issue: string; count: bigint };

async function main() {
  const rows = await prisma.$queryRaw<AuditRow[]>`
    SELECT 'invalid cash direction' AS issue, COUNT(*)::bigint AS count
      FROM "CashMovement" WHERE "direction" IS NOT NULL AND "direction" NOT IN ('in', 'out')
    UNION ALL
    SELECT 'invalid funding lane', COUNT(*)::bigint
      FROM "CeresExpense" WHERE "fundingLane" NOT IN ('cash', 'transfer', 'self_funded')
    UNION ALL
    SELECT 'invalid v2 request union', COUNT(*)::bigint
      FROM "CeresPaymentRequest"
      WHERE "workflowVersion" = 2 AND (
        "requestType" NOT IN ('advance', 'reimbursement', 'purchase') OR
        "approvalStatus" NOT IN ('pending_nee', 'pending_ceo', 'approved', 'rejected', 'cancelled', 'void') OR
        "fulfillmentStatus" NOT IN ('unfulfilled', 'paid', 'bought', 'settling', 'settled', 'reversed') OR
        "aiScreenStatus" NOT IN ('pending', 'clear', 'escalate')
      )
    UNION ALL
    SELECT 'invalid request money event', COUNT(*)::bigint
      FROM "CeresRequestMoneyEvent"
      WHERE "kind" NOT IN ('payment', 'purchase', 'refund', 'reversal')
         OR "lane" NOT IN ('cash', 'transfer')
         OR ("lane" = 'cash' AND "cashMovementId" IS NULL)
         OR ("lane" = 'transfer' AND "kind" <> 'reversal' AND "transferSlipUploadId" IS NULL)
         OR ("kind" = 'purchase' AND "purchaseReceiptUploadId" IS NULL)
         OR ("kind" = 'reversal' AND "reversesEventId" IS NULL)
    UNION ALL
    SELECT 'invalid statement match type', COUNT(*)::bigint
      FROM "CeresStatementLine"
      WHERE "matchedType" NOT IN ('', 'paymentRequest', 'cashMovement', 'requestMoneyEvent')
    UNION ALL
    SELECT 'duplicate requestMoneyEventId', COUNT(*)::bigint
      FROM (
        SELECT "requestMoneyEventId" FROM "CashMovement"
        WHERE "requestMoneyEventId" IS NOT NULL
        GROUP BY "requestMoneyEventId" HAVING COUNT(*) > 1
      ) duplicates
    UNION ALL
    SELECT 'duplicate reversesMovementId', COUNT(*)::bigint
      FROM (
        SELECT "reversesMovementId" FROM "CashMovement"
        WHERE "reversesMovementId" IS NOT NULL
        GROUP BY "reversesMovementId" HAVING COUNT(*) > 1
      ) duplicates
    UNION ALL
    SELECT 'money event matched by multiple statement lines', COUNT(*)::bigint
      FROM (
        SELECT "matchedId" FROM "CeresStatementLine"
        WHERE "matchedType" = 'requestMoneyEvent' AND "matchedId" <> ''
        GROUP BY "matchedId" HAVING COUNT(*) > 1
      ) duplicates
  `;
  const failures = rows.filter((row) => row.count > 0n);
  for (const row of rows) process.stdout.write(`${row.issue}: ${row.count.toString()}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
