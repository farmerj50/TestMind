// apps/api/src/routes/run.ts
import type { FastifyInstance } from "fastify";
import { TestRunStatus } from "@prisma/client";
import { execa } from "execa";
import { prisma } from "../prisma";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";

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

// request schema
const RunBody = z.object({
  projectId: z.string().min(1, "projectId is required"),
});

export default async function runRoutes(app: FastifyInstance) {
  // POST /runner/run
  app.post("/run", async (req, reply) => {
    // validate body
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      return sendError(reply, "INVALID_INPUT", "Invalid request body", 400, flat);
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

    // create run
    const run = await prisma.testRun.create({
      data: { projectId: pid, status: TestRunStatus.running, startedAt: new Date() },
    });

    // make per-run folder & run worker
    const outDir = path.join(process.cwd(), "runner-logs", run.id);
    await fs.mkdir(outDir, { recursive: true });

    (async () => {
      try {
        const { stdout, stderr, exitCode } = await execa("node", ["-v"]);
        await fs.writeFile(path.join(outDir, "stdout.txt"), stdout ?? "");
        await fs.writeFile(path.join(outDir, "stderr.txt"), stderr ?? "");

        await prisma.testRun.update({
          where: { id: run.id },
          data: {
            status: exitCode === 0 ? TestRunStatus.succeeded : TestRunStatus.failed,
            finishedAt: new Date(),
            summary: JSON.stringify({
              ok: exitCode === 0,
              stdoutBytes: (stdout ?? "").length,
              stderrBytes: (stderr ?? "").length,
            }),
            error: exitCode === 0 ? null : (stderr || "Process exited with non-zero code"),
          },
        });
      } catch (err: any) {
        // worker errors are persisted on the run; no reply here
        await prisma.testRun.update({
          where: { id: run.id },
          data: {
            status: TestRunStatus.failed,
            finishedAt: new Date(),
            error: err?.message ?? String(err),
          },
        });
      }
    })().catch(() => { /* no-op */ });

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
    const run = await prisma.testRun.findUnique({ where: { id } });
    if (!run) {
      return sendError(reply, "RUN_NOT_FOUND", `Run ${id} was not found`, 404);
    }
    return reply.send(run);
  });
}
