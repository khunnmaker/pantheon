-- Unified auth: per-employee app grants. ADDITIVE ONLY — safe on the shared live DB.
ALTER TABLE "Agent" ADD COLUMN "apps" TEXT[] NOT NULL DEFAULT '{}';
