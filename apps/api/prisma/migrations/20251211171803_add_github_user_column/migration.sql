/*
  Warnings:

  - A unique constraint covering the columns `[provider,githubUserId]` on the table `GitAccount` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "GitAccount" ADD COLUMN     "githubLogin" TEXT,
ADD COLUMN     "githubUserId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "GitAccount_provider_githubUserId_key" ON "GitAccount"("provider", "githubUserId");
