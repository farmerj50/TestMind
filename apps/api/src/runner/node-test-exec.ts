// apps/api/src/runner/node-test-exec.ts
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { execa } from "execa";

const multiFrameworkEnabled = (() => {
  const v = (process.env.TM_MULTI_FRAMEWORK || "").toLowerCase();
  return ["1", "true", "yes", "on"].includes(v);
})();

// Cap test command execution to avoid hung runs (default 10 minutes unless overridden).
const runTimeout =
  Number(process.env.TM_RUN_TIMEOUT ?? "") || 10 * 60 * 1000;

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
};

export type RunExecResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  resultsPath?: string;
  framework: "playwright" | "vitest" | "jest" | "none";
};

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

    const args: string[] = ["playwright", "test"];
    if (req.headed) {
      args.push("--headed");
    }

    if (req.grep) {
      args.push("--grep", req.grep);
    }

    if (req.extraGlobs && req.extraGlobs.length) {
      for (const g of req.extraGlobs) {
        const rel = path.isAbsolute(g) ? normalizePath(path.relative(found.cwd, g)) : normalizePath(g);
        args.push(rel);
      }
    }

    args.push(
      "--config",
      normalizePath(path.relative(found.cwd, found.configPath))
    );

    // Force reporters so JSON + allure artifacts are emitted
    const proc = await execa(npx, args, {
      cwd: found.cwd,
      env,
      reject: false,
      timeout: runTimeout,
      stdio: "pipe",
    });

    const stdout = proc.stdout ?? "";
    const stderr = proc.stderr ?? "";

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


