ALTER TABLE "Payment" ADD COLUMN "creditUsed" TEXT NOT NULL DEFAULT '';

CREATE TABLE "CustomerCreditEntry" (
    "id" TEXT NOT NULL,
    "customerKey" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL DEFAULT '',
    "customerName" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL,
    "amountSatang" INTEGER NOT NULL,
    "paymentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "CustomerCreditEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CustomerCreditEntry_kind_check" CHECK ("kind" IN ('grant', 'spend')),
    CONSTRAINT "CustomerCreditEntry_amount_nonzero_check" CHECK ("amountSatang" <> 0),
    CONSTRAINT "CustomerCreditEntry_sign_check" CHECK (
      ("kind" = 'grant' AND "amountSatang" > 0) OR
      ("kind" = 'spend' AND "amountSatang" < 0)
    )
);

CREATE UNIQUE INDEX "CustomerCreditEntry_paymentId_kind_key" ON "CustomerCreditEntry"("paymentId", "kind");
CREATE INDEX "CustomerCreditEntry_customerKey_createdAt_idx" ON "CustomerCreditEntry"("customerKey", "createdAt");
CREATE INDEX "CustomerCreditEntry_paymentId_idx" ON "CustomerCreditEntry"("paymentId");

ALTER TABLE "CustomerCreditEntry" ADD CONSTRAINT "CustomerCreditEntry_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
