-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PurchaseOrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poId" TEXT NOT NULL,
    "cloudItemId" TEXT NOT NULL,
    "cloudRequestId" TEXT NOT NULL DEFAULT '',
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
INSERT INTO "new_PurchaseOrderLine" ("classification", "cloudItemId", "currency", "id", "photoRef", "poId", "qty", "realName", "realSku", "unit", "unitCost") SELECT "classification", "cloudItemId", "currency", "id", "photoRef", "poId", "qty", "realName", "realSku", "unit", "unitCost" FROM "PurchaseOrderLine";
DROP TABLE "PurchaseOrderLine";
ALTER TABLE "new_PurchaseOrderLine" RENAME TO "PurchaseOrderLine";
CREATE INDEX "PurchaseOrderLine_poId_idx" ON "PurchaseOrderLine"("poId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
