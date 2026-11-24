-- CreateEnum
CREATE TYPE "DevAgentMode" AS ENUM ('assigned', 'selfImprovement', 'both');

-- CreateEnum
CREATE TYPE "DevAgentRunStatus" AS ENUM ('queued', 'running', 'paused', 'awaitingApproval', 'succeeded', 'failed', 'canceled');

-- AlterEnum
ALTER TYPE "OperatorJobType" ADD VALUE 'autonomousDev';

-- AlterTable
ALTER TABLE "OperatorSchedule" ADD COLUMN     "timezone" TEXT;

-- CreateTable
CREATE TABLE "DevAgentRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "operatorJobId" TEXT,
    "mode" "DevAgentMode" NOT NULL DEFAULT 'assigned',
    "targetRepo" TEXT NOT NULL DEFAULT 'testmind',
    "instructionText" TEXT,
    "scheduledStartAt" TIMESTAMP(3),
    "timezone" TEXT,
    "budgetUsd" DOUBLE PRECISION,
    "spentUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "DevAgentRunStatus" NOT NULL DEFAULT 'queued',
    "worktreePath" TEXT,
    "baseBranch" TEXT,
    "workBranch" TEXT,
    "maxIterations" INTEGER NOT NULL DEFAULT 5,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "DevAgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevAgentMessage" (
    "id" TEXT NOT NULL,
    "devAgentRunId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevAgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevAgentIteration" (
    "id" TEXT NOT NULL,
    "devAgentRunId" TEXT NOT NULL,
    "iterationNumber" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "summary" TEXT,
    "filesChanged" JSONB,
    "testResult" JSONB,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevAgentIteration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DevAgentRun_operatorJobId_key" ON "DevAgentRun"("operatorJobId");

-- CreateIndex
CREATE INDEX "DevAgentRun_projectId_createdAt_idx" ON "DevAgentRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "DevAgentRun_status_idx" ON "DevAgentRun"("status");

-- CreateIndex
CREATE INDEX "DevAgentMessage_devAgentRunId_createdAt_idx" ON "DevAgentMessage"("devAgentRunId", "createdAt");

-- CreateIndex
CREATE INDEX "DevAgentIteration_devAgentRunId_iterationNumber_idx" ON "DevAgentIteration"("devAgentRunId", "iterationNumber");

-- AddForeignKey
ALTER TABLE "DevAgentRun" ADD CONSTRAINT "DevAgentRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevAgentMessage" ADD CONSTRAINT "DevAgentMessage_devAgentRunId_fkey" FOREIGN KEY ("devAgentRunId") REFERENCES "DevAgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevAgentIteration" ADD CONSTRAINT "DevAgentIteration_devAgentRunId_fkey" FOREIGN KEY ("devAgentRunId") REFERENCES "DevAgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

