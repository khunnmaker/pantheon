-- Original filename for received "file" messages (shown + used for download).
ALTER TABLE "Message" ADD COLUMN "attachmentName" TEXT;
