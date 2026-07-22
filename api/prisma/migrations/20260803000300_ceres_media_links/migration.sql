-- Ceres multi-image attachments: additive CeresMediaLink table. Every existing singular
-- upload-id column (CeresExpense.receiptUploadId, CeresPaymentRequest.requestPhotoUploadId,
-- CeresRequestMoneyEvent.transferSlipUploadId / purchaseReceiptUploadId) stays exactly as
-- today's "primary image" for compatibility; this table additionally records every image
-- attached to a target (target = request | expense | money_event), ordered by sortOrder.
-- No backfill: rows with no CeresMediaLink entries fall back to their singular column at
-- read time (see ceres/mediaLinks.ts). No CREATE INDEX CONCURRENTLY — Prisma wraps this
-- migration in a transaction.

-- CreateTable
CREATE TABLE "CeresMediaLink" (
  "id" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CeresMediaLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- purpose is part of the key: a purchase paid by transfer legitimately carries BOTH a
-- transfer_slip and a purchase_receipt link set on the SAME money_event target, and the
-- same media id appearing in both must not P2002.
CREATE UNIQUE INDEX "CeresMediaLink_targetType_targetId_purpose_mediaId_key" ON "CeresMediaLink"("targetType", "targetId", "purpose", "mediaId");
CREATE INDEX "CeresMediaLink_targetType_targetId_idx" ON "CeresMediaLink"("targetType", "targetId");
CREATE INDEX "CeresMediaLink_mediaId_idx" ON "CeresMediaLink"("mediaId");
