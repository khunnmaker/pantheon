-- Additive. Shows staff a Thai translation of an AI draft that itself came out in a
-- non-Thai language (e.g. the customer wrote Chinese and the AI drafted its reply in
-- Chinese too) — read-only staff aid, never sent to the customer, never overwrites draftText.

ALTER TABLE "Draft" ADD COLUMN "translatedText" TEXT;
