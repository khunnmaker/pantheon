-- Juno task 2: withholding tax (หัก ณ ที่จ่าย). ADD-ONLY on the shared live Payment table.
-- amount stays the GROSS/RE figure; whtRate/whtAmount track the withheld slice so
-- net = amount - whtAmount reconciles the bank's short credit. Defaults (0 / '') are a no-op
-- for every existing row and for any non-WHT payment going forward.
ALTER TABLE "Payment" ADD COLUMN "whtRate" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "whtAmount" TEXT NOT NULL DEFAULT '';
