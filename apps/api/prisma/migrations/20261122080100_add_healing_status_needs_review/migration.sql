-- AlterEnum: HealingStatus.needs_review existed in schema.prisma with no migration ever
-- adding it to the live enum type.
ALTER TYPE "HealingStatus" ADD VALUE 'needs_review';
