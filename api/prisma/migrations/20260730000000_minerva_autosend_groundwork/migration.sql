-- Stage-3 groundwork: additive similarity instrumentation and the dark-launch slip-ack lane.
ALTER TABLE "ReplyOutcome" ADD COLUMN IF NOT EXISTS "similarity" DOUBLE PRECISION;

ALTER TABLE "Draft" ADD COLUMN "lane" TEXT;
ALTER TABLE "Draft" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Message" ADD COLUMN "autoSent" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Message_autoSent_createdAt_idx" ON "Message" ("autoSent", "createdAt");

CREATE TABLE "Setting" (
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);
