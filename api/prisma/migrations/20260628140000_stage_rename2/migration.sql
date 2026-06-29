-- Rename pipeline stages on existing customers: จัดส่ง -> ส่ง, หลังการขาย -> ดูแล.
-- (ปิด is a new closed/won stage with no prior rows; ถาม/สั่งซื้อ/ยกเลิก unchanged.)
UPDATE "Customer" SET "stage" = 'ส่ง' WHERE "stage" = 'จัดส่ง';
UPDATE "Customer" SET "stage" = 'ดูแล' WHERE "stage" = 'หลังการขาย';
UPDATE "Customer" SET "suggestedStage" = 'ส่ง' WHERE "suggestedStage" = 'จัดส่ง';
UPDATE "Customer" SET "suggestedStage" = 'ดูแล' WHERE "suggestedStage" = 'หลังการขาย';
