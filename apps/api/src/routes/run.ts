// apps/api/src/routes/run.ts
import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import net from "net";
import { z } from "zod";
import { prisma } from "../prisma.js";

// runner pieces
import { makeWorkdir, rmrf } from "../runner/workdir.js";
import { cloneRepo } from "../runner/git.js";
import { runTests } from "../runner/node-test-exec.js";
import { execa } from "execa";

import { parseResults, ParsedCase } from "../runner/result-parsers.js";
import { scheduleSelfHealingForRun } from "../runner/self-heal.js";
import { enqueueAllureGenerate, enqueueRun } from "../runner/queue.js";
import { CURATED_ROOT, agentSuiteId } from "../testmind/curated-store.js";
import { regenerateAttachedSpecs } from "../agent/service.js";
import { decryptSecret } from "../lib/crypto.js";
import { GENERATED_ROOT, REPORT_ROOT, ensureStorageDirs } from "../lib/storageRoots.js";

// Minimal, workspace-aware dependency installer
// replace your installDeps with this
async function installDeps(repoRoot: string, workspaceCwd: string) {
  const nodeModulesExists = fsSync.existsSync(path.join(repoRoot, "node_modules"));
  const tStart = Date.now();

  const has = (p: string) => fsSync.existsSync(path.join(repoRoot, p));
  const isWorkspaceRoot =
    path.resolve(repoRoot) === path.resolve(workspaceCwd) &&
    fsSync.existsSync(path.join(repoRoot, "pnpm-workspace.yaml"));

  // pick package manager from **repo root**
  let pm: "pnpm" | "yarn" | "npm";
  let installArgs: string[];
  if (has("pnpm-lock.yaml")) {
    pm = "pnpm"; installArgs = ["install", "--silent"];
  } else if (has("yarn.lock")) {
    pm = "yarn"; installArgs = ["install", "--silent", "--non-interactive"];
  } else if (has("package-lock.json")) {
    pm = "npm"; installArgs = ["ci", "--silent"];
  } else {
    pm = "npm"; installArgs = ["install", "--silent"];
  }

  const shouldRunFullInstall =
    !(process.env.TM_SKIP_INSTALL === "1" && nodeModulesExists) &&
    !(process.env.TM_REUSE_WORKSPACE === "1" && nodeModulesExists);

  if (shouldRunFullInstall) {
    if (process.env.TM_SKIP_INSTALL === "1") {
      console.log("[runner] TM_SKIP_INSTALL=1 but node_modules missing; installing anyway");
    }
    if (process.env.TM_REUSE_WORKSPACE === "1" && nodeModulesExists) {
      console.log("[runner] TM_REUSE_WORKSPACE=1 but running minimal install to refresh deps");
    }
    // install at the **repo root** so workspaces are wired correctly
    await execa(pm, installArgs, { cwd: repoRoot, stdio: "pipe" });
  } else {
    console.log("[runner] Reusing workspace; skipping full install");
  }

  // ensure @playwright/test is resolvable from the **workspace cwd**
  const canResolve = () => {
    try { require.resolve("@playwright/test", { paths: [workspaceCwd] }); return true; }
    catch { return false; }
  };

  if (!canResolve()) {
    const addArgs =
      pm === "pnpm" ? ["add", "-D", "@playwright/test", ...(isWorkspaceRoot ? ["-w"] : [])] :
        pm === "yarn" ? ["add", "-D", "@playwright/test"] :
          ["install", "-D", "@playwright/test"];

    await execa(pm, addArgs, { cwd: workspaceCwd, stdio: "pipe" });
  }

  const ensureDevDependency = async (pkg: string) => {
    const canResolvePkg = () => {
      try { require.resolve(pkg, { paths: [workspaceCwd] }); return true; }
      catch { return false; }
    };
    if (canResolvePkg()) return;
    const addArgs =
      pm === "pnpm" ? ["add", "-D", pkg, ...(isWorkspaceRoot ? ["-w"] : [])] :
        pm === "yarn" ? ["add", "-D", pkg] :
          ["install", "-D", pkg];
    await execa(pm, addArgs, { cwd: workspaceCwd, stdio: "pipe" });
  };

  await ensureDevDependency("allure-playwright");
  await ensureDevDependency("allure-commandline");
  await ensureDevDependency("allure-js-commons");

  try {
  const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
  await execa(npx, ["-y", "playwright", "install", "--with-deps"], {
    cwd: workspaceCwd,
    stdio: "pipe",
  });
} catch { /* non-fatal; Playwright may already be installed */ }

  const tEnd = Date.now();
  console.log(`[runner] installDeps completed in ${tEnd - tStart}ms (cwd=${workspaceCwd})`);
}

function isLikelyGitRepo(url?: string | null) {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  return (
    trimmed.endsWith(".git") ||
    trimmed.startsWith("git@") ||
    /github\.com|gitlab\.com|bitbucket\.org/.test(trimmed)
  );
}
// If webServer uses `vite preview`, make sure the app is built first
async function findPlaywrightWorkspace(repoRoot: string): Promise<{ subdir: string, configPath?: string }> {
  // candidate folders (monorepo friendly)
  const bases = ["apps", "packages"];
  const candidates = new Set<string>(["."]);

  for (const base of bases) {
    const full = path.join(repoRoot, base);
    try {
      for (const d of await fs.readdir(full, { withFileTypes: true })) {
        if (d.isDirectory()) candidates.add(path.join(base, d.name));
      }
    } catch { /* ignore */ }
  }

  // Prefer apps/web, then other apps, then packages, then root.
  const ordered = Array.from(candidates).sort((a, b) => {
    const score = (v: string) => {
      if (v === "apps/web") return 0;
      if (v.startsWith("apps/")) return 1;
      if (v.startsWith("packages/")) return 2;
      if (v === ".") return 3;
      return 4;
    };
    return score(a) - score(b);
  });

  // Prefer a folder that contains a Playwright config (CI config first).
  const prefer = ["tm-ci.playwright.config.ts", "tm-ci.playwright.config.mjs", "tm-ci.playwright.config.js",
    "playwright.config.ts", "playwright.config.mjs", "playwright.config.js", "playwright.config.cjs"];

  for (const sub of ordered) {
    const cwd = path.join(repoRoot, sub);
    for (const fname of prefer) {
      // Skip root-level tm-ci configs so we prefer real app workspaces (apps/web)
      if (sub === "." && fname.startsWith("tm-ci.playwright.config")) continue;
      if (fsSync.existsSync(path.join(cwd, fname))) {
        return { subdir: sub, configPath: path.join(cwd, fname) };
      }
    }
  }

  // If no config found, pick any workspace that declares @playwright/test
  for (const sub of ordered) {
    const pkgPath = path.join(repoRoot, sub, "package.json");
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps["@playwright/test"]) return { subdir: sub, configPath: undefined };
    } catch { /* ignore */ }
  }

  return { subdir: ".", configPath: undefined };
}

// Default base URL the runner will hand to Playwright (can be overridden by req or env)
const DEFAULT_BASE_URL = process.env.TM_BASE_URL ?? "http://localhost:4173";
const RUNNER_LOGS_ROOT = path.join(REPORT_ROOT, "runner-logs");

async function findAvailablePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    const onError = () => {
      const fallback = net.createServer();
      fallback.unref();
      fallback.listen(0, () => {
        const addr = fallback.address();
        const port = typeof addr === "object" && addr ? addr.port : preferred + 1;
        fallback.close(() => resolve(port));
      });
      fallback.on("error", () => resolve(preferred + 1));
    };
    srv.on("error", onError);
    srv.listen(preferred, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : preferred;
      srv.close(() => resolve(port));
    });
  });
}



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

async function mergeAgentSpecs(projectId: string, destRoot: string, logPath: string) {
  try {
    const suiteId = agentSuiteId(projectId);
    const src = path.join(CURATED_ROOT, suiteId);
    if (!fsSync.existsSync(src)) return false;
    const agentDest = path.join(destRoot, "__agent", suiteId);
    await fs.rm(agentDest, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.dirname(agentDest), { recursive: true });
    await fs.cp(src, agentDest, { recursive: true });
    await fs.writeFile(
      logPath,
      `[runner] agent specs merged from ${src} -> ${agentDest}\n`,
      { flag: "a" }
    );
    return true;
  } catch (err: any) {
    await fs.writeFile(
      logPath,
      `[runner] agent specs merge failed: ${err?.message ?? String(err)}\n`,
      { flag: "a" }
    );
    return false;
  }
}

const RunBody = z.object({
  projectId: z.string().min(1, "projectId is required"),
  baseUrl: z.string().url().optional(), // optional override
  suiteId: z.string().optional(), // spec suite to link edits back to
  file: z.string().optional(),   // relative path to spec to run
  specPath: z.string().optional(), // alias used by agent UI
  files: z.array(z.string()).optional(), // multiple specs
  grep: z.string().optional(),   // test title to match
  headful: z.boolean().optional(),
  runAll: z.boolean().optional(), // if true, ignore file/files/grep and run full suite
  extraGlobs: z.array(z.string()).optional(), // legacy selector; populated internally
});

function parseBool(val: unknown, fallback: boolean) {
  if (val === undefined || val === null) return fallback;
  const s = String(val).toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

type RunStatus = "queued" | "running" | "succeeded" | "failed";
type ResultStatus = "passed" | "failed" | "skipped" | "error";
const TestRunStatus: Record<RunStatus, RunStatus> = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
};
const TestResultStatus: Record<ResultStatus, ResultStatus> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  error: "error",
};

function mapStatus(s: string): ResultStatus {
  if (s === "passed") return TestResultStatus.passed;
  if (s === "failed" || s === "error") return TestResultStatus.failed;
  if (s === "skipped") return TestResultStatus.skipped;
  return TestResultStatus.error;
}

const stripAnsi = (value?: string | null) =>
  typeof value === "string" ? value.replace(/\u001b\[[0-9;]*m/g, "") : value ?? null;

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
    const headful = parsed.data.headful ?? parseBool(process.env.HEADFUL ?? process.env.TM_HEADFUL, false);
    const suiteId = parsed.data.suiteId?.trim() || undefined;
    const requestedBaseUrl = parsed.data.baseUrl;
    let effectiveBaseUrl = requestedBaseUrl ?? DEFAULT_BASE_URL;
    // Default to honoring file/grep selection unless caller explicitly sets runAll.
    // Honor explicit runAll, otherwise default from env, but if caller passed files/file/grep, prefer those.
    const hasSelection =
      (parsed.data.files && parsed.data.files.length > 0) ||
      !!parsed.data.file ||
      !!parsed.data.grep;
    let runAll = parsed.data.runAll ?? parseBool(process.env.TM_RUN_ALL_DEFAULT ?? "0", false);
    if (hasSelection && parsed.data.runAll === undefined) {
      runAll = false;
    }
    const localRepoRoot = process.env.TM_LOCAL_REPO_ROOT?.trim() || null;

    // look up project
    const project =
      (await prisma.project.findUnique({ where: { id: pid } })) ??
      (await prisma.project.findFirst({ where: { id: pid } }));

    if (!project) {
      return sendError(
        reply,
        "PROJECT_NOT_FOUND",
        `Project ${pid} was not found. Create the project and configure its repoUrl before running.`,
        404
      );
    }
    // Ensure attached agent scenarios are materialized as specs in TM_LOCAL_SPECS before running
    try {
      await regenerateAttachedSpecs(project.ownerId, project.id);
    } catch (err) {
      app.log.warn({ err }, "[runner] regenerateAttachedSpecs failed (continuing)");
    }
    const allowLocalRepo = (process.env.TM_USE_LOCAL_REPO ?? "1") === "1"; // default: allow local fallback
    const runFromRepo = (process.env.TM_RUN_FROM_REPO ?? "0") === "1"; // default: standalone generated-only
    const hasRepoUrl = runFromRepo && isLikelyGitRepo(project.repoUrl);
    if (runFromRepo && !hasRepoUrl && !allowLocalRepo) {
      return sendError(
        reply,
        "MISSING_REPO_URL",
        "Repository URL is not configured for this project. Set repoUrl and try again.",
        400,
        { projectId: pid }
      );
    }

    // create run entry
    const runParams: Record<string, any> = { headful, suiteId };
    if (effectiveBaseUrl) runParams.baseUrl = effectiveBaseUrl;
    const run = await prisma.testRun.create({
      data: {
        projectId: pid,
        status: TestRunStatus.running,
        startedAt: new Date(),
        trigger: "user",
        paramsJson: runParams,
      },
    });

    await ensureStorageDirs();
    const outDir = path.join(RUNNER_LOGS_ROOT, run.id);
    await fs.mkdir(outDir, { recursive: true });
    let artifacts: Record<string, string> | undefined;

    // launch the real runner in background (no await)
    (async () => {
      let work: string;
      let usingLocalRepo = false;

      const reuseWorkspace = (process.env.TM_REUSE_WORKSPACE ?? "1") === "1";
      const reusePathEnv = process.env.TM_WORKSPACE_PATH;

      if (!runFromRepo) {
        work = path.resolve(process.cwd());
        usingLocalRepo = true;
        await fs.writeFile(
          path.join(outDir, "stdout.txt"),
          `[runner] TM_RUN_FROM_REPO=0 using local runtime only (no clone/install/build)\n`,
          { flag: "a" }
        );
      } else if (localRepoRoot) {
        // Explicit local repo root takes priority
        work = path.resolve(localRepoRoot);
        usingLocalRepo = true;
        await fs.writeFile(
          path.join(outDir, "stdout.txt"),
          `[runner] TM_LOCAL_REPO_ROOT=${work} -> using local workspace (skip clone/install/build/server)\n`,
          { flag: "a" }
        );
      } else if (reuseWorkspace) {
        // Reuse an existing checkout; force monorepo root (../../ from apps/api)
        const fallbackRoot = path.resolve(process.cwd(), "../..");
        const hasWorkspace =
          fsSync.existsSync(path.join(fallbackRoot, "package.json")) ||
          fsSync.existsSync(path.join(fallbackRoot, "pnpm-lock.yaml")) ||
          fsSync.existsSync(path.join(fallbackRoot, "package-lock.json")) ||
          fsSync.existsSync(path.join(fallbackRoot, "yarn.lock"));
        if (hasWorkspace) {
          work = fallbackRoot;
          usingLocalRepo = true;
          await fs.writeFile(
            path.join(outDir, "stdout.txt"),
            `[runner] TM_REUSE_WORKSPACE=1 using workdir=${work}\n`,
            { flag: "a" }
          );
        } else {
          await fs.writeFile(
            path.join(outDir, "stdout.txt"),
            `[runner] TM_REUSE_WORKSPACE=1 but no repo root at ${fallbackRoot}; falling back to clone\n`,
            { flag: "a" }
          );
          work = await makeWorkdir();
        }
      } else if (!hasRepoUrl && allowLocalRepo) {
        // fall back to monorepo root (apps/api is one level below)
        work = path.resolve(process.cwd(), "..");
        usingLocalRepo = true;
      } else {
        work = await makeWorkdir(); // where we clone the repo
      }
      try {
        // Safety: if work accidentally points at apps/ or apps/api, lift to repo root
        const workStat = work.replace(/\\/g, "/");
        if (workStat.endsWith("/apps/api")) {
          work = path.resolve(work, "../..");
          await fs.writeFile(
            path.join(outDir, "stdout.txt"),
            `[runner] corrected workdir up to repo root (was apps/api): ${work}\n`,
            { flag: "a" }
          );
        } else if (workStat.endsWith("/apps")) {
          work = path.resolve(work, "..");
          await fs.writeFile(
            path.join(outDir, "stdout.txt"),
            `[runner] corrected workdir up to repo root (was apps): ${work}\n`,
            { flag: "a" }
          );
        }

        // GitHub token if connected
        const gitAcct = await prisma.gitAccount.findFirst({
          where: { userId: project.ownerId, provider: "github" },
          select: { token: true },
        });

        // 1) Clone (skip if using local/reuse workspace)
        if (!usingLocalRepo && hasRepoUrl && project.repoUrl) {
          await cloneRepo(project.repoUrl, work, gitAcct?.token || undefined);
        } else if (usingLocalRepo) {
          await fs.writeFile(
            path.join(outDir, "stdout.txt"),
            "[runner] clone skipped (using local/reuse workspace)\n",
            { flag: "a" }
          );
        } else if (!hasRepoUrl) {
          await fs.writeFile(
            path.join(outDir, "stdout.txt"),
            "[runner] repoUrl missing/non-git; skipping clone and running generated specs only\n",
            { flag: "a" }
          );
        }

        // 2) Install deps
        // await installDeps(work);

        const adapter = "playwright-ts";
        const userSuffix = project.ownerId ? `${adapter}-${project.ownerId}` : adapter;
        const generatedOnly = !hasRepoUrl;

        const resolveGeneratedSpecsDir = () => {
          const cwdRoot = process.cwd();
          const envRoot = process.env.TM_GENERATED_ROOT ? path.resolve(process.env.TM_GENERATED_ROOT) : null;
          const configuredRoot = path.resolve(GENERATED_ROOT);
          const candidates = [
            envRoot,
            configuredRoot,
            path.join(cwdRoot, "testmind-generated"),
            path.join(cwdRoot, "apps", "web", "testmind-generated"),
            path.join(cwdRoot, "apps", "api", "testmind-generated"),
            path.join(path.resolve(cwdRoot, ".."), "testmind-generated"),
            path.join(path.resolve(cwdRoot, "..", ".."), "testmind-generated"),
            path.join(path.resolve(cwdRoot, "..", ".."), "apps", "web", "testmind-generated"),
            path.join(path.resolve(cwdRoot, "..", ".."), "apps", "api", "testmind-generated"),
            path.join(path.sep, "testmind-generated"),
          ].filter(Boolean) as string[];

          const tried: string[] = [];
          const found: {
            projectScoped: string | null;
            userScoped: string | null;
            adapterProject: string | null;
            adapterScoped: string | null;
          } = {
            projectScoped: null,
            userScoped: null,
            adapterProject: null,
            adapterScoped: null,
          };

          for (const root of candidates) {
            const projectScoped = path.join(root, userSuffix, project.id);
            tried.push(projectScoped);
            if (!found.projectScoped && fsSync.existsSync(projectScoped)) found.projectScoped = projectScoped;

            const userScoped = path.join(root, userSuffix);
            tried.push(userScoped);
            if (!found.userScoped && fsSync.existsSync(userScoped)) found.userScoped = userScoped;

            const adapterProject = path.join(root, adapter, project.id);
            tried.push(adapterProject);
            if (!found.adapterProject && fsSync.existsSync(adapterProject)) found.adapterProject = adapterProject;

            const adapterScoped = path.join(root, adapter);
            tried.push(adapterScoped);
            if (!found.adapterScoped && fsSync.existsSync(adapterScoped)) found.adapterScoped = adapterScoped;
          }

          const dir =
            found.projectScoped ??
            found.userScoped ??
            found.adapterProject ??
            found.adapterScoped ??
            null;
          return { dir, tried };
        };

        let genDir: string | null = null;
        if (generatedOnly) {
          const resolved = resolveGeneratedSpecsDir();
          genDir = resolved.dir;
          if (!genDir) {
            await fs.writeFile(
              path.join(outDir, "stderr.txt"),
              `[runner] no generated specs found; set TM_GENERATED_ROOT or generate specs first\n[runner] tried:\n${resolved.tried.map((p) => ` - ${p}`).join("\n")}\n`,
              { flag: "a" }
            );
            return;
          }
          await fs.writeFile(
            path.join(outDir, "stdout.txt"),
            `[runner] generated specs dir=${genDir}\n`,
            { flag: "a" }
          );
        }

        // 3) Detect + run (object signature) and force JSON output to outDir/report.json
        // 3) Run tests (runner auto-finds the correct Playwright config) and write JSON to outDir/report.json
        // 2) Detect the correct workspace that contains Playwright (e.g., apps/web)
        // 2) Detect the correct workspace (e.g., apps/web) and switch cwd there
        // 2) Detect the workspace that contains Playwright and switch cwd to it
        let cwd: string;
        if (generatedOnly) {
          const runnerRoot = process.cwd();
          const apiRoot = path.join(runnerRoot, "apps", "api");
          const hasApiRoot = fsSync.existsSync(path.join(apiRoot, "package.json"));
          cwd = hasApiRoot ? apiRoot : runnerRoot;
        } else {
          const { subdir: appSubdir } = await findPlaywrightWorkspace(work);
          cwd = path.resolve(work, appSubdir);
        }

        // breadcrumbs for debugging
        await fs.writeFile(
          path.join(outDir, "stdout.txt"),
          `[runner] repoRoot=${work}\n[runner] workdir=${cwd}\n`,
          { flag: "a" }
        );


        // 3) Install deps in the workspace
        // - for local/reuse workspaces, only install when @playwright/test is missing
        const needsPlaywright = () => {
          try {
            require.resolve("@playwright/test", { paths: [cwd] });
            return false;
          } catch {
            return true;
          }
        };
        if (!generatedOnly) {
          if (localRepoRoot || reuseWorkspace) {
            if (needsPlaywright()) {
              const t0 = Date.now();
              await fs.writeFile(
                path.join(outDir, "stdout.txt"),
                "[runner] local/reuse workspace: @playwright/test missing, running installDeps\n",
                { flag: "a" }
              );
              await installDeps(work, cwd);
              await fs.writeFile(
                path.join(outDir, "stdout.txt"),
                `[runner] installDeps done in ${Date.now() - t0}ms\n`,
                { flag: "a" }
              );
            } else {
              await fs.writeFile(
                path.join(outDir, "stdout.txt"),
                "[runner] local/reuse workspace: skipping installDeps (deps already present)\n",
                { flag: "a" }
              );
            }
          } else {
            const t0 = Date.now();
            await installDeps(work, cwd);
            await fs.writeFile(
              path.join(outDir, "stdout.txt"),
              `[runner] installDeps done in ${Date.now() - t0}ms\n`,
              { flag: "a" }
            );
          }
        } else {
          await fs.writeFile(
            path.join(outDir, "stdout.txt"),
            "[runner] generated-only mode: skipping installDeps\n",
            { flag: "a" }
          );
        }
        // If this workspace is a Vite app and Playwright's webServer uses "vite preview",
        // do a build first so preview has static assets.
        const isLocalhostBase =
          effectiveBaseUrl?.includes("localhost") || effectiveBaseUrl?.includes("127.0.0.1");
        const hasBuildOutput =
          fsSync.existsSync(path.join(cwd, "dist")) ||
          fsSync.existsSync(path.join(cwd, "build"));
        const shouldBuildVite =
          localRepoRoot
            ? false
            : process.env.TM_SKIP_BUILD === "1"
              ? hasBuildOutput
              : process.env.TM_VITE_BUILD !== "0" && !isLocalhostBase;

        if (
          !generatedOnly &&
          shouldBuildVite &&
          (fsSync.existsSync(path.join(cwd, "vite.config.ts")) ||
            fsSync.existsSync(path.join(cwd, "vite.config.js")) ||
            fsSync.existsSync(path.join(cwd, "vite.config.mts")) ||
            fsSync.existsSync(path.join(cwd, "vite.config.mjs")) ||
            fsSync.existsSync(path.join(cwd, "vite.config.cjs")))
        ) {
          try {
            const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
            const t0 = Date.now();
            await execa(npx, ["-y", "vite", "build"], { cwd, stdio: "pipe" });
            await fs.writeFile(
              path.join(outDir, "stdout.txt"),
              `[runner] vite build completed in ${Date.now() - t0}ms\n`,
              { flag: "a" }
            );
          } catch (e: any) {
            await fs.writeFile(
              path.join(outDir, "stderr.txt"),
              `[runner] vite build failed: ${e?.stdout || e?.message}\n`,
              { flag: "a" }
            );
            // don't throw; Playwright may still start the server for non-Vite apps
          }
        } else if (!generatedOnly && process.env.TM_SKIP_BUILD === "1" && hasBuildOutput) {
          await fs.writeFile(
            path.join(outDir, "stdout.txt"),
            "[runner] TM_SKIP_BUILD=1, skipping vite build (existing build output found)\n",
            { flag: "a" }
          );
        } else if (!generatedOnly && process.env.TM_SKIP_BUILD === "1" && !hasBuildOutput) {
          await fs.writeFile(
            path.join(outDir, "stdout.txt"),
            "[runner] TM_SKIP_BUILD=1 requested but no build output found; running build\n",
            { flag: "a" }
          );
          try {
            const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
            const t0 = Date.now();
            await execa(npx, ["-y", "vite", "build"], { cwd, stdio: "pipe" });
            await fs.writeFile(
              path.join(outDir, "stdout.txt"),
              `[runner] vite build completed after forced build in ${Date.now() - t0}ms\n`,
              { flag: "a" }
            );
          } catch (e: any) {
            await fs.writeFile(
              path.join(outDir, "stderr.txt"),
              `[runner] vite build (forced) failed: ${e?.stdout || e?.message}\n`,
              { flag: "a" }
            );
          }
        }


        // 4) Run tests and force JSON to outDir/report.json
        const resultsPath = path.join(outDir, "report.json");
        process.env.PW_BASE_URL = effectiveBaseUrl;
        process.env.TM_BASE_URL = effectiveBaseUrl;


        // inside apps/api/src/routes/run.ts, after: const cwd = path.resolve(work, appSubdir);
        const ciConfigPath = path.join(cwd, "tm-ci.playwright.config.mjs");
        const legacyTsConfig = path.join(cwd, "tm-ci.playwright.config.ts");
        const legacyJsConfig = path.join(cwd, "tm-ci.playwright.config.js");
        await fs.rm(legacyTsConfig, { force: true }).catch(() => {});
        await fs.rm(legacyJsConfig, { force: true }).catch(() => {});
        const serverPort = await findAvailablePort(Number(process.env.TM_PORT ?? 4173));
        if (!requestedBaseUrl) {
          effectiveBaseUrl = `http://localhost:${serverPort}`;
        }
        const serverDirAbsolute = cwd;
        const winServerDirEsc = serverDirAbsolute
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "''");
        const unixServerDirEsc = serverDirAbsolute
          .replace(/\\/g, "/")
          .replace(/"/g, '\\"');
        const genRoot = process.env.TM_GENERATED_ROOT
          ? path.resolve(process.env.TM_GENERATED_ROOT)
          : path.join(cwd, "testmind-generated");
        const userGenDest = path.join(genRoot, userSuffix);
        const sharedGenDest = path.join(genRoot, adapter);
        let genDestName = adapter;
        const PORT_PLACEHOLDER = "__TM_PORT__";
        const winDevCommand = `powershell -NoProfile -Command "& {Set-Location -Path '${winServerDirEsc}'; pnpm install; pnpm dev --host localhost --port ${PORT_PLACEHOLDER} }"`;
        const unixDevCommand = `bash -lc "cd \\"${unixServerDirEsc}\\" && pnpm install && pnpm dev --host 0.0.0.0 --port ${PORT_PLACEHOLDER}"`;
        const ciConfig = generatedOnly
          ? `import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TM_PORT ?? 4173);
const BASE = process.env.PW_BASE_URL || process.env.TM_BASE_URL || \`http://localhost:\${PORT}\`;
const GEN_ROOT = process.env.TM_GENERATED_ROOT
  ? path.resolve(process.env.TM_GENERATED_ROOT)
  : path.resolve(DIR, 'testmind-generated');
const GEN_DIR = ${genDir ? JSON.stringify(genDir) : "path.join(GEN_ROOT, '__GEN_DEST__')"};
const JSON_REPORT = process.env.PW_JSON_OUTPUT
  ? path.resolve(process.env.PW_JSON_OUTPUT)
  : path.resolve(DIR, 'playwright-report.json');
const ALLURE_RESULTS = process.env.PW_ALLURE_RESULTS
  ? path.resolve(process.env.PW_ALLURE_RESULTS)
  : path.resolve(DIR, 'allure-results');
const GREP = process.env.PW_GREP ? new RegExp(process.env.PW_GREP) : undefined;

const reporters = [
  ['list'],
  ['json', { outputFile: JSON_REPORT }],
  ['allure-playwright', { resultsDir: ALLURE_RESULTS }],
];

const FAST = (process.env.TM_FAST_MODE ?? "1") === "1";
const NAV_TIMEOUT = Number(process.env.TM_NAV_TIMEOUT_MS ?? (FAST ? "20000" : "20000"));
const ACTION_TIMEOUT = Number(process.env.TM_ACTION_TIMEOUT_MS ?? (FAST ? "20000" : "20000"));
const EXPECT_TIMEOUT = Number(process.env.TM_EXPECT_TIMEOUT_MS ?? (FAST ? "5000" : "8000"));
const TEST_TIMEOUT = Number(process.env.TM_TEST_TIMEOUT_MS ?? (FAST ? "30000" : "45000"));
const WORKERS = Number.isFinite(Number(process.env.TM_WORKERS))
  ? Number(process.env.TM_WORKERS)
  : 6;
const MAX_FAILURES = process.env.TM_MAX_FAILURES
  ? Number(process.env.TM_MAX_FAILURES)
  : 0;

export default defineConfig({
  use: {
    baseURL: BASE,
    navigationTimeout: NAV_TIMEOUT,
    actionTimeout: ACTION_TIMEOUT,
    trace: FAST ? 'off' : 'on-first-retry',
    video: FAST ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  timeout: TEST_TIMEOUT,
  expect: { timeout: EXPECT_TIMEOUT },
  workers: WORKERS,
  fullyParallel: true,
  maxFailures: MAX_FAILURES,
  grep: GREP,
  reporter: reporters,
  webServer: undefined,
  testIgnore: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.*/**',
  ],
  projects: [{
    name: 'generated',
    testDir: GEN_DIR,
    testMatch: ['**/*.spec.ts','**/*.test.ts'],
    timeout: 30_000,
  }],
});`
          : `import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.TM_PORT ?? 4173);
const BASE = process.env.PW_BASE_URL || process.env.TM_BASE_URL || \`http://localhost:\${PORT}\`;
const GEN_ROOT = process.env.TM_GENERATED_ROOT
  ? path.resolve(process.env.TM_GENERATED_ROOT)
  : path.resolve(DIR, 'testmind-generated');
const GEN_DIR = path.join(GEN_ROOT, '__GEN_DEST__');
const JSON_REPORT = process.env.PW_JSON_OUTPUT
  ? path.resolve(process.env.PW_JSON_OUTPUT)
  : path.resolve(DIR, 'playwright-report.json');
const ALLURE_RESULTS = process.env.PW_ALLURE_RESULTS
  ? path.resolve(process.env.PW_ALLURE_RESULTS)
  : path.resolve(DIR, 'allure-results');
const GREP = process.env.PW_GREP ? new RegExp(process.env.PW_GREP) : undefined;

const reporters = [
  ['list'],
  ['json', { outputFile: JSON_REPORT }],
  ['allure-playwright', { resultsDir: ALLURE_RESULTS }],
];

const DEV_COMMAND =
  process.platform === 'win32'
    ? \`${winDevCommand}\`
    : \`${unixDevCommand}\`;

const NAV_TIMEOUT = Number(process.env.TM_NAV_TIMEOUT_MS ?? "30000");
const ACTION_TIMEOUT = Number(process.env.TM_ACTION_TIMEOUT_MS ?? "20000");
const EXPECT_TIMEOUT = Number(process.env.TM_EXPECT_TIMEOUT_MS ?? "10000");
const TEST_TIMEOUT = Number(process.env.TM_TEST_TIMEOUT_MS ?? "60000");
const WORKERS = Number.isFinite(Number(process.env.TM_WORKERS))
  ? Number(process.env.TM_WORKERS)
  : 4;
const MAX_FAILURES = process.env.TM_MAX_FAILURES ? Number(process.env.TM_MAX_FAILURES) : 0;

export default defineConfig({
  use: {
    baseURL: BASE,
    navigationTimeout: NAV_TIMEOUT,
    actionTimeout: ACTION_TIMEOUT,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  timeout: TEST_TIMEOUT,
  expect: { timeout: EXPECT_TIMEOUT },
  workers: WORKERS,
  maxFailures: MAX_FAILURES,
  grep: GREP,
  reporter: reporters,
  webServer: process.env.TM_SKIP_SERVER
    ? undefined
    : {
        command: DEV_COMMAND,
        url: \`http://localhost:\${PORT}\`,
        reuseExistingServer: true,
        timeout: 120000,
      },
  testIgnore: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.*/**',
    '**/testmind-generated/appium-js/**', // skip appium stubs that require CommonJS
  ],
  projects: [{
    name: 'generated',
    testDir: GEN_DIR,
    testMatch: ['**/*.spec.ts','**/*.test.ts'],
    timeout: 30_000,
  }],
});`;



        // --- bring generated specs into the temp workspace ---
        // destination inside the workspace (user-scoped when available)
        let genDest = sharedGenDest;

        if (generatedOnly) {
          genDest = genDir ?? sharedGenDest;
          genDestName = path.basename(genDest);
          const finalConfig = ciConfig
            .replace(new RegExp(PORT_PLACEHOLDER, "g"), String(serverPort))
            .replace("__GEN_DEST__", genDestName);
          await fs.writeFile(ciConfigPath, finalConfig, "utf8");
        } else {
          // resolve source based on env
          const MODE = (process.env.TM_SPECS_MODE || 'auto').toLowerCase() as 'auto' | 'local' | 'repo';
          const preferRepo = MODE === 'repo';
          const localPath = process.env.TM_LOCAL_SPECS && fsSync.existsSync(process.env.TM_LOCAL_SPECS)
            ? path.resolve(process.env.TM_LOCAL_SPECS)
            : null;
          const generatedRoot = process.env.TM_GENERATED_ROOT
            ? path.resolve(process.env.TM_GENERATED_ROOT)
            : null;
          const generatedUser = generatedRoot ? path.join(generatedRoot, userSuffix) : null;
          const generatedShared = generatedRoot ? path.join(generatedRoot, adapter) : null;
          const repoPath = path.join(work, 'apps', 'api', 'testmind-generated', adapter);
          const repoAlt = path.join(work, 'testmind-generated', adapter);
          const repoPathUser = path.join(work, 'apps', 'api', 'testmind-generated', userSuffix);
          const repoAltUser = path.join(work, 'testmind-generated', userSuffix);
          const webPath  = path.join(work, 'apps', 'web', 'testmind-generated', adapter); // common dev location
          const webPathUser = path.join(work, 'apps', 'web', 'testmind-generated', userSuffix);
          const curatedPath = path.join(CURATED_ROOT, project.id);

          function pickSource(): string | null {
            // Prefer curated edits when present so saved suite changes are run.
            const curatedExists = fsSync.existsSync(curatedPath);
            if (curatedExists) return curatedPath;

            if (generatedUser && fsSync.existsSync(generatedUser)) return generatedUser;
            if (generatedShared && fsSync.existsSync(generatedShared)) return generatedShared;

            // Repo-first for repo mode or empty user folder
            if (preferRepo) {
              if (fsSync.existsSync(repoPathUser)) return repoPathUser;
              if (fsSync.existsSync(repoAltUser)) return repoAltUser;
              if (fsSync.existsSync(repoPath)) return repoPath;
              if (fsSync.existsSync(repoAlt)) return repoAlt;
              // if nothing repo-side, fall through to local/web
            }

            // Prefer user-specific generated specs when they exist (local cache)
            if (fsSync.existsSync(webPathUser)) return webPathUser;

            // If a dev build already produced specs under apps/web, use that next (auto/local only).
            if (!preferRepo && fsSync.existsSync(webPath)) return webPath;

            if (MODE === 'local') return localPath;
            // auto fallback order: repo, then local
            if (fsSync.existsSync(repoPathUser)) return repoPathUser;
            if (fsSync.existsSync(repoAltUser)) return repoAltUser;
            if (fsSync.existsSync(repoPath)) return repoPath;
            if (fsSync.existsSync(repoAlt)) return repoAlt;
            return localPath;
          }

          // always clean the repo-copy roots to avoid stale mixes
          const repoRoot1 = path.join(work, 'apps', 'api', 'testmind-generated');
          const repoRoot2 = path.join(work, 'testmind-generated');
          try { await fs.rm(repoRoot1, { recursive: true, force: true }); } catch { }
          try { await fs.rm(repoRoot2, { recursive: true, force: true }); } catch { }

          // wipe destination if requested (but don't delete if source==dest)
          const srcPicked = pickSource();
          if (srcPicked && srcPicked.includes(userSuffix)) {
            genDest = userGenDest;
            genDestName = userSuffix;
          } else {
            genDest = sharedGenDest;
            genDestName = adapter;
          }
          const samePath = srcPicked ? path.resolve(srcPicked) === path.resolve(genDest) : false;
          const finalConfig = ciConfig
            .replace(new RegExp(PORT_PLACEHOLDER, "g"), String(serverPort))
            .replace("__GEN_DEST__", genDestName);
          await fs.writeFile(ciConfigPath, finalConfig, "utf8");

          if ((process.env.TM_CLEAN_DEST || '1') !== '0' && !samePath) {
            try { await fs.rm(genDest, { recursive: true, force: true }); } catch { }
          }

          if (!srcPicked) {
            await fs.writeFile(path.join(outDir, 'stderr.txt'),
              `[runner] NO SPECS SOURCE FOUND. MODE=${MODE} local=${localPath || 'null'} repo=${repoPath} or ${repoAlt}\n`,
              { flag: 'a' });
          } else {
            // If we're already inside apps/web, avoid copying onto itself.
            if (!samePath) {
              await fs.mkdir(genDest, { recursive: true });
              // @ts-ignore Node 18+
              await fs.cp(srcPicked, genDest, { recursive: true });
            }
            await fs.writeFile(path.join(outDir, 'stdout.txt'),
              `[runner] specs source=${srcPicked} -> dest=${genDest}${samePath ? " (no copy needed)" : ""}\n`,
              { flag: 'a' });
          }
        }

        // For agent-triggered runs we used to merge curated agent specs into the temp workspace.
        // That pulled in many extra specs and could hang runs. Default is now OFF.
        // Set TM_AGENT_INCLUDE_CURATED=1 to re-enable the merge.
        const includeCuratedAgents =
          (process.env.TM_AGENT_INCLUDE_CURATED ?? "0") === "1";
        if (includeCuratedAgents) {
          await mergeAgentSpecs(project.id, genDest, path.join(outDir, "stdout.txt"));
        } else {
          await fs.writeFile(
            path.join(outDir, "stdout.txt"),
            `[runner] agent curated specs merge skipped (TM_AGENT_INCLUDE_CURATED!=1)\n`,
            { flag: "a" }
          );
        }

        // log a short catalog so we can see exactly what's about to run
        async function catalogSpecs(root: string, label: string) {
          const lines: string[] = [];
          const out: string[] = [];
          async function walk(p: string) {
            const entries = await fs.readdir(p, { withFileTypes: true }).catch(() => []);
            for (const e of entries as any[]) {
              const f = path.join(p, e.name);
              if (e.isDirectory()) await walk(f);
              else if (/\.(spec|test)\.(t|j)sx?$/i.test(e.name)) {
                out.push(f);
                try {
                  const txt = await fs.readFile(f, 'utf8');
                  const first = txt.split(/\r?\n/).slice(0, 2).join(' ');
                  lines.push(` - ${f}\n     preview: ${first.slice(0, 180)}`);
                } catch { }
              }
            }
          }
          await walk(root);
          await fs.writeFile(
            path.join(outDir, 'stdout.txt'),
            `[runner] ${label} specs (${out.length})\n${lines.join('\n')}\n`,
            { flag: 'a' }
          );
        }

        if (fsSync.existsSync(genDest)) {
          await catalogSpecs(genDest, 'FINAL');
        }

        async function logSpecs(root: string, label: string) {
          const out: string[] = [];
          const walk = async (p: string) => { for (const e of await fs.readdir(p, { withFileTypes: true }).catch(() => [] as any)) { const f = path.join(p, e.name); if (e.isDirectory()) await walk(f); else if (/\.(spec|test)\.(t|j)sx?$/i.test(e.name)) out.push(f) } };
          await walk(root);
          await fs.writeFile(path.join(outDir, "stdout.txt"), `[runner] ${label} specs (${out.length})\n` + out.map(x => ` - ${x}`).join("\n") + "\n", { flag: "a" });
        }
        await logSpecs(cwd, "apps/web");
        await logSpecs(genDest, "generated");

        // If the caller provided specific files, restrict to those
        if (!runAll && parsed.data.files && parsed.data.files.length) {
          const requested = new Set(parsed.data.files.map((f: string) => path.resolve(cwd, f)));
          // prune extraGlobs and force to requested (respect user-scoped generated dir)
          const genBase = path.posix.join("testmind-generated", genDestName);
          parsed.data.extraGlobs = parsed.data.files.map((f: string) =>
            path.posix.join(genBase, f.replace(/\\/g, "/"))
          );
        }

                  // --- build optional selectors (single-file + grep) ---
        const extraGlobs: string[] = [];
        // When runAll is true, ignore any file/grep filters from the UI.
        const requestedFiles = runAll
          ? []
          : (parsed.data.files && parsed.data.files.length
            ? parsed.data.files
            : [parsed.data.file, parsed.data.specPath].filter(Boolean as any)) as string[];

        const findByName = async (root: string, needle: string): Promise<string | null> => {
          try {
            const stack: string[] = [root];
            while (stack.length) {
              const dir = stack.pop() as string;
              const entries = await fs.readdir(dir, { withFileTypes: true });
              for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) stack.push(full);
                else if (e.isFile() && e.name === needle) return full;
              }
            }
          } catch { /* ignore */ }
          return null;
        };

        const resolveSelectedPath = (value: string) => {
          const posix = value.replace(/\\/g, "/");
          const candidates: string[] = [];
          if (path.isAbsolute(value)) candidates.push(value);

          let stripped = posix;
          const needles = [
            `apps/web/testmind-generated/${genDestName}/`,
            `apps/testmind-generated/${genDestName}/`,
            `testmind-generated/${genDestName}/`,
          ];
          for (const needle of needles) {
            const idx = posix.indexOf(needle);
            if (idx !== -1) {
              stripped = posix.slice(idx + needle.length);
              break;
            }
          }
          candidates.push(path.join(genDest, stripped));
          if (!generatedOnly) {
            candidates.push(path.join(cwd, posix));
          }

          for (const candidate of candidates) {
            if (fsSync.existsSync(candidate)) return candidate;
          }
          return null;
        };

        for (const selectedFile of requestedFiles) {
          if (!selectedFile) continue;
          const resolved = resolveSelectedPath(selectedFile);
          if (!resolved) {
            await fs.writeFile(
              path.join(outDir, "stdout.txt"),
              `[runner] selected file not found; skipping glob: ${selectedFile}\n`,
              { flag: "a" }
            );
            continue;
          }
          const normalizedFile = path.relative(genDest, resolved).replace(/\\/g, "/");
          let abs = resolved;
          const curatedSuiteDir = path.join(CURATED_ROOT, agentSuiteId(project.id));
          const curatedCandidate = path.join(curatedSuiteDir, normalizedFile);
          try {
            const exists = await fs.stat(abs).then(() => true).catch(() => false);
            if (!exists) {
              if (fsSync.existsSync(curatedCandidate)) {
                await fs.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
                await fs.cp(curatedCandidate, abs, { recursive: false });
              } else {
                // search all curated suites for the relative path
                const suites = fsSync.readdirSync(CURATED_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
                for (const s of suites) {
                  const candidate = path.join(CURATED_ROOT, s.name, normalizedFile);
                  if (fsSync.existsSync(candidate)) {
                    await fs.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
                    await fs.cp(candidate, abs, { recursive: false });
                    break;
                  }
                }
                // if still missing, try basename match anywhere under curated root
                const basename = path.basename(normalizedFile);
                const found = await findByName(CURATED_ROOT, basename);
                if (found && !fsSync.existsSync(abs)) {
                  await fs.mkdir(path.dirname(abs), { recursive: true }).catch(() => {});
                  await fs.cp(found, abs, { recursive: false });
                }
              }
            }
          } catch {
            // ignore copy failures
          }
          extraGlobs.push(abs.replace(/\\/g, "/"));
        }

        // normalize grep: Playwright matches against "path spec.ts Test title",
        // so a leading ^ breaks it. Strip ^ but keep the rest (including $).
        const normalizedGrep = runAll
          ? undefined
          : parsed.data.grep
            ? parsed.data.grep.replace(/^\^/, "")
            : undefined;

        const allureResultsDir = path.join(outDir, "allure-results");
        await fs.mkdir(allureResultsDir, { recursive: true });
        const projectSecrets = await prisma.projectSecret.findMany({
          where: { projectId: project.id },
          select: { key: true, value: true, name: true, id: true },
        });
        const secretEnv: Record<string, string> = {};
        for (const s of projectSecrets) {
          try {
            secretEnv[s.key] = decryptSecret(s.value);
          } catch (err: any) {
            await fs.writeFile(
              path.join(outDir, "stderr.txt"),
              `[runner] failed to decrypt secret ${s.name} (${s.id}): ${err?.message ?? err}\n`,
              { flag: "a" }
            );
          }
        }

        const extraEnv: Record<string, string> = {
          TM_SOURCE_ROOT: work,
          PW_JSON_OUTPUT: resultsPath,
          PW_ALLURE_RESULTS: allureResultsDir,
          ALLURE_RESULTS_DIR: allureResultsDir,
          TM_PORT: String(serverPort),
          ...secretEnv,
        };
        if (generatedOnly) {
          const binDir = path.join(cwd, "node_modules", ".bin");
          extraEnv.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
        }
        if (normalizedGrep) extraEnv.PW_GREP = normalizedGrep;
        const allureReportDir = path.join(outDir, "allure-report");
        let hasAllureResults = false;
        const skipAllure = (process.env.TM_SKIP_ALLURE ?? "0") === "1";

        const tRunStart = Date.now();
        const exec = await runTests({
          workdir: cwd,
          jsonOutPath: resultsPath,
          baseUrl: effectiveBaseUrl,
          configPath: ciConfigPath,
          // extraGlobs is no longer used by the runner; selection is via grep
          extraGlobs,
          extraEnv,
          grep: normalizedGrep,
          sourceRoot: work,
          headed: headful,
        });


        const selectedFilesForLog = requestedFiles.filter(Boolean);
        await fs.writeFile(
          path.join(outDir, "stdout.txt"),
          `[runner] exitCode=${exec.exitCode} baseUrl=${effectiveBaseUrl} headful=${headful} runAll=${runAll} files=${JSON.stringify(selectedFilesForLog)} grep=${parsed.data.grep || ""} extraGlobs=${JSON.stringify(extraGlobs)} durationMs=${Date.now() - tRunStart}\n`,
          { flag: "a" }
        );





        // Save raw logs (always)
        await fs.writeFile(path.join(outDir, "stdout.txt"), exec.stdout ?? "", { flag: "a" });
        await fs.writeFile(path.join(outDir, "stderr.txt"), exec.stderr ?? "");
        const exists = await fs.stat(resultsPath).then(() => true).catch(() => false);
        if (!exists) {
          await fs.writeFile(
            path.join(outDir, "stderr.txt"),
            `\n[runner] report.json missing - Playwright likely did not execute. Check dependency install and webServer.\n`,
            { flag: "a" }
          );
        }
        if (!skipAllure) {
          try {
            const allureEntries = await fs.readdir(allureResultsDir).catch(() => []);
            hasAllureResults = allureEntries.length > 0;
            if (hasAllureResults) {
              const allureTimeoutMs = Number(process.env.TM_ALLURE_TIMEOUT_MS ?? "120000");
              await fs.writeFile(
                path.join(outDir, "stdout.txt"),
                `[runner] allure generate queued (timeout ${allureTimeoutMs}ms)\n`,
                { flag: "a" }
              );
              await enqueueAllureGenerate({
                runId: run.id,
                cwd,
                allureResultsDir,
                allureReportDir,
                timeoutMs: allureTimeoutMs,
                stdoutPath: path.join(outDir, "stdout.txt"),
                stderrPath: path.join(outDir, "stderr.txt"),
              });
            }
          } catch (err: any) {
            await fs.writeFile(
              path.join(outDir, "stderr.txt"),
              `[runner] allure generate failed: ${err?.message || err}\n`,
              { flag: "a" }
            );
          }
        } else {
          await fs.writeFile(
            path.join(outDir, "stdout.txt"),
            "[runner] allure generate skipped (TM_SKIP_ALLURE=1)\n",
            { flag: "a" }
          );
        }


        // 4) Parse → DB (single source: resultsPath)
        let parsedCount = 0;
        let failed = 0;
        let passed = 0;
        let skipped = 0;

        const hasReport = await fs.stat(resultsPath).then(() => true).catch(() => false);
        if (hasReport) {
          const cases = await parseResults(resultsPath);

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

        artifacts = {
          "reportJson": path.join("runner-logs", run.id, "report.json"),
        };
        if (hasAllureResults) {
          artifacts["allure-results"] = path.join("runner-logs", run.id, "allure-results");
          artifacts["allure-report"] = path.join("runner-logs", run.id, "allure-report");
        }

        // 5) Mark run finished
        const ok = failed === 0 && ((exec.exitCode ?? 1) === 0);
        await prisma.testRun.update({
          where: { id: run.id },
          data: {
            status: ok ? TestRunStatus.succeeded : TestRunStatus.failed,
            finishedAt: new Date(),
            summary: JSON.stringify({
              framework: exec.framework,
              baseUrl: effectiveBaseUrl,
              parsedCount,
              passed,
              failed,
              skipped,
            }),
            error: ok ? null : stripAnsi(exec.stderr ?? "Test command failed"),
            artifactsJson: artifacts ?? undefined,
          },
        });
        if (!ok && failed > 0) {
          scheduleSelfHealingForRun(run.id).catch((err) => {
            console.error(`[runner] failed to schedule self heal for run ${run.id}`, err);
          });
        }
      } catch (err: any) {
        await prisma.testRun.update({
          where: { id: run.id },
          data: {
            status: TestRunStatus.failed,
            finishedAt: new Date(),
            error: stripAnsi(err?.message ?? String(err)),
            artifactsJson: artifacts ?? undefined,
          },
        });
      } finally {
        if (!usingLocalRepo) {
          await rmrf(work).catch(() => { });
        }
      }
    })().catch((err) => {
      // last safety net
      prisma.testRun
        .update({
          where: { id: run.id },
          data: {
            status: TestRunStatus.failed,
            finishedAt: new Date(),
            error: stripAnsi(err?.message || "Unexpected error in background runner"),
            artifactsJson: artifacts ?? undefined,
          },
        })
        .catch(() => { });
    });

    return reply.code(201).send({ id: run.id });
  });

  // GET /runner/test-runs
  app.get("/test-runs", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { projectId } = (req.query ?? {}) as { projectId?: string };
    const allowedProjects = await prisma.project.findMany({
      where: { ownerId: userId },
      select: { id: true },
    });
    const projectIds = allowedProjects.map((p) => p.id);
    if (!projectIds.length) return reply.send([]);

    const runs = await prisma.testRun.findMany({
      where: projectId
        ? { projectId, project: { ownerId: userId } }
        : { projectId: { in: projectIds } },
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
        artifactsJson: true,
      },
    });
    return reply.send(runs);
  });

  // GET /runner/test-runs/:id
  app.get("/test-runs/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { id } = req.params as { id: string };
    const run = await loadRunById(id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return reply.send({ run });
  });

  async function loadRunById(id: string) {
    const run = await prisma.testRun.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        rerunOf: { select: { id: true, status: true } },
        reruns: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            status: true,
            createdAt: true,
            startedAt: true,
            finishedAt: true,
          },
        },
        TestHealingAttempt: { select: { id: true, status: true } },
      },
    });
    if (!run) return null;
    const { TestHealingAttempt, ...rest } = run;
    return { ...rest, healingAttempts: TestHealingAttempt };
  }

  async function eventsHandler(req: any, reply: any) {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { id } = req.params as { id: string };
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    if (typeof (reply.raw as any).flushHeaders === "function") {
      (reply.raw as any).flushHeaders();
    }

    let closed = false;
    let interval: NodeJS.Timeout | undefined;
    const send = (payload: any) => {
      if (closed) return;
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const isActive = (run: any) => {
      if (!run) return false;
      if (run.status === "queued" || run.status === "running") return true;
      const reruns = run.reruns ?? [];
      const healingAttempts = run.healingAttempts ?? [];
      const rerunsInProgress = reruns.some(
        (r: any) => r.status === "running" || r.status === "queued"
      );
      const healingInProgress = healingAttempts.some(
        (a: any) => a.status === "running" || a.status === "queued"
      );
      return rerunsInProgress || healingInProgress;
    };

    const tick = async () => {
      try {
        const run = await loadRunById(id);
        if (!run) {
          send({ error: "Run not found" });
          return false;
        }
        send({ run });
        return isActive(run);
      } catch (err: any) {
        send({ error: err?.message ?? "Failed to load run" });
        return false;
      }
    };

    const active = await tick();
    if (active) {
      interval = setInterval(async () => {
        const stillActive = await tick();
        if (!stillActive) {
          if (interval) clearInterval(interval);
          if (!closed) reply.raw.end();
          closed = true;
        }
      }, 2000);
    } else {
      reply.raw.end();
      closed = true;
    }

    req.raw.on("close", () => {
      closed = true;
      if (interval) clearInterval(interval);
    });
  }

  app.get("/runner/test-runs/:id/events", eventsHandler);
  app.get("/test-runs/:id/events", eventsHandler);

  const RerunBody = z.object({
    specFile: z.string().min(1).optional(),
    grep: z.string().optional(),
  });

  app.post("/test-runs/:id/rerun", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await prisma.testRun.findUnique({
      where: { id },
      select: { id: true, projectId: true, paramsJson: true },
    });
    if (!run) return reply.code(404).send({ error: "Run not found" });

    const params = (run.paramsJson as any) ?? {};
    const headful = Boolean((params as any)?.headful);
    const suiteId = typeof (params as any)?.suiteId === "string" ? (params as any).suiteId : undefined;
    const rerunParams: Record<string, any> = { headful, suiteId };
    if ((params as any)?.baseUrl) rerunParams.baseUrl = (params as any).baseUrl;
    const parsedBody = RerunBody.safeParse(req.body ?? {});
    const specFile = parsedBody.success ? parsedBody.data.specFile : undefined;
    const grep = parsedBody.success ? parsedBody.data.grep : undefined;
    if (specFile) rerunParams.file = specFile;
    if (grep) rerunParams.grep = grep ?? undefined;
    const rerun = await prisma.testRun.create({
      data: {
        projectId: run.projectId,
        rerunOfId: run.id,
        status: TestRunStatus.running,
        startedAt: new Date(),
        trigger: "manual",
        paramsJson: rerunParams,
      },
    });

    await enqueueRun(rerun.id, {
      projectId: run.projectId,
      headed: headful,
      baseUrl: (params as any)?.baseUrl,
      file: specFile,
      grep,
    });
    return reply.send({ runId: rerun.id });
  });

  // GET /runner/test-runs/:id/logs?type=stdout|stderr
  app.get("/test-runs/:id/logs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { type } = (req.query ?? {}) as { type?: "stdout" | "stderr" };
    const run = await prisma.testRun.findUnique({ where: { id } });
    if (!run) return reply.code(404).send({ error: "Run not found" });

    const t = type === "stderr" ? "stderr" : "stdout";
    const candidateDirs = [
      RUNNER_LOGS_ROOT,
      path.join(process.cwd(), "runner-logs"),
      path.join(process.cwd(), "apps", "api", "runner-logs"),
    ];
    for (const base of candidateDirs) {
      const logPath = path.join(base, id, `${t}.txt`);
      try {
        const data = await fs.readFile(logPath, "utf8");
        reply.header("Content-Type", "text/plain; charset=utf-8");
        return reply.send(data);
      } catch {
        // try next location
      }
    }
    reply.header("Content-Type", "text/plain; charset=utf-8");
    return reply.send("");
  });

  // Serve runner artifacts (e.g., allure-report) directly from runner-logs
  app.get("/runner-logs/*", async (req, reply) => {
    const splat = (req.params as any)["*"] as string | undefined;
    const parts = (splat || "").split("/").filter(Boolean);
    const id = parts.shift();
    if (!id) return reply.code(404).send("Not found");
    const rest = parts.join("/");
    const roots = [
      RUNNER_LOGS_ROOT,
      path.join(process.cwd(), "runner-logs"),
      path.join(process.cwd(), "apps", "api", "runner-logs"),
    ];

    for (const root of roots) {
      const base = path.resolve(root, id);
      const target = path.resolve(base, rest);

      // Prevent path traversal
      if (!target.startsWith(base)) continue;

      let finalPath = target;
      try {
        const st = await fs.stat(finalPath);
        if (st.isDirectory()) {
          finalPath = path.join(finalPath, "index.html");
        }
      } catch {
        continue;
      }

      try {
        const data = await fs.readFile(finalPath);
        const ext = path.extname(finalPath).toLowerCase();
        const type =
          ext === ".html"
            ? "text/html"
            : ext === ".js"
            ? "application/javascript"
            : ext === ".css"
            ? "text/css"
            : ext === ".json"
            ? "application/json"
            : ext === ".svg"
            ? "image/svg+xml"
            : "application/octet-stream";
        reply.header("Content-Type", `${type}; charset=utf-8`);
        return reply.send(data);
      } catch {
        // try next root
      }
    }

    return reply.code(404).send("Not found");
  });

  // GET /runner/test-runs/:id/results
  // shared results handler so both paths work
  const resultsHandler = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };

    const exists = await prisma.testRun.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      return reply.code(404).send({ error: "Run not found" });
    }

    const rows = await prisma.testResult.findMany({
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

    const extras: Record<string, ParsedCase> = {};
    const reportRoots = [
      RUNNER_LOGS_ROOT,
      path.join(process.cwd(), "runner-logs"),
      path.join(process.cwd(), "apps", "api", "runner-logs"),
    ];
    const reportRoot =
      reportRoots.find((root) => fsSync.existsSync(path.join(root, id, "report.json"))) ??
      reportRoots[0];
    const reportPath = path.join(reportRoot, id, "report.json");
    try {
      const parsed = await parseResults(reportPath);
      for (const c of parsed) {
        extras[`${c.file}#${c.fullName}`] = c;
      }
    } catch {
      // ignore – enriched info optional
    }

    const results = rows.map((r) => {
      const extra = extras[r.testCase.key];
      return {
        id: r.id,
        status: r.status,
        durationMs: r.durationMs,
        message: r.message,
        case: r.testCase,
        steps: extra?.steps ?? [],
        stdout: extra?.stdout ?? [],
        stderr: extra?.stderr ?? [],
      };
    });

    return reply.send({ results });
  };
  app.get("/runner/test-runs/:id/results", resultsHandler);
  app.get("/test-runs/:id/results", resultsHandler);
  app.get("/test-runs/:id/report.json", async (req, reply) => {
    const { id } = req.params as { id: string };
    const candidates = [
      path.join(RUNNER_LOGS_ROOT, id, "report.json"),
      path.join(process.cwd(), "runner-logs", id, "report.json"),
      path.join(process.cwd(), "apps", "api", "runner-logs", id, "report.json"),
    ];
    for (const file of candidates) {
      try {
        const json = await fs.readFile(file, "utf8");
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(json);
      } catch {
        // try next candidate
      }
    }
    return reply.code(404).send({ ok: false, error: "report.json not found for this run" });
  });

  app.get("/test-runs/:id/analysis", async (req, reply) => {
    const { id } = req.params as { id: string };
    const paths = [
      path.join(RUNNER_LOGS_ROOT, id, "analysis.json"),
      path.join(process.cwd(), "runner-logs", id, "analysis.json"),
      path.join(process.cwd(), "apps", "api", "runner-logs", id, "analysis.json"),
    ];
    for (const p of paths) {
      try {
        const raw = await fs.readFile(p, "utf8");
        const analysis = JSON.parse(raw);
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ analysis });
      } catch {
        // try next
      }
    }
    return reply.code(404).send({ ok: false, error: "analysis not found for this run" });
  });

  // GET /projects/:id/specs  -> returns a tree of the generated specs
  app.get("/projects/:id/specs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    // We return the *logical* tree the runner uses: testmind-generated/playwright-ts
    // in the project's repo. If LOCAL mode is set, we use TM_LOCAL_SPECS.
    const tryPaths: string[] = [];
    if (process.env.TM_LOCAL_SPECS && fsSync.existsSync(process.env.TM_LOCAL_SPECS)) {
      tryPaths.push(path.resolve(process.env.TM_LOCAL_SPECS));
    }
    const userSuffix = project.ownerId ? `playwright-ts-${project.ownerId}` : "playwright-ts";
    tryPaths.push(
      path.join(GENERATED_ROOT, userSuffix),
      path.join(GENERATED_ROOT, "playwright-ts"),
      path.join(process.cwd(), "apps", "web", "testmind-generated", userSuffix),
      path.join(process.cwd(), "apps", "web", "testmind-generated", "playwright-ts"),
      path.join(process.cwd(), "apps", "api", "testmind-generated", "playwright-ts") // dev fallback
    );

    const root = tryPaths.find(p => fsSync.existsSync(p));
    if (!root) return reply.send({ files: [] });

    type Node = { name: string; path: string; type: "file" | "dir"; children?: Node[] };
    const walk = (p: string): Node => {
      const st = fsSync.statSync(p);
      if (st.isDirectory()) {
        const children = fsSync.readdirSync(p).map(n => walk(path.join(p, n)))
          .filter(n => n.type === "dir" || /\.(spec|test)\.(t|j)sx?$/i.test(n.name));
        return { name: path.basename(p), path: p, type: "dir", children };
      }
      return { name: path.basename(p), path: p, type: "file" };
    };

    const tree = walk(root);
    return reply.send({ root: tree });
  });


  // optional: keep the old path working too
  // app.get("/runner/test-runs/:id/report.json", async (req, reply) => {
  //   const { id } = req.params as { id: string };
  //   const file = path.join(process.cwd(), "runner-logs", id, "report.json");
  //   try {
  //     const json = await fs.readFile(file, "utf8");
  //     reply.header("Content-Type", "application/json; charset=utf-8");
  //     return reply.send(json);
  //   } catch {
  //     return reply.code(404).send({ ok: false, error: "report.json not found for this run" });
  //   }
  // });

// --- compat alias used by the current UI ---
app.get("/tm/runs/:id/tests", async (req, reply) => {
  const { id } = req.params as { id: string };
    const candidates = [
      path.join(RUNNER_LOGS_ROOT, id, "report.json"),
      path.join(process.cwd(), "runner-logs", id, "report.json"),
      path.join(process.cwd(), "apps", "api", "runner-logs", id, "report.json"),
  ];
  for (const file of candidates) {
    try {
      const json = await fs.readFile(file, "utf8");
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(json);
    } catch {
      // try next
    }
  }
  return reply.code(404).send({ ok: false, error: "report.json not found for this run" });
});

// Optional: simple human view to quickly eyeball failures
app.get("/test-runs/:id/view", async (req, reply) => {
  const { id } = req.params as { id: string };
    const candidates = [
      path.join(RUNNER_LOGS_ROOT, id, "report.json"),
      path.join(process.cwd(), "runner-logs", id, "report.json"),
      path.join(process.cwd(), "apps", "api", "runner-logs", id, "report.json"),
  ];
  let raw: string | null = null;
  for (const file of candidates) {
    try {
      raw = await fs.readFile(file, "utf8");
      break;
    } catch {
      // try next
    }
  }
  if (!raw) {
    return reply.code(404).send("No report.json for this run");
  }
  try {
    const data = JSON.parse(raw);
    const rows = (data.suites ?? []).flatMap((s: any) =>
      (s.specs ?? []).flatMap((sp: any) =>
        (sp.tests ?? []).map((t: any) => ({
          file: s.file, title: sp.title, status: t.results?.[0]?.status, duration: t.results?.[0]?.duration
        }))
      )
    );
    const html = `<!doctype html><meta charset="utf-8"><title>Run ${id}</title>
<style>body{font:14px system-ui} table{border-collapse:collapse} td,th{padding:6px 10px;border:1px solid #ddd}</style>
<h1>Run ${id}</h1>
<table><thead><tr><th>Status</th><th>Duration</th><th>Title</th><th>File</th></tr></thead>
<tbody>
${rows.map((r:any)=>`<tr><td>${r.status}</td><td>${r.duration ?? ""}</td><td>${r.title}</td><td>${r.file}</td></tr>`).join("")}
</tbody></table>`;
    reply.header("Content-Type", "text/html; charset=utf-8");
    return reply.send(html);
  } catch {
    return reply.code(404).send("No report.json for this run");
  }
});


}
