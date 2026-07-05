-- Name-normalization review staging (Vulcan ตรวจทาน tab). ADDITIVE ONLY.
-- A staged proposed English name awaits supervisor approval; the live Product.nameEn is
-- left untouched until a proposal is APPROVED in-app (approve copies proposedNameEn → nameEn).
-- Seeded from api/src/catalog/nameProposals.ts. See docs/VULCAN_BRIEF.md.

ALTER TABLE "Product" ADD COLUMN "proposedNameEn" TEXT;
ALTER TABLE "Product" ADD COLUMN "proposalStatus" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "Product" ADD COLUMN "proposalNeedsReview" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Product_proposalStatus_idx" ON "Product"("proposalStatus");
