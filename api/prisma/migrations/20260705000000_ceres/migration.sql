-- Ceres (expenses & petty cash): all tables. ADDITIVE ONLY — safe on the shared live DB.
-- Timestamp 20260705* sorts after the in-flight Juno work (20260703*).

-- CreateTable
CREATE TABLE "CeresParty" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'person',
    "agentEmail" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CeresParty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "CashAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'pettyCash',
    "type" TEXT NOT NULL,
    "partyId" TEXT,
    "partyName" TEXT NOT NULL DEFAULT '',
    "entity" TEXT NOT NULL DEFAULT '',
    "amount" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CeresExpense" (
    "id" TEXT NOT NULL,
    "partyId" TEXT,
    "partyName" TEXT NOT NULL DEFAULT '',
    "enteredById" TEXT,
    "enteredByName" TEXT NOT NULL DEFAULT '',
    "entity" TEXT NOT NULL DEFAULT 'PROM',
    "category" TEXT NOT NULL DEFAULT '',
    "customerNote" TEXT NOT NULL DEFAULT '',
    "amount" TEXT NOT NULL DEFAULT '',
    "spentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receiptUploadId" TEXT,
    "receiptSha" TEXT NOT NULL DEFAULT '',
    "ocrAmount" TEXT NOT NULL DEFAULT '',
    "ocrVendor" TEXT NOT NULL DEFAULT '',
    "ocrDate" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectReason" TEXT NOT NULL DEFAULT '',
    "settlementId" TEXT,
    "aiVerdict" TEXT NOT NULL DEFAULT '',
    "aiReviewId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CeresExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CeresRevision" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "changedById" TEXT,
    "changedByName" TEXT NOT NULL DEFAULT '',
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CeresRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CeresSettlement" (
    "id" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "closedById" TEXT,
    "closedByName" TEXT NOT NULL DEFAULT '',
    "boxBefore" TEXT NOT NULL DEFAULT '',
    "boxAfter" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CeresSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CeresSettlementLine" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "partyId" TEXT,
    "partyName" TEXT NOT NULL DEFAULT '',
    "advances" TEXT NOT NULL DEFAULT '',
    "expenses" TEXT NOT NULL DEFAULT '',
    "refunds" TEXT NOT NULL DEFAULT '',
    "outstanding" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "CeresSettlementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CeresPaymentRequest" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT,
    "requestedByName" TEXT NOT NULL DEFAULT '',
    "entity" TEXT NOT NULL DEFAULT 'PROM',
    "payee" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "amount" TEXT NOT NULL DEFAULT '',
    "detail" TEXT NOT NULL DEFAULT '',
    "recurringTemplateId" TEXT,
    "billPeriod" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'requested',
    "aiReviewId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "paidById" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidRef" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CeresPaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CeresRecurringTemplate" (
    "id" TEXT NOT NULL,
    "payee" TEXT NOT NULL,
    "entity" TEXT NOT NULL DEFAULT 'PROM',
    "category" TEXT NOT NULL DEFAULT '',
    "expectedAmount" TEXT NOT NULL DEFAULT '',
    "tolerancePct" INTEGER NOT NULL DEFAULT 15,
    "period" TEXT NOT NULL DEFAULT 'monthly',
    "dueDay" INTEGER NOT NULL DEFAULT 1,
    "graceDays" INTEGER NOT NULL DEFAULT 5,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CeresRecurringTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CeresAIReview" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL DEFAULT '',
    "policyVersion" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CeresAIReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CeresStatementImport" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL DEFAULT '',
    "sha256" TEXT NOT NULL DEFAULT '',
    "periodFrom" TEXT NOT NULL DEFAULT '',
    "periodTo" TEXT NOT NULL DEFAULT '',
    "rowsParsed" INTEGER NOT NULL DEFAULT 0,
    "linesNew" INTEGER NOT NULL DEFAULT 0,
    "linesDup" INTEGER NOT NULL DEFAULT 0,
    "excluded" INTEGER NOT NULL DEFAULT 0,
    "importedById" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CeresStatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CeresStatementLine" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "txnAt" TIMESTAMP(3) NOT NULL,
    "amount" TEXT NOT NULL DEFAULT '',
    "direction" TEXT NOT NULL DEFAULT 'in',
    "channel" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "details" TEXT NOT NULL DEFAULT '',
    "payerName" TEXT NOT NULL DEFAULT '',
    "payerBank" TEXT NOT NULL DEFAULT '',
    "dedupeKey" TEXT NOT NULL,
    "matchStatus" TEXT NOT NULL DEFAULT 'unmatched',
    "matchedType" TEXT NOT NULL DEFAULT '',
    "matchedId" TEXT NOT NULL DEFAULT '',
    "refText" TEXT NOT NULL DEFAULT '',
    "reconciledById" TEXT,
    "reconciledAt" TIMESTAMP(3),

    CONSTRAINT "CeresStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CeresCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'general',
    "ceiling" TEXT NOT NULL DEFAULT '',
    "needsCustomerNote" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CeresCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CeresParty_name_key" ON "CeresParty"("name");

-- CreateIndex
CREATE INDEX "CashMovement_accountId_createdAt_idx" ON "CashMovement"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "CashMovement_partyId_idx" ON "CashMovement"("partyId");

-- CreateIndex
CREATE INDEX "CashMovement_type_idx" ON "CashMovement"("type");

-- CreateIndex
CREATE INDEX "CeresExpense_status_idx" ON "CeresExpense"("status");

-- CreateIndex
CREATE INDEX "CeresExpense_partyId_idx" ON "CeresExpense"("partyId");

-- CreateIndex
CREATE INDEX "CeresExpense_settlementId_idx" ON "CeresExpense"("settlementId");

-- CreateIndex
CREATE INDEX "CeresExpense_createdAt_idx" ON "CeresExpense"("createdAt");

-- CreateIndex
CREATE INDEX "CeresExpense_receiptSha_idx" ON "CeresExpense"("receiptSha");

-- CreateIndex
CREATE INDEX "CeresRevision_subjectType_subjectId_idx" ON "CeresRevision"("subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "CeresSettlement_dayKey_key" ON "CeresSettlement"("dayKey");

-- CreateIndex
CREATE INDEX "CeresSettlementLine_settlementId_idx" ON "CeresSettlementLine"("settlementId");

-- CreateIndex
CREATE INDEX "CeresSettlementLine_partyId_idx" ON "CeresSettlementLine"("partyId");

-- CreateIndex
CREATE INDEX "CeresPaymentRequest_status_idx" ON "CeresPaymentRequest"("status");

-- CreateIndex
CREATE INDEX "CeresPaymentRequest_recurringTemplateId_idx" ON "CeresPaymentRequest"("recurringTemplateId");

-- CreateIndex
CREATE INDEX "CeresPaymentRequest_createdAt_idx" ON "CeresPaymentRequest"("createdAt");

-- CreateIndex
CREATE INDEX "CeresAIReview_subjectType_subjectId_idx" ON "CeresAIReview"("subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "CeresStatementLine_dedupeKey_key" ON "CeresStatementLine"("dedupeKey");

-- CreateIndex
CREATE INDEX "CeresStatementLine_txnAt_idx" ON "CeresStatementLine"("txnAt");

-- CreateIndex
CREATE INDEX "CeresStatementLine_matchStatus_idx" ON "CeresStatementLine"("matchStatus");

-- CreateIndex
CREATE INDEX "CeresStatementLine_direction_idx" ON "CeresStatementLine"("direction");

-- CreateIndex
CREATE UNIQUE INDEX "CeresCategory_name_key" ON "CeresCategory"("name");

-- AddForeignKey
ALTER TABLE "CeresSettlementLine" ADD CONSTRAINT "CeresSettlementLine_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "CeresSettlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
