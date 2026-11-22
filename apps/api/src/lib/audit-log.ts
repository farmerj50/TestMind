// Phase 5: minimal audit trail for evaluation-related actions. Scoped to the three actions
// that call it below - not a sweeping audit log for unrelated features.
import { prisma } from "../prisma.js";

export async function recordAuditLog(entry: {
  projectId: string;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadataJson?: unknown;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      projectId: entry.projectId,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      metadataJson: entry.metadataJson as any,
    },
  });
}
