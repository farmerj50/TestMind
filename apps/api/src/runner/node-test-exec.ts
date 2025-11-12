import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";

type FindConfigResult = { cwd: string; configPath: string } | null;

async function pathExists(p: string) {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function findPlaywrightConfig(workdir: string): Promise<FindConfigResult> {
  // prefer tm-ci config anywhere in the repo
  const candidates: string[] = [];

  const exts = ["ts","js","cjs","mjs"];
  for (const ext of exts) candidates.push(`tm-ci.playwright.config.${ext}`);
  for (const ext of exts) candidates.push(`playwright.config.${ext}`);

  // Breadth-first walk a shallow tree to avoid heavy recursion:
  // repo root + common monorepo dirs
  const roots = [workdir, path.join(workdir, "apps"), path.join(workdir, "packages")];
  const queues: string[] = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    queues.push(root);
    // push children one level deep if apps/packages
    if (root !== workdir) {
      try {
        const dirents = await fs.readdir(root, { withFileTypes: true });
        for (const d of dirents) if (d.isDirectory()) queues.push(path.join(root, d.name));
      } catch {}
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

export type RunExecRequest = {
  workdir: string;              // repo root (temp clone)
  jsonOutPath: string;          // where to write report.json
  baseUrl?: string;             // e.g., http://localhost:5173
  extraGlobs?: string[];              // <--- NEW
  extraEnv?: Record<string, string>;  // <--- NEW
  configPath?: string; 
  sourceRoot?: string;  
};

export type RunExecResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  resultsPath?: string;         // equals jsonOutPath when present
  framework: "playwright" | "vitest" | "jest" | "none";
};

export async function detectFramework(workdir: string): Promise<"playwright"|"vitest"|"jest"|"none"> {
  // super simple – you already had a version of this
  for (const ext of ["ts","js","cjs","mjs"]) {
    if (await pathExists(path.join(workdir, `playwright.config.${ext}`))) return "playwright";
  }
  return "playwright"; // we only support PW for now
}

export async function runTests(req: RunExecRequest): Promise<RunExecResult> {
  const fw = await detectFramework(req.workdir);
  if (fw !== "playwright") {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Unsupported framework", framework: fw };
  }

  // locate config
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

  const env = {
    ...process.env,
    PW_BASE_URL: req.baseUrl ?? "",
    TM_BASE_URL: req.baseUrl ?? "",
    BASE_URL: req.baseUrl ?? "",
    TM_SOURCE_ROOT: (req as any).extraEnv?.TM_SOURCE_ROOT ?? req.workdir,
    ...(req as any).extraEnv || {},
  };

  const npx = process.platform.startsWith("win") ? "npx.cmd" : "npx";
  const toPosix = (p: string) => p.replace(/\\/g, "/");

  const args = ["playwright", "test", "--config", found.configPath, "--reporter", "json"];
  if (req.extraGlobs?.length) args.push(...req.extraGlobs.map(toPosix));

  const proc = await execa(npx, args, {
    cwd: found.cwd,
    env,
    reject: false,
    timeout: 0,
    stdio: "pipe",
  });

  // ---- persist reporter output ----
  try { await fs.writeFile(req.jsonOutPath, proc.stdout ?? ""); } catch {}

  // ---- guarantee a report exists so UI link never 404s ----
  try { await fs.mkdir(path.dirname(req.jsonOutPath), { recursive: true }); } catch {}
  const hasReport = await fs.stat(req.jsonOutPath).then(() => true).catch(() => false);
  if (!hasReport) {
    await fs.writeFile(
      req.jsonOutPath,
      JSON.stringify(
        {
          config: {},
          suites: [],
          errors: [{ message: "No tests executed" }],
          stats: { startTime: new Date().toISOString() },
        },
        null,
        2
      ),
      "utf8"
    );
  }

  // ---- final result ----
  return {
    ok: (proc.exitCode ?? 1) === 0,
    exitCode: proc.exitCode ?? null,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    resultsPath: req.jsonOutPath,
    framework: "playwright",
  };
}

