-- AlterTable: stock snapshot fields on Product
ALTER TABLE "Product" ADD COLUMN "stock" INTEGER;
ALTER TABLE "Product" ADD COLUMN "stockAt" TIMESTAMP(3);
