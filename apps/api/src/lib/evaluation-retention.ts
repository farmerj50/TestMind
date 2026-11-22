// Phase 5: data retention policy for evaluation data.
//
// Policy: EvaluationRun (and its cascaded EvaluationResult rows) and AuditLog rows are retained
// for 90 days by default. There is no project-level override implemented yet - a project that
// needs a different window must call purgeExpiredEvaluationData with its own cutoff.
//
// This is deliberately NOT wired into any scheduler, cron, or startup hook anywhere in this
// repo. It is an opt-in function an admin/operator calls explicitly (or a future, separately
// authorized scheduled job would call) - adding automatic scheduling is a production
// configuration change outside this phase's authorization.
import { prisma } from "../prisma.js";

export const DEFAULT_RETENTION_DAYS = 90;

export function defaultRetentionCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export async function purgeExpiredEvaluationData(
  cutoffDate: Date,
  projectId?: string
): Promise<{ evaluationRunsDeleted: number; auditLogsDeleted: number }> {
  const scope = projectId ? { projectId } : {};

  const runsDeleted = await prisma.evaluationRun.deleteMany({
    where: { ...scope, createdAt: { lt: cutoffDate } },
  });
  // EvaluationResult rows cascade-delete via the schema's onDelete: Cascade on EvaluationRun.

  const auditLogsDeleted = await prisma.auditLog.deleteMany({
    where: { ...scope, createdAt: { lt: cutoffDate } },
  });

  return { evaluationRunsDeleted: runsDeleted.count, auditLogsDeleted: auditLogsDeleted.count };
}
