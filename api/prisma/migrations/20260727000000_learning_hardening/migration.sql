-- Add a durable conflict-review lane for learned answers. Status remains a string so existing
-- transient promotion states and production rows remain backward-compatible.
ALTER TABLE "LearnedAnswer" ADD COLUMN "flagNote" TEXT;
