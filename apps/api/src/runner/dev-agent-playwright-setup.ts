import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execa } from "execa";
import { snippet } from "../security/redaction.js";
import { detectPackageManager, type PackageManager } from "./dev-agent-dependencies.js";
import { buildSandboxEnv, envInt, runSandboxed } from "./dev-agent-sandbox.js";

// Minimal Playwright setup for a repository that has no test framework, added inside the run's
// temporary worktree only. Everything it writes (devDependency, lockfile, config, script) is a
// normal repository change: committed on the run branch and disclosed in the draft PR proposal.

const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 4000;
export const PLAYWRIGHT_CONFIG_FILE = "playwright.config.ts";
const CONFIG_NAMES = ["ts", "js", "mjs", "cjs", "mts", "cts"].map((e) => `playwright.config.${e}`);

/** TestMind's own pinned @playwright/test version: its browsers are already installed (no download). */
export function testmindPlaywrightVersion(): string {
  const require = createRequire(import.meta.url);
  let dir = path.dirname(require.resolve("@playwright/test"));
  for (let i = 0; i < 5; i++, dir = path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg?.name === "@playwright/test" && typeof pkg.version === "string") return pkg.version;
    }
  }
  throw new Error("Could not determine TestMind's @playwright/test version");
}

/** Directory holding all generated specs (their common ancestor), used as the config's testDir. */
export function commonSpecDir(specs: string[]): string {
  const dirs = specs.map((s) => path.posix.dirname(s.replace(/\\/g, "/")).split("/").filter((p) => p && p !== "."));
  if (!dirs.length) return ".";
  const out: string[] = [];
  for (let i = 0; dirs.every((d) => d[i] !== undefined && d[i] === dirs[0][i]); i++) out.push(dirs[0][i]);
  return out.length ? `./${out.join("/")}` : ".";
}

export function playwrightConfigSource(opts: { baseUrl: string | null; testDir: string }): string {
  const baseURL = opts.baseUrl ? `process.env.BASE_URL || ${JSON.stringify(opts.baseUrl)}` : "process.env.BASE_URL";
  return [
    `import { defineConfig, devices } from "@playwright/test";`,
    ``,
    `// Minimal end-to-end test setup added by TestMind Dev Agent. Run with: npm run test:e2e`,
    `export default defineConfig({`,
    `  testDir: ${JSON.stringify(opts.testDir)},`,
    `  testIgnore: ["**/node_modules/**"],`,
    `  timeout: 30_000,`,
    `  retries: 0,`,
    `  reporter: "list",`,
    `  use: { baseURL: ${baseURL}, trace: "retain-on-failure" },`,
    `  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],`,
    `});`,
    ``,
  ].join("\n");
}

const ADD_COMMANDS: Record<PackageManager, (spec: string) => { bin: string; args: string[] }> = {
  npm: (s) => ({ bin: "npm", args: ["install", "--save-dev", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", s] }),
  pnpm: (s) => ({ bin: "pnpm", args: ["add", "--save-dev", "--save-exact", "--ignore-scripts", s] }),
  yarn: (s) => ({ bin: "yarn", args: ["add", "--dev", "--exact", "--ignore-scripts", "--non-interactive", s] }),
  "yarn-berry": (s) => ({ bin: "yarn", args: ["add", "--dev", "--exact", s] }),
  bun: (s) => ({ bin: "bun", args: ["add", "--dev", "--exact", "--ignore-scripts", s] }),
};

export type PlaywrightProvisionResult =
  | { ok: true; dependency: string; files: string[]; output: string }
  | { ok: false; error: string };

export async function provisionPlaywrightSetup(worktreePath: string, opts: { baseUrl: string | null; specs: string[] }): Promise<PlaywrightProvisionResult> {
  const pkgPath = path.join(worktreePath, "package.json");
  if (!fs.existsSync(pkgPath)) fs.writeFileSync(pkgPath, `${JSON.stringify({ name: "e2e-tests", private: true }, null, 2)}\n`);

  // Installed packages must never become part of the proposed change, even if the repo's own
  // .gitignore does not exclude them (local, uncommitted exclude in the run's git dir).
  const ignored = await execa("git", ["check-ignore", "-q", "node_modules"], { cwd: worktreePath, reject: false });
  if (ignored.exitCode !== 0) {
    const excl = (await execa("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: worktreePath })).stdout.trim();
    const abs = path.resolve(worktreePath, excl);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, "\nnode_modules/\n");
  }

  let version: string;
  try { version = testmindPlaywrightVersion(); } catch (err: any) { return { ok: false, error: err?.message ?? String(err) }; }
  const dependency = `@playwright/test@${version}`;
  const pm = detectPackageManager(worktreePath) ?? "npm";
  const { bin, args } = ADD_COMMANDS[pm](dependency);
  const label = `${bin} ${args.join(" ")}`;
  const timeoutMs = envInt("DEV_AGENT_INSTALL_TIMEOUT_MS", DEFAULT_INSTALL_TIMEOUT_MS);
  const result = await runSandboxed(bin, args, {
    cwd: worktreePath,
    timeoutMs,
    maxOutputChars: MAX_OUTPUT_CHARS,
    env: buildSandboxEnv({ CI: "true", HUSKY: "0", npm_config_ignore_scripts: "true", YARN_ENABLE_SCRIPTS: "false", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" }),
  });
  if (result.timedOut) return { ok: false, error: `Installing ${dependency} timed out after ${timeoutMs}ms (${label}); process tree killed.` };
  if (result.spawnError) return { ok: false, error: `Installing ${dependency} failed to run (${label}): ${snippet(result.spawnError, MAX_OUTPUT_CHARS)}` };
  if (result.exitCode !== 0) return { ok: false, error: `${label} exited ${result.exitCode}: ${snippet(result.output, MAX_OUTPUT_CHARS)}` };

  if (!CONFIG_NAMES.some((n) => fs.existsSync(path.join(worktreePath, n)))) {
    fs.writeFileSync(path.join(worktreePath, PLAYWRIGHT_CONFIG_FILE), playwrightConfigSource({ baseUrl: opts.baseUrl, testDir: commonSpecDir(opts.specs) }));
  }
  const raw = fs.readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw);
  if (!pkg.scripts?.["test:e2e"]) {
    pkg.scripts = { ...(pkg.scripts ?? {}), "test:e2e": "playwright test" };
    const indent = /^\{\r?\n([ \t]+)"/.exec(raw)?.[1] ?? "  ";
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}${raw.endsWith("\n") ? "\n" : ""}`);
  }

  const status = await execa("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: worktreePath });
  const files = status.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, "")).filter((p) => !opts.specs.includes(p));
  return { ok: true, dependency, files, output: `${label}: ok` };
}
