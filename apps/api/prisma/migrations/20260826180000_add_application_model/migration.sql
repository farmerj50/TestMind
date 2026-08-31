-- Project Memory foundation: persisted, discovery-derived application-model facts
-- (forms/fields per page), separate from the sharedSteps blob used for locator resolution.
-- Additive, nullable, no backfill.
ALTER TABLE "Project" ADD COLUMN "applicationModel" JSONB DEFAULT '{}';
