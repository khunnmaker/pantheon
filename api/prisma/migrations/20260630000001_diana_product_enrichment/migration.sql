-- CreateTable
CREATE TABLE "ProductEnrichment" (
    "sku" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "categoryEn" TEXT NOT NULL DEFAULT '',
    "descriptionTh" TEXT NOT NULL DEFAULT '',
    "descriptionEn" TEXT NOT NULL DEFAULT '',
    "specs" TEXT[],
    "source" TEXT NOT NULL DEFAULT 'derived',
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductEnrichment_pkey" PRIMARY KEY ("sku")
);

-- CreateIndex
CREATE INDEX "ProductEnrichment_brand_idx" ON "ProductEnrichment"("brand");

-- CreateIndex
CREATE INDEX "ProductEnrichment_category_idx" ON "ProductEnrichment"("category");
