-- CreateEnum
CREATE TYPE "TestCaseType" AS ENUM ('functional', 'regression', 'security', 'accessibility', 'other');

-- AlterTable
ALTER TABLE "TestCase" ADD COLUMN     "lastAiSyncAt" TIMESTAMP(3),
ADD COLUMN     "preconditions" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "type" "TestCaseType" NOT NULL DEFAULT 'functional';

-- CreateTable
CREATE TABLE "TestStep" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "expected" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestCaseRun" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "status" "TestResultStatus" NOT NULL,
    "note" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestCaseRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestStep_caseId_idx_idx" ON "TestStep"("caseId", "idx");

-- CreateIndex
CREATE INDEX "TestCaseRun_caseId_createdAt_idx" ON "TestCaseRun"("caseId", "createdAt");

-- AddForeignKey
ALTER TABLE "TestStep" ADD CONSTRAINT "TestStep_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "TestCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCaseRun" ADD CONSTRAINT "TestCaseRun_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "TestCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
