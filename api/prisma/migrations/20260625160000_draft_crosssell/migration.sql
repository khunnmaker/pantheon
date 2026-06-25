-- AI-suggested cross-sell/complementary product SKUs offered alongside the match.
ALTER TABLE "Draft" ADD COLUMN "crossSellSkus" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
