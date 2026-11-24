-- CreateEnum
CREATE TYPE "QeStageOutcome" AS ENUM ('pending', 'running', 'succeeded', 'partial', 'failed', 'unverified', 'blocked', 'skipped', 'canceled', 'awaitingApproval');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OperatorJobStatus" ADD VALUE 'paused';
ALTER TYPE "OperatorJobStatus" ADD VALUE 'partial';
ALTER TYPE "OperatorJobStatus" ADD VALUE 'unverified';

-- AlterEnum
ALTER TYPE "OperatorTaskType" ADD VALUE 'stage';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OperatorArtifactType" ADD VALUE 'plan';
ALTER TYPE "OperatorArtifactType" ADD VALUE 'spec';
ALTER TYPE "OperatorArtifactType" ADD VALUE 'execution_result';
ALTER TYPE "OperatorArtifactType" ADD VALUE 'repair_attempt';
ALTER TYPE "OperatorArtifactType" ADD VALUE 'pr_proposal';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OperatorApprovalAction" ADD VALUE 'destructive_test';
ALTER TYPE "OperatorApprovalAction" ADD VALUE 'sensitive_action';
ALTER TYPE "OperatorApprovalAction" ADD VALUE 'pr_publish';

-- AlterTable
ALTER TABLE "OperatorTask" ADD COLUMN     "checkpointJson" JSONB,
ADD COLUMN     "outcome" "QeStageOutcome",
ADD COLUMN     "outcomeReason" TEXT,
ADD COLUMN     "stageKey" TEXT,
ADD COLUMN     "stageOrder" INTEGER;

-- CreateIndex
CREATE INDEX "OperatorTask_jobId_stageKey_idx" ON "OperatorTask"("jobId", "stageKey");

