-- CreateEnum
CREATE TYPE "SecurityScanStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "SecurityFindingType" AS ENUM ('recon', 'static_analysis', 'dependency', 'dynamic');

-- CreateEnum
CREATE TYPE "SecuritySeverity" AS ENUM ('info', 'low', 'medium', 'high', 'critical');

-- CreateTable
CREATE TABLE "SecurityScanJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "SecurityScanStatus" NOT NULL DEFAULT 'queued',
    "phase" TEXT,
    "startedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "config" JSONB,
    "summary" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityScanJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityFinding" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "type" "SecurityFindingType" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "tool" TEXT,
    "evidence" JSONB,
    "suggestion" TEXT,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityScanJob_projectId_createdAt_idx" ON "SecurityScanJob"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityFinding_scanId_severity_idx" ON "SecurityFinding"("scanId", "severity");

-- AddForeignKey
ALTER TABLE "SecurityScanJob" ADD CONSTRAINT "SecurityScanJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityFinding" ADD CONSTRAINT "SecurityFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "SecurityScanJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
