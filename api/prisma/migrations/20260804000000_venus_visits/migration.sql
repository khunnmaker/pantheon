-- CreateTable
CREATE TABLE "VenusVisitMessage" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "lineMessageId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT,
    "visitId" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenusVisitMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenusVisit" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "repName" TEXT NOT NULL,
    "repAgentId" TEXT,
    "customerCode" TEXT,
    "status" TEXT NOT NULL,
    "visitAt" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "extractJson" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenusVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenusCustomerAlias" (
    "aliasKey" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "VenusActionItem" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "customerCode" TEXT,
    "text" TEXT NOT NULL,
    "needsOwner" BOOLEAN NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneBy" TEXT,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenusActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VenusVisitMessage_lineMessageId_key" ON "VenusVisitMessage"("lineMessageId");

-- CreateIndex
CREATE INDEX "VenusVisitMessage_groupId_lineUserId_processedAt_idx" ON "VenusVisitMessage"("groupId", "lineUserId", "processedAt");

-- CreateIndex
CREATE INDEX "VenusVisit_customerCode_idx" ON "VenusVisit"("customerCode");

-- CreateIndex
CREATE INDEX "VenusVisit_status_idx" ON "VenusVisit"("status");

-- CreateIndex
CREATE UNIQUE INDEX "VenusCustomerAlias_aliasKey_key" ON "VenusCustomerAlias"("aliasKey");

-- CreateIndex
CREATE INDEX "VenusActionItem_done_idx" ON "VenusActionItem"("done");

-- AddForeignKey
ALTER TABLE "VenusVisitMessage" ADD CONSTRAINT "VenusVisitMessage_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "VenusVisit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenusActionItem" ADD CONSTRAINT "VenusActionItem_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "VenusVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
