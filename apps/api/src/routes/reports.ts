import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import fs from "node:fs/promises";
import path from "node:path";
import fsSync from "node:fs";
import { getAuth } from "@clerk/fastify";

export default async function reportsRoutes(app: FastifyInstance) {
  // small helpers
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const parseIntSafe = (v: unknown, def = 20) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : def;
  };

  // GET /reports/summary?projectId=...
  app.get("/reports/summary", async (req, reply) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });
      const { projectId } = (req.query ?? {}) as { projectId?: string };

      const allowedProjects = await prisma.project.findMany({
        where: { ownerId: userId },
        select: { id: true },
      });
      const projectIds = allowedProjects.map((p) => p.id);
      if (!projectIds.length) {
        const empty = { queued: 0, running: 0, succeeded: 0, failed: 0, total: 0 };
        return reply.send({ counts: empty, lastRun: null });
      }

      // counts by status
      const grouped = await prisma.testRun.groupBy({
        by: ["status"],
        where: projectId
          ? { projectId, project: { ownerId: userId } }
          : { projectId: { in: projectIds } },
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

      // latest run – prefer most recently finished, then started, then created
      const lastRun = await prisma.testRun.findFirst({
        where: projectId
          ? { projectId, project: { ownerId: userId } }
          : { projectId: { in: projectIds } },
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
      return reply.code(500).send({ statusCode: 500, error: "Internal Server Error" });
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
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });

      const { projectId, take, cursorId, since, status } = (req.query ?? {}) as {
        projectId?: string;
        take?: string;
        cursorId?: string;
        since?: string;
        status?: "queued" | "running" | "succeeded" | "failed";
      };

      const allowedProjects = await prisma.project.findMany({
        where: { ownerId: userId },
        select: { id: true },
      });
      const projectIds = allowedProjects.map((p) => p.id);
      if (!projectIds.length) return reply.send({ runs: [], nextCursor: undefined, hasMore: false });

      // hard clamp to keep memory sane
      const n = clamp(parseIntSafe(take, 20), 1, 50);

      // build filters
      const where: any = projectId
        ? { projectId, project: { ownerId: userId } }
        : { projectId: { in: projectIds } };
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
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
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
      return reply.code(500).send({ statusCode: 500, error: "Internal Server Error" });
    }
  });

  /**
   * POST /reports/runs/delete
   * Body:
   *  ids?: string[]            // explicit run ids
   *  projectId?: string        // optional filter
   *  all?: boolean             // delete all runs (optionally scoped by projectId)
   *  olderThanDays?: number    // delete runs older than N days (optionally scoped by projectId)
   */
  app.post("/reports/runs/delete", async (req, reply) => {
    try {
      const { userId } = getAuth(req);
      if (!userId) return reply.code(401).send({ error: "Unauthorized" });

      const body = (req.body ?? {}) as {
        ids?: string[];
        projectId?: string;
        all?: boolean;
        olderThanDays?: number;
      };

      const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
      const olderThanDays =
        typeof body.olderThanDays === "number" && isFinite(body.olderThanDays) && body.olderThanDays > 0
          ? body.olderThanDays
          : undefined;

      if (!body.all && !ids.length && !olderThanDays) {
        return reply.code(400).send({ error: "Provide ids[], or olderThanDays, or all=true" });
      }

      const where: any = body.projectId
        ? { projectId: body.projectId, project: { ownerId: userId } }
        : { project: { ownerId: userId } };
      if (ids.length) where.id = { in: ids };
      if (olderThanDays) {
        const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000);
        where.createdAt = { lt: cutoff };
      }

      // gather run ids to clean up files
      const runs = await prisma.testRun.findMany({
        where,
        select: { id: true },
        take: body.all ? undefined : 500, // guardrail
      });
      const deleteIds = runs.map((r) => r.id);
      if (deleteIds.length === 0) {
        return reply.send({ deleted: 0, message: "No runs matched the criteria." });
      }

      // delete child rows first
      await prisma.testResult.deleteMany({ where: { runId: { in: deleteIds } } });
      await prisma.testRun.deleteMany({ where: { id: { in: deleteIds } } });

      // best-effort log cleanup
      const roots = [
        path.join(process.cwd(), "runner-logs"),
        path.join(process.cwd(), "apps", "api", "runner-logs"),
      ];
      for (const id of deleteIds) {
        for (const root of roots) {
          const p = path.join(root, id);
          if (fsSync.existsSync(p)) {
            await fs.rm(p, { recursive: true, force: true }).catch(() => {});
          }
        }
      }

      reply.send({ deleted: deleteIds.length });
    } catch (err: any) {
      req.log.error({ err }, "reports/runs/delete failed");
      return reply.code(500).send({ statusCode: 500, error: "Internal Server Error" });
    }
  });
}
