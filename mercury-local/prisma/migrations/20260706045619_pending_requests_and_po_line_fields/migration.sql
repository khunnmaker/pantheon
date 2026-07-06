-- CreateTable
CREATE TABLE "PendingRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cloudRequestId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "requestedById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "itemDisplayName" TEXT NOT NULL DEFAULT '',
    "itemIsSecret" BOOLEAN NOT NULL DEFAULT false,
    "itemVulcanSku" TEXT,
    "cloudCreatedAt" TEXT NOT NULL DEFAULT '',
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PurchaseOrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poId" TEXT NOT NULL,
    "cloudItemId" TEXT NOT NULL,
    "realName" TEXT NOT NULL,
    "realSku" TEXT NOT NULL DEFAULT '',
    "qty" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL DEFAULT '',
    "unitCost" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "classification" TEXT NOT NULL DEFAULT 'normal',
    "photoRef" TEXT,
    CONSTRAINT "PurchaseOrderLine_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PurchaseOrderLine" ("cloudItemId", "id", "poId", "qty", "realName", "realSku", "unitCost") SELECT "cloudItemId", "id", "poId", "qty", "realName", "realSku", "unitCost" FROM "PurchaseOrderLine";
DROP TABLE "PurchaseOrderLine";
ALTER TABLE "new_PurchaseOrderLine" RENAME TO "PurchaseOrderLine";
CREATE INDEX "PurchaseOrderLine_poId_idx" ON "PurchaseOrderLine"("poId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PendingRequest_cloudRequestId_key" ON "PendingRequest"("cloudRequestId");

-- CreateIndex
CREATE INDEX "PendingRequest_status_idx" ON "PendingRequest"("status");

-- CreateIndex
CREATE INDEX "PendingRequest_itemId_idx" ON "PendingRequest"("itemId");
