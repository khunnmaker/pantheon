-- Venus (360° customer CRM) Stage A+B: customer-master backend foundation. ADDITIVE
-- ONLY — new tables, no changes to existing ones. See docs/VENUS_BRIEF.md.

-- CreateTable
CREATE TABLE "VenusCustomer" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "searchKey" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "nameEn" TEXT,
    "custType" TEXT,
    "repCode" TEXT,
    "zone" TEXT,
    "priceType" TEXT,
    "discount" TEXT,
    "address" TEXT,
    "contact" TEXT,
    "phone" TEXT,
    "acctNo" TEXT,
    "shipBy" TEXT,
    "creditDays" INTEGER,
    "creditLimit" TEXT,
    "creditTerms" TEXT,
    "creditTermsNorm" TEXT,
    "note" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenusCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleDoc" (
    "id" TEXT NOT NULL,
    "docNo" TEXT NOT NULL,
    "customerCode" TEXT,
    "customerId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "total" TEXT NOT NULL DEFAULT '',
    "docType" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleLine" (
    "id" TEXT NOT NULL,
    "saleDocId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "sku" TEXT,
    "productId" TEXT,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitPrice" TEXT NOT NULL DEFAULT '',
    "amount" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "SaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerStats" (
    "id" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "r" INTEGER,
    "f" INTEGER,
    "m" DOUBLE PRECISION,
    "rfmScore" TEXT,
    "segment" TEXT,
    "trendPct" DOUBLE PRECISION,
    "trendDir" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VenusCustomer_code_key" ON "VenusCustomer"("code");

-- CreateIndex
CREATE INDEX "VenusCustomer_searchKey_idx" ON "VenusCustomer"("searchKey");

-- CreateIndex
CREATE INDEX "VenusCustomer_repCode_idx" ON "VenusCustomer"("repCode");

-- CreateIndex
CREATE INDEX "VenusCustomer_custType_idx" ON "VenusCustomer"("custType");

-- CreateIndex
CREATE UNIQUE INDEX "SaleDoc_docNo_key" ON "SaleDoc"("docNo");

-- CreateIndex
CREATE INDEX "SaleDoc_customerCode_idx" ON "SaleDoc"("customerCode");

-- CreateIndex
CREATE INDEX "SaleDoc_date_idx" ON "SaleDoc"("date");

-- CreateIndex
CREATE UNIQUE INDEX "SaleLine_saleDocId_lineNo_key" ON "SaleLine"("saleDocId", "lineNo");

-- CreateIndex
CREATE INDEX "SaleLine_sku_idx" ON "SaleLine"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerStats_customerCode_key" ON "CustomerStats"("customerCode");

-- CreateIndex
CREATE INDEX "CustomerStats_segment_idx" ON "CustomerStats"("segment");

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_saleDocId_fkey" FOREIGN KEY ("saleDocId") REFERENCES "SaleDoc"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
