-- Juno task 1: CEO-only receipt-verify gate for cash/cheque payments.
-- receivedAt/receivedBy are SEPARATE from settleState/settledAt (the banking/deposit-clear
-- state) — this stamps that the CEO physically confirmed receipt of the cash/cheque, which is
-- a hard prerequisite for ยืนยันใน Express (status->'recorded'). ADD-only, no data backfill
-- needed (null = not yet confirmed, the correct default for every existing row).
ALTER TABLE "Payment" ADD COLUMN "receivedAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "receivedBy" TEXT;
