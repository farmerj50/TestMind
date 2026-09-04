-- CreateTable
CREATE TABLE "SecurityLiveExchange" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "authSessionId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "requestHeadersJson" JSONB NOT NULL,
    "requestPostDataInline" TEXT,
    "requestPostDataPath" TEXT,
    "responseStatus" INTEGER,
    "responseHeadersJson" JSONB,
    "responseDurationMs" INTEGER,
    "responseBodyInline" TEXT,
    "responseBodyPath" TEXT,
    "responseBodyBytes" INTEGER,
    "correlatedActionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityLiveExchange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityLiveExperiment" (
    "id" TEXT NOT NULL,
    "authSessionId" TEXT NOT NULL,
    "baselineExchangeId" TEXT,
    "baselineUrl" TEXT NOT NULL,
    "baselineMethod" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "requestJson" JSONB,
    "resultStatus" INTEGER,
    "resultBodyInline" TEXT,
    "resultBodyPath" TEXT,
    "diffJson" JSONB,
    "securityTestResultJson" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityLiveExperiment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SecurityLiveExchange_seq_key" ON "SecurityLiveExchange"("seq");

-- CreateIndex
CREATE INDEX "SecurityLiveExchange_authSessionId_seq_idx" ON "SecurityLiveExchange"("authSessionId", "seq");

-- CreateIndex
CREATE INDEX "SecurityLiveExchange_createdAt_idx" ON "SecurityLiveExchange"("createdAt");

-- CreateIndex
CREATE INDEX "SecurityLiveExperiment_authSessionId_createdAt_idx" ON "SecurityLiveExperiment"("authSessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "SecurityLiveExchange" ADD CONSTRAINT "SecurityLiveExchange_authSessionId_fkey" FOREIGN KEY ("authSessionId") REFERENCES "SecurityAuthSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityLiveExperiment" ADD CONSTRAINT "SecurityLiveExperiment_authSessionId_fkey" FOREIGN KEY ("authSessionId") REFERENCES "SecurityAuthSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

