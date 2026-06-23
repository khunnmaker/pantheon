-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sessionId" TEXT,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "agentId" TEXT,
    "kbIds" TEXT[],
    "channelMsgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMemory" (
    "customerId" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "summarizedThroughN" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerMemory_pkey" PRIMARY KEY ("customerId")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'agent',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbEntry" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "questionVariants" TEXT[],
    "answer" TEXT NOT NULL,
    "sku" TEXT,
    "sensitivity" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "lastVerifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerAgentId" TEXT,

    CONSTRAINT "KbEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearnedAnswer" (
    "id" TEXT NOT NULL,
    "customerQuestion" TEXT NOT NULL,
    "aiDraft" TEXT NOT NULL,
    "finalAnswer" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "edited" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "promotedKbId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearnedAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "draftText" TEXT NOT NULL,
    "usedKb" TEXT[],
    "note" TEXT,
    "retrievedMsgIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_lineUserId_key" ON "Customer"("lineUserId");

-- CreateIndex
CREATE INDEX "Message_customerId_idx" ON "Message"("customerId");

-- CreateIndex
CREATE INDEX "Message_sessionId_idx" ON "Message"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_email_key" ON "Agent"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Draft_messageId_key" ON "Draft"("messageId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMemory" ADD CONSTRAINT "CustomerMemory_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
