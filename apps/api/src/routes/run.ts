// apps/api/src/routes/run.ts
import type { FastifyInstance } from "fastify";
import { execa } from "execa";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { prisma } from "../prisma";
import { TestRunStatus, TestResultStatus } from "@prisma/client";

// ---------- shared error helper ----------
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

export default async function runRoutes(app: FastifyInstance) {
  // POST /runner/run
  app.post("/run", async (req, reply) => {
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, "INVALID_INPUT", "Invalid request body", 400, parsed.error.flatten());
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

    // launch the runner process in background
    (async () => {
      let exitCode = 1;
      let combined = "";

      try {
        const proc = execa("node", ["-v"], {
          cwd: process.cwd(),
          env: process.env,
          all: true,
        });

        proc.all?.on("data", (b: Buffer) => {
          combined += b.toString();
        });

        const result = await proc;
        exitCode = result.exitCode ?? 0;

        await fs.writeFile(path.join(outDir, "stdout.txt"), result.stdout ?? "");
        await fs.writeFile(path.join(outDir, "stderr.txt"), result.stderr ?? "");
      } catch (err: any) {
        combined += `\n[runner error]\n${err?.stack || err}`;
      } finally {
        // ✅ ALWAYS update the run when process finishes or throws
        await prisma.testRun.update({
          where: { id: run.id },
          data: {
            status: exitCode === 0 ? TestRunStatus.succeeded : TestRunStatus.failed,
            finishedAt: new Date(),
            summary: JSON.stringify({
              ok: exitCode === 0,
              outputLength: combined.length,
            }),
            error: exitCode === 0 ? null : combined.slice(0, 500),
          },
        });

        // optional: seed example test cases and results (best-effort)
        try {
          let cases = await prisma.testCase.findMany({ where: { projectId: pid }, take: 6 });
          if (cases.length === 0) {
            const created = await prisma.$transaction([
              prisma.testCase.create({ data: { projectId: pid, title: "Login works" } }),
              prisma.testCase.create({ data: { projectId: pid, title: "Checkout totals correct" } }),
              prisma.testCase.create({ data: { projectId: pid, title: "Profile update persists" } }),
              prisma.testCase.create({ data: { projectId: pid, title: "Forgot password flow" } }),
              prisma.testCase.create({ data: { projectId: pid, title: "Search returns results" } }),
            ]);
            cases = created;
          }

          await prisma.testResult.createMany({
            data: cases.map((c, i) => ({
              runId: run.id,
              testCaseId: c.id,
              status: i === 0 ? TestResultStatus.failed : TestResultStatus.passed,
              durationMs: 300 + i * 80,
              message: i === 0 ? "Expected 200, got 500 from /api/login" : null,
            })),
          });
        } catch {
          /* no-op */
        }
      }
    })().catch((err) => {
      // last safety net: ensure run is marked failed if async block crashes
      prisma.testRun.update({
        where: { id: run.id },
        data: {
          status: TestRunStatus.failed,
          finishedAt: new Date(),
          error: err?.message || "Unexpected error in background runner",
        },
      }).catch(() => {});
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
    const r = await prisma.testRun.findUnique({
      where: { id },
      select: { projectId: true, project: { select: { ownerId: true } } },
    });
    if (!r) return reply.code(404).send({ error: "Run not found" });

    const results = await prisma.testResult.findMany({
      where: { runId: id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        status: true,
        durationMs: true,
        message: true,
        testCase: { select: { id: true, title: true, key: true } },
      },
    });
    return reply.send({ results });
  });
}
