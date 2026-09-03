-- AlterTable
ALTER TABLE "TestCase" ADD COLUMN     "securityFindingId" TEXT;

-- AddForeignKey
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_securityFindingId_fkey" FOREIGN KEY ("securityFindingId") REFERENCES "SecurityFinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

