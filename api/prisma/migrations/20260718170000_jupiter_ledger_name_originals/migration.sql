ALTER TABLE "JupiterJournalEntry"
  ADD COLUMN "memoOriginal" TEXT,
  ADD COLUMN "refOriginal" TEXT;

ALTER TABLE "JupiterJournalLine"
  ADD COLUMN "labelOriginal" TEXT;

ALTER TABLE "JupiterLedgerPartner"
  ADD COLUMN "nameOriginal" TEXT;
