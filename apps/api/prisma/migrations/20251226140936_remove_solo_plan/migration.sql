/*
  Warnings:

  - The values [enterprise] on the enum `PlanTier` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "PlanTier_new" AS ENUM ('free', 'starter', 'pro', 'team');
ALTER TABLE "public"."Project" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "public"."User" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "plan" TYPE "PlanTier_new" USING ("plan"::text::"PlanTier_new");
ALTER TABLE "Project" ALTER COLUMN "plan" TYPE "PlanTier_new" USING ("plan"::text::"PlanTier_new");
ALTER TYPE "PlanTier" RENAME TO "PlanTier_old";
ALTER TYPE "PlanTier_new" RENAME TO "PlanTier";
DROP TYPE "public"."PlanTier_old";
ALTER TABLE "Project" ALTER COLUMN "plan" SET DEFAULT 'free';
COMMIT;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "plan" DROP NOT NULL,
ALTER COLUMN "plan" DROP DEFAULT;
