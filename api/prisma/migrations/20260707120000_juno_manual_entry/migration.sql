-- Juno manual entry (add receipt / cash / cheque) + settle state.
-- ADD-only: 6 new columns on Payment (all with safe defaults so every existing
-- LINE-slip row is unaffected — source defaults to 'line', settleState to '').

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "chequeBank" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "chequeDueDate" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "chequeNo" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "settleState" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "settledById" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'line';

-- CreateIndex
CREATE INDEX "Payment_source_idx" ON "Payment"("source");

-- CreateIndex
CREATE INDEX "Payment_settleState_idx" ON "Payment"("settleState");
