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

// ★ allow client to specify monorepo subdir (optional)
const RunBody = z.object({
  projectId: z.string().min(1, "projectId is required"),
  appSubdir: z.string().optional(), // e.g. "apps/justicepath"
});

function mapStatus(s: string): TestResultStatus {
  if (s === "passed") return TestResultStatus.passed;
  if (s === "failed" || s === "error") return TestResultStatus.failed;
  if (s === "skipped") return TestResultStatus.skipped;
  return TestResultStatus.error;
}

// ★ tiny helper to auto-detect a Playwright workspace in a repo
async function autoDetectAppSubdir(repoRoot: string): Promise<string | null> {
  const candidates: string[] = [];

  // common monorepo roots
  for (const dir of ["apps", "packages"]) {
    try {
      const items = await fs.readdir(path.join(repoRoot, dir), { withFileTypes: true });
      for (const d of items) if (d.isDirectory()) candidates.push(path.join(dir, d.name));
    } catch {}
  }

  // include root as a candidate
  candidates.unshift(".");

  // choose the first location that looks like a PW project
  for (const sub of candidates) {
    const base = path.join(repoRoot, sub);
    const hasPkg = await fs.stat(path.join(base, "package.json")).then(()=>true).catch(()=>false);
    if (!hasPkg) continue;

    const hasCfg =
      await fs.stat(path.join(base, "playwright.config.ts")).then(()=>true).catch(()=>false) ||
      await fs.stat(path.join(base, "playwright.config.js")).then(()=>true).catch(()=>false) ||
      await fs.stat(path.join(base, "playwright.config.mjs")).then(()=>true).catch(()=>false) ||
      await fs.stat(path.join(base, "playwright.config.cjs")).then(()=>true).catch(()=>false);

    if (hasCfg) return sub;

    // fallback: check dep in package.json
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(base, "package.json"), "utf8"));
      const deps = { ...(pkg.dependencies||{}), ...(pkg.devDependencies||{}) };
      if (deps["@playwright/test"]) return sub;
    } catch {}
  }

  return null;
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
      const repoRoot = await makeWorkdir(); // where we clone the repo
      try {
        // GitHub token if connected
        const gitAcct = await prisma.gitAccount.findFirst({
          where: { userId: project.ownerId, provider: "github" },
          select: { token: true },
        });

        // 1) Clone (into repoRoot)
        await cloneRepo(project.repoUrl, repoRoot, gitAcct?.token || undefined);

        // ★ 2) choose correct workspace
        // priority: request body -> project.appSubdir (if you add one later) -> auto-detect -> "."
        const requested = parsed.data.appSubdir?.trim();
        const detected = await autoDetectAppSubdir(repoRoot);
        const appSubdir = requested || detected || ".";
        const work = path.resolve(repoRoot, appSubdir);

        // helpful debug breadcrumbs in logs
        await fs.writeFile(path.join(outDir, "stdout.txt"), `[runner] repoRoot=${repoRoot}\n[runner] work=${work}\n`, { flag: "a" });

        // 3) Install deps in that workspace
        await installDeps(work);

        // 4) Detect + run
        const framework = await detectFramework(work);
        const exec = await runTests(framework, work);

        // Save raw logs (always)
        await fs.writeFile(path.join(outDir, "stdout.txt"), exec.stdout ?? "", { flag: "a" });
        await fs.writeFile(path.join(outDir, "stderr.txt"), exec.stderr ?? "");

        // Write a legacy report.json so the "View tests" page can read it
if (exec.resultsPath) {
  const reportPath = path.join(outDir, "report.json");
  try {
    await fs.copyFile(exec.resultsPath, reportPath);
  } catch (e) {
    // log but don't fail the run
    await fs.writeFile(
      path.join(outDir, "stderr.txt"),
      `\n[runner] failed to copy report.json: ${String(e)}\n`,
      { flag: "a" }
    );
  }
}


        // 5) Parse → DB
        let parsedCount = 0;
        let failed = 0;
        let passed = 0;
        let skipped = 0;

        if (exec.resultsPath) {
          const cases = await parseResults(exec.resultsPath);

          await prisma.$transaction(async (db) => {
            for (const c of cases) {
              const key = `${c.file}#${c.fullName}`.slice(0, 255);

              const testCase = await db.testCase.upsert({
                where: { projectId_key: { projectId: pid, key } },
                update: { title: c.fullName },
                create: { projectId: pid, key, title: c.fullName },
              });

              await db.testResult.create({
                data: {
                  run: { connect: { id: run.id } },
                  testCase: { connect: { id: testCase.id } },
                  status: mapStatus(c.status),
                  durationMs: c.durationMs ?? null,
                  message: c.message ?? null,
                },
              });

              parsedCount++;
              if (c.status === "passed") passed++;
              else if (c.status === "failed" || c.status === "error") failed++;
              else skipped++;
            }
          });
        }

        // 6) Mark run finished
        const ok = failed === 0 && exec.ok;
        await prisma.testRun.update({
          where: { id: run.id },
          data: {
            status: ok ? TestRunStatus.succeeded : TestRunStatus.failed,
            finishedAt: new Date(),
            summary: JSON.stringify({
              framework,
              appSubdir,  // ★ add to summary for visibility
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
        await rmrf(repoRoot).catch(() => {});
      }
    })().catch((err) => {
      prisma.testRun
        .update({
          where: { id: run.id },
          data: {
            status: TestRunStatus.failed,
            finishedAt: new Date(),
            error: err?.message || "Unexpected error in background runner",
          },
        })
        .catch(() => {});
    });

    return reply.code(201).send({ id: run.id });
  });

  // … the rest of the handlers unchanged …
}
