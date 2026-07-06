-- Additive: LINE profile/group picture url for a customer (nullable, no backfill).
ALTER TABLE "Customer" ADD COLUMN "pictureUrl" TEXT;
