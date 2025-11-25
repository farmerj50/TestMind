-- DropForeignKey
ALTER TABLE "public"."AgentPage" DROP CONSTRAINT "AgentPage_sessionId_fkey";

-- DropForeignKey
ALTER TABLE "public"."AgentScenario" DROP CONSTRAINT "AgentScenario_pageId_fkey";

-- DropForeignKey
ALTER TABLE "public"."AgentSession" DROP CONSTRAINT "AgentSession_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."JiraIntegration" DROP CONSTRAINT "JiraIntegration_projectId_fkey";

-- DropForeignKey
ALTER TABLE "public"."JiraIntegration" DROP CONSTRAINT "JiraIntegration_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."JiraRequirement" DROP CONSTRAINT "JiraRequirement_integrationId_fkey";

-- AlterTable
ALTER TABLE "AgentPage" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AgentScenario" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AgentSession" ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "JiraIntegration" ALTER COLUMN "lastSyncedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "JiraRequirement" ALTER COLUMN "syncedAt" SET DATA TYPE TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPage" ADD CONSTRAINT "AgentPage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentScenario" ADD CONSTRAINT "AgentScenario_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "AgentPage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JiraIntegration" ADD CONSTRAINT "JiraIntegration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JiraIntegration" ADD CONSTRAINT "JiraIntegration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JiraRequirement" ADD CONSTRAINT "JiraRequirement_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "JiraIntegration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
