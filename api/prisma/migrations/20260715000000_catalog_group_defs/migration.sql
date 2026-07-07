-- User-created catalog groups + sub-groups (Vulcan จัดกลุ่ม tab). ADDITIVE ONLY.
-- These OVERLAY the built-in vocabulary in api/src/stock/catalogGroups.ts; the merged view is
-- loaded by api/src/stock/taxonomy.ts. Built-ins stay in code; only staff-created rows land here.

CREATE TABLE "CatalogGroupDef" (
    "key" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL DEFAULT '',
    "nameEn" TEXT NOT NULL DEFAULT '',
    "pillar" TEXT NOT NULL DEFAULT 'lab',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CatalogGroupDef_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "CatalogGroupDef_code_key" ON "CatalogGroupDef"("code");

CREATE TABLE "CatalogSubgroupDef" (
    "id" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL DEFAULT '',
    "nameEn" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CatalogSubgroupDef_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CatalogSubgroupDef_groupKey_code_key" ON "CatalogSubgroupDef"("groupKey", "code");

CREATE INDEX "CatalogSubgroupDef_groupKey_idx" ON "CatalogSubgroupDef"("groupKey");
