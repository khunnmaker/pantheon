-- Doc recon (RE/MB/XS unified reconciliation): in-app payment-confirm marks for MB + imported XS
-- documents. ADD-only.

ALTER TABLE "ManualBill" ADD COLUMN "paymentConfirmedAt" TIMESTAMP(3);
ALTER TABLE "ManualBill" ADD COLUMN "paymentConfirmedBy" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ManualBill" ADD COLUMN "closeNote" TEXT NOT NULL DEFAULT '';

CREATE TABLE "XsDoc" (
    "id" TEXT NOT NULL,
    "xsNo" TEXT NOT NULL,
    "docDate" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "amount" TEXT NOT NULL DEFAULT '',
    "paymentConfirmedAt" TIMESTAMP(3),
    "paymentConfirmedBy" TEXT NOT NULL DEFAULT '',
    "closeNote" TEXT NOT NULL DEFAULT '',
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XsDoc_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "XsDoc_xsNo_key" ON "XsDoc"("xsNo");
CREATE INDEX "XsDoc_docDate_idx" ON "XsDoc"("docDate");
