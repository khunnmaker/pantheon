ALTER TABLE "CeresCategory" ADD COLUMN "group" TEXT NOT NULL DEFAULT '';

UPDATE "CeresCategory" SET "group" = 'งานขนส่ง (เมสเซนเจอร์)', "sortOrder" = 10 WHERE "name" = 'ค่าขนส่ง SD';
UPDATE "CeresCategory" SET "group" = 'งานขนส่ง (เมสเซนเจอร์)', "sortOrder" = 20 WHERE "name" = 'ค่าขนส่ง J&T';
UPDATE "CeresCategory" SET "group" = 'งานขนส่ง (เมสเซนเจอร์)', "sortOrder" = 30 WHERE "name" = 'ค่าขนส่ง LALAMOVE Prom';
UPDATE "CeresCategory" SET "group" = 'งานขนส่ง (เมสเซนเจอร์)', "sortOrder" = 40 WHERE "name" = 'ค่าขนส่ง LALAMOVE Dentalport';
UPDATE "CeresCategory" SET "group" = 'งานขนส่ง (เมสเซนเจอร์)', "sortOrder" = 50 WHERE "name" = 'ค่าขนส่งทั่วไป';
UPDATE "CeresCategory" SET "group" = 'งานขนส่ง (เมสเซนเจอร์)', "sortOrder" = 60 WHERE "name" = 'ค่าไปรษณีย์';
UPDATE "CeresCategory" SET "group" = 'ยานพาหนะ/เดินทาง', "sortOrder" = 110 WHERE "name" = 'ค่าน้ำมัน';
UPDATE "CeresCategory" SET "group" = 'ยานพาหนะ/เดินทาง', "sortOrder" = 120 WHERE "name" = 'ค่าทางด่วน';
UPDATE "CeresCategory" SET "group" = 'ยานพาหนะ/เดินทาง', "sortOrder" = 130 WHERE "name" = 'ค่าซ่อมบำรุงรถ';
UPDATE "CeresCategory" SET "group" = 'สำนักงาน/ธุรการ', "sortOrder" = 210 WHERE "name" = 'ค่าเอกสาร/ธุรการ';
UPDATE "CeresCategory" SET "group" = 'อื่นๆ', "sortOrder" = 910 WHERE "name" = 'อื่นๆ';

INSERT INTO "CeresCategory" ("id", "name", "group", "kind", "ceiling", "needsCustomerNote", "active", "sortOrder") VALUES
  ('cerescat_travel_public', 'ค่าเดินทาง (แท็กซี่/วิน/รถสาธารณะ)', 'ยานพาหนะ/เดินทาง', 'general', '', false, true, 140),
  ('cerescat_parking', 'ค่าที่จอดรถ', 'ยานพาหนะ/เดินทาง', 'general', '', false, true, 150),
  ('cerescat_office_supplies', 'อุปกรณ์/เครื่องเขียนสำนักงาน', 'สำนักงาน/ธุรการ', 'general', '', false, true, 220),
  ('cerescat_copy_print', 'ค่าถ่ายเอกสาร/พิมพ์งาน', 'สำนักงาน/ธุรการ', 'general', '', false, true, 230),
  ('cerescat_consumables', 'ของใช้สิ้นเปลือง', 'ของใช้/วัสดุ', 'general', '', false, true, 310),
  ('cerescat_tools', 'อุปกรณ์/เครื่องมือ', 'ของใช้/วัสดุ', 'general', '', false, true, 320),
  ('cerescat_food_drink', 'ค่าอาหารและเครื่องดื่ม', 'อาหาร/รับรอง', 'general', '', false, true, 410),
  ('cerescat_client_entertainment', 'ค่ารับรองลูกค้า', 'อาหาร/รับรอง', 'general', '', false, true, 420),
  ('cerescat_facility_repair', 'ค่าซ่อมแซม/บำรุงสถานที่', 'สถานที่/ซ่อมแซม', 'general', '', false, true, 510)
ON CONFLICT ("name") DO NOTHING;
