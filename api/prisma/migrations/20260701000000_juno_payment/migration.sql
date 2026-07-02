-- Juno (finance). ADDITIVE ONLY — adds one new table (Payment) that Minerva's
-- /to-finance hook writes and the Juno app reads. Nothing Minerva already reads or
-- writes is dropped or renamed. Safe to run on the shared live DB.

-- CreateTable: the structured record of every incoming LINE-slip payment
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "customerCode" TEXT NOT NULL DEFAULT '',
    "customerName" TEXT NOT NULL DEFAULT '',
    "senderName" TEXT NOT NULL DEFAULT '',
    "amount" TEXT NOT NULL DEFAULT '',
    "ocrAmount" TEXT NOT NULL DEFAULT '',
    "bank" TEXT NOT NULL DEFAULT '',
    "transferAt" TEXT NOT NULL DEFAULT '',
    "ref" TEXT NOT NULL DEFAULT '',
    "slipMessageId" TEXT,
    "slipUrl" TEXT NOT NULL DEFAULT '',
    "taxInvoice" TEXT NOT NULL DEFAULT '',
    "taxInvoiceStatus" TEXT NOT NULL DEFAULT 'none',
    "salesAgentId" TEXT,
    "salesName" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'received',
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");
CREATE INDEX "Payment_flagged_idx" ON "Payment"("flagged");
CREATE INDEX "Payment_taxInvoiceStatus_idx" ON "Payment"("taxInvoiceStatus");
CREATE INDEX "Payment_customerCode_idx" ON "Payment"("customerCode");
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");
CREATE UNIQUE INDEX "Payment_slipMessageId_key" ON "Payment"("slipMessageId");
