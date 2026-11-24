-- AlterEnum
ALTER TYPE "DevAgentRunStatus" ADD VALUE 'unverified';

-- AlterTable
ALTER TABLE "DevAgentRun" ADD COLUMN     "baseUrl" TEXT;
ALTER TABLE "DevAgentRun" ADD COLUMN     "environmentId" TEXT;
ALTER TABLE "DevAgentRun" ADD COLUMN     "discoveryContextJson" JSONB;

-- AddForeignKey
ALTER TABLE "DevAgentRun" ADD CONSTRAINT "DevAgentRun_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
