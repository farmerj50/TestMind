-- CreateTable: ApiCollection
CREATE TABLE "ApiCollection" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "apiSpecId" TEXT,
    "environmentId" TEXT,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ApiTestCase
CREATE TABLE "ApiTestCase" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "name" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "headers" JSONB,
    "queryParams" JSONB,
    "bodyJson" TEXT,
    "expectedStatus" INTEGER,
    "assertions" JSONB,
    "authSessionId" TEXT,
    "timeoutMs" INTEGER NOT NULL DEFAULT 8000,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiTestCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ApiTestRun
CREATE TABLE "ApiTestRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "summary" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiTestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ApiTestResult
CREATE TABLE "ApiTestResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "statusCode" INTEGER,
    "durationMs" INTEGER,
    "responseHeaders" JSONB,
    "bodyPreview" TEXT,
    "assertionResults" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiTestResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiCollection_projectId_createdAt_idx" ON "ApiCollection"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ApiTestCase_collectionId_order_idx" ON "ApiTestCase"("collectionId", "order");

-- CreateIndex
CREATE INDEX "ApiTestRun_projectId_createdAt_idx" ON "ApiTestRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ApiTestRun_collectionId_createdAt_idx" ON "ApiTestRun"("collectionId", "createdAt");

-- CreateIndex
CREATE INDEX "ApiTestResult_runId_idx" ON "ApiTestResult"("runId");

-- CreateIndex
CREATE INDEX "ApiTestResult_testCaseId_idx" ON "ApiTestResult"("testCaseId");

-- AddForeignKey
ALTER TABLE "ApiCollection" ADD CONSTRAINT "ApiCollection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiCollection" ADD CONSTRAINT "ApiCollection_apiSpecId_fkey" FOREIGN KEY ("apiSpecId") REFERENCES "ApiSpec"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiCollection" ADD CONSTRAINT "ApiCollection_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiTestCase" ADD CONSTRAINT "ApiTestCase_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ApiCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiTestRun" ADD CONSTRAINT "ApiTestRun_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ApiCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiTestResult" ADD CONSTRAINT "ApiTestResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ApiTestRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiTestResult" ADD CONSTRAINT "ApiTestResult_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "ApiTestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
