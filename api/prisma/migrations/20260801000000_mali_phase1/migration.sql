-- Mali staff knowledge models. Add-only migration.
CREATE TABLE "KnowledgeArticle" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "lineExposable" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "authorAgentId" TEXT NOT NULL,
    "sourceQuestionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeArticle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeDepartment" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "answererAgentIds" TEXT[],

    CONSTRAINT "KnowledgeDepartment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeQuestion" (
    "id" TEXT NOT NULL,
    "askerAgentId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "matchedArticleIds" TEXT[],
    "topSimilarity" DOUBLE PRECISION,
    "departmentId" TEXT,
    "answererAgentId" TEXT,
    "humanAnswer" TEXT,
    "distilledArticleId" TEXT,
    "askedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "KnowledgeQuestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KnowledgeDepartment_code_key" ON "KnowledgeDepartment"("code");
