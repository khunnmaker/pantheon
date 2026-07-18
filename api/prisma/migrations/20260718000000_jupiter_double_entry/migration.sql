-- Jupiter Phase 2 Slice 1a: additive double-entry ledger foundation.

ALTER TABLE "JupiterCompany"
  ADD COLUMN "baseCurrency" TEXT NOT NULL DEFAULT 'THB',
  ADD COLUMN "ledgerMode" TEXT NOT NULL DEFAULT 'cockpit',
  ADD COLUMN "ledgerCutoverDate" DATE,
  ADD COLUMN "ledgerLockDate" DATE,
  ADD CONSTRAINT "JupiterCompany_ledgerMode_check"
    CHECK ("ledgerMode" IN ('cockpit', 'shadow', 'book_of_record', 'paper_only'));

CREATE TABLE "JupiterLedgerAccount" (
  "id" TEXT NOT NULL,
  "companyCode" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "accountType" TEXT NOT NULL,
  "accountClass" TEXT NOT NULL,
  "normalBalance" TEXT NOT NULL,
  "reconcile" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "currencyCode" TEXT,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "sourceRef" TEXT,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JupiterLedgerAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JupiterLedgerJournal" (
  "id" TEXT NOT NULL,
  "companyCode" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "journalType" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "defaultAccountId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "sourceRef" TEXT,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JupiterLedgerJournal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JupiterLedgerTax" (
  "id" TEXT NOT NULL,
  "companyCode" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "taxKind" TEXT NOT NULL DEFAULT 'unclassified',
  "usage" TEXT NOT NULL DEFAULT 'none',
  "amountType" TEXT NOT NULL DEFAULT 'percent',
  "rate" DECIMAL(9,6) NOT NULL,
  "priceIncluded" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "sourceRef" TEXT,
  "contentHash" TEXT,
  CONSTRAINT "JupiterLedgerTax_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JupiterLedgerPartner" (
  "id" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "legalName" TEXT NOT NULL DEFAULT '',
  "taxId" TEXT NOT NULL DEFAULT '',
  "partnerType" TEXT NOT NULL DEFAULT 'other',
  "address" TEXT NOT NULL DEFAULT '',
  "partyId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "sourceRef" TEXT,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JupiterLedgerPartner_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JupiterJournalEntry" (
  "id" TEXT NOT NULL,
  "companyCode" TEXT NOT NULL,
  "journalId" TEXT NOT NULL,
  "entryNo" TEXT,
  "entryDate" DATE NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'draft',
  "entryType" TEXT NOT NULL DEFAULT 'general',
  "ref" TEXT NOT NULL DEFAULT '',
  "memo" TEXT NOT NULL DEFAULT '',
  "partnerId" TEXT,
  "documentNo" TEXT NOT NULL DEFAULT '',
  "documentDate" DATE,
  "dueDate" DATE,
  "paymentReference" TEXT NOT NULL DEFAULT '',
  "paymentState" TEXT NOT NULL DEFAULT '',
  "taxInvoiceNo" TEXT NOT NULL DEFAULT '',
  "taxInvoiceDate" DATE,
  "whtCertificateNo" TEXT NOT NULL DEFAULT '',
  "currencyCode" TEXT NOT NULL DEFAULT 'THB',
  "version" INTEGER NOT NULL DEFAULT 1,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "sourceRef" TEXT,
  "sourceSnapshotRef" TEXT,
  "contentHash" TEXT,
  "originTxnId" TEXT,
  "reversalOfId" TEXT,
  "createdById" TEXT,
  "createdByName" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "postedById" TEXT,
  "postedByName" TEXT NOT NULL DEFAULT '',
  "postedAt" TIMESTAMP(3),
  "voidedAt" TIMESTAMP(3),
  CONSTRAINT "JupiterJournalEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JupiterJournalEntry_state_check" CHECK ("state" IN ('draft', 'posted', 'void'))
);

CREATE TABLE "JupiterJournalLine" (
  "id" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "lineNo" INTEGER NOT NULL,
  "accountId" TEXT NOT NULL,
  "partnerId" TEXT,
  "label" TEXT NOT NULL DEFAULT '',
  "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "amountCurrency" DECIMAL(18,2),
  "currencyCode" TEXT,
  "maturityDate" DATE,
  "reconciled" BOOLEAN NOT NULL DEFAULT false,
  "externalReconcileRef" TEXT,
  "sourceRef" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JupiterJournalLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JupiterJournalLine_nonnegative_check" CHECK ("debit" >= 0 AND "credit" >= 0),
  CONSTRAINT "JupiterJournalLine_one_side_check" CHECK (NOT ("debit" > 0 AND "credit" > 0))
);

CREATE TABLE "JupiterJournalLineTax" (
  "id" TEXT NOT NULL,
  "lineId" TEXT NOT NULL,
  "taxId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "baseAmount" DECIMAL(18,2),
  "taxAmount" DECIMAL(18,2),
  CONSTRAINT "JupiterJournalLineTax_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JupiterJournalSequence" (
  "id" TEXT NOT NULL,
  "companyCode" TEXT NOT NULL,
  "journalId" TEXT NOT NULL,
  "fiscalYear" INTEGER NOT NULL,
  "nextNo" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "JupiterJournalSequence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JupiterLedgerImportBatch" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "snapshotRef" TEXT NOT NULL,
  "manifestSha256" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "requestedCompanies" JSONB NOT NULL,
  "result" JSONB,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdByName" TEXT NOT NULL DEFAULT 'cli',
  CONSTRAINT "JupiterLedgerImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JupiterLedgerAudit" (
  "id" TEXT NOT NULL,
  "companyCode" TEXT,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL DEFAULT '',
  "before" JSONB,
  "after" JSONB,
  "actorId" TEXT,
  "actorName" TEXT NOT NULL DEFAULT '',
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JupiterLedgerAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JupiterLedgerAccount_companyCode_code_key" ON "JupiterLedgerAccount"("companyCode", "code");
CREATE UNIQUE INDEX "JupiterLedgerAccount_companyCode_source_sourceRef_key" ON "JupiterLedgerAccount"("companyCode", "source", "sourceRef");
CREATE INDEX "JupiterLedgerAccount_companyCode_accountClass_active_idx" ON "JupiterLedgerAccount"("companyCode", "accountClass", "active");
CREATE UNIQUE INDEX "JupiterLedgerJournal_companyCode_code_key" ON "JupiterLedgerJournal"("companyCode", "code");
CREATE UNIQUE INDEX "JupiterLedgerJournal_companyCode_source_sourceRef_key" ON "JupiterLedgerJournal"("companyCode", "source", "sourceRef");
CREATE UNIQUE INDEX "JupiterLedgerTax_companyCode_source_sourceRef_key" ON "JupiterLedgerTax"("companyCode", "source", "sourceRef");
CREATE INDEX "JupiterLedgerTax_companyCode_taxKind_active_idx" ON "JupiterLedgerTax"("companyCode", "taxKind", "active");
CREATE UNIQUE INDEX "JupiterLedgerPartner_source_sourceRef_key" ON "JupiterLedgerPartner"("source", "sourceRef");
CREATE INDEX "JupiterLedgerPartner_taxId_idx" ON "JupiterLedgerPartner"("taxId");
CREATE INDEX "JupiterLedgerPartner_partyId_idx" ON "JupiterLedgerPartner"("partyId");
CREATE UNIQUE INDEX "JupiterJournalEntry_originTxnId_key" ON "JupiterJournalEntry"("originTxnId");
CREATE UNIQUE INDEX "JupiterJournalEntry_reversalOfId_key" ON "JupiterJournalEntry"("reversalOfId");
CREATE UNIQUE INDEX "JupiterJournalEntry_companyCode_entryNo_key" ON "JupiterJournalEntry"("companyCode", "entryNo");
CREATE UNIQUE INDEX "JupiterJournalEntry_companyCode_source_sourceRef_key" ON "JupiterJournalEntry"("companyCode", "source", "sourceRef");
CREATE INDEX "JupiterJournalEntry_companyCode_entryDate_state_idx" ON "JupiterJournalEntry"("companyCode", "entryDate", "state");
CREATE INDEX "JupiterJournalEntry_journalId_entryDate_idx" ON "JupiterJournalEntry"("journalId", "entryDate");
CREATE INDEX "JupiterJournalEntry_partnerId_entryDate_idx" ON "JupiterJournalEntry"("partnerId", "entryDate");
CREATE UNIQUE INDEX "JupiterJournalLine_entryId_lineNo_key" ON "JupiterJournalLine"("entryId", "lineNo");
CREATE UNIQUE INDEX "JupiterJournalLine_entryId_sourceRef_key" ON "JupiterJournalLine"("entryId", "sourceRef");
CREATE INDEX "JupiterJournalLine_accountId_entryId_idx" ON "JupiterJournalLine"("accountId", "entryId");
CREATE INDEX "JupiterJournalLine_partnerId_entryId_idx" ON "JupiterJournalLine"("partnerId", "entryId");
CREATE UNIQUE INDEX "JupiterJournalLineTax_lineId_taxId_role_key" ON "JupiterJournalLineTax"("lineId", "taxId", "role");
CREATE UNIQUE INDEX "JupiterJournalSequence_companyCode_journalId_fiscalYear_key" ON "JupiterJournalSequence"("companyCode", "journalId", "fiscalYear");
CREATE UNIQUE INDEX "JupiterLedgerImportBatch_source_manifestSha256_key" ON "JupiterLedgerImportBatch"("source", "manifestSha256");
CREATE INDEX "JupiterLedgerAudit_entityType_entityId_createdAt_idx" ON "JupiterLedgerAudit"("entityType", "entityId", "createdAt");
CREATE INDEX "JupiterLedgerAudit_companyCode_createdAt_idx" ON "JupiterLedgerAudit"("companyCode", "createdAt");

ALTER TABLE "JupiterLedgerAccount" ADD CONSTRAINT "JupiterLedgerAccount_companyCode_fkey" FOREIGN KEY ("companyCode") REFERENCES "JupiterCompany"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JupiterLedgerJournal" ADD CONSTRAINT "JupiterLedgerJournal_companyCode_fkey" FOREIGN KEY ("companyCode") REFERENCES "JupiterCompany"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JupiterLedgerJournal" ADD CONSTRAINT "JupiterLedgerJournal_defaultAccountId_fkey" FOREIGN KEY ("defaultAccountId") REFERENCES "JupiterLedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JupiterLedgerTax" ADD CONSTRAINT "JupiterLedgerTax_companyCode_fkey" FOREIGN KEY ("companyCode") REFERENCES "JupiterCompany"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JupiterLedgerPartner" ADD CONSTRAINT "JupiterLedgerPartner_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JupiterJournalEntry" ADD CONSTRAINT "JupiterJournalEntry_companyCode_fkey" FOREIGN KEY ("companyCode") REFERENCES "JupiterCompany"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JupiterJournalEntry" ADD CONSTRAINT "JupiterJournalEntry_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "JupiterLedgerJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JupiterJournalEntry" ADD CONSTRAINT "JupiterJournalEntry_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "JupiterLedgerPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JupiterJournalEntry" ADD CONSTRAINT "JupiterJournalEntry_originTxnId_fkey" FOREIGN KEY ("originTxnId") REFERENCES "JupiterTxn"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JupiterJournalEntry" ADD CONSTRAINT "JupiterJournalEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "JupiterJournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JupiterJournalLine" ADD CONSTRAINT "JupiterJournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JupiterJournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JupiterJournalLine" ADD CONSTRAINT "JupiterJournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "JupiterLedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JupiterJournalLine" ADD CONSTRAINT "JupiterJournalLine_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "JupiterLedgerPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JupiterJournalLineTax" ADD CONSTRAINT "JupiterJournalLineTax_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "JupiterJournalLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JupiterJournalLineTax" ADD CONSTRAINT "JupiterJournalLineTax_taxId_fkey" FOREIGN KEY ("taxId") REFERENCES "JupiterLedgerTax"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JupiterJournalSequence" ADD CONSTRAINT "JupiterJournalSequence_companyCode_fkey" FOREIGN KEY ("companyCode") REFERENCES "JupiterCompany"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JupiterJournalSequence" ADD CONSTRAINT "JupiterJournalSequence_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "JupiterLedgerJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION jupiter_reject_posted_entry_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD."state" = 'posted' THEN
    RAISE EXCEPTION 'posted Jupiter journal entries are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JupiterJournalEntry_posted_immutable"
BEFORE UPDATE OR DELETE ON "JupiterJournalEntry"
FOR EACH ROW EXECUTE FUNCTION jupiter_reject_posted_entry_mutation();

CREATE FUNCTION jupiter_reject_posted_line_mutation() RETURNS trigger AS $$
DECLARE
  old_entry_id TEXT;
  new_entry_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_entry_id := OLD."entryId"; END IF;
  IF TG_OP <> 'DELETE' THEN new_entry_id := NEW."entryId"; END IF;

  IF (old_entry_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM "JupiterJournalEntry" WHERE "id" = old_entry_id AND "state" = 'posted'
      )) OR (new_entry_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM "JupiterJournalEntry" WHERE "id" = new_entry_id AND "state" = 'posted'
      )) THEN
    RAISE EXCEPTION 'lines of posted Jupiter journal entries are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JupiterJournalLine_posted_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "JupiterJournalLine"
FOR EACH ROW EXECUTE FUNCTION jupiter_reject_posted_line_mutation();

CREATE FUNCTION jupiter_reject_posted_line_tax_mutation() RETURNS trigger AS $$
DECLARE
  old_line_id TEXT;
  new_line_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_line_id := OLD."lineId"; END IF;
  IF TG_OP <> 'DELETE' THEN new_line_id := NEW."lineId"; END IF;

  IF EXISTS (
    SELECT 1
    FROM "JupiterJournalLine" line
    JOIN "JupiterJournalEntry" entry ON entry."id" = line."entryId"
    WHERE line."id" IN (old_line_id, new_line_id) AND entry."state" = 'posted'
  ) THEN
    RAISE EXCEPTION 'taxes of posted Jupiter journal lines are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JupiterJournalLineTax_posted_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "JupiterJournalLineTax"
FOR EACH ROW EXECUTE FUNCTION jupiter_reject_posted_line_tax_mutation();
