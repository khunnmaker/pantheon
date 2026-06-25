-- Product catalog (extracted from the Prominent PDF catalogue via vision).
CREATE TABLE "Product" (
    "sku" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL DEFAULT '',
    "nameTh" TEXT NOT NULL DEFAULT '',
    "price" INTEGER NOT NULL DEFAULT 0,
    "promo" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "page" INTEGER,
    "photoSku" TEXT,
    "keywords" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("sku")
);

-- CreateIndex
CREATE INDEX "Product_status_idx" ON "Product"("status");
