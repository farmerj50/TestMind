-- CreateTable: OperatorSchedule existed in schema.prisma and is used live by the scheduler
-- (`OperatorSchedule.timezone` is altered by the very next migration, 20261122071818), but no
-- migration anywhere in history ever created the base table - a second, independent instance of
-- the same gap as Environment (verified via `prisma migrate diff --from-empty`).
CREATE TABLE "OperatorSchedule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "contextJson" JSONB NOT NULL DEFAULT '{}',
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperatorSchedule_projectId_idx" ON "OperatorSchedule"("projectId");

-- AddForeignKey
ALTER TABLE "OperatorSchedule" ADD CONSTRAINT "OperatorSchedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
