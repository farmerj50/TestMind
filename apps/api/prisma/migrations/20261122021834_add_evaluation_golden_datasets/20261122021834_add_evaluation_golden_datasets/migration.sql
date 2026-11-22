-- Phase 3: versioned golden datasets (EvaluationDataset / EvaluationDatasetVersion).

-- CreateTable
CREATE TABLE "EvaluationDataset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvaluationDatasetVersion" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "casesJson" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvaluationDatasetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvaluationDataset_projectId_createdAt_idx" ON "EvaluationDataset"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EvaluationDatasetVersion_datasetId_digest_key" ON "EvaluationDatasetVersion"("datasetId", "digest");

-- AddForeignKey
ALTER TABLE "EvaluationDataset" ADD CONSTRAINT "EvaluationDataset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvaluationDatasetVersion" ADD CONSTRAINT "EvaluationDatasetVersion_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "EvaluationDataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
