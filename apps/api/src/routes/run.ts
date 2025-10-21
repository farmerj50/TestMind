// apps/api/src/routes/run.ts
import type { FastifyInstance } from "fastify";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { prisma } from "../prisma";
import { TestRunStatus, TestResultStatus } from "@prisma/client";

// runner pieces
import { makeWorkdir, rmrf } from "../runner/workdir";
import { cloneRepo } from "../runner/git";
import { detectFramework, installDeps, runTests } from "../runner/node-test-exec";
import { parseResults } from "../runner/result-parsers";

// ---------- helpers ----------
function sendError(
  reply: any,
  code: string,
  message: string,
  statusCode = 400,
  details?: any
) {
  return reply.code(statusCode).send({ error: { code, message, details } });
}

const RunBody = z.object({
  projectId: z.string().min(1, "projectId is required"),
});

function mapStatus(s: string): TestResultStatus {
  if (s === "passed") return TestResultStatus.passed;
  if (s === "failed" || s === "error") return TestResultStatus.failed;
  if (s === "skipped") return TestResultStatus.skipped;
  return TestResultStatus.error;
}

export default async function runRoutes(app: FastifyInstance) {
  // POST /runner/run
  app.post("/run", async (req, reply) => {
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) {
      return sendError(
        reply,
        "INVALID_INPUT",
        "Invalid request body",
        400,
        parsed.error.flatten()
      );
    }

    const pid = parsed.data.projectId.trim();

    // look up project
    const project =
      (await prisma.project.findUnique({ where: { id: pid } })) ??
      (await prisma.project.findFirst({ where: { id: pid } }));

    if (!project) {
      return sendError(reply, "PROJECT_NOT_FOUND", `Project ${pid} was not found`, 404);
    }
    if (!project.repoUrl?.trim()) {
      return sendError(
        reply,
        "MISSING_REPO_URL",
        "Repository URL is not configured for this project",
        400,
        { projectId: pid }
      );
    }

    // create run entry
    const run = await prisma.testRun.create({
      data: { projectId: pid, status: TestRunStatus.running, startedAt: new Date() },
    });

    const outDir = path.join(process.cwd(), "runner-logs", run.id);
    await fs.mkdir(outDir, { recursive: true });

    // launch the real runner in background (no await)
    (async () => {
      const work = await makeWorkdir();
      try {
        // GitHub token if connected
        const gitAcct = await prisma.gitAccount.findFirst({
          where: { userId: project.ownerId, provider: "github" },
          select: { token: true },
        });

        // 1) Clone
        await cloneRepo(project.repoUrl, work, gitAcct?.token || undefined);

        // 2) Install deps
        await installDeps(work);

        // 3) Detect + run
        const framework = await detectFramework(work);
        const exec = await runTests(framework, work);

        // Save raw logs (always)
        await fs.writeFile(path.join(outDir, "stdout.txt"), exec.stdout ?? "");
        await fs.writeFile(path.join(outDir, "stderr.txt"), exec.stderr ?? "");

        // 4) Parse → DB
        let parsedCount = 0;
        let failed = 0;
        let passed = 0;
        let skipped = 0;

        if (exec.resultsPath) {
          const cases = await parseResults(exec.resultsPath);

          // Interactive transaction so we can await inside the loop without PrismaPromise typing issues
          await prisma.$transaction(async (db) => {
            for (const c of cases) {
              const key = `${c.file}#${c.fullName}`.slice(0, 255);

              // upsert the TestCase (requires @@unique([projectId, key]) in schema)
              const testCase = await db.testCase.upsert({
                where: { projectId_key: { projectId: pid, key } },
                update: { title: c.fullName },
                create: { projectId: pid, key, title: c.fullName },
              });

              // create the TestResult referencing the case
              await db.testResult.create({
                data: {
                  run: { connect: { id: run.id } },
                  testCase: { connect: { id: testCase.id } }, // <- relation name is `testCase`
                  status: mapStatus(c.status),
                  durationMs: c.durationMs ?? null,
                  message: c.message ?? null,
                },
              });

              // accounting
              parsedCount++;
              if (c.status === "passed") passed++;
              else if (c.status === "failed" || c.status === "error") failed++;
              else skipped++;
            }
          });
        }

        // 5) Mark run finished
        const ok = failed === 0 && exec.ok;
        await prisma.testRun.update({
          where: { id: run.id },
          data: {
            status: ok ? TestRunStatus.succeeded : TestRunStatus.failed,
            finishedAt: new Date(),
            summary: JSON.stringify({
              framework,
              parsedCount,
              passed,
              failed,
              skipped,
            }),
            error: ok ? null : (exec.stderr || "Test command failed"),
          },
        });
      } catch (err: any) {
        await prisma.testRun.update({
          where: { id: run.id },
          data: {
            status: TestRunStatus.failed,
            finishedAt: new Date(),
            error: err?.message ?? String(err),
          },
        });
      } finally {
        await rmrf(work).catch(() => { });
      }
    })().catch((err) => {
      // last safety net
      prisma.testRun
        .update({
          where: { id: run.id },
          data: {
            status: TestRunStatus.failed,
            finishedAt: new Date(),
            error: err?.message || "Unexpected error in background runner",
          },
        })
        .catch(() => { });
    });

    return reply.code(201).send({ id: run.id });
  });

  // GET /runner/test-runs
  app.get("/test-runs", async (req, reply) => {
    const { projectId } = (req.query ?? {}) as { projectId?: string };
    const runs = await prisma.testRun.findMany({
      where: projectId ? { projectId } : undefined,
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        projectId: true,
        status: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        summary: true,
        error: true,
      },
    });
    return reply.send(runs);
  });

  // GET /runner/test-runs/:id
  app.get("/test-runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await prisma.testRun.findUnique({
      where: { id },
      include: { project: { select: { id: true, name: true } } },
    });
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return reply.send({ run }); // UI expects { run }
  });

  // GET /runner/test-runs/:id/logs?type=stdout|stderr
  app.get("/test-runs/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { type } = (req.query ?? {}) as { type?: "stdout" | "stderr" };
    const run = await prisma.testRun.findUnique({ where: { id } });
    if (!run) return reply.code(404).send({ error: "Run not found" });

    const t = type === "stderr" ? "stderr" : "stdout";
    const logPath = path.join(process.cwd(), "runner-logs", id, `${t}.txt`);
    try {
      const data = await fs.readFile(logPath, "utf8");
      reply.header("Content-Type", "text/plain; charset=utf-8");
      return reply.send(data);
    } catch {
      reply.header("Content-Type", "text/plain; charset=utf-8");
      return reply.send("");
    }
  });

  // GET /runner/test-runs/:id/results
  app.get("/test-runs/:id/results", async (req, reply) => {
    const { id } = req.params as { id: string };
    const exists = await prisma.testRun.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) return reply.code(404).send({ error: "Run not found" });

    const results = await prisma.testResult.findMany({
      where: { runId: id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        status: true,
        durationMs: true,
        message: true,
        testCase: { select: { id: true, title: true, key: true } }, // <- relation is `testCase`
      },
    });
    return reply.send({ results });


    return reply.send({ results });
  });
}
