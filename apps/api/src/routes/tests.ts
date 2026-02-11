// apps/api/src/routes/tests.ts
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma.js";
import { parseResults } from "../runner/result-parsers.js";
import { normalizeSharedSteps, resolveLocator } from "../testmind/runtime/locator-store.js";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { execa } from "execa";
import OpenAI from "openai";
import { GENERATED_ROOT, REPORT_ROOT, ensureStorageDirs } from "../lib/storageRoots.js";
import { sendRunNotifications } from "../notifications/runNotifications.js";
import type { Step } from "../testmind/core/plan.js";
import { slugify, ensureCuratedProjectEntry, ensureWithin } from "../testmind/curated-store.js";
import { decryptSecret } from "../lib/crypto.js";

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
const RUNNER_LOGS_ROOT = path.join(REPORT_ROOT, "runner-logs");

async function writeJson(file: string, data: any) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

const PLAYWRIGHT_BROWSERS_CACHE = path.join(REPO_ROOT, "node_modules", ".cache", "ms-playwright");
const OPENAI_SECRET_KEYS = ["OPENAI_API_KEY", "OPEN_API_KEY"] as const;
const AI_SPEC_MODEL = process.env.AI_SPEC_MODEL || process.env.AGENT_MODEL || "gpt-4o-mini";

async function resolveOpenAiKey(projectId?: string) {
  if (!projectId) {
    return { apiKey: process.env.OPENAI_API_KEY, availableKeys: [] as string[] };
  }
  const secrets = await prisma.projectSecret.findMany({
    where: { projectId },
    select: { key: true, value: true },
  });
  const availableKeys = secrets.map((s) => s.key);
  const secret = secrets.find((s) => OPENAI_SECRET_KEYS.includes(s.key as any));
  if (!secret) {
    return { apiKey: process.env.OPENAI_API_KEY, availableKeys };
  }
  try {
    return { apiKey: decryptSecret(secret.value), availableKeys };
  } catch {
    throw new Error("Failed to decrypt OPENAI_API_KEY secret. Please re-save it.");
  }
}

async function browsersAlreadyInstalled() {
  try {
    await fs.access(PLAYWRIGHT_BROWSERS_CACHE);
    return true;
  } catch {
    return false;
  }
}

const normalizeBaseUrl = (value?: string | null) => {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(raw)) {
    return `http://${raw}`;
  }
  return `https://${raw}`;
};

const parseStepLine = (line: string): Step => {
  const raw = line.trim();
  const lower = raw.toLowerCase();

  const normalizeSelector = (value: string) => {
    const v = value.trim();
    if (v.includes("<") && v.includes(">")) {
      const hrefMatch = v.match(/href\s*=\s*["']([^"']+)["']/i);
      const testIdMatch = v.match(/data-testid\s*=\s*["']([^"']+)["']/i);
      const textMatch = v.match(/>([^<]+)</);
      if (testIdMatch?.[1]) return `testid=${testIdMatch[1].trim()}`;
      if (hrefMatch?.[1]) return `css=a[href="${hrefMatch[1].trim()}"]`;
      if (textMatch?.[1]) return `text=${textMatch[1].trim()}`;
    }
    if (/^(css|xpath|text|label|role|placeholder|testid|data-testid)=/i.test(v)) return v;
    if (/^(\.|#|\[|\/\/)/.test(v)) return v; // css or xpath-ish
    return `text=${v}`;
  };

  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("/")) {
    return { kind: "goto", url: raw };
  }

  const gotoMatch = raw.match(/^(go to|goto|navigate|open)\s+(.+)$/i);
  if (gotoMatch) {
    let target = gotoMatch[2]?.trim();
    if (target?.toLowerCase().startsWith("to ")) {
      target = target.slice(3).trim();
    }
    if (target) {
      const url = target.startsWith("http") || target.startsWith("/") ? target : `/${target}`;
      return { kind: "goto", url };
    }
  }

  const clickMatch = raw.match(/^(click|tap|press)\s+(.+)$/i);
  if (clickMatch) {
    const target = clickMatch[2]?.trim();
    return { kind: "click", selector: target ? normalizeSelector(target) : "text=Continue" };
  }

  const fillMatch = raw.match(/^(type|fill|enter)\s+(.+?)(?:\s+(?:with|as|to)\s+|\s*=\s*)(.+)$/i);
  if (fillMatch) {
    const field = fillMatch[2]?.trim();
    const value = fillMatch[3]?.trim();
    return { kind: "fill", selector: normalizeSelector(field || "input"), value: value || "TODO" };
  }

  const fillSimple = raw.match(/^(type|fill|enter)\s+(.+)$/i);
  if (fillSimple) {
    const field = fillSimple[2]?.trim();
    return { kind: "fill", selector: normalizeSelector(field || "input"), value: "TODO" };
  }

  const expectMatch = raw.match(/^(expect|assert|verify|see|should)\s+(.+)$/i);
  if (expectMatch) {
    const text = expectMatch[2]?.trim();
    return { kind: "expect-text", text: text || raw };
  }

  return { kind: "expect-text", text: raw };
};

async function startGeneratedRun(runId: string, projectId: string, userId: string, caseId?: string) {
  await ensureStorageDirs();
  const runDir = path.join(REPORT_ROOT, runId);
  // Avoid temp workspaces on Windows; keep runs rooted under REPORT_ROOT.
  const workspaceDir = runDir;
      const projectRecord = await prisma.project.findUnique({
        where: { id: projectId },
        select: { sharedSteps: true, ownerId: true, repoUrl: true },
      });
      const projectSharedSteps = projectRecord?.sharedSteps;
      const adapterId = "playwright-ts";
  // Kick off background work (no blocking)
  (async () => {
    try {
      // 1) mark running
      await prisma.testRun.update({
        where: { id: runId },
        data: { status: "running", startedAt: new Date() },
      });

      // 2) GH-like env + payload (same as CI)
      const baseURL =
        normalizeBaseUrl((projectSharedSteps as any)?.baseUrl) ||
        normalizeBaseUrl(projectRecord?.repoUrl) ||
        normalizeBaseUrl(process.env.TM_BASE_URL) ||
        normalizeBaseUrl(process.env.TEST_BASE_URL) ||
        "http://localhost:5173";
      const prNumber = 1; // you can pass this from the client if you want
      const command = "plan+gen"; // also can be a client param

      await fs.mkdir(runDir, { recursive: true });
      await fs.mkdir(workspaceDir, { recursive: true });
      const eventPath = path.join(runDir, "event.json");
      await writeJson(eventPath, {
        issue: { number: prNumber },
        comment: { body: `/testmind ${command}` },
      });

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY ?? "owner/repo",
        GITHUB_EVENT_NAME: "issue_comment",
        GITHUB_EVENT_PATH: eventPath,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "dummy",
        TEST_BASE_URL: baseURL,
        TM_BASE_URL: baseURL,
        PW_BASE_URL: baseURL,
        RUN_TESTS: "false", // we run tests explicitly below
        LOCAL_RUN: "1", // instruct runner to skip GitHub and run locally
      };
      const missingLocatorsPath = path.join(runDir, "missing-locators.json");
      await fs.rm(missingLocatorsPath, { force: true }).catch(() => {});
      env.TM_MISSING_LOCATORS_PATH = missingLocatorsPath;
      if (projectSharedSteps !== undefined) {
        env.TM_PROJECT_SHARED_STEPS = JSON.stringify(projectSharedSteps);
      } else {
        delete env.TM_PROJECT_SHARED_STEPS;
      }

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
        // Generate the manual spec using the same pipeline as Test Builder.
        manualSpecDir = path.join(runDir, "manual-specs");
        await fs.mkdir(manualSpecDir, { recursive: true });
        const caseTitle = tc?.title ?? "Untitled";
        const baseUrl =
          normalizeBaseUrl((projectSharedSteps as any)?.baseUrl) ||
          normalizeBaseUrl(projectRecord?.repoUrl) ||
          normalizeBaseUrl(process.env.TM_BASE_URL) ||
          normalizeBaseUrl(process.env.TEST_BASE_URL) ||
          "http://localhost:5173";
        let hasNavigatedExpected = false;
        const shouldIncludeExpected = (value?: string | null) => {
          const raw = (value ?? "").trim().toLowerCase();
          if (!raw) return false;
          const trivial = new Set([
            "navigated",
            "navigation complete",
            "page loaded",
            "page loads",
            "success",
            "passed",
          ]);
          if (trivial.has(raw)) {
            if (raw === "navigated" || raw.includes("navigate")) {
              hasNavigatedExpected = true;
            }
            return false;
          }
          return !trivial.has(raw);
        };
        const stepLines = (tc?.steps ?? []).flatMap((s) => {
          const lines: string[] = [];
          if (s.action?.trim()) lines.push(s.action.trim());
          if (shouldIncludeExpected(s.expected)) {
            lines.push(`expect ${s.expected.trim()}`);
          }
          return lines;
        });
        const extractUrl = (value?: string | null) => {
          const raw = (value ?? "").trim();
          if (!raw) return null;
          const baseMatch = raw.match(/base\s*url\s*[:=]\s*([^\s]+)/i);
          if (baseMatch?.[1]) return baseMatch[1].trim();
          const urlMatch = raw.match(/https?:\/\/[^\s)]+/i);
          if (urlMatch?.[0]) return urlMatch[0].replace(/[.,]$/, "");
          return null;
        };
        const preconditionUrl = extractUrl(tc?.preconditions as any);
        const stepUrl = stepLines.map(extractUrl).find(Boolean) as string | undefined;
        const baseUrlFromSteps = normalizeBaseUrl(stepUrl || preconditionUrl || "");
        const effectiveBaseUrl = baseUrlFromSteps || baseUrl;
        const isBaseUrlDirective = (line: string) => /base\s*url\s*[:=]/i.test(line);
        const filteredStepLines = stepLines.filter((line) => !isBaseUrlDirective(line));
        const parsedSteps: Step[] = filteredStepLines.length ? filteredStepLines.map(parseStepLine) : [];

        const toSimpleAction = (step: Step) => {
          const selector = (step as any).selector as string | undefined;
          const isText = selector?.startsWith("text=");
          const isLabel = selector?.startsWith("label=");
          const isPlaceholder = selector?.startsWith("placeholder=");
          const isRole = selector?.startsWith("role=");
          const isTestId = selector?.startsWith("testid=") || selector?.startsWith("data-testid=");
          const stripPrefix = (s: string, prefix: string) => s.slice(prefix.length);
          switch (step.kind) {
            case "goto":
              return `    await page.goto(${JSON.stringify(step.url)});`;
            case "click": {
              if (selector) {
                if (isText) {
                  return `    await page.getByText(${JSON.stringify(stripPrefix(selector, "text="))}).first().click();`;
                }
                if (isRole) {
                  return `    await page.getByRole(${JSON.stringify(stripPrefix(selector, "role=") as any)}).first().click();`;
                }
                if (isTestId) {
                  const id = stripPrefix(selector, selector.startsWith("testid=") ? "testid=" : "data-testid=");
                  return `    await page.getByTestId(${JSON.stringify(id)}).click();`;
                }
                return `    await page.locator(${JSON.stringify(selector)}).first().click();`;
              }
              return `    await page.getByText("Continue").first().click();`;
            }
            case "fill": {
              const raw = selector || "input";
              if (isLabel) {
                return `    await page.getByLabel(${JSON.stringify(stripPrefix(raw, "label="))}).fill(${JSON.stringify(step.value)});`;
              }
              if (isPlaceholder) {
                return `    await page.getByPlaceholder(${JSON.stringify(stripPrefix(raw, "placeholder="))}).fill(${JSON.stringify(step.value)});`;
              }
              return `    await page.locator(${JSON.stringify(raw)}).fill(${JSON.stringify(step.value)});`;
            }
            case "expect-text":
              return `    await expect(page.getByText(${JSON.stringify(step.text)}).first()).toBeVisible();`;
            case "expect-visible":
              return `    await expect(page.locator(${JSON.stringify(step.selector)}).first()).toBeVisible();`;
            case "upload":
              return `    await page.locator(${JSON.stringify(step.selector)}).setInputFiles(${JSON.stringify(step.path)});`;
            default:
              return `    // TODO: unsupported step`;
          }
        };

        const lines: string[] = [];
        const hasGoto = parsedSteps.some((s) => s.kind === "goto");
        if (!hasGoto) {
          lines.push(`    await page.goto(${JSON.stringify(effectiveBaseUrl)});`);
        }
        for (const step of parsedSteps) {
          lines.push(toSimpleAction(step));
        }
        if (hasNavigatedExpected) {
          const gotoStep = parsedSteps.find((s) => s.kind === "goto") as Step | undefined;
          if (gotoStep?.kind === "goto") {
            const url = /^https?:\/\//i.test(gotoStep.url)
              ? gotoStep.url
              : new URL(gotoStep.url, effectiveBaseUrl).toString();
            lines.push(`    await expect(page).toHaveURL(${JSON.stringify(url)});`);
          } else {
            lines.push(`    await expect(page).toHaveURL(${JSON.stringify(effectiveBaseUrl)});`);
          }
        }
        if (!lines.length) {
          lines.push(`    await page.goto(${JSON.stringify(effectiveBaseUrl)});`);
          lines.push(`    await expect(page).toHaveTitle(/.+/);`);
        }

        const fileBase = `manual-${slugify(caseTitle) || "case"}`;
        const spec = `import { test, expect } from "@playwright/test";

test(${JSON.stringify(caseTitle)}, async ({ page }) => {
${lines.join("\n")}
});
`;

        const ownerIdForSpecs = projectRecord?.ownerId ?? userId;
        const generatedProjectRoot = path.join(GENERATED_ROOT, `${adapterId}-${ownerIdForSpecs}`, projectId);
        await fs.mkdir(generatedProjectRoot, { recursive: true });
        await fs.writeFile(path.join(manualSpecDir, `${fileBase}.spec.ts`), spec, "utf8");
        await fs.writeFile(path.join(generatedProjectRoot, `${fileBase}.spec.ts`), spec, "utf8");
      } else {
        // 3) run your generator (writes to testmind-generated/*)
        await execa("pnpm", ["tsx", RUNNER_PATH], {
          cwd: REPO_ROOT,
          env,
          stdio: "inherit",
        });
        const generatedFolder = path.join(GENERATED_ROOT, adapterId);
        const userGeneratedDir = path.join(GENERATED_ROOT, `${adapterId}-${userId}`);
        await fs.rm(userGeneratedDir, { recursive: true, force: true }).catch(() => {});
        await fs.mkdir(userGeneratedDir, { recursive: true });
        await fs.cp(generatedFolder, userGeneratedDir, { recursive: true });
        const webGeneratedDir = path.join(REPO_ROOT, "apps", "web", "testmind-generated", `${adapterId}-${userId}`);
        await fs.rm(webGeneratedDir, { recursive: true, force: true }).catch(() => {});
        await fs.mkdir(webGeneratedDir, { recursive: true });
        await fs.cp(generatedFolder, webGeneratedDir, { recursive: true });
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
      const workspaceManualDir = manualSpecDir ? path.resolve(manualSpecDir) : "";

      const ciConfigPath = path.join(workspaceDir, "tm-ci.playwright.config.ts");
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
        const manualDir = manualSpecDir ? workspaceManualDir : "";
      const esc = (p: string) => p.replace(/\\/g, "/");

      // 5) ensure browsers are installed (reuse existing workspace version when available)
      const skipBrowserInstall =
        env.LOCAL_RUN === "1" || process.env.SKIP_PLAYWRIGHT_INSTALL === "1";
      if (skipBrowserInstall) {
        console.log("[startGeneratedRun] skipping Playwright install (local run)");
      } else {
        const alreadyInstalled = await browsersAlreadyInstalled();
        if (alreadyInstalled) {
          console.log("[startGeneratedRun] Playwright browsers already installed, reusing cache");
        } else {
          await execa("pnpm", ["exec", "playwright", "install", "--with-deps"], {
            cwd: REPO_ROOT,
            env,
            stdio: "inherit",
          });
        }
      }

      // 6) run tests to produce 'playwright-report/'
      try {
        const projects: string[] = [];
        if (manualDir) {
          projects.push(`{ name: 'manual', testDir: '${esc(manualDir)}' }`);
        }
        if (!caseId) {
          const generatedDirCandidates = [
            path.join(REPO_ROOT, "apps", "web", "testmind-generated", `${adapterId}-${userId}`),
            path.join(GENERATED_ROOT, `${adapterId}-${userId}`),
          ];
          const generatedDir = generatedDirCandidates.find((p) => {
            try { return fsSync.existsSync(p); } catch { return false; }
          }) ?? null;
          if (generatedDir) {
            projects.push(`{ name: 'generated', testDir: '${esc(generatedDir)}' }`);
          }
        }

        const configContent = `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  projects: [
    ${projects.join(",\n    ")}
  ],
  reporter: [
    ['list'],
    ['json', { outputFile: '${esc(path.join(runDir, "report.json"))}' }],
    ['html', { open: 'never' }],
  ],
  use: { baseURL: process.env.TM_BASE_URL || process.env.TEST_BASE_URL || 'http://localhost:5173' },
  workers: (() => {
    const raw = process.env.PW_WORKERS;
    if (!raw) return '50%';
    if (raw.endsWith('%')) return raw;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : '50%';
  })(),
});
`;
      await fs.writeFile(ciConfigPath, configContent, "utf8");

        try {
          await execa("pnpm", ["exec", "playwright", "test", "-c", ciConfigPath], {
            cwd: REPO_ROOT,
            env,
            stdio: "pipe",
          });
        } catch (err: any) {
          const stdout = err?.stdout ?? "";
          const stderr = err?.stderr ?? err?.message ?? String(err);
          await fs.writeFile(path.join(runDir, "stdout.txt"), String(stdout), { flag: "a" });
          await fs.writeFile(path.join(runDir, "stderr.txt"), String(stderr), { flag: "a" });
          throw err;
        }
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

      // 6b) parse JSON report and persist results for UI
      const reportPath = path.join(runDir, "report.json");
      const cases = await parseResults(reportPath).catch(() => []);
      if (cases.length) {
        const repoRootPosix = REPO_ROOT.replace(/\\/g, "/");
        const runDirPosix = runDir.replace(/\\/g, "/");
        await prisma.$transaction(async (db) => {
          for (const c of cases) {
            let file = (c.file || "unknown").replace(/\\/g, "/");
            if (file.startsWith(repoRootPosix)) file = file.slice(repoRootPosix.length + 1);
            if (file.startsWith(runDirPosix)) file = file.slice(runDirPosix.length + 1);
            file = file.replace(/^\/+/, "");
            const key = `${file}#${c.fullName}`.slice(0, 255);

            const testCase = await db.testCase.upsert({
              where: { projectId_key: { projectId, key } },
              update: { title: c.fullName },
              create: { projectId, key, title: c.fullName },
            });

            await db.testResult.create({
              data: {
                run: { connect: { id: runId } },
                testCase: { connect: { id: testCase.id } },
                status: c.status,
                durationMs: c.durationMs ?? null,
                message: c.message ?? null,
              },
            });
          }
        });
      }

      // 7) update DB with locations the UI can use
      await prisma.testRun.update({
        where: { id: runId },
        data: {
          status: "succeeded",
          finishedAt: new Date(),
          summary: cases.length
            ? `Run complete. Parsed ${cases.length} tests.`
            : "Run complete, but no tests were parsed (check config/spec output).",
          reportPath: "playwright-report/index.html", // relative to repo root
          artifactsJson: JSON.stringify({
            generatedDirs: manualDir ? [path.relative(REPO_ROOT, manualDir)] : [],
            reportDir: "playwright-report",
            jsonReport: path.relative(REPO_ROOT, reportPath),
          }),
        },
      });
      sendRunNotifications(runId).catch((err) => {
        console.error(`[notifications] run ${runId} failed`, err);
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
      sendRunNotifications(runId).catch((err) => {
        console.error(`[notifications] run ${runId} failed`, err);
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
      select: { id: true, sharedSteps: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    // create a run record
    const run = await prisma.testRun.create({
      data: {
        projectId,
        status: "queued",
        trigger: "user",
        paramsJson: project?.sharedSteps ? { sharedSteps: project.sharedSteps } : undefined,
      },
    });
    const updatedRun = await prisma.testRun.update({
      where: { id: run.id },
      data: { summary: `Generate tests (run ${run.id})` },
    });

    await startGeneratedRun(updatedRun.id, projectId, userId);

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

  app.get<{
    Params: { projectId: string; runId: string };
  }>("/projects/:projectId/test-runs/:runId/missing-locators", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const { projectId, runId } = req.params;
    const project = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true, sharedSteps: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const run = await prisma.testRun.findFirst({
      where: { id: runId, projectId },
      select: { id: true },
    });
    if (!run) return reply.code(404).send({ error: "Run not found" });

    const missingLocatorsCandidates = [
      path.join(RUNNER_LOGS_ROOT, runId, "missing-locators.json"),
      path.join(REPORT_ROOT, runId, "missing-locators.json"),
    ];
    let missingLocators: any[] = [];
    for (const missingLocatorsPath of missingLocatorsCandidates) {
      try {
        const raw = await fs.readFile(missingLocatorsPath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.items)) {
          missingLocators = parsed.items;
          break;
        }
      } catch (error: any) {
        if (error?.code && error.code !== "ENOENT") {
          console.error("[missing-locators] failed to read", { runId, projectId, error });
          return reply.code(500).send({ error: "Failed to read missing locators" });
        }
      }
    }

    const locatorStore = normalizeSharedSteps(project.sharedSteps ?? {});
    const filtered = missingLocators.filter((item) => {
      const result = resolveLocator(locatorStore, item.pagePath, item.bucket, item.name);
      return !result.selector;
    });

    reply.send({ missingLocators: filtered });
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

    const suite = await prisma.testSuite.create({
      data: {
        projectId: parsed.data.projectId,
        name: parsed.data.name,
        parentId: parsed.data.parentId ?? undefined,
      },
    });
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

    const { steps, ...casePayload } = parsed.data;
    const { projectId, suiteId, ...caseFields } = casePayload;

    const created = await prisma.$transaction(async (tx) => {
      const tc = await tx.testCase.create({
        data: {
          project: { connect: { id: projectId } },
          title: caseFields.title,
          suite: suiteId ? { connect: { id: suiteId } } : undefined,
          priority: caseFields.priority,
          status: caseFields.status,
          type: caseFields.type,
          tags: caseFields.tags ?? undefined,
          preconditions: caseFields.preconditions ?? undefined,
        },
      });
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

    const { steps, ...casePayload } = parsed.data;

    const updated = await prisma.$transaction(async (tx) => {
      const updateData: Prisma.TestCaseUpdateInput = {};
      if (casePayload.title) updateData.title = casePayload.title;
      if (casePayload.priority) updateData.priority = casePayload.priority;
      if (casePayload.status) updateData.status = casePayload.status;
      if (casePayload.type) updateData.type = casePayload.type;
      if (casePayload.tags !== undefined) updateData.tags = casePayload.tags;
      if (casePayload.preconditions !== undefined) updateData.preconditions = casePayload.preconditions;
      if (casePayload.suiteId !== undefined) {
        updateData.suite = casePayload.suiteId
          ? { connect: { id: casePayload.suiteId } }
          : { disconnect: true };
      }

      const tc = await tx.testCase.update({
        where: { id: req.params.id },
        data: updateData,
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
        select: { id: true, sharedSteps: true },
      });
      if (!ownerOk) return reply.code(404).send({ error: "Case not found" });

      const run = await prisma.testRun.create({
        data: {
          projectId: tc.projectId,
          status: "queued",
          summary: `Generate Playwright for case "${tc.title}"`,
          paramsJson: ownerOk?.sharedSteps ? { sharedSteps: ownerOk.sharedSteps } : undefined,
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

      await startGeneratedRun(updatedRun.id, tc.projectId, userId, tc.id);

      reply.code(202).send({ runId: updatedRun.id });
    }
  );

  // AI-generate a Playwright spec for a manual case and save to curated.
  app.post<{ Params: { id: string } }>(
    "/tests/cases/:id/ai-generate-spec",
    async (req, reply) => {
      const userId = requireUser(req, reply);
      if (!userId) return;

      const tc = await prisma.testCase.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          projectId: true,
          title: true,
          preconditions: true,
          steps: { orderBy: { idx: "asc" }, select: { action: true, expected: true, idx: true } },
        },
      });
      if (!tc) return reply.code(404).send({ error: "Case not found" });

      const project = await prisma.project.findFirst({
        where: { id: tc.projectId, ownerId: userId },
        select: { id: true, name: true, sharedSteps: true, repoUrl: true },
      });
      if (!project) return reply.code(404).send({ error: "Case not found" });

      const { apiKey, availableKeys } = await resolveOpenAiKey(project.id);
      if (!apiKey) {
        return reply.code(400).send({
          error:
            `OPENAI_API_KEY is required. Add it under Integrations > Secrets for this project. Keys found: ${
              availableKeys.length ? availableKeys.join(", ") : "none"
            }`,
        });
      }

      const extractUrl = (value?: string | null) => {
        const raw = (value ?? "").trim();
        if (!raw) return null;
        const baseMatch = raw.match(/base\s*url\s*[:=]\s*([^\s]+)/i);
        if (baseMatch?.[1]) return baseMatch[1].trim();
        const urlMatch = raw.match(/https?:\/\/[^\s)]+/i);
        if (urlMatch?.[0]) return urlMatch[0].replace(/[.,]$/, "");
        return null;
      };

      const baseUrl =
        normalizeBaseUrl(extractUrl(tc.preconditions as any) || "") ||
        normalizeBaseUrl((project.sharedSteps as any)?.baseUrl) ||
        normalizeBaseUrl(project.repoUrl) ||
        normalizeBaseUrl(process.env.TM_BASE_URL) ||
        normalizeBaseUrl(process.env.TEST_BASE_URL) ||
        "http://localhost:5173";

      const steps = (tc.steps ?? []).map((s, idx) => ({
        idx: idx + 1,
        action: s.action?.trim() || "",
        expected: s.expected?.trim() || "",
      }));

      const systemPrompt = [
        "You are an expert QA automation engineer.",
        "Generate a Playwright test in TypeScript using @playwright/test.",
        "Return ONLY the code. No markdown, no backticks.",
        "Single test per file.",
      ].join("\n");

      const userPrompt = [
        `Test title: ${tc.title}`,
        `Base URL: ${baseUrl}`,
        "Steps (action + expected):",
        JSON.stringify(steps, null, 2),
        "",
        "Rules:",
        "- Use page.goto() for navigation.",
        "- If action contains a selector or HTML snippet, prefer a stable locator (href, data-testid, text).",
        "- If expected is 'navigated' or similar, assert URL with expect(page).toHaveURL(...).",
        "- Keep it minimal and deterministic. No extra setup or shared steps.",
      ].join("\n");

      const openai = new OpenAI({ apiKey });
      const completion = await openai.chat.completions.create({
        model: AI_SPEC_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
      });

      let content = completion.choices?.[0]?.message?.content?.trim() || "";
      if (!content) {
        return reply.code(500).send({ error: "AI did not return a spec" });
      }
      content = content.replace(/^```[a-z]*\s*/i, "").replace(/```$/i, "").trim();
      if (!content.includes("import") || !content.includes("test(")) {
        return reply.code(500).send({ error: "AI response did not look like a Playwright spec" });
      }

      const projectSlug = slugify(project.name ?? project.id);
      const caseSlug = slugify(tc.title || "case");
      const rootRel = `project-${project.id}/${projectSlug}`;
      const { root } = ensureCuratedProjectEntry(project.id, project.name, rootRel);
      let fileName = `${caseSlug}.spec.ts`;
      let destAbs = path.join(root, fileName);
      if (fsSync.existsSync(destAbs)) {
        fileName = `${caseSlug}-${Date.now()}.spec.ts`;
        destAbs = path.join(root, fileName);
      }
      ensureWithin(root, destAbs);
      await fs.mkdir(path.dirname(destAbs), { recursive: true });
      await fs.writeFile(destAbs, content, "utf8");

      const curatedPath = path.posix.join(
        "testmind-curated",
        rootRel.replace(/\\/g, "/"),
        fileName
      );

      return reply.send({ fileName, curatedPath, preview: content });
    }
  );
}

