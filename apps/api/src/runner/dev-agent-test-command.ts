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

export const NO_APP_URL_REASON =
  "No authorized application URL is configured for this run, its environment, or the project, so website tests cannot be generated or executed. Set the application URL on the run or the project and start the run again.";

const TEST_INTENT = /\b(tests?|testing|specs?|verify|verifies|check|assert|e2e|qa)\b/i;
const WEB_TARGET = /\b(e2e|end[- ]to[- ]end|playwright|browser|web ?site|web ?app|web ?page|pages?|ui|buttons?|links?|forms?|log ?in|sign ?(up|in)|checkout|navigat\w*|click\w*|landing|home ?page|screens?|modals?|menus?|headings?)\b/i;
/** True when the instruction asks for website (browser) tests, which need an authorized application URL. */
export function requiresApplicationUrl(instructionText: string | null | undefined): boolean {
  const t = instructionText ?? "";
  return TEST_INTENT.test(t) && WEB_TARGET.test(t);
}

/** One instruction for the code phase: which test framework generated tests must use, and the real app URL (if any). */
export function describeTestSetup(worktreePath: string, baseUrl: string | null = null): string {
  const raw = readText(path.join(worktreePath, "package.json"));
  let deps: Record<string, string> = {};
  try { const pkg = raw ? JSON.parse(raw) : {}; deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }; } catch { /* treated as no framework */ }
  const noUrl = 'No application URL is configured for this run: do not write browser/website tests. If the instruction requires testing a website, respond with ONLY {"blocked": true, "reason": "No application URL is configured"}.';
  if (deps["@playwright/test"] || deps.playwright) {
    return [
      'This repository already uses Playwright. Write end-to-end tests as Playwright specs (*.spec.ts) in its existing test folder, importing from "@playwright/test", and follow its existing Playwright configuration.',
      baseUrl ? `The application under test is at ${baseUrl}.` : "No application URL is configured for this run; rely only on the repository's own Playwright configuration.",
    ].join(" ");
  }
  if (!baseUrl) return noUrl;
  const other = deps.vitest ? "Vitest" : deps.jest ? "Jest" : null;
  return [
    other ? `This repository uses ${other} for unit tests but has no end-to-end test framework.` : "This repository has no test framework.",
    'Write end-to-end tests as Playwright specs: files under e2e/ named *.spec.ts, importing { test, expect } from "@playwright/test".',
    `Use relative paths with page.goto (for example page.goto("/")) - baseURL is configured to ${baseUrl}.`,
    "Do not add package.json, lockfile or Playwright config changes - TestMind provisions a minimal Playwright setup and discloses it in the proposal.",
  ].join(" ");
}

const FAILURE_START = /^\s*(\w*Error\b.*:|Error:|Test timeout of|No tests found|.*could not determine executable|.*Executable doesn't exist|.*Cannot find module|Test command (timed out|killed|failed to start)|Invalid test command)/;
const FAILING_TEST = /^\s*(✘|\d+\)\s+\[|\d+\)\s+\S+\.(spec|test)\.)/;
/** The actual error from a failed test run (first error and its key detail lines), for display. */
export function summarizeTestFailure(output: string | null | undefined): string | null {
  const lines = String(output ?? "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/);
  const start = lines.findIndex((l) => FAILURE_START.test(l));
  const title = lines.find((l) => FAILING_TEST.test(l))?.trim();
  const body = start >= 0
    ? lines.slice(start, start + 8).map((l) => l.trim()).filter(Boolean).slice(0, 5)
    : lines.map((l) => l.trim()).filter(Boolean).slice(-3);
  const text = [title, ...body].filter((l, i, a) => l && a.indexOf(l) === i).join("\n").slice(0, 800);
  return text || null;
}
