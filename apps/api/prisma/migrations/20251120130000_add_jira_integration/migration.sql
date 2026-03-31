CREATE TABLE "JiraIntegration" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "siteUrl" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "apiToken" TEXT NOT NULL,
  "projectKey" TEXT NOT NULL,
  "lastSyncedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "JiraRequirement" (
  "id" TEXT PRIMARY KEY,
  "integrationId" TEXT NOT NULL,
  "issueKey" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "priority" TEXT,
  "url" TEXT,
  "syncedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "JiraIntegration_userId_projectId_key" ON "JiraIntegration"("userId","projectId");
CREATE UNIQUE INDEX "JiraRequirement_integrationId_issueKey_key" ON "JiraRequirement"("integrationId","issueKey");

ALTER TABLE "JiraIntegration"
  ADD CONSTRAINT "JiraIntegration_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JiraIntegration"
  ADD CONSTRAINT "JiraIntegration_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JiraRequirement"
  ADD CONSTRAINT "JiraRequirement_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "JiraIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
