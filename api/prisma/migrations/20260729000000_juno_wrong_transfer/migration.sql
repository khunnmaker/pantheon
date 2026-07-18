-- Add-only: classification marker for a customer transfer that belongs to no sale/document.
ALTER TABLE "Payment" ADD COLUMN "wrongTransferAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "wrongTransferBy" TEXT NOT NULL DEFAULT '';
CREATE INDEX "Payment_wrongTransferAt_idx" ON "Payment"("wrongTransferAt");
