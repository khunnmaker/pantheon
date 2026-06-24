-- Image/sticker/other non-text message support.
ALTER TABLE "Message" ADD COLUMN "attachmentType" TEXT;
ALTER TABLE "Message" ADD COLUMN "attachmentRef" TEXT;
