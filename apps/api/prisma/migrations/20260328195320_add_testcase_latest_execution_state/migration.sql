-- AlterTable
ALTER TABLE "TestCase" ADD COLUMN     "lastFailureMessage" TEXT,
ADD COLUMN     "lastHealedAt" TIMESTAMP(3),
ADD COLUMN     "lastHealingAttemptId" TEXT,
ADD COLUMN     "lastResultStatus" "TestResultStatus",
ADD COLUMN     "lastRunAt" TIMESTAMP(3),
ADD COLUMN     "lastRunId" TEXT,
ADD COLUMN     "lastSource" TEXT;

-- CreateIndex
CREATE INDEX "TestCase_projectId_lastResultStatus_idx" ON "TestCase"("projectId", "lastResultStatus");
