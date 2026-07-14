-- Apollo v1: project/task work management plus per-agent LINE binding.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN "lineUserId" TEXT,
ADD COLUMN "lineBindCode" TEXT;

-- CreateTable
CREATE TABLE "ApolloProject" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#4f46e5',
    "columns" TEXT[] NOT NULL DEFAULT ARRAY['To do', 'Doing', 'Done']::TEXT[],
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApolloProject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApolloProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApolloProjectMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApolloTask" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "assigneeId" TEXT,
    "creatorId" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL,
    "customerRef" TEXT,
    "recurrenceRule" JSONB,
    "seriesId" TEXT,
    "sortOrder" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApolloTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApolloComment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApolloComment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApolloAttachment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApolloAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Agent_lineUserId_key" ON "Agent"("lineUserId");
CREATE UNIQUE INDEX "Agent_lineBindCode_key" ON "Agent"("lineBindCode");
CREATE INDEX "ApolloProject_archived_idx" ON "ApolloProject"("archived");
CREATE UNIQUE INDEX "ApolloProjectMember_projectId_agentId_key" ON "ApolloProjectMember"("projectId", "agentId");
CREATE INDEX "ApolloProjectMember_agentId_idx" ON "ApolloProjectMember"("agentId");
CREATE UNIQUE INDEX "ApolloTask_seriesId_dueDate_key" ON "ApolloTask"("seriesId", "dueDate");
CREATE INDEX "ApolloTask_projectId_status_sortOrder_idx" ON "ApolloTask"("projectId", "status", "sortOrder");
CREATE INDEX "ApolloTask_assigneeId_completedAt_dueDate_idx" ON "ApolloTask"("assigneeId", "completedAt", "dueDate");
CREATE INDEX "ApolloTask_seriesId_completedAt_idx" ON "ApolloTask"("seriesId", "completedAt");
CREATE INDEX "ApolloComment_taskId_createdAt_idx" ON "ApolloComment"("taskId", "createdAt");
CREATE UNIQUE INDEX "ApolloAttachment_uploadId_key" ON "ApolloAttachment"("uploadId");
CREATE INDEX "ApolloAttachment_taskId_createdAt_idx" ON "ApolloAttachment"("taskId", "createdAt");

ALTER TABLE "ApolloProject" ADD CONSTRAINT "ApolloProject_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApolloProjectMember" ADD CONSTRAINT "ApolloProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ApolloProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApolloProjectMember" ADD CONSTRAINT "ApolloProjectMember_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApolloTask" ADD CONSTRAINT "ApolloTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ApolloProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApolloTask" ADD CONSTRAINT "ApolloTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ApolloTask" ADD CONSTRAINT "ApolloTask_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApolloComment" ADD CONSTRAINT "ApolloComment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ApolloTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApolloComment" ADD CONSTRAINT "ApolloComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApolloAttachment" ADD CONSTRAINT "ApolloAttachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ApolloTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApolloAttachment" ADD CONSTRAINT "ApolloAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Apollo is the whole-team task app: grant it to every existing employee (fresh databases
-- get it from the seed defaults; supervisor/md access is implicit via role in auth/jwt.ts).
UPDATE "Agent" SET "apps" = array_append("apps", 'apollo')
WHERE "role" = 'employee' AND NOT ('apollo' = ANY("apps"));
