-- AlterTable: TestCase's canonical-latest-execution-snapshot fields (Journey 1 & 2) existed in
-- schema.prisma with no migration ever adding them.
ALTER TABLE "TestCase" ADD COLUMN     "curatedSuiteId" TEXT,
ADD COLUMN     "lastFailureMessage" TEXT,
ADD COLUMN     "lastHealedAt" TIMESTAMP(3),
ADD COLUMN     "lastHealingAttemptId" TEXT,
ADD COLUMN     "lastResultStatus" "TestResultStatus",
ADD COLUMN     "lastRunAt" TIMESTAMP(3),
ADD COLUMN     "lastRunId" TEXT,
ADD COLUMN     "lastSource" TEXT;

-- AlterTable: TestHealingAttempt's structured repair-result fields, same gap.
ALTER TABLE "TestHealingAttempt" ADD COLUMN     "confidenceScore" INTEGER,
ADD COLUMN     "executionAfter" JSONB,
ADD COLUMN     "executionBefore" JSONB,
ADD COLUMN     "modelUsed" TEXT,
ADD COLUMN     "originalSpec" TEXT,
ADD COLUMN     "repairReason" TEXT,
ADD COLUMN     "repairedSpec" TEXT,
ADD COLUMN     "targetSpec" TEXT;

-- CreateIndex
CREATE INDEX "TestCase_projectId_curatedSuiteId_idx" ON "TestCase"("projectId", "curatedSuiteId");

-- CreateIndex
CREATE INDEX "TestCase_projectId_lastResultStatus_idx" ON "TestCase"("projectId", "lastResultStatus");

-- AddForeignKey
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_curatedSuiteId_fkey" FOREIGN KEY ("curatedSuiteId") REFERENCES "CuratedSuite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
