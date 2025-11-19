// apps/api/src/runner/node-test-exec.ts
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { execa } from "execa";

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
  extraGlobs?: string[];        // (IGNORED for now – we run the whole suite)
  extraEnv?: Record<string, string>;
  grep?: string;                // (IGNORED for now)
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
  for (const ext of ["ts", "js", "cjs", "mjs"]) {
    if (await pathExists(path.join(workdir, `playwright.config.${ext}`))) return "playwright";
    if (await pathExists(path.join(workdir, `tm-ci.playwright.config.${ext}`))) return "playwright";
  }
  return "playwright";
}

export async function installDeps(repoRoot: string, workspaceCwd = repoRoot) {
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
  if (fw !== "playwright") {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "Unsupported framework",
      framework: fw,
    };
  }

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
    ...(req.extraEnv || {}),
  };

    const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
  const normalizePath = (v: string) => v.replace(/\\/g, "/");

  // ---- CLI args ----
  const args: string[] = ["playwright", "test"];
  if (req.headed) {
    args.push("--headed");
  }

  // 🔹 Use grep to select individual tests, not path-based "globs"
  if (req.grep) {
    args.push("--grep", req.grep);
  }

  args.push(
    "--config",
    normalizePath(path.relative(found.cwd, found.configPath))
  );


  console.log("[runner] cwd =", found.cwd);
  console.log("[runner] args =", JSON.stringify(args));


  const proc = await execa(npx, args, {
    cwd: found.cwd,
    env,
    reject: false,
    timeout: 0,
    stdio: "pipe",
  });

  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";

  const hasReport = await fs
    .stat(req.jsonOutPath)
    .then(() => true)
    .catch(() => false);

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

