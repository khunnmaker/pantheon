-- Rename the closed/won stage ปิด -> เสร็จ (new stage; usually no rows yet).
UPDATE "Customer" SET "stage" = 'เสร็จ' WHERE "stage" = 'ปิด';
UPDATE "Customer" SET "suggestedStage" = 'เสร็จ' WHERE "suggestedStage" = 'ปิด';
