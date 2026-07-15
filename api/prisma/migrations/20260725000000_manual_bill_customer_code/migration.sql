-- ADD-only: บิลมือ gains an optional Express customer code (some off-system sales are to known customers).
ALTER TABLE "ManualBill" ADD COLUMN "customerCode" TEXT NOT NULL DEFAULT '';
