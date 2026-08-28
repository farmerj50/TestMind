import { prisma } from "../prisma.js";

// Consolidates two previously-duplicated implementations of the same check
// (secrets.ts's isProjectOwner, workflows.ts's ensureProjectOwned) into one.
// Pure boolean check, not a req/reply-handling helper: callers still do their
// own getAuth(req) 401 check and their own 403 reply, matching the existing
// convention at every current call site rather than introducing a new one.
export async function isProjectOwner(projectId: string, userId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true },
  });
  if (!project) return false;
  return project.ownerId === userId;
}
