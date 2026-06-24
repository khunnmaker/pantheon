-- M3 retrieval: pgvector extension + embedding tables (Voyage voyage-3 = 1024 dims).
-- Managed via raw SQL (spec ?5 note) ? vector ops use $queryRaw/$executeRaw.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS message_embedding (
  message_id TEXT PRIMARY KEY REFERENCES "Message"("id") ON DELETE CASCADE,
  embedding  vector(1024) NOT NULL
);
CREATE TABLE IF NOT EXISTS kb_embedding (
  kb_id     TEXT PRIMARY KEY REFERENCES "KbEntry"("id") ON DELETE CASCADE,
  embedding vector(1024) NOT NULL
);

CREATE INDEX IF NOT EXISTS message_embedding_hnsw ON message_embedding USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS kb_embedding_hnsw ON kb_embedding USING hnsw (embedding vector_cosine_ops);
