-- Product alias (short human-friendly codes). ADDITIVE ONLY — one new table, nothing
-- existing is dropped/renamed. Product.sku stays the shared key. See api/src/stock/aliases.ts.

CREATE TABLE "ProductAlias" (
    "sku" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductAlias_pkey" PRIMARY KEY ("sku")
);

CREATE UNIQUE INDEX "ProductAlias_alias_key" ON "ProductAlias"("alias");

CREATE INDEX "ProductAlias_groupKey_idx" ON "ProductAlias"("groupKey");
