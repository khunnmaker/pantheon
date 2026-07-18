-- Persist provider-reported AI token usage for the suite-wide cost dashboard.
CREATE TABLE "TokenUsage" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "app" TEXT NOT NULL,
  "feature" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
  "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
  "estCostUsd" DOUBLE PRECISION,

  CONSTRAINT "TokenUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TokenUsage_createdAt_idx" ON "TokenUsage"("createdAt");
CREATE INDEX "TokenUsage_app_feature_idx" ON "TokenUsage"("app", "feature");
CREATE INDEX "TokenUsage_model_idx" ON "TokenUsage"("model");
