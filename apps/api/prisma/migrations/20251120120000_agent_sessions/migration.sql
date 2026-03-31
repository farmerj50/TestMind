-- Create Enums
CREATE TYPE "AgentSessionStatus" AS ENUM ('draft', 'running', 'ready', 'failed');
CREATE TYPE "AgentPageStatus" AS ENUM ('pending', 'running', 'completed', 'failed');
CREATE TYPE "AgentScenarioStatus" AS ENUM ('suggested', 'attached', 'archived');

-- AgentSession table
CREATE TABLE "AgentSession" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "projectId" TEXT,
  "name" TEXT,
  "baseUrl" TEXT NOT NULL,
  "instructions" TEXT,
  "status" "AgentSessionStatus" NOT NULL DEFAULT 'draft',
  "meta" JSONB,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AgentSession_userId_idx" ON "AgentSession"("userId");
CREATE INDEX "AgentSession_projectId_idx" ON "AgentSession"("projectId");

ALTER TABLE "AgentSession"
  ADD CONSTRAINT "AgentSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentSession"
  ADD CONSTRAINT "AgentSession_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AgentPage table
CREATE TABLE "AgentPage" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "instructions" TEXT,
  "status" "AgentPageStatus" NOT NULL DEFAULT 'pending',
  "summary" TEXT,
  "coverage" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AgentPage_sessionId_idx" ON "AgentPage"("sessionId");

ALTER TABLE "AgentPage"
  ADD CONSTRAINT "AgentPage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AgentScenario table
CREATE TABLE "AgentScenario" (
  "id" TEXT PRIMARY KEY,
  "pageId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "coverageType" TEXT NOT NULL,
  "description" TEXT,
  "tags" JSONB,
  "risk" TEXT,
  "status" "AgentScenarioStatus" NOT NULL DEFAULT 'suggested',
  "steps" JSONB,
  "specPath" TEXT,
  "attachedProjectId" TEXT,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "AgentScenario_pageId_idx" ON "AgentScenario"("pageId");
CREATE INDEX "AgentScenario_attachedProjectId_idx" ON "AgentScenario"("attachedProjectId");

ALTER TABLE "AgentScenario"
  ADD CONSTRAINT "AgentScenario_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "AgentPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentScenario"
  ADD CONSTRAINT "AgentScenario_attachedProjectId_fkey" FOREIGN KEY ("attachedProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
