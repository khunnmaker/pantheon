-- Hestia v1 is additive: private goals, habits, check-ins, derived streaks, and journal entries.
CREATE TABLE "HestiaGoal" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "color" TEXT NOT NULL DEFAULT '#b45309',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HestiaGoal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HestiaHabit" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "cadence" TEXT NOT NULL DEFAULT 'daily',
    "scheduleDays" INTEGER[] NOT NULL DEFAULT ARRAY[0, 1, 2, 3, 4, 5, 6]::INTEGER[],
    "targetCount" INTEGER NOT NULL DEFAULT 1,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HestiaHabit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HestiaCheckIn" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "habitId" TEXT NOT NULL,
    "checkDate" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT NOT NULL DEFAULT '',
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HestiaCheckIn_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HestiaHabitStreak" (
    "habitId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastCompletedOn" DATE,
    "calculatedOn" DATE NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HestiaHabitStreak_pkey" PRIMARY KEY ("habitId")
);

CREATE TABLE "HestiaJournalEntry" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "entryDate" DATE NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "bodyMarkdown" TEXT NOT NULL,
    "mood" INTEGER,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'manual',
    "externalId" TEXT,
    "externalUrl" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3),
    "sourceMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HestiaJournalEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HestiaGoal_ownerId_year_code_key" ON "HestiaGoal"("ownerId", "year", "code");
CREATE INDEX "HestiaGoal_ownerId_year_status_idx" ON "HestiaGoal"("ownerId", "year", "status");
CREATE UNIQUE INDEX "HestiaHabit_ownerId_goalId_code_key" ON "HestiaHabit"("ownerId", "goalId", "code");
CREATE INDEX "HestiaHabit_ownerId_active_idx" ON "HestiaHabit"("ownerId", "active");
CREATE INDEX "HestiaHabit_goalId_sortOrder_idx" ON "HestiaHabit"("goalId", "sortOrder");
CREATE UNIQUE INDEX "HestiaCheckIn_habitId_checkDate_key" ON "HestiaCheckIn"("habitId", "checkDate");
CREATE INDEX "HestiaCheckIn_ownerId_checkDate_idx" ON "HestiaCheckIn"("ownerId", "checkDate");
CREATE INDEX "HestiaCheckIn_habitId_checkDate_idx" ON "HestiaCheckIn"("habitId", "checkDate");
CREATE INDEX "HestiaHabitStreak_ownerId_idx" ON "HestiaHabitStreak"("ownerId");
CREATE UNIQUE INDEX "HestiaJournalEntry_ownerId_source_externalId_key" ON "HestiaJournalEntry"("ownerId", "source", "externalId");
CREATE INDEX "HestiaJournalEntry_ownerId_entryDate_idx" ON "HestiaJournalEntry"("ownerId", "entryDate");

ALTER TABLE "HestiaGoal" ADD CONSTRAINT "HestiaGoal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HestiaHabit" ADD CONSTRAINT "HestiaHabit_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HestiaHabit" ADD CONSTRAINT "HestiaHabit_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "HestiaGoal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HestiaCheckIn" ADD CONSTRAINT "HestiaCheckIn_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HestiaCheckIn" ADD CONSTRAINT "HestiaCheckIn_habitId_fkey" FOREIGN KEY ("habitId") REFERENCES "HestiaHabit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HestiaHabitStreak" ADD CONSTRAINT "HestiaHabitStreak_habitId_fkey" FOREIGN KEY ("habitId") REFERENCES "HestiaHabit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HestiaHabitStreak" ADD CONSTRAINT "HestiaHabitStreak_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HestiaJournalEntry" ADD CONSTRAINT "HestiaJournalEntry_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
