-- FIN-declared per-XS amount (owner ruling 2026-07-21): the imported STTRNR6.TXT `amount` is
-- not trusted money-of-record for XS docs — FIN types the real figure in the ตรวจแล้ว dialog.
-- ADD-only.

ALTER TABLE "XsDoc" ADD COLUMN "confirmedAmount" TEXT NOT NULL DEFAULT '';
ALTER TABLE "XsDoc" ADD COLUMN "confirmedAmountAt" TIMESTAMP(3);
ALTER TABLE "XsDoc" ADD COLUMN "confirmedAmountBy" TEXT NOT NULL DEFAULT '';
