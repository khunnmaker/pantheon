-- Vulcan (stock management). ADDITIVE ONLY — adds one nullable column to Product
-- and two new audit tables. Nothing Minerva reads (Product.stock/stockAt and the
-- rest) is dropped or renamed. Safe to run on the shared live DB.

-- AlterTable: low-stock threshold per SKU
ALTER TABLE "Product" ADD COLUMN "reorderPoint" INTEGER;

-- CreateTable: audit of each daily Express CSV import
CREATE TABLE "StockImport" (
    "id" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedBy" TEXT,
    "fileName" TEXT NOT NULL DEFAULT '',
    "rowsParsed" INTEGER NOT NULL DEFAULT 0,
    "skusUpdated" INTEGER NOT NULL DEFAULT 0,
    "skusUnmatched" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "StockImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable: audit of manual stock edits
CREATE TABLE "StockAdjustment" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "fromQty" INTEGER,
    "toQty" INTEGER,
    "reason" TEXT NOT NULL DEFAULT '',
    "byAgentId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockAdjustment_sku_idx" ON "StockAdjustment"("sku");
