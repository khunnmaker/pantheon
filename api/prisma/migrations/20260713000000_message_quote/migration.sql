-- LINE quote-reply support. ADDITIVE ONLY (both columns nullable, no backfill).
-- quoteToken: LINE's token to quote THIS message later (inbound text/sticker only).
-- quotedMessageId: OUR internal Message.id this message is a reply to.

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "quoteToken" TEXT,
ADD COLUMN     "quotedMessageId" TEXT;
