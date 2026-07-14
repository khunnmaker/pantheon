-- Additive Diana semantic-search index (Voyage voyage-3 = 1024 dims).
-- Managed via raw SQL, matching the existing KB embedding tables.
CREATE TABLE IF NOT EXISTS "ProductEmbedding" (
  sku           TEXT PRIMARY KEY REFERENCES "Product"("sku") ON DELETE CASCADE,
  embedding     vector(1024) NOT NULL,
  "contentHash" TEXT NOT NULL,
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ProductEmbedding_embedding_hnsw"
  ON "ProductEmbedding" USING hnsw (embedding vector_cosine_ops);
