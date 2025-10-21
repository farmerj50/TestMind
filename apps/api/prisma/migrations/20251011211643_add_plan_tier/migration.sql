-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('free', 'pro', 'enterprise');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "plan" "PlanTier" NOT NULL DEFAULT 'free';
