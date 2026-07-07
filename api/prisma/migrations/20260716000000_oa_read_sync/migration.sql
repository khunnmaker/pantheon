-- OA read-sync. ADD-ONLY: a brand-new table, no changes to any existing column. One row per
-- OA-Manager-native customer id (oaChatId, U…32hex), upserted by the passive Chrome extension.
-- customerId is our matched Customer.id (nullable — left null when the name match is ambiguous).
-- The LINE Messaging API has no outbound read receipts, so this is the only source of "Read" status.

-- CreateTable
CREATE TABLE "OaReadSync" (
    "id" TEXT NOT NULL,
    "oaChatId" TEXT NOT NULL,
    "customerId" TEXT,
    "oaTitle" TEXT,
    "oaSubName" TEXT,
    "readLabel" TEXT,
    "readSeenAt" TIMESTAMP(3),
    "reportedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OaReadSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OaReadSync_oaChatId_key" ON "OaReadSync"("oaChatId");

-- CreateIndex
CREATE INDEX "OaReadSync_customerId_idx" ON "OaReadSync"("customerId");
