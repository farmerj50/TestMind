import fs from "node:fs";
import path from "node:path";
import { snippet } from "../security/redaction.js";
import { buildSandboxEnv, envInt, runSandboxed } from "./dev-agent-sandbox.js";

export type PackageManager = "pnpm" | "npm" | "yarn" | "yarn-berry" | "bun";

export type DependencyProvisionResult =
  | { ok: true; packageManager: PackageManager | null }
  | { ok: false; error: string };

const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_INSTALL_OUTPUT_CHARS = 4000;

// Lockfile presence is the only signal used - never "whichever manager happens to be on
// PATH" - so the exact dependency graph the repo already committed to is what gets
// installed, not something re-resolved from package.json ranges.
const LOCKFILES: Array<{ file: string; packageManager: PackageManager }> = [
  { file: "pnpm-lock.yaml", packageManager: "pnpm" },
  { file: "package-lock.json", packageManager: "npm" },
  { file: "npm-shrinkwrap.json", packageManager: "npm" },
  { file: "yarn.lock", packageManager: "yarn" },
  { file: "bun.lock", packageManager: "bun" },
  { file: "bun.lockb", packageManager: "bun" },
];

// Yarn 2+ ("Berry") uses a different CLI than classic Yarn 1 (--immutable, not
// --frozen-lockfile; scripts disabled via --mode=skip-build, not --ignore-scripts).
function isYarnBerry(repoPath: string): boolean {
  if (fs.existsSync(path.join(repoPath, ".yarnrc.yml"))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, "package.json"), "utf8"));
    const m = typeof pkg?.packageManager === "string" ? /^yarn@(\d+)/.exec(pkg.packageManager) : null;
    return !!m && Number(m[1]) >= 2;
  } catch {
    return false;
  }
}

export function detectPackageManager(repoPath: string): PackageManager | null {
  for (const { file, packageManager } of LOCKFILES) {
    if (fs.existsSync(path.join(repoPath, file))) {
      if (packageManager === "yarn" && isYarnBerry(repoPath)) return "yarn-berry";
      return packageManager;
    }
  }
  return null;
}

// Every command is lockfile-frozen (fails rather than re-resolving) and has lifecycle
// scripts disabled, so an untrusted dependency's install/postinstall hooks never execute.
const INSTALL_COMMANDS: Record<PackageManager, { bin: string; args: string[] }> = {
  pnpm: { bin: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"] },
  npm: { bin: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] },
  yarn: { bin: "yarn", args: ["install", "--frozen-lockfile", "--ignore-scripts", "--non-interactive"] },
  "yarn-berry": { bin: "yarn", args: ["install", "--immutable", "--mode=skip-build"] },
  bun: { bin: "bun", args: ["install", "--frozen-lockfile", "--ignore-scripts"] },
};

// Reproducible, lockfile-based dependency installation inside an already-created,
// already-owned dev-agent worktree. Never copies/junctions/symlinks node_modules from the
// main repository - pnpm's own content-addressable global store (a separate, standard
// pnpm mechanism, not "the main repo's node_modules") is what makes a repeat install of an
// already-seen lockfile fast; npm/yarn/bun install for real from their own caches.
// Runs under the shared sandbox: allowlisted env (no API secrets), process-tree timeout,
// bounded output, Node heap cap.
export async function provisionWorktreeDependencies(worktreePath: string): Promise<DependencyProvisionResult> {
  const hasPackageJson = fs.existsSync(path.join(worktreePath, "package.json"));
  if (!hasPackageJson) return { ok: true, packageManager: null }; // not every target repo is a JS project

  const packageManager = detectPackageManager(worktreePath);
  if (!packageManager) {
    return {
      ok: false,
      error: "package.json exists but no recognized lockfile (pnpm-lock.yaml, package-lock.json, npm-shrinkwrap.json, yarn.lock, bun.lock, bun.lockb) was found - refusing to install without one, since that would re-resolve versions instead of reproducing a known-good dependency graph.",
    };
  }

  const { bin, args } = INSTALL_COMMANDS[packageManager];
  const label = `${bin} ${args.join(" ")}`;
  const timeoutMs = envInt("DEV_AGENT_INSTALL_TIMEOUT_MS", DEFAULT_INSTALL_TIMEOUT_MS);
  const result = await runSandboxed(bin, args, {
    cwd: worktreePath,
    timeoutMs,
    maxOutputChars: MAX_INSTALL_OUTPUT_CHARS,
    env: buildSandboxEnv({
      CI: "true",
      HUSKY: "0",
      // Defense-in-depth beyond the CLI flags above.
      npm_config_ignore_scripts: "true",
      YARN_ENABLE_SCRIPTS: "false",
      YARN_ENABLE_IMMUTABLE_INSTALLS: "true",
      // Playwright's own browser download is a separate, explicit step - never implicit.
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    }),
  });

  if (result.timedOut) {
    return { ok: false, error: `Dependency installation timed out after ${timeoutMs}ms (${label}); process tree killed.` };
  }
  if (result.spawnError) {
    return { ok: false, error: `Dependency installation failed to run (${label}): ${snippet(result.spawnError, MAX_INSTALL_OUTPUT_CHARS)}` };
  }
  if (result.exitCode !== 0) {
    return { ok: false, error: `${label} exited ${result.exitCode}: ${snippet(result.output, MAX_INSTALL_OUTPUT_CHARS)}` };
  }
  return { ok: true, packageManager };
}
