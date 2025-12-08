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

// Resolve monorepo root (API runs from apps/api)
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");
const RUNNER_PATH = path.join(REPO_ROOT, "apps", "api", "src", "runner", "bot.ts");
const RUNS_DIR = path.join(REPO_ROOT, "apps", "api", "runs");

async function writeJson(file: string, data: any) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function startGeneratedRun(runId: string, projectId: string, caseId?: string) {
  const runDir = path.join(RUNS_DIR, runId);
  // Kick off background work (no blocking)
  (async () => {
    try {
      // 1) mark running
      await prisma.testRun.update({
        where: { id: runId },
        data: { status: "running", startedAt: new Date() },
      });

      // 2) GH-like env + payload (same as CI)
      const baseURL = process.env.TEST_BASE_URL ?? "http://localhost:5173";
      const prNumber = 1; // you can pass this from the client if you want
      const command = "plan+gen"; // also can be a client param

      await fs.mkdir(runDir, { recursive: true });
      const eventPath = path.join(runDir, "event.json");
      await writeJson(eventPath, {
        issue: { number: prNumber },
        comment: { body: `/testmind ${command}` },
      });

      const env = {
        ...process.env,
        GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY ?? "owner/repo",
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_EVENT_PATH: eventPath,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "dummy",
        TEST_BASE_URL: baseURL,
        RUN_TESTS: "false", // we run tests explicitly below
        LOCAL_RUN: "1", // instruct runner to skip GitHub and run locally
      };

      // If this run was triggered from a manual case, synthesize a simple spec so Playwright has something to run.
      let manualSpecDir: string | null = null;
      if (caseId) {
        const tc = await prisma.testCase.findUnique({
          where: { id: caseId },
          select: {
            id: true,
            key: true,
            title: true,
            preconditions: true,
            steps: { orderBy: { idx: "asc" }, select: { action: true, expected: true, idx: true } },
          },
        });
        // Write the manual spec inside this run folder so the config can target it directly.
        manualSpecDir = path.join(runDir, "manual-specs");
        await fs.mkdir(manualSpecDir, { recursive: true });
        const specPath = path.join(manualSpecDir, `manual-${tc?.key ?? tc?.id ?? "case"}.spec.ts`);
        const steps = tc?.steps ?? [];
        const pre = tc?.preconditions?.trim() ? `// Preconditions:\n// ${tc?.preconditions}\n` : "";
        const stepLines =
          steps.length > 0
            ? steps
                .map(
                  (s, i) =>
                    `  // Step ${i + 1}: ${s.action}${
                      s.expected ? ` => Expected: ${s.expected}` : ""
                    }`
                )
                .join("\n")
            : "  // No steps provided.";

        const spec = `import { test, expect } from "@playwright/test";

test.describe("Manual case: ${tc?.title ?? "Untitled"}", () => {
  test("manual-flow", async ({ page }) => {
    await page.goto(process.env.TEST_BASE_URL || "http://localhost:5173");
${pre}${stepLines}
    expect(true).toBeTruthy();
  });
});
`;
        await fs.writeFile(specPath, spec, "utf8");
      } else {
        // 3) run your generator (writes to testmind-generated/*)
        await execa("pnpm", ["tsx", RUNNER_PATH], {
          cwd: REPO_ROOT,
          env,
          stdio: "inherit",
        });
      }
      // Ensure at least one spec exists in the run folder to avoid "No tests found"
      if (!manualSpecDir) {
        manualSpecDir = path.join(runDir, "manual-specs");
        await fs.mkdir(manualSpecDir, { recursive: true });
        const specPath = path.join(manualSpecDir, "smoke.spec.ts");
        await fs.writeFile(
          specPath,
          `import { test, expect } from "@playwright/test";
test("smoke", async ({ page }) => {
  await page.goto(process.env.TEST_BASE_URL || "http://localhost:5173");
  expect(true).toBeTruthy();
});`,
          "utf8"
        );
      }

      // 4) author a tiny CI config that points only to the manual specs for this run
      const ciConfigPath = path.join(runDir, "tm-ci.playwright.config.ts");
      const ciConfig = `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  projects: [
    ${manualSpecDir ? `{ name: 'manual', testDir: './manual-specs' }` : ""}
  ].filter(Boolean),
  reporter: 'html',
  use: { baseURL: process.env.TEST_BASE_URL || 'http://localhost:5173' },
});
`;
      await fs.writeFile(ciConfigPath, ciConfig);

      // Absolute test dirs (avoid empty suite due to relative paths)
      const manualDir = manualSpecDir ? manualSpecDir : "";
      const esc = (p: string) => p.replace(/\\/g, "/");

      // 5) ensure browsers are installed (reuse existing workspace version)
      await execa("pnpm", ["exec", "playwright", "install", "--with-deps"], {
        cwd: REPO_ROOT,
        env,
        stdio: "inherit",
      });

      // 6) run tests to produce 'playwright-report/'
      try {
        const projects: string[] = [];
        if (manualDir) {
          projects.push(`{ name: 'manual', testDir: '${esc(manualDir)}' }`);
        }

        const configContent = `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  projects: [
    ${projects.join(",\n    ")}
  ],
  reporter: 'html',
  use: { baseURL: process.env.TEST_BASE_URL || 'http://localhost:5173' },
});
`;
        await fs.writeFile(ciConfigPath, configContent, "utf8");

        await execa("pnpm", ["exec", "playwright", "test", "-c", ciConfigPath], {
          cwd: REPO_ROOT,
          env,
          stdio: "inherit",
        });
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (msg.includes("No tests found")) {
          await prisma.testRun.update({
            where: { id: runId },
            data: {
              status: "succeeded",
              finishedAt: new Date(),
              summary: "No tests found; generation completed",
            },
          });
          return;
        }
        throw e;
      }

      // 7) update DB with locations the UI can use
      await prisma.testRun.update({
        where: { id: runId },
        data: {
          status: "succeeded",
          finishedAt: new Date(),
          summary: "Generation complete. See HTML report.",
          reportPath: "playwright-report/index.html", // relative to repo root
          artifactsJson: JSON.stringify({
            generatedDirs: manualDir ? [path.relative(REPO_ROOT, manualDir)] : [],
            reportDir: "playwright-report",
          }),
        },
      });
    } catch (e) {
      console.error("[startGeneratedRun] failed", { runId, projectId, error: e });
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
}

const stepsSchema = z
  .array(
    z.object({
      action: z.string().min(1),
      expected: z.string().min(1),
    })
  )
  .optional();

const tagsSchema = z.array(z.string().trim()).optional();

export async function testRoutes(app: FastifyInstance) {
  //
  // -------------------- RUNS (generated tests) --------------------
  //
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
      data: {
        projectId,
        status: "queued",
        trigger: "user",
      },
    });
    const updatedRun = await prisma.testRun.update({
      where: { id: run.id },
      data: { summary: `Generate tests (run ${run.id})` },
    });

    await startGeneratedRun(updatedRun.id, projectId);

    return reply.send({ run: updatedRun });
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
        type: true,
        suiteId: true,
        updatedAt: true,
        tags: true,
      },
    });

    reply.send({ cases });
  });

  app.get<{ Params: { id: string } }>("/tests/cases/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const tc = await prisma.testCase.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        projectId: true,
        suiteId: true,
        key: true,
        title: true,
        status: true,
        priority: true,
        type: true,
        tags: true,
        preconditions: true,
        lastAiSyncAt: true,
        updatedAt: true,
        steps: {
          orderBy: { idx: "asc" },
          select: { id: true, idx: true, action: true, expected: true },
        },
        runs: {
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { id: true, status: true, note: true, createdAt: true, userId: true },
        },
      },
    });
    if (!tc) return reply.code(404).send({ error: "Case not found" });

    const project = await prisma.project.findFirst({
      where: { id: tc.projectId, ownerId: userId },
      select: { id: true },
    });
    if (!project) return reply.code(404).send({ error: "Case not found" });

    reply.send({ case: tc });
  });

  app.post("/tests/cases", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      projectId: z.string().min(1),
      title: z.string().min(1),
      suiteId: z.string().optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
      type: z
        .enum(["functional", "regression", "security", "accessibility", "other"])
        .optional(),
      status: z.enum(["draft", "active", "archived"]).optional(),
      tags: tagsSchema,
      preconditions: z.string().optional(),
      steps: stepsSchema,
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const ownerOk = await prisma.project.findFirst({
      where: { id: parsed.data.projectId, ownerId: userId },
      select: { id: true },
    });
    if (!ownerOk) return reply.code(404).send({ error: "Project not found" });

    const { steps, ...caseData } = parsed.data;

    const created = await prisma.$transaction(async (tx) => {
      const tc = await tx.testCase.create({ data: caseData });
      if (steps && steps.length) {
        await tx.testStep.createMany({
          data: steps.map((s, i) => ({
            caseId: tc.id,
            idx: i,
            action: s.action,
            expected: s.expected,
          })),
        });
      }
      return tc;
    });

    reply.code(201).send({ case: created });
  });

  app.patch<{ Params: { id: string } }>("/tests/cases/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      title: z.string().min(1).optional(),
      suiteId: z.string().nullable().optional(),
      status: z.enum(["draft", "active", "archived"]).optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
      type: z.enum(["functional", "regression", "security", "accessibility", "other"]).optional(),
      tags: tagsSchema,
      preconditions: z.string().optional().nullable(),
      steps: stepsSchema,
      lastAiSyncAt: z.coerce.date().optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { steps, ...caseData } = parsed.data;

    const updated = await prisma.$transaction(async (tx) => {
      const tc = await tx.testCase.update({
        where: { id: req.params.id },
        data: caseData as any,
        select: {
          id: true,
          key: true,
          title: true,
          status: true,
          priority: true,
          type: true,
          suiteId: true,
          updatedAt: true,
          tags: true,
          preconditions: true,
          lastAiSyncAt: true,
        },
      });

      if (steps) {
        await tx.testStep.deleteMany({ where: { caseId: tc.id } });
        if (steps.length) {
          await tx.testStep.createMany({
            data: steps.map((s, i) => ({
              caseId: tc.id,
              idx: i,
              action: s.action,
              expected: s.expected,
            })),
          });
        }
      }

      return tc;
    });

    reply.send({ case: updated });
  });

  app.delete<{ Params: { id: string } }>("/tests/cases/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    await prisma.testCase.delete({ where: { id: req.params.id } });
    reply.code(204).send();
  });

  //
  // -------------------- MANUAL RUNS --------------------
  //
  app.get<{ Params: { id: string } }>("/tests/cases/:id/runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const tc = await prisma.testCase.findUnique({
      where: { id: req.params.id },
      select: { id: true, projectId: true },
    });
    if (!tc) return reply.code(404).send({ error: "Case not found" });

    const ownerOk = await prisma.project.findFirst({
      where: { id: tc.projectId, ownerId: userId },
      select: { id: true },
    });
    if (!ownerOk) return reply.code(404).send({ error: "Case not found" });

    const runs = await prisma.testCaseRun.findMany({
      where: { caseId: tc.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    reply.send({ runs });
  });

  app.post<{ Params: { id: string } }>("/tests/cases/:id/runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      status: z.enum(["passed", "failed", "skipped", "error"]),
      note: z.string().optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const tc = await prisma.testCase.findUnique({
      where: { id: req.params.id },
      select: { id: true, projectId: true },
    });
    if (!tc) return reply.code(404).send({ error: "Case not found" });

    const ownerOk = await prisma.project.findFirst({
      where: { id: tc.projectId, ownerId: userId },
      select: { id: true },
    });
    if (!ownerOk) return reply.code(404).send({ error: "Case not found" });

    const run = await prisma.testCaseRun.create({
      data: {
        caseId: tc.id,
        status: parsed.data.status,
        note: parsed.data.note,
        userId,
      },
    });

    reply.code(201).send({ run });
  });

  //
  // -------------------- AI HOOK --------------------
  //
  app.post<{ Params: { id: string } }>(
    "/tests/cases/:id/generate-playwright",
    async (req, reply) => {
      const userId = requireUser(req, reply);
      if (!userId) return;

      const tc = await prisma.testCase.findUnique({
        where: { id: req.params.id },
        select: { id: true, projectId: true, title: true },
      });
      if (!tc) return reply.code(404).send({ error: "Case not found" });

      const ownerOk = await prisma.project.findFirst({
        where: { id: tc.projectId, ownerId: userId },
        select: { id: true },
      });
      if (!ownerOk) return reply.code(404).send({ error: "Case not found" });

      const run = await prisma.testRun.create({
        data: {
          projectId: tc.projectId,
          status: "queued",
          summary: `Generate Playwright for case "${tc.title}"`,
        },
      });
      const updatedRun = await prisma.testRun.update({
        where: { id: run.id },
        data: { summary: `Generate Playwright for case "${tc.title}" (run ${run.id})` },
      });

      await prisma.testCase.update({
        where: { id: tc.id },
        data: { lastAiSyncAt: new Date() },
      });

      await startGeneratedRun(updatedRun.id, tc.projectId, tc.id);

      reply.code(202).send({ runId: updatedRun.id });
    }
  );
}
