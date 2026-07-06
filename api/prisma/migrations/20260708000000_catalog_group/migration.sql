-- Catalog merchandising group per product. ADDITIVE ONLY — one nullable column + index.
-- Independent of the Express category in the SKU; assigned in Vulcan. See catalogGroups.ts.

ALTER TABLE "Product" ADD COLUMN "catalogGroup" TEXT;

CREATE INDEX "Product_catalogGroup_idx" ON "Product"("catalogGroup");
