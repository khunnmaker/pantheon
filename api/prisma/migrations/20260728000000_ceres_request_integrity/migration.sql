-- Phase 3 integrity hardening. Run `npm --prefix api run ceres:integrity-check`
-- against the deployment database before applying this migration.
-- CHECK constraints are NOT VALID so legacy rows cannot block the rollout; PostgreSQL
-- still enforces them for every new/updated row. A later audited migration may VALIDATE.

ALTER TABLE "CashMovement"
  ADD CONSTRAINT "CashMovement_direction_check"
  CHECK ("direction" IS NULL OR "direction" IN ('in', 'out')) NOT VALID;

ALTER TABLE "CeresExpense"
  ADD CONSTRAINT "CeresExpense_fundingLane_check"
  CHECK ("fundingLane" IN ('cash', 'transfer', 'self_funded')) NOT VALID;

ALTER TABLE "CeresPaymentRequest"
  ADD CONSTRAINT "CeresPaymentRequest_v2_union_check"
  CHECK (
    "workflowVersion" <> 2 OR (
      "requestType" IN ('advance', 'reimbursement', 'purchase') AND
      "approvalStatus" IN ('pending_nee', 'pending_ceo', 'approved', 'rejected', 'cancelled', 'void') AND
      "fulfillmentStatus" IN ('unfulfilled', 'paid', 'bought', 'settling', 'settled', 'reversed') AND
      "aiScreenStatus" IN ('pending', 'clear', 'escalate')
    )
  ) NOT VALID;

ALTER TABLE "CeresRequestMoneyEvent"
  ADD CONSTRAINT "CeresRequestMoneyEvent_union_check"
  CHECK (
    "kind" IN ('payment', 'purchase', 'refund', 'reversal') AND
    "lane" IN ('cash', 'transfer') AND
    ("lane" <> 'cash' OR "cashMovementId" IS NOT NULL) AND
    ("lane" <> 'transfer' OR "kind" = 'reversal' OR "transferSlipUploadId" IS NOT NULL) AND
    ("kind" <> 'purchase' OR "purchaseReceiptUploadId" IS NOT NULL) AND
    ("kind" <> 'reversal' OR "reversesEventId" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "CeresStatementLine"
  ADD CONSTRAINT "CeresStatementLine_matchedType_check"
  CHECK ("matchedType" IN ('', 'paymentRequest', 'cashMovement', 'requestMoneyEvent')) NOT VALID;

-- Plain transactional indexes: Prisma migration deploy wraps this file in a transaction.
CREATE UNIQUE INDEX "CashMovement_requestMoneyEventId_unique"
  ON "CashMovement"("requestMoneyEventId")
  WHERE "requestMoneyEventId" IS NOT NULL;

CREATE UNIQUE INDEX "CashMovement_reversesMovementId_unique"
  ON "CashMovement"("reversesMovementId")
  WHERE "reversesMovementId" IS NOT NULL;

CREATE UNIQUE INDEX "CeresStatementLine_requestMoneyEvent_unique"
  ON "CeresStatementLine"("matchedId")
  WHERE "matchedType" = 'requestMoneyEvent' AND "matchedId" <> '';
