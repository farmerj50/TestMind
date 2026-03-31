/*
  Warnings:

  - You are about to drop the column `reportPatg` on the `TestRun` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "TestRun" DROP COLUMN "reportPatg",
ADD COLUMN     "envName" TEXT,
ADD COLUMN     "framework" TEXT,
ADD COLUMN     "paramsJson" JSONB,
ADD COLUMN     "reportPath" TEXT,
ADD COLUMN     "trigger" TEXT;
