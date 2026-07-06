-- Ceres: soft-delete (void) for expenses. ADDITIVE ONLY — safe on the shared live DB.
-- md/ceo can void any entry; the row is kept but excluded from every total/board/settlement.
ALTER TABLE "CeresExpense" ADD COLUMN "voidedById" TEXT;
ALTER TABLE "CeresExpense" ADD COLUMN "voidedAt" TIMESTAMP(3);
ALTER TABLE "CeresExpense" ADD COLUMN "voidReason" TEXT NOT NULL DEFAULT '';
