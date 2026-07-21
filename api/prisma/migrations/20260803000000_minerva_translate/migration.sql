-- Bilingual customer support. ADD-only.
-- Inbound: auto-translate non-Thai customer text messages to Thai for staff to read.
-- Outbound: remember the customer's detected language so staff can translate a reply to it.

ALTER TABLE "Message" ADD COLUMN "translatedText" TEXT;
ALTER TABLE "Message" ADD COLUMN "sourceLang" TEXT;
ALTER TABLE "Customer" ADD COLUMN "replyLang" TEXT;
