-- Venus Phase 1 (sales import, OESOC) + Phase 2 (RFM/trend/reorder engine). ADDITIVE
-- ONLY — new columns on the already-defined SaleDoc/CustomerStats tables, no changes to
-- existing columns. See docs/VENUS_BRIEF.md.

-- AlterTable
ALTER TABLE "SaleDoc" ADD COLUMN     "void" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "repCode" TEXT,
ADD COLUMN     "goodsValue" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "vat" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "delivered" BOOLEAN,
ADD COLUMN     "reference" TEXT;

-- AlterTable
ALTER TABLE "CustomerStats" ADD COLUMN     "trendOrders" INTEGER,
ADD COLUMN     "reorderDue" JSONB,
ADD COLUMN     "dataFrom" TIMESTAMP(3),
ADD COLUMN     "dataTo" TIMESTAMP(3);
