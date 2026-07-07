-- Additive: human-readable Diana order number (shown as WD-00001). SERIAL backfills existing rows.
-- AlterTable
ALTER TABLE "WebOrder" ADD COLUMN     "orderNo" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "WebOrder_orderNo_key" ON "WebOrder"("orderNo");
