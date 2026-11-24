import fs from "node:fs";
import path from "node:path";
import { detectPackageManager, type PackageManager } from "./dev-agent-dependencies.js";
import { TEST_FILE_PATTERN } from "./dev-agent-objective.js";

// Auto-detects how to execute a repository's tests when the user gave no test command.
// Reads only package.json, lockfiles and the changed test files - never runs anything.
// No reliable command => null with a reason, and the run is reported 'unverified'.

export type TestFramework = "playwright" | "vitest" | "jest" | "script";
export type DetectedTestCommand =
  | { command: string; framework: TestFramework; packageManager: PackageManager | null; reason: string }
  | { command: null; reason: string; provisionPlaywright?: { specs: string[] } };

// npm's placeholder "test" script always fails; it is not a test configuration.
const NPM_PLACEHOLDER_TEST = /no test specified/i;

const EXEC: Record<PackageManager, string> = { pnpm: "pnpm exec", npm: "npx --no-install", yarn: "yarn", "yarn-berry": "yarn", bun: "bunx" };
const RUN_TEST: Record<PackageManager, string> = { pnpm: "pnpm test", npm: "npm test", yarn: "yarn test", "yarn-berry": "yarn test", bun: "bun run test" };

const quote = (p: string) => (/[\s"']/.test(p) ? `"${p.replace(/"/g, "")}"` : p);

function readText(file: string): string | null {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

const PLAYWRIGHT_IMPORT = /(from\s+|require\(\s*|import\(\s*)["']@?playwright\/test["']/;

/** Playwright output (traces, screenshots) goes to `outputDir`, outside the worktree, so it never enters the change. */
export function detectTestCommand(worktreePath: string, changedFiles: string[], opts: { outputDir?: string } = {}): DetectedTestCommand {
  const raw = readText(path.join(worktreePath, "package.json"));
  if (raw === null) return { command: null, reason: "No package.json in the repository, so no test framework or test command could be detected." };
  let pkg: any;
  try { pkg = JSON.parse(raw); } catch { return { command: null, reason: "package.json could not be parsed, so no test command could be detected." }; }

  const pm = detectPackageManager(worktreePath);
  const exec = EXEC[pm ?? "npm"];
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) } as Record<string, string>;
  const pmLabel = pm ?? "npm (no lockfile)";

  // Only the test files this run created/modified that still exist - run them, not the whole suite.
  const specs = [...new Set(changedFiles.map((f) => f.replace(/\\/g, "/")))]
    .filter((f) => TEST_FILE_PATTERN.test(f) && fs.existsSync(path.join(worktreePath, f)));
  const playwrightSpecs = specs.filter((f) => PLAYWRIGHT_IMPORT.test(readText(path.join(worktreePath, f)) ?? ""));

  if (playwrightSpecs.length) {
    if (!deps["@playwright/test"] && !deps.playwright) {
      return { command: null, provisionPlaywright: { specs: playwrightSpecs }, reason: `Generated Playwright tests (${playwrightSpecs.join(", ")}) but the repository has no Playwright test setup.` };
    }
    const out = opts.outputDir ? ` --output ${quote(opts.outputDir.replace(/\\/g, "/"))}` : "";
    return { command: `${exec} playwright test ${playwrightSpecs.map(quote).join(" ")}${out}`, framework: "playwright", packageManager: pm, reason: `Playwright (@playwright/test) via ${pmLabel}, running the generated specs` };
  }
  if (specs.length && deps.vitest) {
    return { command: `${exec} vitest run ${specs.map(quote).join(" ")}`, framework: "vitest", packageManager: pm, reason: `Vitest via ${pmLabel}, running the changed tests` };
  }
  if (specs.length && deps.jest) {
    return { command: `${exec} jest ${specs.map(quote).join(" ")}`, framework: "jest", packageManager: pm, reason: `Jest via ${pmLabel}, running the changed tests` };
  }
  const script = typeof pkg?.scripts?.test === "string" ? pkg.scripts.test.trim() : "";
  if (script && !NPM_PLACEHOLDER_TEST.test(script)) {
    return { command: RUN_TEST[pm ?? "npm"], framework: "script", packageManager: pm, reason: `package.json "test" script via ${pmLabel}` };
  }
  return { command: null, reason: "No executable test configuration was found (no supported test framework for the changed files and no package.json \"test\" script)." };
}

/** One instruction for the code phase: which test framework generated tests must use. */
export function describeTestSetup(worktreePath: string): string {
  const raw = readText(path.join(worktreePath, "package.json"));
  let deps: Record<string, string> = {};
  try { const pkg = raw ? JSON.parse(raw) : {}; deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }; } catch { /* treated as no framework */ }
  if (deps["@playwright/test"] || deps.playwright) {
    return 'This repository already uses Playwright. Write end-to-end tests as Playwright specs (*.spec.ts) in its existing test folder, importing from "@playwright/test".';
  }
  const other = deps.vitest ? "Vitest" : deps.jest ? "Jest" : null;
  return [
    other ? `This repository uses ${other} for unit tests but has no end-to-end test framework.` : "This repository has no test framework.",
    'Write end-to-end tests as Playwright specs: files under e2e/ named *.spec.ts, importing { test, expect } from "@playwright/test".',
    'Use relative paths with page.goto (for example page.goto("/")) - the base URL is configured for you.',
    "Do not add package.json, lockfile or Playwright config changes - TestMind provisions a minimal Playwright setup and discloses it in the proposal.",
  ].join(" ");
}
