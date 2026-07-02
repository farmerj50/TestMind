-- CreateTable
CREATE TABLE "ApiSpec" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "version" TEXT,
    "sourceUrl" TEXT,
    "specJson" JSONB NOT NULL,
    "endpoints" JSONB NOT NULL,
    "endpointCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiSpec_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiSpec_projectId_createdAt_idx" ON "ApiSpec"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "ApiSpec" ADD CONSTRAINT "ApiSpec_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
