-- CreateTable
CREATE TABLE "ClinicAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "clinicName" TEXT NOT NULL DEFAULT '',
    "contactName" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "rejectNote" TEXT NOT NULL DEFAULT '',
    "customerCode" TEXT,
    "pdpaConsentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "ClinicAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebOrder" (
    "id" TEXT NOT NULL,
    "clinicAccountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "note" TEXT NOT NULL DEFAULT '',
    "taxName" TEXT NOT NULL DEFAULT '',
    "taxAddress" TEXT NOT NULL DEFAULT '',
    "taxId" TEXT NOT NULL DEFAULT '',
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    "invoicedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL DEFAULT '',
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WebOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClinicAccount_email_key" ON "ClinicAccount"("email");

-- CreateIndex
CREATE INDEX "ClinicAccount_status_idx" ON "ClinicAccount"("status");

-- CreateIndex
CREATE INDEX "WebOrder_clinicAccountId_idx" ON "WebOrder"("clinicAccountId");

-- CreateIndex
CREATE INDEX "WebOrder_status_idx" ON "WebOrder"("status");

-- CreateIndex
CREATE INDEX "WebOrderLine_orderId_idx" ON "WebOrderLine"("orderId");

-- CreateIndex
CREATE INDEX "WebOrderLine_sku_idx" ON "WebOrderLine"("sku");

-- AddForeignKey
ALTER TABLE "WebOrder" ADD CONSTRAINT "WebOrder_clinicAccountId_fkey" FOREIGN KEY ("clinicAccountId") REFERENCES "ClinicAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebOrderLine" ADD CONSTRAINT "WebOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "WebOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
