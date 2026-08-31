import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma.js";

// Extracted from run.ts's runRoutes closure so index.ts's runner-artifact routes can use
// the identical ownership check instead of a separately-maintained copy (or, previously,
// no check at all) — eliminates drift risk between the protected and unprotected paths.
export async function requireRunOwner(req: any, reply: any, runId: string) {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  const run = await prisma.testRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      projectId: true,
      project: { select: { ownerId: true } },
    },
  });
  if (!run || run.project.ownerId !== userId) {
    reply.code(404).send({ error: "Run not found" });
    return null;
  }
  return { runId: run.id, projectId: run.projectId, userId };
}
