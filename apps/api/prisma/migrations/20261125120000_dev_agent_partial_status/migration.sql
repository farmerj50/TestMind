-- Dev Agent runs whose generated tests were saved but did not pass end as "partial" (additive, non-destructive).
ALTER TYPE "DevAgentRunStatus" ADD VALUE IF NOT EXISTS 'partial';
