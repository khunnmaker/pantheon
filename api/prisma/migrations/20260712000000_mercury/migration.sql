-- Mercury (procurement / buy-side) — CLOUD node tables only. ADDITIVE ONLY: two new tables,
-- no ALTER/DROP of any existing table — safe on the shared live DB. Timestamp 20260712* sorts
-- after the latest existing migration (20260711000000_ceres_expense_void).
-- SECRETS-FREE BY CONSTRUCTION: no vendor/cost/realName/realSku columns exist here (see
-- docs/MERCURY_BRIEF.md §3/§8). Vendor/SecretMap/PurchaseOrder live only in local-Mercury.

-- CreateTable
CREATE TABLE "MercuryItem" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "vulcanSku" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MercuryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MercuryRequest" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" TEXT NOT NULL DEFAULT '',
    "requestedById" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),

    CONSTRAINT "MercuryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MercuryItem_active_idx" ON "MercuryItem"("active");

-- CreateIndex
CREATE INDEX "MercuryRequest_status_idx" ON "MercuryRequest"("status");
