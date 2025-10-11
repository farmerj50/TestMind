import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma";

export default async function reportsRoutes(app: FastifyInstance) {
  // GET /reports/summary?projectId=...
  app.get("/reports/summary", async (req, reply) => {
    const { projectId } = (req.query ?? {}) as { projectId?: string };

    // counts by status
    const grouped = await prisma.testRun.groupBy({
      by: ["status"],
      where: projectId ? { projectId } : undefined,
      _count: { _all: true },
    });

    const counts: Record<string, number> = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      total: 0,
    };

    for (const g of grouped) {
      counts[g.status] = g._count._all;
      counts.total += g._count._all;
    }

    // latest run — prefer most recently finished, then started, then created
    const lastRun = await prisma.testRun.findFirst({
      where: projectId ? { projectId } : undefined,
      orderBy: [
        { finishedAt: "desc" },
        { startedAt: "desc" },
        { createdAt: "desc" },
      ],
      select: {
        id: true,
        status: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        projectId: true,
        summary: true,
        error: true,
        issueUrl: true,
      },
    });

    reply.header("Cache-Control", "no-store");

    return reply.send({ counts, lastRun });
  });

  // GET /reports/recent?projectId=...&take=20
  app.get("/reports/recent", async (req, reply) => {
    const { projectId, take } = (req.query ?? {}) as {
      projectId?: string;
      take?: string;
    };
    const n = Math.max(1, Math.min(Number(take ?? 20), 100));

    const runs = await prisma.testRun.findMany({
      where: projectId ? { projectId } : undefined,
      orderBy: [
        { finishedAt: "desc" },
        { startedAt: "desc" },
        { createdAt: "desc" },
      ],
      take: n,
      select: {
        id: true,
        projectId: true,
        status: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        summary: true,
        error: true,
        issueUrl: true,
      },
    });

    reply.header("Cache-Control", "no-store");

    return reply.send({ runs });
  });
}
