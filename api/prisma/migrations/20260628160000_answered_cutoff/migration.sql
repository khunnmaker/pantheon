-- "ตอบแล้ว" cutoff: messages at/before this are treated as handled (answered elsewhere,
-- e.g. on LINE OA directly); the AI drafts only from messages created after it.
ALTER TABLE "Customer" ADD COLUMN "answeredThroughAt" TIMESTAMP(3);
