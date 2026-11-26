import fs from "node:fs";
import path from "node:path";
import { detectPackageManager, type PackageManager } from "./dev-agent-dependencies.js";
import { TEST_FILE_PATTERN } from "./dev-agent-objective.js";

// Auto-detects how to execute a repository's tests when the user gave no test command.
// Reads only package.json, lockfiles and the changed test files - never runs anything.
// No reliable command => null with a reason, and the run is reported 'unverified'.

export type TestFramework = "playwright" | "vitest" | "jest" | "node" | "script";
export type PackageTestCommand = { command: string; cwd: string; framework: TestFramework; reportPath?: string };

/** Native Node events in the existing Jest-compatible report format consumed by parseResults. */
export const NODE_TEST_REPORTER = `module.exports = async function* (source) {
  const files = new Map();
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    if (!d.file || d.details?.type === 'suite') continue;
    const cases = files.get(d.file) || [];
    cases.push({ title: d.name, fullName: d.name, status: d.skip || d.todo ? 'pending' : event.type === 'test:pass' ? 'passed' : 'failed', duration: d.details?.duration_ms,
      failureMessages: d.details?.error ? [d.details.error.stack || d.details.error.message || String(d.details.error)] : [] });
    files.set(d.file, cases);
  }
  yield JSON.stringify({ testResults: [...files].map(([name, assertionResults]) => ({ name, assertionResults })) });
};`;
export type DetectedTestCommand =
  | { command: string; framework: TestFramework; packageManager: PackageManager | null; reason: string; commands?: PackageTestCommand[] }
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
function detectPackageTestCommand(worktreePath: string, changedFiles: string[], opts: { outputDir?: string; packageManager?: PackageManager | null } = {}): DetectedTestCommand {
  const raw = readText(path.join(worktreePath, "package.json"));
  if (raw === null) return { command: null, reason: "No package.json in the repository, so no test framework or test command could be detected." };
  let pkg: any;
  try { pkg = JSON.parse(raw); } catch { return { command: null, reason: "package.json could not be parsed, so no test command could be detected." }; }

  const pm = detectPackageManager(worktreePath) ?? opts.packageManager ?? null;
  const exec = EXEC[pm ?? "npm"];
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) } as Record<string, string>;
  const pmLabel = pm ?? "npm (no lockfile)";

  // Only the test files this run created/modified that still exist - run them, not the whole suite.
  const specs = [...new Set(changedFiles.map((f) => f.replace(/\\/g, "/")))]
    .filter((f) => TEST_FILE_PATTERN.test(f) && fs.existsSync(path.join(worktreePath, f)));
  const playwrightSpecs = specs.filter((f) => PLAYWRIGHT_IMPORT.test(readText(path.join(worktreePath, f)) ?? ""));
  const nodeSpecs = specs.filter((f) => /["']node:test["']/.test(readText(path.join(worktreePath, f)) ?? ""));
  if (nodeSpecs.length === specs.length && specs.length) {
    const ts = specs.some((f) => /\.tsx?$/.test(f));
    if (ts && !deps.tsx) return { command: null, reason: "TypeScript node:test files require the repository's tsx dependency." };
    return { command: `${ts ? `${exec} tsx` : "node"} --test ${specs.map(quote).join(" ")}`, framework: "node", packageManager: pm ?? null, reason: "Node test runner, running the affected tests" };
  }

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
  return { command: null, reason: script && !NPM_PLACEHOLDER_TEST.test(script)
    ? "A test script exists but its scope is unknown. Provide a focused test command; the full regression suite is not selected automatically."
    : specs.length
      ? `Affected test files (${specs.join(", ")}) do not import a supported test runner. Use the nearest package's existing Node, Vitest, Jest, or Playwright convention with explicit imports.`
      : "No supported test framework was found for the affected tests." };
}

/** Resolve each affected test to its nearest package, preserving workspace configuration. */
export function detectTestCommand(worktreePath: string, changedFiles: string[], opts: { outputDir?: string } = {}): DetectedTestCommand {
  const root = path.resolve(worktreePath);
  const files = [...new Set(changedFiles.map((f) => f.replace(/\\/g, "/")))];
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const absolute = path.resolve(root, file);
    if (!absolute.startsWith(root + path.sep) || !TEST_FILE_PATTERN.test(file) || !fs.existsSync(absolute)) continue;
    let cwd = path.dirname(absolute);
    while (cwd !== root && !fs.existsSync(path.join(cwd, "package.json"))) cwd = path.dirname(cwd);
    const content = readText(absolute) ?? "";
    const family = PLAYWRIGHT_IMPORT.test(content) ? "playwright" : /["']node:test["']/.test(content) ? "node" : /["']vitest["']/.test(content) ? "vitest" : "unit";
    const key = `${cwd}\0${family}`;
    groups.set(key, [...(groups.get(key) ?? []), path.relative(cwd, absolute).replace(/\\/g, "/")]);
  }
  if (!groups.size) return { command: null, reason: fs.existsSync(path.join(root, "package.json")) ? "No affected test files were found. Provide a focused test command." : "No package.json or affected test files were found." };
  if (groups.size > 8) return { command: null, reason: "Affected tests exceed the eight-package verification limit; provide a focused command." };
  const commands: PackageTestCommand[] = [];
  let first: Extract<DetectedTestCommand, { command: string }> | undefined;
  for (const [key, specs] of groups) {
    const cwd = key.split("\0")[0];
    const detected = detectPackageTestCommand(cwd, specs, { ...opts, packageManager: detectPackageManager(root) });
    if (!("framework" in detected)) {
      if (cwd !== root && detected.provisionPlaywright) return { command: null, reason: `No Playwright setup in package ${path.relative(root, cwd)}; configure that package before verification.` };
      return detected;
    }
    first ??= detected;
    commands.push({ command: detected.command, cwd, framework: detected.framework });
  }
  return { ...first!, commands, reason: `${commands.length} affected package(s); ${first!.reason}` };
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
export function describeTestSetup(worktreePath: string, baseUrl: string | null = null, existingTestPaths: string[] = []): string {
  const raw = readText(path.join(worktreePath, "package.json"));
  let deps: Record<string, string> = {};
  try { const pkg = raw ? JSON.parse(raw) : {}; deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }; } catch { /* treated as no framework */ }
  // No live application: a repository task (website-test instructions never get this far
  // without a URL). Verification comes from the repository's own tests, not a live site.
  if (!baseUrl) {
    const samples = existingTestPaths.slice(0, 80).map((p) => readText(path.join(worktreePath, p)) ?? "");
    const conventions: string[] = [];
    if (samples.some((source) => /["']node:test["']/.test(source))) conventions.push('Node test runner (import test from "node:test" and assertions from "node:assert/strict")');
    if (samples.some((source) => /["']vitest["']/.test(source))) conventions.push('Vitest (import test APIs from "vitest")');
    if (samples.some((source) => /["'](?:@jest\/globals|jest)["']/.test(source))) conventions.push('Jest (import test APIs from "@jest/globals" when the package does not provide globals)');
    const hasBrowserTests = samples.some((source) => PLAYWRIGHT_IMPORT.test(source));
    return [
      "No live application is associated with this run: this is a repository task.",
      "Make the requested change in the repository and, where tests are relevant, add or update repository-level tests (unit/integration) with the repository's existing test tooling.",
      conventions.length
        ? `Observed repository test conventions: ${conventions.join("; ")}. Use the convention already present in the nearest package.`
        : "No source-level test convention was observed. Inspect the nearest package and an existing test before creating a new test file.",
      "Every test file must explicitly import its runner APIs. Do not invent Jest/Mocha globals such as describe, it, beforeEach, or page when that package does not configure them.",
      ...(hasBrowserTests ? ["Playwright/browser suites exist elsewhere in the repository, but this run has no authorized live URL; do not create or modify browser tests for this repository-only task."] : []),
      "Do not write browser or end-to-end tests that need a running site. A missing live site is not a reason to report blocked.",
    ].join(" ");
  }
  if (deps["@playwright/test"] || deps.playwright) {
    return [
      'This repository already uses Playwright. Write end-to-end tests as Playwright specs (*.spec.ts) in its existing test folder, importing from "@playwright/test", and follow its existing Playwright configuration.',
      `The application under test is at ${baseUrl}.`,
    ].join(" ");
  }
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
  const lines = String(output ?? "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.replace(/\s*─{3,}\s*$/, ""));
  const start = lines.findIndex((l) => FAILURE_START.test(l));
  const title = lines.find((l) => FAILING_TEST.test(l))?.trim();
  const body = start >= 0
    ? lines.slice(start, start + 8).map((l) => l.trim()).filter(Boolean).slice(0, 5)
    : lines.map((l) => l.trim()).filter(Boolean).slice(-3);
  const text = [title, ...body].filter((l, i, a) => l && a.indexOf(l) === i).join("\n").slice(0, 800);
  return text || null;
}
