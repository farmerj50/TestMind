// apps/api/src/routes/run.ts
import type { FastifyInstance } from "fastify";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { z } from "zod";
import { prisma } from "../prisma";
import { TestRunStatus, TestResultStatus } from "@prisma/client";

// runner pieces
import { makeWorkdir, rmrf } from "../runner/workdir";
import { cloneRepo } from "../runner/git";
import { runTests } from "../runner/node-test-exec";
import { execa } from "execa";

import { parseResults } from "../runner/result-parsers";

// Minimal, workspace-aware dependency installer
// replace your installDeps with this
async function installDeps(repoRoot: string, workspaceCwd: string) {
  const has = (p: string) => fsSync.existsSync(path.join(repoRoot, p));

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

  // install at the **repo root** so workspaces are wired correctly
  await execa(pm, installArgs, { cwd: repoRoot, stdio: "pipe" });

  // ensure @playwright/test is resolvable from the **workspace cwd**
  const canResolve = () => {
    try { require.resolve("@playwright/test", { paths: [workspaceCwd] }); return true; }
    catch { return false; }
  };

  if (!canResolve()) {
    const addArgs =
      pm === "pnpm" ? ["add", "-D", "@playwright/test"] :
        pm === "yarn" ? ["add", "-D", "@playwright/test"] :
          ["install", "-D", "@playwright/test"];

    await execa(pm, addArgs, { cwd: workspaceCwd, stdio: "pipe" });
  }
  try {
  const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
  await execa(npx, ["-y", "playwright", "install", "--with-deps"], {
    cwd: workspaceCwd,
    stdio: "pipe",
  });
} catch { /* non-fatal; Playwright may already be installed */ }
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

  // Prefer a folder that contains a Playwright config (CI config first).
  const prefer = ["tm-ci.playwright.config.ts", "tm-ci.playwright.config.mjs", "tm-ci.playwright.config.js",
    "playwright.config.ts", "playwright.config.mjs", "playwright.config.js", "playwright.config.cjs"];

  for (const sub of candidates) {
    const cwd = path.join(repoRoot, sub);
    for (const fname of prefer) {
      if (fsSync.existsSync(path.join(cwd, fname))) {
        return { subdir: sub, configPath: path.join(cwd, fname) };
      }
    }
  }

  // If no config found, pick any workspace that declares @playwright/test
  for (const sub of candidates) {
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
  baseUrl: z.string().url().optional(), // optional override
  file: z.string().optional(),   // relative path to spec to run
  grep: z.string().optional(),   // test title to match
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
    const providedBaseUrl = parsed.data.baseUrl ?? DEFAULT_BASE_URL;

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
      const work = await makeWorkdir(); // where we clone the repo
      try {
        // GitHub token if connected
        const gitAcct = await prisma.gitAccount.findFirst({
          where: { userId: project.ownerId, provider: "github" },
          select: { token: true },
        });

        // 1) Clone
        await cloneRepo(project.repoUrl, work, gitAcct?.token || undefined);

        // 2) Install deps
        // await installDeps(work);

        // 3) Detect + run (object signature) and force JSON output to outDir/report.json
        // 3) Run tests (runner auto-finds the correct Playwright config) and write JSON to outDir/report.json
        // 2) Detect the correct workspace that contains Playwright (e.g., apps/web)
        // 2) Detect the correct workspace (e.g., apps/web) and switch cwd there
        // 2) Detect the workspace that contains Playwright and switch cwd to it
        const { subdir: appSubdir } = await findPlaywrightWorkspace(work);
        const cwd = path.resolve(work, appSubdir);

        // breadcrumbs for debugging
        await fs.writeFile(
          path.join(outDir, "stdout.txt"),
          `[runner] repoRoot=${work}\n[runner] workdir=${cwd}\n`,
          { flag: "a" }
        );


        // 3) Install deps in the workspace (this is what was missing)
        await installDeps(work, cwd);
        // If this workspace is a Vite app and Playwright's webServer uses "vite preview",
        // do a build first so preview has static assets.
        if (
          fsSync.existsSync(path.join(cwd, "vite.config.ts")) ||
          fsSync.existsSync(path.join(cwd, "vite.config.js")) ||
          fsSync.existsSync(path.join(cwd, "vite.config.mts")) ||
          fsSync.existsSync(path.join(cwd, "vite.config.mjs")) ||
          fsSync.existsSync(path.join(cwd, "vite.config.cjs"))
        ) {
          try {
            const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
            await execa(npx, ["-y", "vite", "build"], { cwd, stdio: "pipe" });
            await fs.writeFile(
              path.join(outDir, "stdout.txt"),
              "[runner] vite build completed\n",
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
        }


        // 4) Run tests and force JSON to outDir/report.json
        const resultsPath = path.join(outDir, "report.json");
        process.env.PW_BASE_URL = providedBaseUrl;
        process.env.TM_BASE_URL = providedBaseUrl;


        // inside apps/api/src/routes/run.ts, after: const cwd = path.resolve(work, appSubdir);
        const ciConfigPath = path.join(cwd, "tm-ci.playwright.config.ts");
        // when building ciConfig:
        const ciConfig = `import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PW_BASE_URL || process.env.TM_BASE_URL || 'http://localhost:4173';
const GEN_DIR = path.resolve(DIR, 'testmind-generated', 'playwright-ts');

// Optional grep forwarded via env PW_GREP (plain string -> RegExp)
const GREP = process.env.PW_GREP ? new RegExp(process.env.PW_GREP) : undefined;

export default defineConfig({
  use: { baseURL: BASE },
  grep: GREP,
  webServer: { command: 'vite preview --port 4173', port: 4173, reuseExistingServer: true },
  testIgnore: ['**/node_modules/**','**/dist/**','**/build/**','**/.*/**'],
  projects: [{
    name: 'generated',
    testDir: GEN_DIR,
    testMatch: ['**/*.spec.ts','**/*.test.ts'],
    timeout: 30_000,
  }],
});`;



        await fs.writeFile(ciConfigPath, ciConfig, "utf8");
        // --- bring generated specs into the temp workspace ---
        // destination inside the workspace
        const genDest = path.join(cwd, 'testmind-generated', 'playwright-ts');

        // resolve source based on env
        const MODE = (process.env.TM_SPECS_MODE || 'auto').toLowerCase() as 'auto' | 'local' | 'repo';
        const localPath = process.env.TM_LOCAL_SPECS && fsSync.existsSync(process.env.TM_LOCAL_SPECS)
          ? path.resolve(process.env.TM_LOCAL_SPECS)
          : null;
        const repoPath = path.join(work, 'apps', 'api', 'testmind-generated', 'playwright-ts');
        const repoAlt = path.join(work, 'testmind-generated', 'playwright-ts');

        function pickSource(): string | null {
          if (MODE === 'local') return localPath;
          if (MODE === 'repo') return fsSync.existsSync(repoPath) ? repoPath : (fsSync.existsSync(repoAlt) ? repoAlt : null);
          // auto
          return fsSync.existsSync(repoPath) ? repoPath
            : fsSync.existsSync(repoAlt) ? repoAlt
              : localPath;
        }

        // always clean the repo-copy roots to avoid stale mixes
        const repoRoot1 = path.join(work, 'apps', 'api', 'testmind-generated');
        const repoRoot2 = path.join(work, 'testmind-generated');
        try { await fs.rm(repoRoot1, { recursive: true, force: true }); } catch { }
        try { await fs.rm(repoRoot2, { recursive: true, force: true }); } catch { }

        // wipe destination if requested
        if ((process.env.TM_CLEAN_DEST || '1') !== '0') {
          try { await fs.rm(genDest, { recursive: true, force: true }); } catch { }
        }

        const srcPicked = pickSource();
        if (!srcPicked) {
          await fs.writeFile(path.join(outDir, 'stderr.txt'),
            `[runner] NO SPECS SOURCE FOUND. MODE=${MODE} local=${localPath || 'null'} repo=${repoPath} or ${repoAlt}\n`,
            { flag: 'a' });
        } else {
          await fs.mkdir(genDest, { recursive: true });
          // @ts-ignore Node 18+
          await fs.cp(srcPicked, genDest, { recursive: true });
          await fs.writeFile(path.join(outDir, 'stdout.txt'),
            `[runner] specs source=${srcPicked} -> dest=${genDest}\n`,
            { flag: 'a' });
        }

        // log a short catalog so we can see exactly what’s about to run
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
          // optional guard: if user forced local, ensure JusticePath text didn’t sneak in
          if ((MODE === 'local') && process.env.TM_FAIL_ON_JP === '1') {
            const jpHit = await (async () => {
              const files: string[] = [];
              const read = async (p: string) => {
                const ents = await fs.readdir(p, { withFileTypes: true });
                for (const e of ents as any[]) {
                  const f = path.join(p, e.name);
                  if (e.isDirectory()) await read(f);
                  else if (/\.(spec|test)\.(t|j)sx?$/i.test(e.name)) {
                    const t = await fs.readFile(f, 'utf8').catch(() => '');
                    if (t.includes('JusticePath — Accessible Legal Help')) files.push(f);
                  }
                }
              };
              await read(genDest);
              return files;
            })();
            if (jpHit.length) {
              await fs.writeFile(path.join(outDir, 'stderr.txt'),
                `[runner] ABORT: JusticePath strings found in LOCAL mode:\n${jpHit.join('\n')}\n`,
                { flag: 'a' });
              throw new Error('Spec source contamination detected (JusticePath markers present during LOCAL mode).');
            }
          }
        }

        async function logSpecs(root: string, label: string) {
          const out: string[] = [];
          const walk = async (p: string) => { for (const e of await fs.readdir(p, { withFileTypes: true }).catch(() => [] as any)) { const f = path.join(p, e.name); if (e.isDirectory()) await walk(f); else if (/\.(spec|test)\.(t|j)sx?$/i.test(e.name)) out.push(f) } };
          await walk(root);
          await fs.writeFile(path.join(outDir, "stdout.txt"), `[runner] ${label} specs (${out.length})\n` + out.map(x => ` - ${x}`).join("\n") + "\n", { flag: "a" });
        }
        await logSpecs(cwd, "apps/web");
        await logSpecs(path.join(cwd, "testmind-generated", "playwright-ts"), "generated");

        // --- build optional selectors (single-file + grep) ---
        const extraGlobs: string[] = [];
        if (parsed.data.file) {
          // parsed.data.file is relative to the generated root (e.g. "home.spec.ts" or "auth/login.spec.ts")
          const abs = path.join(genDest, parsed.data.file);
          const relFromCwd = path.relative(cwd, abs).replace(/\\/g, "/");
          extraGlobs.push(relFromCwd);
        }

        const extraEnv: Record<string, string> = { TM_SOURCE_ROOT: work };
        if (parsed.data.grep) extraEnv.PW_GREP = parsed.data.grep;


        const exec = await runTests({
          workdir: cwd,
          jsonOutPath: resultsPath,
          baseUrl: providedBaseUrl,
          configPath: ciConfigPath,
          extraGlobs,
          extraEnv,
          sourceRoot: work,
        });

        await fs.writeFile(path.join(outDir, 'stdout.txt'),
          `[runner] exitCode=${exec.exitCode} baseUrl=${providedBaseUrl} extraGlobs=${JSON.stringify(extraGlobs)} grep=${parsed.data.grep || ''}\n`,
          { flag: 'a' });





        // Save raw logs (always)
        await fs.writeFile(path.join(outDir, "stdout.txt"), exec.stdout ?? "", { flag: "a" });
        await fs.writeFile(path.join(outDir, "stderr.txt"), exec.stderr ?? "");
        const exists = await fs.stat(resultsPath).then(() => true).catch(() => false);
        if (!exists) {
          await fs.writeFile(
            path.join(outDir, "stderr.txt"),
            `\n[runner] report.json missing – Playwright likely didn’t execute. Check dependency install and webServer.\n`,
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

        // 5) Mark run finished
        const ok = failed === 0 && ((exec.exitCode ?? 1) === 0);
        await prisma.testRun.update({
          where: { id: run.id },
          data: {
            status: ok ? TestRunStatus.succeeded : TestRunStatus.failed,
            finishedAt: new Date(),
            summary: JSON.stringify({
              framework: exec.framework,
              baseUrl: providedBaseUrl,
              parsedCount,
              passed,
              failed,
              skipped,
            }),
            error: ok ? null : (exec.stderr ?? "Test command failed"),
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
  };
  app.get("/runner/test-runs/:id/results", resultsHandler);
  app.get("/test-runs/:id/results", resultsHandler);
  app.get("/test-runs/:id/report.json", async (req, reply) => {
    const { id } = req.params as { id: string };
    const file = path.join(process.cwd(), "runner-logs", id, "report.json");
    try {
      const json = await fs.readFile(file, "utf8");
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(json);
    } catch {
      return reply.code(404).send({ ok: false, error: "report.json not found for this run" });
    }
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
    tryPaths.push(
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
  const file = path.join(process.cwd(), "runner-logs", id, "report.json");
  try {
    const json = await fs.readFile(file, "utf8");
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send(json);
  } catch {
    return reply.code(404).send({ ok: false, error: "report.json not found for this run" });
  }
});

// Optional: simple human view to quickly eyeball failures
app.get("/test-runs/:id/view", async (req, reply) => {
  const { id } = req.params as { id: string };
  const file = path.join(process.cwd(), "runner-logs", id, "report.json");
  try {
    const raw = await fs.readFile(file, "utf8");
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
