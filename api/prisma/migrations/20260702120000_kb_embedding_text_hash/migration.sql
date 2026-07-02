-- Freshness marker for KB embeddings: the sha256 of the exact text each vector was computed
-- from. Lets the boot backfill detect and re-embed entries whose text changed but whose
-- re-embed was lost (deploy mid-flight, bulk KB reload, failed delete) — previously a stale
-- vector was served forever because the backfill was presence-only. ADD-only, raw table.
ALTER TABLE kb_embedding ADD COLUMN IF NOT EXISTS text_hash TEXT;
