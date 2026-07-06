-- Per-agent private "pin chat" (ปักหมุด). ADDITIVE ONLY: one new table, no ALTER/DROP of
-- any existing table — safe on the shared live DB. Timestamp 20260713* sorts after the
-- latest existing migration (20260712000000_mercury / _juno_received_confirm).

-- CreateTable
CREATE TABLE "Pin" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Pin_agentId_idx" ON "Pin"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "Pin_agentId_customerId_key" ON "Pin"("agentId", "customerId");
