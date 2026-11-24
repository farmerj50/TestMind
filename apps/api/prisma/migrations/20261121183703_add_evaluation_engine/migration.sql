-- CreateEnum
CREATE TYPE "EvaluationRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "EvaluationRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "EvaluationRunStatus" NOT NULL DEFAULT 'queued',
    "datasetId" TEXT NOT NULL,
    "datasetVersion" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "applicationVersion" TEXT NOT NULL,
    "evaluatorVersion" TEXT,
    "evaluatorMetadata" JSONB,
    "gatesConfig" JSONB,
    "casesJson" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "overallGateStatus" TEXT,
    "metricsSummary" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvaluationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "recallAtK" DOUBLE PRECISION,
    "precisionAtK" DOUBLE PRECISION,
    "requiredFactRate" DOUBLE PRECISION,
    "abstainedCorrectly" BOOLEAN,
    "latencyMs" INTEGER,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvaluationRun_projectId_createdAt_idx" ON "EvaluationRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "EvaluationResult_runId_createdAt_idx" ON "EvaluationResult"("runId", "createdAt");

-- AddForeignKey
ALTER TABLE "EvaluationRun" ADD CONSTRAINT "EvaluationRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationResult" ADD CONSTRAINT "EvaluationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "EvaluationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

