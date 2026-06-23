-- Enables pgvector on first database boot (mounted into the db container's
-- /docker-entrypoint-initdb.d). Prisma's `extensions = [vector]` will also
-- ensure this via migrations, but enabling it here means a fresh container is
-- ready before the first `prisma migrate`.
CREATE EXTENSION IF NOT EXISTS vector;

-- Vector similarity indexes (cosine) are added in M3 once the embedding tables
-- are populated, e.g.:
--   CREATE INDEX ON "MessageEmbedding" USING hnsw (embedding vector_cosine_ops);
--   CREATE INDEX ON "KbEmbedding"      USING hnsw (embedding vector_cosine_ops);
