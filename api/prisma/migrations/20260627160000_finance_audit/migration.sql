-- CreateTable: tamper-proof corrected-amount audit (supervisor-only, in Minerva)
CREATE TABLE "FinanceAudit" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL DEFAULT '',
    "senderName" TEXT NOT NULL DEFAULT '',
    "ocrAmount" TEXT NOT NULL DEFAULT '',
    "amount" TEXT NOT NULL DEFAULT '',
    "diff" TEXT NOT NULL DEFAULT '',
    "salesName" TEXT NOT NULL DEFAULT '',
    "salesAgentId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FinanceAudit_resolvedAt_idx" ON "FinanceAudit"("resolvedAt");
