-- M2: idempotent reply ? a customer message can be answered exactly once.
ALTER TABLE "Message" ADD COLUMN "answersMessageId" TEXT;
CREATE UNIQUE INDEX "Message_answersMessageId_key" ON "Message"("answersMessageId");
