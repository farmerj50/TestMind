import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma.js";
import fs from "node:fs/promises";
import path from "node:path";
import fsSync from "node:fs";
import { getAuth } from "@clerk/fastify";

type RunLifecycleStatus = "queued" | "running" | "completed" | "failed";
type ArtifactState = "none" | "partial" | "complete";

const firstHeaderValue = (value?: string | string[]) => {
  if (Array.isArray(value)) return value[0]?.split(",")[0]?.trim() || "";
  return value?.split(",")[0]?.trim() || "";
};

const resolvePublicBaseUrl = (req: any) => {
  const configured = (process.env.TM_PUBLIC_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const xfProto = firstHeaderValue(req.headers?.["x-forwarded-proto"]);
  const xfHost = firstHeaderValue(req.headers?.["x-forwarded-host"]);
  if (xfProto && xfHost) return `${xfProto}://${xfHost}`;
  const host = firstHeaderValue(req.headers?.host);
  const proto =
    (typeof req.protocol === "string" && req.protocol) ||
    (req.raw?.socket?.encrypted ? "https" : "http");
  return host ? `${proto}://${host}` : "";
};

const normalizePathLike = (value: string) => value.replace(/\\/g, "/").replace(/^\/+/, "");

const toAbsoluteUrl = (base: string, relOrAbs: string) => {
  if (!relOrAbs) return "";
  if (/^https?:\/\//i.test(relOrAbs)) return relOrAbs;
  const rel = relOrAbs.startsWith("/") ? relOrAbs : `/${relOrAbs}`;
  return base ? new URL(rel, `${base}/`).toString() : rel;
};

const toStaticArtifactPath = (runId: string, input: string, options?: { indexHtml?: boolean }) => {
  const normalized = normalizePathLike(input);
  let artifactPath = normalized;
  if (artifactPath.startsWith("runner/runner-logs/")) {
    artifactPath = artifactPath.slice("runner/".length);
  } else if (artifactPath.startsWith("runner/")) {
    artifactPath = artifactPath.slice("runner/".length);
  } else if (!artifactPath.startsWith("runner-logs/")) {
    artifactPath = `runner-logs/${runId}/${artifactPath}`;
  }
  let staticPath = `/_static/${artifactPath}`;
  if (options?.indexHtml && !staticPath.endsWith("/index.html")) {
    staticPath = `${staticPath.replace(/\/+$/, "")}/index.html`;
  }
  return staticPath;
};

const toPublicArtifacts = (req: any, runId: string, artifactsJson?: Record<string, unknown> | null) => {
  const base = resolvePublicBaseUrl(req);
  const artifacts = (artifactsJson ?? {}) as Record<string, unknown>;
  const readString = (key: string) => (typeof artifacts[key] === "string" ? String(artifacts[key]) : "");
  const reportPathRaw = readString("reportJson");
  const allureReportRaw = readString("allure-report") || readString("allure");
  const allureResultsRaw = readString("allure-results");

  const reportPath = reportPathRaw
    ? /^https?:\/\//i.test(reportPathRaw)
      ? reportPathRaw
      : toStaticArtifactPath(runId, reportPathRaw)
    : `/runner/test-runs/${runId}/report.json`;
  const allureReportPath = allureReportRaw
    ? /^https?:\/\//i.test(allureReportRaw)
      ? allureReportRaw
      : toStaticArtifactPath(runId, allureReportRaw, { indexHtml: true })
    : "";
  const allureResultsPath = allureResultsRaw
    ? /^https?:\/\//i.test(allureResultsRaw)
      ? allureResultsRaw
      : toStaticArtifactPath(runId, allureResultsRaw)
    : "";

  return {
    reportJsonUrl: toAbsoluteUrl(base, reportPath),
    allureReportUrl: allureReportPath ? toAbsoluteUrl(base, allureReportPath) : null,
    allureResultsUrl: allureResultsPath ? toAbsoluteUrl(base, allureResultsPath) : null,
    analysisUrl: toAbsoluteUrl(base, `/runner/test-runs/${runId}/analysis`),
    stdoutUrl: toAbsoluteUrl(base, `/runner/test-runs/${runId}/logs?type=stdout`),
    stderrUrl: toAbsoluteUrl(base, `/runner/test-runs/${runId}/logs?type=stderr`),
    liveEventsUrl: toAbsoluteUrl(base, `/runner/test-runs/${runId}/live`),
    runViewUrl: toAbsoluteUrl(base, `/test-runs/${runId}`),
  };
};

const toLifecycleStatus = (status: string): RunLifecycleStatus => {
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "queued";
};

const toArtifactsState = (artifactsJson: unknown): ArtifactState => {
  if (!artifactsJson || typeof artifactsJson !== "object") return "none";
  const artifacts = artifactsJson as Record<string, unknown>;
  const keys = Object.keys(artifacts).filter((k) => typeof artifacts[k] === "string" && (artifacts[k] as string).trim());
  if (!keys.length) return "none";
  const hasReport = typeof artifacts.reportJson === "string";
  const hasAllure = typeof artifacts["allure-report"] === "string";
  return hasReport && hasAllure ? "complete" : "partial";
};

const toStructuredErrors = (run: { error?: string | null; summary?: string | null }) => {
  const out: Array<{ code: string; message: string; source: "runner" | "summary" }> = [];
  const seen = new Set<string>();
  const pushUnique = (code: string, message: string, source: "runner" | "summary") => {
    const trimmed = message.trim();
    if (!trimmed) return;
    const key = `${source}:${trimmed}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ code, message: trimmed, source });
  };
  if (run.error) pushUnique("RUN_ERROR", run.error, "runner");
  if (run.summary) {
    try {
      const parsed = JSON.parse(run.summary);
      const errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
      for (const value of errors) {
        if (typeof value === "string") pushUnique("SUMMARY_ERROR", value, "summary");
      }
    } catch {
      // Ignore non-JSON summaries.
    }
  }
  return out;
};

const withReportsRunContract = <T extends { id: string; status: string; error?: string | null; summary?: string | null; artifactsJson?: unknown }>(
  req: any,
  run: T
) => ({
  ...run,
  lifecycleStatus: toLifecycleStatus(run.status),
  artifactsState: toArtifactsState(run.artifactsJson),
  errors: toStructuredErrors(run),
  publicArtifacts: toPublicArtifacts(req, run.id, (run.artifactsJson ?? null) as Record<string, unknown> | null),
});

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
   *   take?: number (default 100, max 200)
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
      const n = clamp(parseIntSafe(take, 100), 1, 200);

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
          artifactsJson: true,
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
        runs: paged.map((run) => withReportsRunContract(req, run)),
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
