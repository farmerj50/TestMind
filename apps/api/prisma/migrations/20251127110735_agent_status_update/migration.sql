-- AlterEnum
BEGIN;
CREATE TYPE "AgentScenarioStatus_new" AS ENUM ('suggested', 'accepted', 'rejected', 'completed');
ALTER TABLE "public"."AgentScenario" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "AgentScenario" ALTER COLUMN "status" TYPE "AgentScenarioStatus_new" USING ("status"::text::"AgentScenarioStatus_new");
ALTER TYPE "AgentScenarioStatus" RENAME TO "AgentScenarioStatus_old";
ALTER TYPE "AgentScenarioStatus_new" RENAME TO "AgentScenarioStatus";
DROP TYPE "public"."AgentScenarioStatus_old";
ALTER TABLE "AgentScenario" ALTER COLUMN "status" SET DEFAULT 'suggested';
COMMIT;


