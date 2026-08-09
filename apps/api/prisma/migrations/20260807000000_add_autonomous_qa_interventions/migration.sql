-- Additive review records for autonomous QA escalation.
CREATE TABLE "HumanInterventionCandidate" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "runId" TEXT,
  "testResultId" TEXT,
  "healingAttemptId" TEXT,
  "operatorJobId" TEXT,
  "operatorTaskId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'autonomous-qa',
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "contextJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "HumanInterventionCandidate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HumanInterventionCandidate_projectId_status_idx" ON "HumanInterventionCandidate"("projectId", "status");
CREATE INDEX "HumanInterventionCandidate_runId_idx" ON "HumanInterventionCandidate"("runId");
CREATE INDEX "HumanInterventionCandidate_testResultId_idx" ON "HumanInterventionCandidate"("testResultId");
CREATE INDEX "HumanInterventionCandidate_healingAttemptId_idx" ON "HumanInterventionCandidate"("healingAttemptId");
CREATE INDEX "HumanInterventionCandidate_operatorJobId_idx" ON "HumanInterventionCandidate"("operatorJobId");
CREATE INDEX "HumanInterventionCandidate_operatorTaskId_idx" ON "HumanInterventionCandidate"("operatorTaskId");

ALTER TABLE "HumanInterventionCandidate"
  ADD CONSTRAINT "HumanInterventionCandidate_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HumanInterventionCandidate"
  ADD CONSTRAINT "HumanInterventionCandidate_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "TestRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HumanInterventionCandidate"
  ADD CONSTRAINT "HumanInterventionCandidate_testResultId_fkey"
  FOREIGN KEY ("testResultId") REFERENCES "TestResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HumanInterventionCandidate"
  ADD CONSTRAINT "HumanInterventionCandidate_healingAttemptId_fkey"
  FOREIGN KEY ("healingAttemptId") REFERENCES "TestHealingAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HumanInterventionCandidate"
  ADD CONSTRAINT "HumanInterventionCandidate_operatorJobId_fkey"
  FOREIGN KEY ("operatorJobId") REFERENCES "OperatorJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HumanInterventionCandidate"
  ADD CONSTRAINT "HumanInterventionCandidate_operatorTaskId_fkey"
  FOREIGN KEY ("operatorTaskId") REFERENCES "OperatorTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
