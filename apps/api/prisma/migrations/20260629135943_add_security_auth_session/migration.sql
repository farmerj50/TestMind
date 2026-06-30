-- CreateTable
CREATE TABLE "SecurityAuthSession" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "provider" TEXT,
    "baseUrl" TEXT,
    "loginUrl" TEXT,
    "scopeAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "successPattern" TEXT,
    "storagePath" TEXT,
    "role" TEXT,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityAuthSession_projectId_createdAt_idx" ON "SecurityAuthSession"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityAuthSession_projectId_status_idx" ON "SecurityAuthSession"("projectId", "status");

-- AddForeignKey
ALTER TABLE "SecurityAuthSession" ADD CONSTRAINT "SecurityAuthSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
