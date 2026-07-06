-- Juno RE reconciliation (the "future RE-import" the WHT task's grossOf() was built for).
-- ADD-ONLY: a brand-new table, no changes to any existing column. One row per Express
-- AR-receipt (ARRCPDAT "RE#######"), upserted by reNumber on each periodic import. Match
-- status against Payment.reNumbers is computed live on read, never stored here.
CREATE TABLE "ReReceipt" (
    "id" TEXT NOT NULL,
    "reNumber" TEXT NOT NULL,
    "receiptDate" TEXT NOT NULL DEFAULT '',
    "customerName" TEXT NOT NULL DEFAULT '',
    "salesName" TEXT NOT NULL DEFAULT '',
    "amount" TEXT NOT NULL DEFAULT '',
    "notPosted" BOOLEAN NOT NULL DEFAULT false,
    "invoices" JSONB,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReReceipt_reNumber_key" ON "ReReceipt"("reNumber");

-- CreateIndex
CREATE INDEX "ReReceipt_notPosted_idx" ON "ReReceipt"("notPosted");
