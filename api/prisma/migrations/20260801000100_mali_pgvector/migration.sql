-- Mali retrieval: Voyage voyage-3 embeddings (1024 dims), isolated from Minerva's KB.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_embedding (
  article_id TEXT PRIMARY KEY REFERENCES "KnowledgeArticle"("id") ON DELETE CASCADE,
  embedding  vector(1024) NOT NULL
);

CREATE INDEX IF NOT EXISTS knowledge_embedding_hnsw
  ON knowledge_embedding USING hnsw (embedding vector_cosine_ops);
