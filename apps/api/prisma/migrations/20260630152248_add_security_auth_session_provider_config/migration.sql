-- AlterTable
ALTER TABLE "SecurityAuthSession" ADD COLUMN "providerConfig" JSONB;
ALTER TABLE "SecurityAuthSession" ADD COLUMN "providerPasswordSecretKey" TEXT;
ALTER TABLE "SecurityAuthSession" ADD COLUMN "providerClientSecretKey" TEXT;
