-- CreateEnum
CREATE TYPE "HealingStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "TestHealingAttempt" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "testResultId" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "HealingStatus" NOT NULL DEFAULT 'queued',
    "summary" TEXT,
    "diff" TEXT,
    "error" TEXT,
    "prompt" JSONB,
    "response" JSONB,
    "artifactsPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestHealingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestHealingAttempt_runId_testCaseId_idx" ON "TestHealingAttempt"("runId", "testCaseId");

-- CreateIndex
CREATE INDEX "TestHealingAttempt_testResultId_idx" ON "TestHealingAttempt"("testResultId");

-- CreateIndex
CREATE UNIQUE INDEX "TestHealingAttempt_testResultId_attempt_key" ON "TestHealingAttempt"("testResultId", "attempt");

-- AddForeignKey
ALTER TABLE "TestHealingAttempt" ADD CONSTRAINT "TestHealingAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TestRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestHealingAttempt" ADD CONSTRAINT "TestHealingAttempt_testResultId_fkey" FOREIGN KEY ("testResultId") REFERENCES "TestResult"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestHealingAttempt" ADD CONSTRAINT "TestHealingAttempt_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
