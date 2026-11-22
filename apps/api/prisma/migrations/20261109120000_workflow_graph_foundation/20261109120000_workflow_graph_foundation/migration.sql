-- Additive only: existing workflows, runs and operator records remain intact.
ALTER TYPE "OperatorJobType" ADD VALUE IF NOT EXISTS 'workflow';
ALTER TABLE "Workflow" ADD COLUMN "archivedAt" TIMESTAMP(3);
CREATE TABLE "WorkflowVersion" (
  "id" TEXT NOT NULL, "workflowId" TEXT NOT NULL, "digest" TEXT NOT NULL,
  "snapshotJson" JSONB NOT NULL, "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkflowVersion_workflowId_digest_key" ON "WorkflowVersion"("workflowId", "digest");
ALTER TABLE "WorkflowRun" ADD COLUMN "versionId" TEXT, ADD COLUMN "contextJson" JSONB;
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "WorkflowVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OperatorTask" ADD COLUMN "workflowRunId" TEXT, ADD COLUMN "nodeKey" TEXT, ADD COLUMN "nodeVersion" INTEGER, ADD COLUMN "nodeAttempt" INTEGER NOT NULL DEFAULT 1, ADD COLUMN "stateEncrypted" TEXT;
ALTER TABLE "OperatorTask" ADD CONSTRAINT "OperatorTask_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "OperatorTask_workflowRunId_nodeKey_nodeAttempt_key" ON "OperatorTask"("workflowRunId", "nodeKey", "nodeAttempt");
