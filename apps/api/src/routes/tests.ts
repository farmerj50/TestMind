// apps/api/src/routes/tests.ts
import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";


type IdParams = { id: string };

function requireUser(req: any, reply: any) {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}
// Resolve project root (adjust if your API is not at repo root)
const REPO_ROOT = path.resolve(process.cwd());
const RUNS_DIR   = path.join(REPO_ROOT, "apps", "api", "runs");

async function writeJson(file: string, data: any) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}


export async function testRoutes(app: FastifyInstance) {
  //
  // -------------------- RUNS (keep your endpoints) --------------------
  //

  // Create a run (stub) and simulate work for a project
 app.post<{ Params: IdParams }>("/projects/:id/test-runs", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const projectId = req.params.id;

  // ensure the project belongs to the signed-in user
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true },
  });
  if (!project) return reply.code(404).send({ error: "Project not found" });

  // create a run record
  const run = await prisma.testRun.create({
    data: { projectId, status: "queued", trigger: "user" },
  });

  // Kick off background work (no blocking)
  (async () => {
    const runId = run.id;
    const runDir = path.join(RUNS_DIR, runId);
    try {
      // 1) mark running
      await prisma.testRun.update({
        where: { id: runId },
        data: { status: "running", startedAt: new Date() },
      });

      // 2) GH-like env + payload (same as CI)
      const baseURL  = process.env.TEST_BASE_URL ?? "http://localhost:5173";
      const prNumber = 1;               // you can pass this from the client if you want
      const command  = "plan+gen";      // also can be a client param

      await fs.mkdir(runDir, { recursive: true });
      const eventPath = path.join(runDir, "event.json");
      await writeJson(eventPath, { issue: { number: prNumber }, comment: { body: `/testmind ${command}` } });

      const env = {
        ...process.env,
        GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY ?? "owner/repo",
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_EVENT_PATH: eventPath,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "dummy",
        TEST_BASE_URL: baseURL,
        RUN_TESTS: "false", // we run tests explicitly below
      };

      // 3) run your generator (writes to testmind-generated/*)
      await execa("pnpm", ["tsx", "apps/api/src/runner/bot.ts"], {
        cwd: REPO_ROOT,
        env,
        stdio: "inherit",
      });

      // 4) author a tiny CI config that points to the generated folders
      const ciConfigPath = path.join(runDir, "tm-ci.playwright.config.ts");
      const ciConfig = `
        import { defineConfig } from '@playwright/test';
        export default defineConfig({
          testDir: '.',
          projects: [
            { name: 'gen-root', testDir: './testmind-generated' },
            { name: 'gen-api',  testDir: './apps/api/testmind-generated/playwright-ts' },
          ],
          reporter: 'html',
          use: { baseURL: process.env.TEST_BASE_URL || 'http://localhost:5173' },
        });
      `;
      await fs.writeFile(ciConfigPath, ciConfig);

      // 5) ensure local runner exists (same version as repo core)
      // If already installed in devDeps, this is a no-op
      await execa("pnpm", ["add", "-Dw", "@playwright/test@1.56.0"], {
        cwd: REPO_ROOT,
        env,
        stdio: "ignore",
      });
      await execa("pnpm", ["exec", "playwright", "install", "--with-deps"], {
        cwd: REPO_ROOT,
        env,
        stdio: "inherit",
      });

      // 6) run tests to produce 'playwright-report/'
      await execa("pnpm", ["exec", "playwright", "test", "-c", ciConfigPath], {
        cwd: REPO_ROOT,
        env,
        stdio: "inherit",
      });

      // 7) update DB with locations the UI can use
      await prisma.testRun.update({
        where: { id: runId },
        data: {
          status: "succeeded",
          finishedAt: new Date(),
          summary: "Generation complete. See HTML report.",
          reportPath: "playwright-report/index.html", // relative to repo root
          artifactsJson: JSON.stringify({
            generatedDirs: [
              "testmind-generated",
              "apps/api/testmind-generated/playwright-ts",
            ],
            reportDir: "playwright-report",
          }),
        },
      });
    } catch (e) {
      await prisma.testRun.update({
        where: { id: runId },
        data: {
          status: "failed",
          finishedAt: new Date(),
          error: String(e),
        },
      });
    }
  })();

  return reply.send({ run });
});


  // List runs for a project
  app.get<{ Params: IdParams }>("/projects/:id/test-runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

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

  // NOTE:
  // The single-run endpoint is served by run.ts at GET /runner/test-runs/:id
  // so we intentionally do NOT define GET /test-runs/:runId here to avoid duplication.

  //
  // -------------------- TEST SUITES --------------------
  //
  app.get("/tests/suites", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const { projectId } = (req.query ?? {}) as { projectId?: string };
    if (!projectId) return reply.code(400).send({ error: "projectId required" });

    // Ensure project ownership
    const ownerOk = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true },
    });
    if (!ownerOk) return reply.code(404).send({ error: "Project not found" });

    const suites = await prisma.testSuite.findMany({
      where: { projectId },
      orderBy: [{ parentId: "asc" }, { order: "asc" }, { name: "asc" }],
      select: { id: true, name: true, parentId: true, order: true },
    });

    reply.send({ suites });
  });

  app.post("/tests/suites", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      projectId: z.string().min(1),
      name: z.string().min(1),
      parentId: z.string().optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    // Ownership check
    const ownerOk = await prisma.project.findFirst({
      where: { id: parsed.data.projectId, ownerId: userId },
      select: { id: true },
    });
    if (!ownerOk) return reply.code(404).send({ error: "Project not found" });

    const suite = await prisma.testSuite.create({ data: parsed.data });
    reply.code(201).send({ suite });
  });

  app.patch<{ Params: { id: string } }>("/tests/suites/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      name: z.string().min(1).optional(),
      parentId: z.string().nullable().optional(),
      order: z.number().int().optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const suite = await prisma.testSuite.update({
      where: { id: req.params.id },
      data: parsed.data as any,
      select: { id: true, name: true, parentId: true, order: true },
    });
    reply.send({ suite });
  });

  app.delete<{ Params: { id: string } }>("/tests/suites/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    await prisma.testSuite.delete({ where: { id: req.params.id } });
    reply.code(204).send();
  });

  //
  // -------------------- TEST CASES --------------------
  //
  app.get("/tests/cases", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const { projectId, suiteId, q } = (req.query ?? {}) as {
      projectId?: string;
      suiteId?: string;
      q?: string;
    };
    if (!projectId) return reply.code(400).send({ error: "projectId required" });

    const ownerOk = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true },
    });
    if (!ownerOk) return reply.code(404).send({ error: "Project not found" });

    const cases = await prisma.testCase.findMany({
      where: {
        projectId,
        suiteId: suiteId || undefined,
        title: q ? { contains: q, mode: "insensitive" } : undefined,
      },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        id: true,
        key: true,
        title: true,
        status: true,
        priority: true,
        suiteId: true,
        updatedAt: true,
      },
    });

    reply.send({ cases });
  });

  app.post("/tests/cases", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      projectId: z.string().min(1),
      title: z.string().min(1),
      suiteId: z.string().optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const ownerOk = await prisma.project.findFirst({
      where: { id: parsed.data.projectId, ownerId: userId },
      select: { id: true },
    });
    if (!ownerOk) return reply.code(404).send({ error: "Project not found" });

    const tc = await prisma.testCase.create({ data: parsed.data });
    reply.code(201).send({ case: tc });
  });

  app.patch<{ Params: { id: string } }>("/tests/cases/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      title: z.string().min(1).optional(),
      suiteId: z.string().nullable().optional(),
      status: z.enum(["draft", "active", "archived"]).optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const tc = await prisma.testCase.update({
      where: { id: req.params.id },
      data: parsed.data as any,
      select: {
        id: true,
        key: true,
        title: true,
        status: true,
        priority: true,
        suiteId: true,
        updatedAt: true,
      },
    });
    reply.send({ case: tc });
  });

  app.delete<{ Params: { id: string } }>("/tests/cases/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    await prisma.testCase.delete({ where: { id: req.params.id } });
    reply.code(204).send();
  });
}
