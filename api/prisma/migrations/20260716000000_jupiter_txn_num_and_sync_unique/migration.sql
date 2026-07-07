-- Jupiter Phase-1b groundwork. ADD-ONLY — new nullable columns + one partial index.

-- (1) Exact-decimal SHADOW of JupiterTxn's String money fields — the P2 double-entry
--     precondition (a ledger must balance to the satang; lossy parseFloat sums cannot).
--     Nullable + populated going forward; the String fields remain the live read path.
ALTER TABLE "JupiterTxn" ADD COLUMN "amountNum" DECIMAL(14,2);
ALTER TABLE "JupiterTxn" ADD COLUMN "vatNum" DECIMAL(14,2);
ALTER TABLE "JupiterTxn" ADD COLUMN "whtNum" DECIMAL(14,2);

-- (2) Idempotency for the deity sync feed (sync:juno / sync:ceres / …): a synced row is
--     unique per (source, sourceRef). PARTIAL (WHERE source LIKE 'sync:%') so it never
--     collides on the many manual rows, which all share source='manual', sourceRef=''.
--     The sync writer upserts on this key; the index is the DB-level backstop against a race.
CREATE UNIQUE INDEX "JupiterTxn_sync_source_ref_key" ON "JupiterTxn"("source", "sourceRef") WHERE "source" LIKE 'sync:%';
