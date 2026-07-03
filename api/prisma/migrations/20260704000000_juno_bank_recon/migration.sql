-- Juno phase B: bank import + reconciliation. ADDITIVE ONLY — safe on the shared live DB.

-- Payment: denormalized reconciled flag (true while >=1 PaymentBankMatch link exists)
ALTER TABLE "Payment" ADD COLUMN "reconciled" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Payment_reconciled_idx" ON "Payment"("reconciled");

-- BankImport: audit row per bank-file import (preview -> apply)
CREATE TABLE "BankImport" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fileName" TEXT NOT NULL DEFAULT '',
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedBy" TEXT,
    "rowsParsed" INTEGER NOT NULL DEFAULT 0,
    "txnsNew" INTEGER NOT NULL DEFAULT 0,
    "txnsDup" INTEGER NOT NULL DEFAULT 0,
    "txnsExcluded" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "BankImport_pkey" PRIMARY KEY ("id")
);

-- BankTxn: one parsed bank line (KBIZ statement row or K SHOP transaction row)
CREATE TABLE "BankTxn" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "txnAt" TIMESTAMP(3) NOT NULL,
    "amount" TEXT NOT NULL DEFAULT '',
    "direction" TEXT NOT NULL DEFAULT 'in',
    "channel" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "details" TEXT NOT NULL DEFAULT '',
    "payerName" TEXT NOT NULL DEFAULT '',
    "payerBank" TEXT NOT NULL DEFAULT '',
    "dedupeKey" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "matchStatus" TEXT NOT NULL DEFAULT 'unmatched',
    "refText" TEXT NOT NULL DEFAULT '',
    "expressConfirmedAt" TIMESTAMP(3),
    "expressConfirmedById" TEXT,

    CONSTRAINT "BankTxn_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BankTxn_dedupeKey_key" ON "BankTxn"("dedupeKey");
CREATE INDEX "BankTxn_txnAt_idx" ON "BankTxn"("txnAt");
CREATE INDEX "BankTxn_matchStatus_idx" ON "BankTxn"("matchStatus");
CREATE INDEX "BankTxn_direction_idx" ON "BankTxn"("direction");

-- PaymentBankMatch: many-to-many link between Payment and BankTxn
CREATE TABLE "PaymentBankMatch" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "bankTxnId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "PaymentBankMatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentBankMatch_paymentId_bankTxnId_key" ON "PaymentBankMatch"("paymentId", "bankTxnId");
CREATE INDEX "PaymentBankMatch_paymentId_idx" ON "PaymentBankMatch"("paymentId");
CREATE INDEX "PaymentBankMatch_bankTxnId_idx" ON "PaymentBankMatch"("bankTxnId");

-- FK relations (both sides are Juno-owned models; ON DELETE CASCADE so removing a
-- Payment/BankTxn — never done by the app today, but safe to assume for the future —
-- cleans up its match links rather than orphaning them).
ALTER TABLE "PaymentBankMatch" ADD CONSTRAINT "PaymentBankMatch_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentBankMatch" ADD CONSTRAINT "PaymentBankMatch_bankTxnId_fkey"
    FOREIGN KEY ("bankTxnId") REFERENCES "BankTxn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
