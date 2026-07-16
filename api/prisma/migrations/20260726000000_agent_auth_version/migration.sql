-- ADD-only: invalidate every bearer/device session for one Agent without changing token TTLs.
ALTER TABLE "Agent" ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;
