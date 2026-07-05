-- Catalog sub-group per product (2-letter code within the group; product code = group +
-- subgroup + number → "IMAL01"). ADDITIVE ONLY — one nullable column. See catalogGroups.ts.

ALTER TABLE "Product" ADD COLUMN "catalogSubgroup" TEXT;
