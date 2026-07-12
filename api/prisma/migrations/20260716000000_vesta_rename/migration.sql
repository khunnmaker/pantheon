-- Deity swap 2026-07-12: the stock app Vulcan is renamed Vesta.
-- ("Vulcan" is reserved for the future KPKF manufacturing app.)
ALTER TABLE "MercuryItem" RENAME COLUMN "vulcanSku" TO "vestaSku";
UPDATE "Agent" SET "apps" = array_replace("apps", 'vulcan', 'vesta') WHERE 'vulcan' = ANY("apps");
