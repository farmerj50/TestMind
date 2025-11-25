import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma";

export default async function reportsRoutes(app: FastifyInstance) {
  // small helpers
  const clamp = (n: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, n));
  const parseIntSafe = (v: unknown, def = 20) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : def;
  };

  // GET /reports/summary?projectId=...
  app.get("/reports/summary", async (req, reply) => {
    try {
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
    } catch (err: any) {
      req.log.error({ err }, "reports/summary failed");
      return reply
        .code(500)
        .send({ statusCode: 500, error: "Internal Server Error" });
    }
  });

  /**
   * GET /reports/recent
   * Query:
   *   projectId?: string
   *   take?: number (default 20, max 50)
   *   cursorId?: string  -> for pagination (exclusive)
   *   since?: ISO string -> only runs createdAt >= since
   *   status?: 'queued'|'running'|'succeeded'|'failed'
   *
   * Response:
   *   { runs: TestRunLite[], nextCursor?: string, hasMore: boolean }
   */
  app.get("/reports/recent", async (req, reply) => {
    try {
      const { projectId, take, cursorId, since, status } = (req.query ??
        {}) as {
        projectId?: string;
        take?: string;
        cursorId?: string;
        since?: string;
        status?: "queued" | "running" | "succeeded" | "failed";
      };

      // hard clamp to keep memory sane
      const n = clamp(parseIntSafe(take, 20), 1, 50);

      // build filters
      const where: any = {};
      if (projectId) where.projectId = projectId;
      if (status) where.status = status;
      if (since) {
        const d = new Date(since);
        if (!isNaN(d.getTime())) where.createdAt = { gte: d };
      }

      // cursor-based pagination on (id) with stable ordering
      const orderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];

      const runs = await prisma.testRun.findMany({
        where,
        orderBy,
        // fetch one extra to know if there's a next page
        take: n + 1,
        ...(cursorId
          ? { cursor: { id: cursorId }, skip: 1 } // exclude the cursor row
          : {}),
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

      let nextCursor: string | undefined;
      let paged = runs;
      if (runs.length > n) {
        // more pages available
        const next = runs[n];
        nextCursor = next.id;
        paged = runs.slice(0, n);
      }

      reply.header("Cache-Control", "no-store");
      return reply.send({
        runs: paged,
        nextCursor,
        hasMore: Boolean(nextCursor),
      });
    } catch (err: any) {
      req.log.error({ err }, "reports/recent failed");
      return reply
        .code(500)
        .send({ statusCode: 500, error: "Internal Server Error" });
    }
  });
}
