-- AlterTable
ALTER TABLE "TestCase" ADD COLUMN     "interactiveUiFindingId" TEXT;

-- CreateTable
CREATE TABLE "InteractiveUiSession" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testRunId" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "securityAuthSessionId" TEXT,
    "baseUrl" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "maxTurns" INTEGER NOT NULL DEFAULT 40,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InteractiveUiSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InteractiveUiTurn" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "pageUrlBefore" TEXT NOT NULL,
    "pageUrlAfter" TEXT,
    "domSnapshotPath" TEXT,
    "screenshotBeforePath" TEXT,
    "screenshotAfterPath" TEXT,
    "stateBeforeJson" JSONB,
    "stateAfterJson" JSONB,
    "llmModel" TEXT,
    "llmActionJson" JSONB,
    "executionJson" JSONB,
    "llmJudgmentJson" JSONB,
    "actionType" TEXT,
    "actionTarget" TEXT,
    "actionValue" TEXT,
    "executedOk" BOOLEAN,
    "consoleErrorsJson" JSONB,
    "networkErrorsJson" JSONB,
    "verdict" TEXT,
    "confidenceScore" INTEGER,
    "findingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InteractiveUiTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InteractiveUiFinding" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "expectedBehavior" TEXT NOT NULL,
    "actualBehavior" TEXT NOT NULL,
    "severity" "SecuritySeverity" NOT NULL DEFAULT 'low',
    "confidenceScore" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'needs_review',
    "evidenceJson" JSONB,
    "regressionTestCaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InteractiveUiFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InteractiveUiSession_testRunId_key" ON "InteractiveUiSession"("testRunId");

-- CreateIndex
CREATE INDEX "InteractiveUiSession_projectId_createdAt_idx" ON "InteractiveUiSession"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InteractiveUiTurn_seq_key" ON "InteractiveUiTurn"("seq");

-- CreateIndex
CREATE INDEX "InteractiveUiTurn_sessionId_seq_idx" ON "InteractiveUiTurn"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "InteractiveUiFinding_sessionId_status_idx" ON "InteractiveUiFinding"("sessionId", "status");

-- AddForeignKey
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_interactiveUiFindingId_fkey" FOREIGN KEY ("interactiveUiFindingId") REFERENCES "InteractiveUiFinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InteractiveUiSession" ADD CONSTRAINT "InteractiveUiSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InteractiveUiSession" ADD CONSTRAINT "InteractiveUiSession_testRunId_fkey" FOREIGN KEY ("testRunId") REFERENCES "TestRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InteractiveUiSession" ADD CONSTRAINT "InteractiveUiSession_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InteractiveUiTurn" ADD CONSTRAINT "InteractiveUiTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InteractiveUiSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InteractiveUiFinding" ADD CONSTRAINT "InteractiveUiFinding_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InteractiveUiSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

