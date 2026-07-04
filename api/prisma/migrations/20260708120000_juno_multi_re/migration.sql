-- A Payment can carry MULTIPLE RE (receipt) numbers: one transfer may pay several
-- receipts, and one RE can be split across several payments. ADD-only + backfill.
-- The old single "reNumber" column stays as a DEPRECATED join mirror (reNumbers.join('/'))
-- for back-compat search (buildListWhere's `contains` filter) and the CSV export column.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "reNumbers" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: every existing single reNumber becomes a one-element list.
UPDATE "Payment" SET "reNumbers" = ARRAY["reNumber"] WHERE "reNumber" <> '';
