// apps/api/src/runner/node-test-exec.ts
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createRequire } from "node:module";
import { execa } from "execa";

const multiFrameworkEnabled = (() => {
  const v = (process.env.TM_MULTI_FRAMEWORK || "").toLowerCase();
  return ["1", "true", "yes", "on"].includes(v);
})();

// Cap test command execution to avoid hung runs (default 10 minutes unless overridden).
const runTimeout =
  Number(process.env.TM_RUN_TIMEOUT ?? "") || 10 * 60 * 1000;

const require = createRequire(import.meta.url);

type FindConfigResult = { cwd: string; configPath: string } | null;

async function pathExists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// Find tm-ci.playwright.config.* or playwright.config.* under the workdir/apps/packages tree
async function findPlaywrightConfig(workdir: string): Promise<FindConfigResult> {
  const candidates: string[] = [];
  const exts = ["ts", "js", "cjs", "mjs"];

  for (const ext of exts) candidates.push(`tm-ci.playwright.config.${ext}`);
  for (const ext of exts) candidates.push(`playwright.config.${ext}`);

  const roots = [workdir, path.join(workdir, "apps"), path.join(workdir, "packages")];
  const queues: string[] = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    queues.push(root);

    if (root !== workdir) {
      try {
        const dirents = await fs.readdir(root, { withFileTypes: true });
        for (const d of dirents) {
          if (d.isDirectory()) queues.push(path.join(root, d.name));
        }
      } catch {
        // ignore
      }
    }
  }

  for (const dir of queues) {
    for (const name of candidates) {
      const p = path.join(dir, name);
      if (await pathExists(p)) return { cwd: dir, configPath: p };
    }
  }

  return null;
}

async function patchPreviewCommand(configPath: string) {
  try {
    const original = await fs.readFile(configPath, "utf8");
    let updated = original;
    const replacements: Array<[RegExp, string]> = [
      [/pnpm\s+preview/g, "pnpm dev --host 0.0.0.0"],
      [/vite\s+preview/g, "vite dev --host 0.0.0.0"],
    ];
    for (const [pattern, replacement] of replacements) {
      updated = updated.replace(pattern, `${replacement}`);
    }
    if (updated !== original) {
      await fs.writeFile(configPath, updated, "utf8");
    }
  } catch {
    // ignore patch failures; fall back to original command
  }
}

export type RunExecRequest = {
  workdir: string;              // repo root (temp clone)
  jsonOutPath: string;          // where to write report.json
  baseUrl?: string;             // e.g., http://localhost:5173
  extraGlobs?: string[];        // optional file globs/paths
  extraEnv?: Record<string, string>;
  grep?: string;                // optional test grep
  configPath?: string;
  sourceRoot?: string;
  headed?: boolean;
  runTimeout?: number;
  abortSignal?: AbortSignal;
};

export type RunExecResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  resultsPath?: string;
  framework: "playwright" | "vitest" | "jest" | "none";
};

function sanitizeForSpawnArg(value?: string | null): string | undefined {
  if (!value) return undefined;
  let s = String(value);
  s = s.replace(/^\uFEFF/, "");
  s = s.replace(/[\u200B-\u200F\u2060\uFEFF]/g, "");
  s = s.replace(/[\u0000-\u001F\u007F]/g, "");
  s = s.replace(/[\uD800-\uDFFF]/g, "");
  s = s.trim();
  return s.length ? s : undefined;
}

function findLatestPng(rootDir: string): string | null {
  const stack: string[] = [rootDir];
  let latestPath: string | null = null;
  let latestMtime = 0;
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".png")) continue;
      try {
        const stat = fsSync.statSync(full);
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs;
          latestPath = full;
        }
      } catch {
        // ignore unreadable files
      }
    }
  }
  return latestPath;
}

function startLivePreview(foundCwd: string, runLogDir: string, outputDir?: string) {
  const liveDir = path.join(runLogDir, "live");
  const latestTarget = path.join(liveDir, "latest.png");
  const resultsDir = outputDir
    ? path.resolve(outputDir)
    : path.join(foundCwd, "test-results");
  let lastCopied = "";
  const tick = () => {
    const latest = findLatestPng(resultsDir);
    if (!latest || latest === lastCopied) return;
    try {
      fsSync.mkdirSync(liveDir, { recursive: true });
      fsSync.copyFileSync(latest, latestTarget);
      lastCopied = latest;
    } catch {
      // ignore copy failures
    }
  };
  tick();
  const interval = setInterval(tick, 1000);
  return () => {
    tick();
    clearInterval(interval);
  };
}

export async function detectFramework(workdir: string): Promise<"playwright" | "vitest" | "jest" | "none"> {
  // If multi-framework is disabled, force Playwright.
  if (!multiFrameworkEnabled) {
    for (const ext of ["ts", "js", "cjs", "mjs"]) {
      if (await pathExists(path.join(workdir, `playwright.config.${ext}`))) return "playwright";
      if (await pathExists(path.join(workdir, `tm-ci.playwright.config.${ext}`))) return "playwright";
    }
    return "playwright";
  }

  // Prefer Playwright when configs exist
  for (const ext of ["ts", "js", "cjs", "mjs"]) {
    if (await pathExists(path.join(workdir, `playwright.config.${ext}`))) return "playwright";
    if (await pathExists(path.join(workdir, `tm-ci.playwright.config.${ext}`))) return "playwright";
  }

  // Check package.json for vitest / jest
  const pkgPath = path.join(workdir, "package.json");
  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    const has = (dep: string) => !!(pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]);
    if (has("vitest")) return "vitest";
    if (has("jest")) return "jest";
    const scr = pkg.scripts || {};
    if (/vitest/.test(String(scr.test || ""))) return "vitest";
    if (/jest/.test(String(scr.test || ""))) return "jest";
  } catch {
    // ignore
  }
  return "none";
}

export async function installDeps(repoRoot: string, workspaceCwd = repoRoot) {
  if (process.env.TM_REUSE_WORKSPACE === "1") {
    console.log("[runner] TM_REUSE_WORKSPACE=1 – skipping installDeps");
    return;
  }
  if (process.env.TM_LOCAL_REPO_ROOT) {
    console.log("[runner] TM_LOCAL_REPO_ROOT set - skipping installDeps");
    return;
  }
  if (process.env.TM_SKIP_INSTALL === "1") {
    console.log("[runner] TM_SKIP_INSTALL=1, skipping installDeps");
    return;
  }
  const has = (p: string) => fsSync.existsSync(path.join(repoRoot, p));

  let pm: "pnpm" | "yarn" | "npm";
  let installArgs: string[];

  if (has("pnpm-lock.yaml")) {
    pm = "pnpm";
    installArgs = ["install", "--silent"];
  } else if (has("yarn.lock")) {
    pm = "yarn";
    installArgs = ["install", "--silent", "--non-interactive"];
  } else if (has("package-lock.json")) {
    pm = "npm";
    installArgs = ["ci", "--silent"];
  } else {
    pm = "npm";
    installArgs = ["install", "--silent"];
  }

  await execa(pm, installArgs, { cwd: repoRoot, stdio: "pipe" });

  const canResolve = (pkg: string) => {
    try {
      require.resolve(pkg, { paths: [workspaceCwd] });
      return true;
    } catch {
      return false;
    }
  };

  const addPlaywright = async () => {
    const addArgs =
      pm === "pnpm"
        ? ["add", "-Dw", "@playwright/test"]
        : pm === "yarn"
        ? ["add", "-D", "@playwright/test"]
        : ["install", "-D", "@playwright/test"];

    await execa(pm, addArgs, { cwd: workspaceCwd, stdio: "pipe" });
  };

  if (!canResolve("@playwright/test")) {
    await addPlaywright();
  }

  const addDevDependency = async (pkg: string) => {
    const addArgs =
      pm === "pnpm"
        ? ["add", "-Dw", pkg]
        : pm === "yarn"
        ? ["add", "-D", pkg]
        : ["install", "-D", pkg];
    await execa(pm, addArgs, { cwd: workspaceCwd, stdio: "pipe" });
  };

  if (!canResolve("allure-playwright")) {
    await addDevDependency("allure-playwright");
  }

  if (!canResolve("allure-commandline")) {
    await addDevDependency("allure-commandline");
  }

  if (!canResolve("allure-js-commons")) {
    await addDevDependency("allure-js-commons");
  }

  try {
    const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
    await execa(npx, ["-y", "playwright", "install", "--with-deps"], {
      cwd: workspaceCwd,
      stdio: "pipe",
    });
  } catch {
    // non-fatal
  }
}

export async function runTests(req: RunExecRequest): Promise<RunExecResult> {
  const fw = await detectFramework(req.workdir);
  const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
  const normalizePath = (v: string) => v.replace(/\\/g, "/");

  // ---- Playwright path ----
  if (fw === "playwright") {
    const found = req.configPath
      ? { cwd: path.dirname(req.configPath), configPath: req.configPath }
      : await findPlaywrightConfig(req.workdir);

    if (!found) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: `No Playwright config found under ${req.workdir}`,
        framework: "playwright",
      };
    }

    await patchPreviewCommand(found.configPath);

    const env = {
      ...process.env,
      PW_BASE_URL: req.baseUrl ?? "",
      TM_BASE_URL: req.baseUrl ?? "",
      BASE_URL: req.baseUrl ?? "",
      TM_SOURCE_ROOT: req.extraEnv?.TM_SOURCE_ROOT ?? req.workdir,
      PW_JSON_OUTPUT: req.jsonOutPath,
      ALLURE_RESULTS_DIR: req.extraEnv?.PW_ALLURE_RESULTS || req.extraEnv?.ALLURE_RESULTS_DIR,
      ...(req.extraEnv || {}),
    };
    const nodePathParts = new Set<string>();
    const addNodePath = (p: string | undefined) => {
      if (!p) return;
      if (fsSync.existsSync(p)) nodePathParts.add(p);
    };
    const existingNodePath = env.NODE_PATH
      ? String(env.NODE_PATH)
          .split(path.delimiter)
          .map((p) => p.trim())
          .filter(Boolean)
      : [];
    for (const entry of existingNodePath) nodePathParts.add(entry);
    addNodePath(process.cwd());
    addNodePath(path.join(process.cwd(), "node_modules"));
    addNodePath(req.workdir);
    addNodePath(path.join(req.workdir, "node_modules"));
    if (nodePathParts.size) {
      env.NODE_PATH = Array.from(nodePathParts).join(path.delimiter);
    }

    const aiTestDir =
      req.extraEnv?.TM_TEST_DIR || process.env.TM_TEST_DIR || undefined;
    const isAiConfig =
      req.configPath && /tm-ai\.playwright\.config\./i.test(req.configPath);
    if (aiTestDir && isAiConfig) {
      found.cwd = path.resolve(aiTestDir);
      found.configPath = path.resolve(req.configPath as string);
    }
    const mapAiGlob = (g: string): string => {
      if (!aiTestDir) return g;
      const abs = path.isAbsolute(g) ? g : path.resolve(req.workdir, g);
      const relToAi = path.relative(aiTestDir, abs).replace(/\\/g, "/");
      if (relToAi.startsWith("..")) return g;
      return relToAi;
    };
    const mappedGlobs = (req.extraGlobs ?? []).map(mapAiGlob);

    const args: string[] = ["playwright", "test"];
    if (req.headed) {
      args.push("--headed");
    }

    if (req.grep) {
      const safeGrep = sanitizeForSpawnArg(req.grep);
      if (safeGrep) args.push("--grep", safeGrep);
    }

    if (mappedGlobs.length && !(aiTestDir && isAiConfig)) {
      for (const g of mappedGlobs) {
        // Playwright treats positional args as regex filters for test files.
        // Absolute paths or parent traversal often lead to "No tests found".
        if (path.isAbsolute(g)) continue;
        const n = normalizePath(g);
        if (n.startsWith("..")) continue;
        args.push(n);
      }
    }

    const configArg = path.isAbsolute(found.configPath)
      ? normalizePath(found.configPath)
      : normalizePath(path.relative(found.cwd, found.configPath));
    args.push("--config", configArg);

    const timeoutMs = req.runTimeout ?? runTimeout;

    const missingBrowserError = (text: string | undefined) =>
      !!text && /Executable doesn't exist|chrome-headless-shell/.test(text);

    const installBrowsers = async () => {
      try {
        await execa(npx, ["-y", "playwright", "install", "--with-deps"], {
          cwd: found.cwd,
          stdio: "pipe",
        });
      } catch {
        /* best effort */
      }
    };

    const finalArgs = args.filter((arg) => typeof arg === "string" && arg.length > 0);

    const debugSpawn = process.env.TM_DEBUG_SPAWN !== "0";
    const debugLines: string[] = [];
    if (debugSpawn) {
      const grepIdx = finalArgs.indexOf("--grep");
      const g = grepIdx >= 0 ? finalArgs[grepIdx + 1] : "";
      debugLines.push(`[spawn-debug] cwd=${found.cwd}`);
      debugLines.push(`[spawn-debug] args=${JSON.stringify([npx, ...finalArgs])}`);
      debugLines.push(`[spawn-debug] grep=${JSON.stringify(g)}`);
      debugLines.push(
        `[spawn-debug] grepCodepoints=${Array.from(g)
          .map((ch) => ch.codePointAt(0)?.toString(16))
          .join(" ")}`
      );
      const globHints = (req.extraGlobs ?? []).map((g) => {
        const mapped = mapAiGlob(g);
        const abs = path.isAbsolute(mapped) ? mapped : path.join(found.cwd, mapped);
        return { glob: g, exists: fsSync.existsSync(abs) };
      });
      if (globHints.length) {
        debugLines.push(`[spawn-debug] extraGlobs=${JSON.stringify(globHints)}`);
      }
      for (const line of debugLines) console.log(line);
    }

    const runPlaywright = () =>
      execa(npx, finalArgs, {
        cwd: found.cwd,
        env,
        reject: false,
        timeout: timeoutMs,
        cancelSignal: req.abortSignal,
        stdio: "pipe",
      });

    try {
      console.log("[dep-check] @playwright/test =", require.resolve("@playwright/test"));
    } catch (err: any) {
      console.log("[dep-check] @playwright/test NOT RESOLVABLE", err?.message ?? err);
    }

    const enableLivePreview =
      req.extraEnv?.TM_LIVE_PREVIEW === "1" && !!req.extraEnv?.TM_RUN_LOG_DIR;
    const outputDir = req.extraEnv?.PW_OUTPUT_DIR;
    const stopLivePreview = enableLivePreview
      ? startLivePreview(found.cwd, req.extraEnv?.TM_RUN_LOG_DIR as string, outputDir)
      : null;

    let proc = await runPlaywright();
    if (stopLivePreview) stopLivePreview();
    if (!req.extraEnv?.TM_SKIP_PLAYWRIGHT_INSTALL && missingBrowserError(proc.stderr)) {
      await installBrowsers();
      proc = await runPlaywright();
    }

    // Force reporters so JSON + allure artifacts are emitted
    
    const stdout = (debugLines.length ? `${debugLines.join("\n")}\n` : "") + (proc.stdout ?? "");
    let stderr = proc.stderr ?? "";
    if (/No tests found/i.test(stderr)) {
      const debugLines = [
        "[TESTMIND DEBUG]",
        `resolvedCwd=${found.cwd}`,
        `workdir=${req.workdir}`,
        `jsonOutPath=${req.jsonOutPath}`,
        `extraGlobs=${JSON.stringify(req.extraGlobs ?? [])}`,
        `baseUrl=${req.baseUrl ?? ""}`,
        `args=${JSON.stringify(args)}`,
      ];
      stderr += `\n${debugLines.join("\n")}`;
    }
    if (missingBrowserError(stderr)) {
      stderr +=
        "\nPlaywright browser binary missing. Run `npx playwright install --with-deps` on the machine to fetch a headless shell.";
    }

    let hasReport = await fs
      .stat(req.jsonOutPath)
      .then(() => true)
      .catch(() => false);

    // fallback: copy default json reporter output if present
    if (!hasReport) {
      const candidates = [
        path.join(found.cwd, "test-results.json"),
        path.join(found.cwd, "playwright-report", "test-results.json"),
      ];
      for (const c of candidates) {
        try {
          await fs.access(c);
          await fs.mkdir(path.dirname(req.jsonOutPath), { recursive: true }).catch(() => {});
          await fs.copyFile(c, req.jsonOutPath);
          hasReport = true;
          break;
        } catch {
          /* continue */
        }
      }
    }

    if (!hasReport) {
      try {
        await fs.mkdir(path.dirname(req.jsonOutPath), { recursive: true });
      } catch {}
      await fs.writeFile(
        req.jsonOutPath,
        JSON.stringify(
          {
            suites: [],
            errors: [{ message: "No Playwright JSON report produced" }],
            stats: { startTime: new Date().toISOString() },
          },
          null,
          2
        ),
        "utf8"
      );
    }

    return {
      ok: (proc.exitCode ?? 1) === 0,
      exitCode: proc.exitCode ?? null,
      stdout,
      stderr,
      resultsPath: req.jsonOutPath,
      framework: "playwright",
    };
  }

  // ---- Vitest path (requires TM_MULTI_FRAMEWORK=on) ----
  if (fw === "vitest") {
    const args: string[] = ["vitest", "run", "--reporter=json", `--outputFile=${req.jsonOutPath}`];
    if (req.grep) {
      args.push("--grep", req.grep);
    }
    if (req.extraGlobs && req.extraGlobs.length) {
      args.push(...req.extraGlobs);
    }
    const proc = await execa(npx, args, {
      cwd: req.workdir,
      env: { ...process.env, ...req.extraEnv },
      reject: false,
      timeout: runTimeout,
      cancelSignal: req.abortSignal,
      stdio: "pipe",
    });
    return {
      ok: (proc.exitCode ?? 1) === 0,
      exitCode: proc.exitCode ?? null,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
      resultsPath: req.jsonOutPath,
      framework: "vitest",
    };
  }

  // ---- Jest path (requires TM_MULTI_FRAMEWORK=on) ----
  if (fw === "jest") {
    const args: string[] = [
      "jest",
      "--runInBand",
      "--testLocationInResults",
      "--json",
      `--outputFile=${req.jsonOutPath}`,
    ];
    if (req.grep) args.push("--testNamePattern", req.grep);
    if (req.extraGlobs && req.extraGlobs.length) {
      args.push(...req.extraGlobs);
    }
    const proc = await execa(npx, args, {
      cwd: req.workdir,
      env: { ...process.env, ...req.extraEnv },
      reject: false,
      timeout: runTimeout,
      cancelSignal: req.abortSignal,
      stdio: "pipe",
    });
    return {
      ok: (proc.exitCode ?? 1) === 0,
      exitCode: proc.exitCode ?? null,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
      resultsPath: req.jsonOutPath,
      framework: "jest",
    };
  }

  // No supported framework
  return {
    ok: false,
    exitCode: 1,
    stdout: "",
    stderr: "Unsupported framework",
    framework: fw,
  };
}
