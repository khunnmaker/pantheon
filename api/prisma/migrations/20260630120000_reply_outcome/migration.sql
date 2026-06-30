-- Learning metrics (Stage 1 instrumentation): one row per AI-drafted reply SENT, recording
-- whether the draft was accepted verbatim, edited (with magnitude), or escalated — the
-- positive signal the loop was previously missing. Kept as a RAW table (not a Prisma model)
-- so it stays additive and decoupled from the evolving schema; the app writes/reads it via
-- $executeRaw / $queryRaw, the same pattern already used for message_embedding.
CREATE TABLE IF NOT EXISTS "ReplyOutcome" (
  "id"                TEXT NOT NULL,
  "customerMessageId" TEXT,
  "draftType"         TEXT,                 -- what the AI produced: draft | needs_human | out_of_scope
  "category"          TEXT,                 -- price_stock | clinical | product | kb | general
  "outcome"           TEXT NOT NULL,        -- accepted_verbatim | edited | escalated
  "editScore"         DOUBLE PRECISION DEFAULT 0,  -- 0..1 normalized edit distance (0 = identical)
  "editBucket"        TEXT,                 -- none | cosmetic | minor | major | rewrite
  "agentId"           TEXT,
  "sentAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReplyOutcome_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ReplyOutcome_sentAt_idx" ON "ReplyOutcome" ("sentAt");
CREATE INDEX IF NOT EXISTS "ReplyOutcome_category_idx" ON "ReplyOutcome" ("category");
