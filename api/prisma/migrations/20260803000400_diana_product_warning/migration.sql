-- Diana "สิ่งที่ควรรู้" product warning callout. Purely additive: two new nullable
-- columns on ProductEnrichment, no backfill. null = no warning shown for that sku.

ALTER TABLE "ProductEnrichment" ADD COLUMN "warningTh" TEXT;
ALTER TABLE "ProductEnrichment" ADD COLUMN "warningEn" TEXT;
