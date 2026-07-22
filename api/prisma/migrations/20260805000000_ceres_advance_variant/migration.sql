-- Additive nullable column for the Ceres 4-button request chooser (owner-confirmed
-- design, 2026-07-23). Only meaningful when "requestType" = 'advance': NULL = plain
-- float advance (เบิกล่วงหน้า, unchanged); 'purchase' = เบิกเงินไปซื้อ. Old advance rows
-- stay NULL — no backfill needed.
ALTER TABLE "CeresPaymentRequest" ADD COLUMN "advanceVariant" TEXT;
