-- Juno payment discrepancy ledger. ADD-ONLY on the shared live Payment table.
-- Empty strings preserve existing rows as unset; resolution/confirmation timestamps are nullable.
ALTER TABLE "Payment" ADD COLUMN "discExpected" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Payment" ADD COLUMN "discResolution" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Payment" ADD COLUMN "discNote" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Payment" ADD COLUMN "discResolvedAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "discResolvedBy" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Payment" ADD COLUMN "discConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "discConfirmedBy" TEXT NOT NULL DEFAULT '';
