-- Venus weekly AI suggestion card (VENUS_BRIEF.md §7 "AI cards"). ADDITIVE ONLY — one new
-- table, nothing existing is dropped/renamed/altered. One row per customer, overwritten each
-- generator run. Keyed on the Express customer code (soft-link, no FK — same convention as
-- VenusNote/SaleDoc.customerCode).

CREATE TABLE "VenusCard" (
    "id" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "signalsJson" JSONB NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenusCard_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VenusCard_customerCode_key" ON "VenusCard"("customerCode");
