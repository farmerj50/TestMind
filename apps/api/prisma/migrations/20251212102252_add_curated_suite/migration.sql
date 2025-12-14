-- CreateTable
CREATE TABLE "CuratedSuite" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rootRel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CuratedSuite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CuratedSuite_projectId_idx" ON "CuratedSuite"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "CuratedSuite_projectId_name_key" ON "CuratedSuite"("projectId", "name");

-- AddForeignKey
ALTER TABLE "CuratedSuite" ADD CONSTRAINT "CuratedSuite_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
