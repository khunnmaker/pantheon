-- Stage list change: rename สอบถาม → ถาม, and remove รอชำระเงิน (fold into สั่งซื้อ).
UPDATE "Customer" SET "stage" = 'ถาม' WHERE "stage" = 'สอบถาม';
UPDATE "Customer" SET "stage" = 'สั่งซื้อ' WHERE "stage" = 'รอชำระเงิน';
UPDATE "Customer" SET "suggestedStage" = 'ถาม' WHERE "suggestedStage" = 'สอบถาม';
UPDATE "Customer" SET "suggestedStage" = 'สั่งซื้อ' WHERE "suggestedStage" = 'รอชำระเงิน';
