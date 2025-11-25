-- AlterTable
ALTER TABLE "TestRun" ADD COLUMN     "rerunOfId" TEXT;

-- CreateIndex
CREATE INDEX "TestRun_rerunOfId_idx" ON "TestRun"("rerunOfId");

-- AddForeignKey
ALTER TABLE "TestRun" ADD CONSTRAINT "TestRun_rerunOfId_fkey" FOREIGN KEY ("rerunOfId") REFERENCES "TestRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
