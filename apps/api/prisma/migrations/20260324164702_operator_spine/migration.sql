-- CreateEnum
CREATE TYPE "OperatorJobType" AS ENUM ('qa', 'security', 'repair', 'discovery');

-- CreateEnum
CREATE TYPE "OperatorJobStatus" AS ENUM ('queued', 'running', 'blocked', 'succeeded', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "OperatorTaskType" AS ENUM ('discover', 'execute', 'triage', 'repair', 'retest', 'verify');

-- CreateEnum
CREATE TYPE "OperatorTaskStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "OperatorStepCapability" AS ENUM ('browser', 'api', 'terminal', 'git', 'security', 'filesystem');

-- CreateEnum
CREATE TYPE "OperatorStepStatus" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "OperatorArtifactType" AS ENUM ('screenshot', 'trace', 'video', 'har', 'console', 'network', 'patch', 'report', 'dom');

-- CreateEnum
CREATE TYPE "OperatorDecisionType" AS ENUM ('retry', 'heal', 'abort', 'escalate', 'patch', 'request_approval');

-- CreateEnum
CREATE TYPE "OperatorApprovalStatus" AS ENUM ('pending', 'approved', 'denied', 'expired');

-- CreateEnum
CREATE TYPE "OperatorApprovalAction" AS ENUM ('patch_code', 'run_terminal', 'security_active_test', 'git_push');

-- CreateTable
CREATE TABLE "OperatorJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT,
    "type" "OperatorJobType" NOT NULL,
    "status" "OperatorJobStatus" NOT NULL DEFAULT 'queued',
    "objective" TEXT,
    "requestedBy" TEXT,
    "contextJson" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "OperatorJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorTask" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "parentTaskId" TEXT,
    "type" "OperatorTaskType" NOT NULL,
    "status" "OperatorTaskStatus" NOT NULL DEFAULT 'pending',
    "assignedAgent" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "inputJson" JSONB,
    "outputJson" JSONB,
    "error" TEXT,
    "testRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "OperatorTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorStep" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "capability" "OperatorStepCapability" NOT NULL,
    "action" TEXT NOT NULL,
    "target" TEXT,
    "inputJson" JSONB,
    "outputJson" JSONB,
    "status" "OperatorStepStatus" NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "OperatorStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorArtifact" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "taskId" TEXT,
    "stepId" TEXT,
    "testRunId" TEXT,
    "type" "OperatorArtifactType" NOT NULL,
    "path" TEXT NOT NULL,
    "metaJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorDecision" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "taskId" TEXT,
    "decisionType" "OperatorDecisionType" NOT NULL,
    "rationale" TEXT,
    "confidence" DOUBLE PRECISION,
    "model" TEXT,
    "evidenceJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorApproval" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "taskId" TEXT,
    "actionType" "OperatorApprovalAction" NOT NULL,
    "status" "OperatorApprovalStatus" NOT NULL DEFAULT 'pending',
    "requestedBy" TEXT NOT NULL,
    "resolvedBy" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "contextJson" JSONB,

    CONSTRAINT "OperatorApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperatorJob_projectId_createdAt_idx" ON "OperatorJob"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "OperatorJob_status_idx" ON "OperatorJob"("status");

-- CreateIndex
CREATE INDEX "OperatorTask_jobId_idx" ON "OperatorTask"("jobId");

-- CreateIndex
CREATE INDEX "OperatorTask_parentTaskId_idx" ON "OperatorTask"("parentTaskId");

-- CreateIndex
CREATE INDEX "OperatorTask_testRunId_idx" ON "OperatorTask"("testRunId");

-- CreateIndex
CREATE INDEX "OperatorStep_taskId_idx_idx" ON "OperatorStep"("taskId", "idx");

-- CreateIndex
CREATE INDEX "OperatorArtifact_jobId_idx" ON "OperatorArtifact"("jobId");

-- CreateIndex
CREATE INDEX "OperatorArtifact_taskId_idx" ON "OperatorArtifact"("taskId");

-- CreateIndex
CREATE INDEX "OperatorDecision_jobId_idx" ON "OperatorDecision"("jobId");

-- CreateIndex
CREATE INDEX "OperatorDecision_taskId_idx" ON "OperatorDecision"("taskId");

-- CreateIndex
CREATE INDEX "OperatorApproval_jobId_status_idx" ON "OperatorApproval"("jobId", "status");

-- CreateIndex
CREATE INDEX "OperatorApproval_status_expiresAt_idx" ON "OperatorApproval"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "OperatorJob" ADD CONSTRAINT "OperatorJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorTask" ADD CONSTRAINT "OperatorTask_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "OperatorJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorTask" ADD CONSTRAINT "OperatorTask_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "OperatorTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorStep" ADD CONSTRAINT "OperatorStep_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "OperatorTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorArtifact" ADD CONSTRAINT "OperatorArtifact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "OperatorJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorArtifact" ADD CONSTRAINT "OperatorArtifact_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "OperatorTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorArtifact" ADD CONSTRAINT "OperatorArtifact_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "OperatorStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorDecision" ADD CONSTRAINT "OperatorDecision_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "OperatorJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorDecision" ADD CONSTRAINT "OperatorDecision_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "OperatorTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorApproval" ADD CONSTRAINT "OperatorApproval_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "OperatorJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorApproval" ADD CONSTRAINT "OperatorApproval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "OperatorTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
