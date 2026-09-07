-- AlterTable
ALTER TABLE "SecurityAuthSession" ADD COLUMN     "allowDeleteActiveProbes" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "allowMutatingActiveProbes" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sensitiveDataStopped" BOOLEAN NOT NULL DEFAULT false;

