-- Venus manual pinned note (ข้อควรระวัง precaution #4, VENUS_BRIEF.md §7). ADDITIVE ONLY —
-- one new table, nothing existing is dropped/renamed. Keyed on the Express customer code
-- (soft-link, no FK — same convention as SaleDoc.customerCode).

CREATE TABLE "VenusNote" (
    "id" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "authorName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenusNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VenusNote_customerCode_key" ON "VenusNote"("customerCode");
