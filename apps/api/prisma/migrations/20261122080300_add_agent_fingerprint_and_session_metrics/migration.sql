-- AlterTable: AgentPage.fingerprint and AgentSession.metrics existed in schema.prisma with no
-- migration ever adding them.
ALTER TABLE "AgentPage" ADD COLUMN     "fingerprint" TEXT;

-- AlterTable
ALTER TABLE "AgentSession" ADD COLUMN     "metrics" JSONB;
