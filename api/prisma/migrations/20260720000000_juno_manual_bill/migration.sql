-- Juno manual-bill lane. ADD-ONLY: one new table and one new Payment list column.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "billNos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ManualBill" (
    "id" TEXT NOT NULL,
    "billNo" TEXT NOT NULL,
    "billedAt" TEXT NOT NULL DEFAULT '',
    "buyerName" TEXT NOT NULL DEFAULT '',
    "buyerPhone" TEXT NOT NULL DEFAULT '',
    "buyerAddress" TEXT NOT NULL DEFAULT '',
    "items" JSONB,
    "amount" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualBill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualBill_billNo_key" ON "ManualBill"("billNo");

-- CreateIndex
CREATE INDEX "ManualBill_status_idx" ON "ManualBill"("status");

-- CreateIndex
CREATE INDEX "ManualBill_createdAt_idx" ON "ManualBill"("createdAt");
