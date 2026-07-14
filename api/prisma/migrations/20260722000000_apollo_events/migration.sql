-- Apollo private events: per-agent personal calendar entries with free/busy visibility.
-- Additive only (new table, no changes to existing Apollo tables).

-- CreateTable
CREATE TABLE "ApolloEvent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "date" DATE NOT NULL,
    "endDate" DATE,
    "startTime" TEXT,
    "endTime" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApolloEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ApolloEvent_agentId_date_idx" ON "ApolloEvent"("agentId", "date");
CREATE INDEX "ApolloEvent_date_idx" ON "ApolloEvent"("date");

ALTER TABLE "ApolloEvent" ADD CONSTRAINT "ApolloEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
