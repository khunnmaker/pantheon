-- Juno phase A: FIN check data on Payment. ADDITIVE ONLY — safe on the shared live DB.
ALTER TABLE "Payment" ADD COLUMN "reNumber" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Payment" ADD COLUMN "receiptName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Payment" ADD COLUMN "customerType" TEXT NOT NULL DEFAULT '';
CREATE INDEX "Payment_reNumber_idx" ON "Payment"("reNumber");
