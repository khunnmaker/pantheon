-- Deity swap 2026-07-12: mirror the cloud MercuryItem SKU field rename locally.
ALTER TABLE "PendingRequest" RENAME COLUMN "itemVulcanSku" TO "itemVestaSku";
