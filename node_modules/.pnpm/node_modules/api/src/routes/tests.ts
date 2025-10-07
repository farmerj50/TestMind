import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma";

type IdParams = { id: string };

export async function testRoutes(app: FastifyInstance) {
  // Create a run (stub) and simulate work
  app.post<{ Params: IdParams }>("/projects/:id/test-runs", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const projectId = req.params.id;

    // make sure the project belongs to the signed-in user
    const project = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    // queue the run
    const run = await prisma.testRun.create({
      data: { projectId, status: "queued" },
    });

    // background simulation (safe, no fancy helpers)
    setTimeout(async () => {
      try {
        await prisma.testRun.update({
          where: { id: run.id },
          data: { status: "running", startedAt: new Date() },
        });

        setTimeout(async () => {
          await prisma.testRun.update({
            where: { id: run.id },
            data: {
              status: "succeeded",
              finishedAt: new Date(),
              summary: "Generated 12 tests.",
            },
          });
        }, 2000);
      } catch (e) {
        await prisma.testRun.update({
          where: { id: run.id },
          data: {
            status: "failed",
            finishedAt: new Date(),
            error: String(e),
          },
        });
      }
    }, 0);

    return reply.send({ run });
  });

  // List runs
  app.get<{ Params: IdParams }>("/projects/:id/test-runs", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const projectId = req.params.id;
    const project = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const runs = await prisma.testRun.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return reply.send({ runs });
  });
  app.get<{ Params: { runId: string } }>("/test-runs/:runId", async (req, reply) => {
  const { userId } = getAuth(req);
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });

  const { runId } = req.params;
  const run = await prisma.testRun.findUnique({
    where: { id: runId },
    include: { project: true },
  });
  if (!run || run.project.ownerId !== userId) {
    return reply.code(404).send({ error: "Not found" });
  }
  return reply.send({ run });
});

}
