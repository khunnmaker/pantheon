-- Additive: timestamp of the last LINE picture fetch, throttling the periodic refresh (nullable, no backfill).
ALTER TABLE "Customer" ADD COLUMN "pictureFetchedAt" TIMESTAMP(3);
