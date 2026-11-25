import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { prisma } from "../prisma.js";
import { createDevAgentWorktree, removeDevAgentWorktree } from "./dev-agent-worktree.js";
import { canAffordNextStep, CONSERVATIVE_LLM_STEP_ESTIMATE_USD, callOpenAiAndTrackCost, resolveRealOpenAiClient } from "./dev-agent-budget.js";
import { applyFileOps, commitChanges, parseFileOps } from "./dev-agent-apply.js";
import { snippet } from "../security/redaction.js";
import { discoverSite, type RouteScan } from "../testmind/discover.js";
import { validateUrl } from "../lib/safe-fetch.js";
import { isLikelyGitRepoUrl } from "../lib/git-url.js";
import { listGeneratedSpecFiles } from "../testmind/generated-files.js";
import { DEFAULT_FRAMEWORK_ID } from "@testmind/core/framework";
import { provisionWorktreeDependencies, type DependencyProvisionResult } from "./dev-agent-dependencies.js";
import { buildSandboxEnv, envInt, parseCommandLine, runSandboxed } from "./dev-agent-sandbox.js";
import os from "node:os";
import { extractFailureDetail, failureSignature } from "./dev-agent-repair-feedback.js";
import { parseTestOutcomes, saveGeneratedSpecsToSuite, suiteRelDir } from "./dev-agent-suite.js";
import { describeTestSetup, detectTestCommand, NO_APP_URL_REASON, requiresApplicationUrl, summarizeTestFailure, type DetectedTestCommand } from "./dev-agent-test-command.js";
import { provisionPlaywrightSetup, type PlaywrightProvisionResult } from "./dev-agent-playwright-setup.js";
import { checkObjectiveAlignment, extractAssertionTargets, TEST_FILE_PATTERN, type AssertionTarget, type ObjectiveCheck } from "./dev-agent-objective.js";

const TICK_DELAY_MS = 2000;
const PAUSE_RECHECK_MS = 5000;
const MAX_TEST_OUTPUT_CHARS = 4000;
const DEFAULT_TEST_TIMEOUT_MS = 15 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 30_000;
const DISCOVERY_MAX_PAGES = 20;
const MAX_PROMPT_ROUTES = 15;
const MAX_PROMPT_TEST_PATHS = 50;

type OpJobCtx = { id: string; projectId: string; type: string; requestedBy: string | null };
type ReDelayFn = (ms: number, phase: { kind: "dev_agent_iterate"; devAgentRunId: string }) => Promise<never>;

export type RequestApprovalFn = (opts: {
  jobId: string;
  taskId?: string;
  requestedBy: string;
  actionType: "run_terminal" | "git_push" | "patch_code" | "security_active_test";
  description: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
}) => Promise<"approved">;

// `blocked` is set (and no files were written) when the model reports the requested
// feature/element does not exist on the target.
export type CodePhaseResult = { summary: string; filesChanged: import("./dev-agent-apply.js").AppliedFileChange[]; costUsd: number; blocked?: string };
export type CodePhaseFn = (ctx: { run: any; iterationNumber: number; worktreePath: string }) => Promise<CodePhaseResult>;

export type TestCommandResult = { passed: boolean; output: string };
export type RunTestCommandFn = (worktreePath: string, command: string, devAgentRunId: string) => Promise<TestCommandResult>;

// Trimmed, prompt-safe summary of a live crawl - never the raw RouteScan[] (unbounded size).
export type DiscoveryPromptContext = {
  baseUrl: string;
  totalRoutes: number;
  routes: Array<{
    path: string;
    status: number;
    headings: string[];
    formCount: number;
    formFields: string[];
    buttons: string[];
  }>;
};

// Why no grounded site context is available for this run - surfaced in the prompt and
// cached alongside the result, so a lack of grounding is always stated, never implied away.
export type DiscoveryUnavailableReason = "no-base-url" | "blocked" | "timeout" | "crawl-error";

export type DiscoveryState = {
  context: DiscoveryPromptContext | null;
  unavailableReason: DiscoveryUnavailableReason | null;
};

export type ResolveDiscoveryFn = (baseUrl: string) => Promise<DiscoveryState>;

export type PriorIterationContext = {
  iterationNumber: number;
  summary: string | null;
  testOutput: string | null;
  filesChanged: string[];
  /** The actual test failure block (error, locator, expected/received, location, stack), cleaned. */
  failureDetail?: string | null;
  /** Current content of the test files under repair, so the repair edits what actually failed. */
  failingTestFiles?: Array<{ path: string; content: string }>;
};

const MAX_REPAIR_FILE_CHARS = 6000;

export type ProvisionDependenciesFn = (worktreePath: string) => Promise<DependencyProvisionResult>;

export type DevAgentDeps = {
  requestApproval?: RequestApprovalFn;
  codePhase?: CodePhaseFn;
  runTestCommand?: RunTestCommandFn;
  resolveDiscovery?: ResolveDiscoveryFn;
  provisionDependencies?: ProvisionDependenciesFn;
  detectTestCommand?: (worktreePath: string, changedFiles: string[], opts?: { outputDir?: string }) => DetectedTestCommand;
  provisionPlaywright?: (worktreePath: string, opts: { baseUrl: string | null; specs: string[] }) => Promise<PlaywrightProvisionResult>;
  resolveBaseUrl?: (run: { baseUrl: string | null; environmentId: string | null; projectId: string }) => Promise<string | undefined>;
  saveSpecs?: (run: { id: string; projectId: string; requestedBy: string }, files: Array<{ path: string; content?: string }>) => string[];
};

// Default "code" phase: a real LLM call via the budget-tracked path, whose response is
// now actually applied as real file writes/deletes in the worktree and committed on the
// run's own branch - closing the gap the prior stage flagged (cost-tracked LLM call existed,
// but nothing was written to disk). The contract (dev-agent-apply.ts's FileOp[]) is enforced
// strictly: a malformed or path-unsafe response throws (InvalidFileOpsError) rather than
// silently doing nothing or writing something unsafe - advanceDevAgentJob below treats that
// the same as any other code-phase failure: fail closed, record the attempt, don't retry blindly.
const CODE_PHASE_SYSTEM_PROMPT = [
  "You are an autonomous coding agent working in an isolated git worktree.",
  'Respond with ONLY a JSON array of file operations, no prose, no markdown fence: [{"path":"relative/path.ts","action":"create"|"modify"|"delete","content":"...full file content, required for create/modify..."}]',
  "Paths must be relative to the repo root and must never contain '..' or start with '/'.",
  "Preserve the original objective: when repairing a failing test you may fix selectors, waits, navigation, or implementation errors, but you must NOT change which feature, element, text, or behavior is asserted, and must not skip, negate, or delete the test.",
  "In Playwright tests prefer resilient, accessible locators (getByRole with a name, getByLabel, getByText, getByPlaceholder) over guessed tag or CSS selectors.",
  'If the requested feature or element does not exist on the target (per the site context or the failure output), do not substitute a different one - respond with ONLY {"blocked": true, "reason": "..."} instead of file operations.',
].join(" ");

// The model's explicit "the requested thing doesn't exist" signal - returns the reason, or
// null if the response is not a blocked signal (normal file-ops parsing applies then).
export function parseBlockedSignal(raw: string): string | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object" && parsed.blocked === true) {
      return snippet(typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason : "no reason given", 1000);
    }
  } catch { /* not JSON - parseFileOps reports the real error */ }
  return null;
}

// Base URL resolution precedence - same convention operator-worker.ts already uses in
// several places (explicit field -> project's established app URL conventions), reused
// rather than reinvented. Returns undefined (never throws) when nothing resolves; the
// caller treats that as "no live site for this run," not an error.
async function resolveBaseUrlForRun(run: {
  baseUrl: string | null;
  environmentId: string | null;
  projectId: string;
}): Promise<string | undefined> {
  if (run.baseUrl?.trim()) return run.baseUrl.trim();
  if (run.environmentId) {
    const env = await prisma.environment.findUnique({ where: { id: run.environmentId }, select: { baseUrl: true } });
    if (env?.baseUrl?.trim()) return env.baseUrl.trim();
  }
  const project = await prisma.project.findUnique({ where: { id: run.projectId }, select: { sharedSteps: true, repoUrl: true } });
  const sharedBaseUrl = (project?.sharedSteps as any)?.baseUrl;
  if (typeof sharedBaseUrl === "string" && sharedBaseUrl.trim()) return sharedBaseUrl.trim();
  const repoUrl = project?.repoUrl?.trim() ?? "";
  if (repoUrl && !isLikelyGitRepoUrl(repoUrl) && /^https?:\/\//i.test(repoUrl)) return repoUrl;
  return undefined;
}

function routePathFromScan(scan: RouteScan): string {
  try {
    return new URL(scan.finalUrl || scan.url).pathname || "/";
  } catch {
    return scan.url;
  }
}

// Trims an unbounded RouteScan[] down to a small, prompt-safe shape. Never store/forward
// raw scans (textSnippets/controls can be large per page) - only what a code-generation
// prompt actually needs to avoid hallucinating pages/selectors that don't exist.
function summarizeDiscoveryForPrompt(baseUrl: string, scans: RouteScan[]): DiscoveryPromptContext {
  const top = scans.slice(0, MAX_PROMPT_ROUTES);
  return {
    baseUrl,
    totalRoutes: scans.length,
    routes: top.map((scan) => {
      const formFieldNames = new Set<string>();
      for (const form of scan.forms ?? []) for (const field of form.fields ?? []) if (field.name) formFieldNames.add(field.name);
      for (const field of scan.fields ?? []) if (field.name) formFieldNames.add(field.name);
      return {
        path: routePathFromScan(scan),
        status: scan.status,
        headings: (scan.headings ?? []).slice(0, 2),
        formCount: scan.forms?.length ?? (scan.fields?.length ? 1 : 0),
        formFields: Array.from(formFieldNames).slice(0, 10),
        buttons: (scan.buttons ?? []).slice(0, 5),
      };
    }),
  };
}

// Real implementation: SSRF-guards the target (reusing the same validateUrl guard
// testmind/runtime/live-page-probe.ts already applies before driving a real browser to a
// URL), bounds crawl duration via discoverSite's existing AbortSignal plumbing, and bounds
// crawl breadth via maxPages. A rejected/failed/timed-out crawl is reported with a reason,
// never silently treated as "nothing to discover."
const defaultResolveDiscovery: ResolveDiscoveryFn = async (baseUrl) => {
  try {
    await validateUrl(baseUrl);
  } catch (err: any) {
    console.warn(`[dev-agent-worker] discovery target rejected: ${err?.message ?? err}`);
    return { context: null, unavailableReason: "blocked" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const { scans } = await discoverSite(baseUrl, [], { maxPages: DISCOVERY_MAX_PAGES, signal: controller.signal });
    return { context: summarizeDiscoveryForPrompt(baseUrl, scans), unavailableReason: null };
  } catch (err: any) {
    console.warn(`[dev-agent-worker] discovery failed for ${baseUrl}: ${err?.message ?? err}`);
    return { context: null, unavailableReason: controller.signal.aborted ? "timeout" : "crawl-error" };
  } finally {
    clearTimeout(timer);
  }
};

// Runs once per run (called only from the queued->running transition below), never
// per-iteration. Best-effort: a missing/unauthorized/unreachable site must never fail
// the run - it only means the prompt gets an explicit "no live grounding" note instead.
async function resolveDiscoveryContext(
  run: { id: string; baseUrl: string | null; environmentId: string | null; projectId: string },
  deps: DevAgentDeps
): Promise<DiscoveryState> {
  const baseUrl = await resolveBaseUrlForRun(run);
  if (!baseUrl) return { context: null, unavailableReason: "no-base-url" };
  const resolveDiscovery = deps.resolveDiscovery ?? defaultResolveDiscovery;
  try {
    return await resolveDiscovery(baseUrl);
  } catch (err: any) {
    console.warn(`[dev-agent-worker] resolveDiscovery threw for run ${run.id}: ${err?.message ?? err}`);
    return { context: null, unavailableReason: "crawl-error" };
  }
}

const TEST_FILE_RE = /\.(spec|test)\.(ts|tsx|js|jsx|mjs|py)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

// Bounded, path-only walk of the dev-agent's own worktree (the target repo's real existing
// tests), separate from TestMind's own GENERATED_ROOT specs - the two can be entirely
// different sets. Bounded on both files and depth so a huge/adversarial tree can't make a
// single prompt-assembly call expensive or unbounded.
export function listRepoTestFiles(worktreePath: string, opts: { maxFiles?: number; maxDepth?: number } = {}): string[] {
  const maxFiles = opts.maxFiles ?? 300;
  const maxDepth = opts.maxDepth ?? 8;
  const results: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (results.length >= maxFiles || depth > maxDepth) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (results.length >= maxFiles) return;
      if (SKIP_DIRS.has(name)) continue;
      const abs = path.join(dir, name);
      const rel2 = rel ? `${rel}/${name}` : name;
      let isDir: boolean;
      try {
        isDir = fs.statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(abs, rel2, depth + 1);
      else if (TEST_FILE_RE.test(name)) results.push(rel2);
    }
  };
  walk(worktreePath, "", 0);
  return results;
}

// Pure and exported for direct unit testing (no network/Prisma/OpenAI involved). Assembles,
// in order: the instruction, an honest site-grounding section (real data, or an explicit
// statement of why none is available - never silently omitted), existing tests this project
// already has (TestMind-generated + the target repo's own), and the prior iteration's
// failure when repairing (iteration > 1 only).
export function buildCodePhasePrompt(opts: {
  instructionText: string | null;
  iterationNumber: number;
  discoveryContext: DiscoveryPromptContext | null;
  discoveryUnavailableReason?: DiscoveryUnavailableReason | null;
  existingTestPaths: string[];
  priorIteration: PriorIterationContext | null;
  /** Which test framework generated tests must use (from the repository's own setup). */
  testSetup?: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`Instruction: ${opts.instructionText ?? "(self-improvement mode: find and fix an issue)"}`);
  lines.push(`Iteration: ${opts.iterationNumber}`);
  lines.push("");
  // Repairs: the actual failure comes first, before any other context.
  const prior = opts.iterationNumber > 1 ? opts.priorIteration : null;
  if (prior?.failureDetail) {
    lines.push(`## Repair required: iteration ${prior.iterationNumber} failed with this actual test error (fix exactly this)`);
    lines.push("```");
    lines.push(prior.failureDetail);
    lines.push("```");
    for (const f of prior.failingTestFiles ?? []) {
      lines.push(`Current ${f.path}:`);
      lines.push("```");
      lines.push(f.content);
      lines.push("```");
    }
    lines.push("Repair rules:");
    lines.push("- Keep the objective, the asserted feature, the expected text/values and the expected behavior exactly as they are; never weaken, skip, negate or remove an assertion.");
    lines.push("- Fix what the error shows is wrong (locator, wait, navigation). Prefer resilient, accessible locators - getByRole with a name, getByLabel, getByText, getByPlaceholder - over guessed tag or CSS selectors (for a heading use page.getByRole(\"heading\", { name: \"...\" }), not locator(\"h1\")).");
    lines.push("");
  }
  if (opts.testSetup) {
    lines.push("## Test framework");
    lines.push(opts.testSetup);
    lines.push("");
  }
  lines.push("## Site context");
  if (opts.discoveryContext) {
    const d = opts.discoveryContext;
    lines.push(`Live crawl of ${d.baseUrl} (best-effort, may be incomplete). ${d.totalRoutes} route(s) discovered, showing up to ${d.routes.length}:`);
    for (const r of d.routes) {
      const headings = r.headings.length ? r.headings.join(", ") : "(none)";
      const buttons = r.buttons.length ? r.buttons.join(", ") : "(none)";
      const fields = r.formFields.length ? ` (fields: ${r.formFields.join(", ")})` : "";
      lines.push(`- ${r.path} -> ${r.status}, headings: [${headings}], forms: ${r.formCount}${fields}, buttons: [${buttons}]`);
    }
  } else if (opts.discoveryUnavailableReason === "no-base-url") {
    lines.push("No live site is associated with this run (general code-maintenance task) - live grounding was not attempted.");
  } else {
    lines.push(
      `Live site grounding was NOT available for this run (reason: ${opts.discoveryUnavailableReason ?? "unknown"}). ` +
        "Do not invent or assume any specific page, URL, or selector exists - write only what the instruction itself supports."
    );
  }
  lines.push("");
  lines.push("## Existing tests for this project (avoid duplicating these)");
  if (opts.existingTestPaths.length) {
    for (const p of opts.existingTestPaths.slice(0, MAX_PROMPT_TEST_PATHS)) lines.push(`- ${p}`);
  } else {
    lines.push("(none found)");
  }
  if (opts.priorIteration && opts.iterationNumber > 1) {
    lines.push("");
    lines.push("## Objective (unchanged - a repair must still verify exactly this)");
    lines.push(opts.instructionText ?? "(self-improvement mode)");
    lines.push('If what it asks for does not exist on the target, respond {"blocked": true, "reason": "..."} - never assert a different element just to pass.');
    lines.push("");
    lines.push(`## Prior iteration ${opts.priorIteration.iterationNumber} result (repair this, don't repeat the same mistake)`);
    if (opts.priorIteration.summary) lines.push(`Summary: ${snippet(opts.priorIteration.summary, 500)}`);
    if (opts.priorIteration.failureDetail) lines.push("Test result: FAILED - see the actual test error at the top.");
    else if (opts.priorIteration.testOutput) lines.push(`Test result: FAILED - ${snippet(opts.priorIteration.testOutput, 800)}`);
    if (opts.priorIteration.filesChanged.length) lines.push(`Files changed: ${opts.priorIteration.filesChanged.slice(0, 20).join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * The previous iteration's result for the repair prompt: the actual failure block (cleaned of
 * setup notices and temporary paths) and the current content of the test files this run wrote.
 */
export async function loadPriorIterationContext(devAgentRunId: string, iterationNumber: number, worktreePath: string): Promise<PriorIterationContext | null> {
  if (iterationNumber <= 1) return null;
  const rows = await prisma.devAgentIteration.findMany({ where: { devAgentRunId, phase: { not: "baseline" } }, orderBy: { iterationNumber: "asc" }, select: { iterationNumber: true, summary: true, filesChanged: true, testResult: true } });
  const row = rows[rows.length - 1];
  if (!row) return null;
  const tr = row.testResult as any;
  const paths = (r: { filesChanged: unknown }) => (Array.isArray(r.filesChanged) ? (r.filesChanged as any[]).map((f) => f?.path).filter((p): p is string => typeof p === "string") : []);
  const testPaths = [...new Set(rows.flatMap(paths))].filter((p) => TEST_FILE_PATTERN.test(p));
  const failingTestFiles = tr?.passed === false
    ? testPaths.slice(0, 3).flatMap((p) => {
        const abs = path.join(worktreePath, p);
        if (!fs.existsSync(abs)) return [];
        const content = fs.readFileSync(abs, "utf8");
        return [{ path: p, content: content.length > MAX_REPAIR_FILE_CHARS ? `${content.slice(0, MAX_REPAIR_FILE_CHARS)}\n...[truncated]` : content }];
      })
    : [];
  return {
    iterationNumber: row.iterationNumber,
    summary: row.summary,
    testOutput: tr?.output ?? null,
    filesChanged: paths(row),
    failureDetail: tr?.passed === false ? extractFailureDetail(tr?.output, { worktreePath }) : null,
    failingTestFiles,
  };
}

const defaultCodePhase: CodePhaseFn = async ({ run, iterationNumber, worktreePath }) => {
  const client = await resolveRealOpenAiClient(run.projectId);

  const discoveryState = (run.discoveryContextJson as DiscoveryState | null) ?? { context: null, unavailableReason: "no-base-url" as const };

  const generatedSpecs = listGeneratedSpecFiles(DEFAULT_FRAMEWORK_ID, run.requestedBy, run.projectId).map((f) => f.path);
  const repoTests = listRepoTestFiles(worktreePath);
  const existingTestPaths = Array.from(new Set([...generatedSpecs, ...repoTests]));

  const priorIteration = await loadPriorIterationContext(run.id, iterationNumber, worktreePath);

  // B6 code-fix proposals: inspect the repository for the defect's likely source and show the
  // baseline failure, under a prompt that fixes application code and never touches tests.
  const codeFix = run.operatorJobId
    ? ((await prisma.operatorJob.findUnique({ where: { id: run.operatorJobId }, select: { contextJson: true } }))?.contextJson as any)?.qeCodeFix
    : null;

  let userPrompt = buildCodePhasePrompt({
    instructionText: run.instructionText,
    iterationNumber,
    discoveryContext: discoveryState.context,
    discoveryUnavailableReason: discoveryState.unavailableReason,
    existingTestPaths,
    priorIteration,
    testSetup: codeFix || run.testCommand ? null : describeTestSetup(worktreePath, (await resolveBaseUrlForRun(run)) ?? null),
  });
  if (codeFix) {
    const { searchTermsForDefect } = await import("../lib/qe-codefix.js");
    const { findLikelySourceFiles } = await import("../lib/qe-codefix-store.js");
    const sources = await findLikelySourceFiles(worktreePath, searchTermsForDefect(run.instructionText ?? ""));
    // The authorized scope of this fix: only these application files may change (enforced by
    // codeFixScopeViolations when the proposal is reviewed or published).
    if (run.operatorJobId) {
      const ctxNow = ((await prisma.operatorJob.findUnique({ where: { id: run.operatorJobId }, select: { contextJson: true } }))?.contextJson ?? {}) as any;
      const authorizedPaths = [...new Set([...(ctxNow.qeCodeFix?.authorizedPaths ?? []), ...sources.map((f) => f.path)])].slice(0, 20);
      await prisma.operatorJob.update({ where: { id: run.operatorJobId }, data: { contextJson: { ...ctxNow, qeCodeFix: { ...(ctxNow.qeCodeFix ?? {}), authorizedPaths } } } }).catch(() => {});
    }
    const baseline = await prisma.devAgentIteration.findFirst({ where: { devAgentRunId: run.id, phase: "baseline" }, select: { testResult: true } });
    userPrompt += [
      "",
      "## Baseline (focused regression test before any change)",
      baseline ? `${(baseline.testResult as any)?.passed ? "PASSED" : "FAILED"}: ${snippet(String((baseline.testResult as any)?.output ?? ""), 1500)}` : "(no baseline recorded)",
      "",
      "## Likely source files (bounded repository search for the terms the defect names)",
      ...(sources.length ? sources.map((f) => `### ${f.path}\n${f.content}`) : ["(no application file mentions the defect's terms - report blocked if the responsible code is not in this repository)"]),
    ].join("\n");
  }

  const { CODE_FIX_SYSTEM_PROMPT } = codeFix ? await import("../lib/qe-codefix.js") : { CODE_FIX_SYSTEM_PROMPT: "" };
  const result = await callOpenAiAndTrackCost({
    devAgentRunId: run.id,
    client,
    systemPrompt: codeFix ? CODE_FIX_SYSTEM_PROMPT : CODE_PHASE_SYSTEM_PROMPT,
    userPrompt,
  });

  const blocked = parseBlockedSignal(result.content);
  if (blocked) return { summary: `Blocked: ${blocked}`, filesChanged: [], costUsd: result.costUsd, blocked };

  const ops = parseFileOps(result.content);
  const filesChanged = await applyFileOps(worktreePath, ops);
  await commitChanges(worktreePath, `dev-agent: iteration ${iterationNumber} - ${snippet(ops.map(o => `${o.action} ${o.path}`).join(", "), 200)}`);

  return { summary: snippet(result.content, 2000), filesChanged, costUsd: result.costUsd };
};

// The configured test command executes target-repo code, so it runs under the same
// sandbox as dependency install: allowlisted env (no API secrets), a wall-clock timeout
// that kills the whole process tree, a bounded rolling output tail, and a Node heap cap.
// Only an actual exit code 0 counts as passed - timeout, cancel, or spawn failure never do.
export const runConfiguredTestCommand: RunTestCommandFn = async (worktreePath, command, devAgentRunId) => {
  let argv: string[];
  try {
    argv = parseCommandLine(command);
  } catch (err: any) {
    return { passed: false, output: `Invalid test command: ${snippet(err?.message ?? String(err), 500)}` };
  }
  if (argv.length === 0) return { passed: false, output: "Invalid test command: empty" };
  const [cmd, ...args] = argv;

  const timeoutMs = envInt("DEV_AGENT_TEST_TIMEOUT_MS", DEFAULT_TEST_TIMEOUT_MS);
  const result = await runSandboxed(cmd, args, {
    cwd: worktreePath,
    timeoutMs,
    maxOutputChars: MAX_TEST_OUTPUT_CHARS,
    env: buildSandboxEnv({ CI: "true" }),
    // Item 5 (approved plan): emergency stop must kill an in-flight subprocess
    // immediately, not wait for the next tick boundary.
    shouldAbort: async () => {
      const current = await prisma.devAgentRun.findUnique({ where: { id: devAgentRunId }, select: { status: true } }).catch(() => null);
      return current?.status === "canceled";
    },
  });

  // runSandboxed already redacts and bounds this to a rolling tail; keep line breaks (and
  // drop terminal colour codes) so the run inspector can show readable test output.
  const output = result.output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim();
  if (result.timedOut) return { passed: false, output: `Test command timed out after ${timeoutMs}ms; process tree killed. ${output}`.trim() };
  if (result.killedByAbort) return { passed: false, output: `Test command killed: run canceled. ${output}`.trim() };
  if (result.spawnError) return { passed: false, output: `Test command failed to start: ${snippet(result.spawnError, 500)}` };
  return { passed: result.exitCode === 0, output };
};

// Collects every test file the agent touched across ALL iterations (not just this one),
// reads their final content from the worktree, and - when the run passed - checks
// alignment against the instruction and the first iteration's recorded assertions.
async function evaluateObjective(
  run: { id: string; instructionText: string | null; worktreePath: string | null },
  iterationNumber: number,
  currentChanges: Array<{ path: string }>,
  passed: boolean
): Promise<{ targets: AssertionTarget[]; check: ObjectiveCheck | null }> {
  const prior = await prisma.devAgentIteration.findMany({
    where: { devAgentRunId: run.id },
    orderBy: { iterationNumber: "asc" },
    select: { iterationNumber: true, filesChanged: true, testResult: true },
  });
  const touched = new Set<string>();
  for (const it of prior) for (const f of (Array.isArray(it.filesChanged) ? it.filesChanged : []) as any[]) if (typeof f?.path === "string") touched.add(f.path);
  for (const f of currentChanges) touched.add(f.path);

  const finalTestFiles = [...touched].filter((p) => TEST_FILE_PATTERN.test(p)).map((p) => {
    const abs = path.join(run.worktreePath ?? "", p);
    return { path: p, content: run.worktreePath && fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null };
  });
  const targets = finalTestFiles.flatMap((f) => (f.content ? extractAssertionTargets(f.content) : []));

  if (!passed) return { targets, check: null };
  const first = prior.find((it) => Array.isArray((it.testResult as any)?.objectiveTargets));
  const originalTargets: AssertionTarget[] | null = first ? (first.testResult as any).objectiveTargets : iterationNumber === 1 ? targets : null;
  return { targets, check: checkObjectiveAlignment({ instructionText: run.instructionText, originalTargets, finalTestFiles }) };
}

async function getRealRequestApproval(): Promise<RequestApprovalFn> {
  const mod = await import("./operator-worker.js");
  return mod.requestApproval;
}

export async function advanceDevAgentJob(opJob: OpJobCtx, reDelay: ReDelayFn, deps: DevAgentDeps = {}): Promise<void> {
  const run = await prisma.devAgentRun.findFirst({ where: { operatorJobId: opJob.id } });
  if (!run) throw new Error(`DevAgentRun not found for OperatorJob ${opJob.id}`);

  const freshStatus = await prisma.devAgentRun.findUnique({ where: { id: run.id }, select: { status: true } });
  if (!freshStatus || freshStatus.status === "canceled") return;
  if (freshStatus.status === "paused") {
    await reDelay(PAUSE_RECHECK_MS, { kind: "dev_agent_iterate", devAgentRunId: run.id });
    return;
  }

  // One-time gate (correction #3): fail-closed authorization before autonomous code
  // execution is enabled for this run at all - not a per-iteration/per-action gate.
  // Also re-entered on "awaitingApproval": if the worker process died (crash, restart, a
  // BullMQ-detected stall) while this run's approval was still pending, a resumed/retried
  // invocation must re-request approval, never silently fall through to the "not running"
  // guard below and get misreported as a succeeded job despite nothing having happened.
  if (run.status === "queued" || run.status === "awaitingApproval") {
    // Website tests need an authorized application URL. Without one, stop before approval,
    // workspace, LLM spend or retries. Repository-only tasks and user-provided commands proceed.
    if (!run.testCommand && !(opJob as any).contextJson?.qeCodeFix && requiresApplicationUrl(run.instructionText) && !(await (deps.resolveBaseUrl ?? resolveBaseUrlForRun)(run))) {
      await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "unverified", finishedAt: new Date(), error: NO_APP_URL_REASON } });
      return;
    }
    await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "awaitingApproval" } });
    const requestApprovalFn = deps.requestApproval ?? (await getRealRequestApproval());
    try {
      await requestApprovalFn({
        jobId: opJob.id,
        // No OperatorTask backs this one-time, job-level gate - leave taskId unset rather
        // than pass the jobId (OperatorApproval.taskId is a real FK to OperatorTask).
        requestedBy: opJob.requestedBy ?? "system",
        actionType: "patch_code",
        description: `Enable autonomous code execution for DevAgentRun ${run.id} (target: ${run.targetRepo})`,
      });
    } catch (err: any) {
      await prisma.devAgentRun.update({
        where: { id: run.id },
        data: { status: "failed", finishedAt: new Date(), error: `Autonomous code execution not authorized: ${snippet(err?.message ?? String(err))}` },
      });
      throw err;
    }

    const worktree = await createDevAgentWorktree({ id: run.id, targetRepo: run.targetRepo, projectId: run.projectId, baseBranch: run.baseBranch });

    // Reproducible, lockfile-based install - never a node_modules copy/junction/symlink
    // from the main repo. Must happen before anything tries to run code/tests in this
    // worktree; a failure here fails the run closed, same as any other setup failure.
    const provisionDependencies: ProvisionDependenciesFn = deps.provisionDependencies ?? provisionWorktreeDependencies;
    const provision = await provisionDependencies(worktree.path);
    // TS narrowing on `!provision.ok` doesn't hold here for an unrelated reason (reproduced
    // in isolation as a tsc quirk, not a real type-soundness issue) - the explicit cast
    // below is a deliberate, verified-safe workaround, not an unexplained `any` escape.
    if (provision.ok === false) {
      const error = `Dependency provisioning failed: ${(provision as { ok: false; error: string }).error}`;
      await prisma.devAgentRun.update({
        where: { id: run.id },
        data: { status: "failed", finishedAt: new Date(), error, worktreePath: worktree.path, workBranch: worktree.branch },
      });
      await removeDevAgentWorktree({ id: run.id, targetRepo: run.targetRepo, worktreePath: worktree.path });
      throw new Error(error);
    }

    // Discovery runs exactly once per run, right here, and is cached - every iteration's
    // code phase reads this same cached value rather than re-crawling.
    const discoveryState = await resolveDiscoveryContext(run, deps);
    await prisma.devAgentRun.update({
      where: { id: run.id },
      data: {
        status: "running",
        startedAt: new Date(),
        worktreePath: worktree.path,
        workBranch: worktree.branch,
        discoveryContextJson: discoveryState as any,
      },
    });

    // B6 code-fix proposals only: run the focused regression test BEFORE any change, so the
    // result can show the test actually caught the defect (a pass before the fix proves nothing).
    if ((opJob as any).contextJson?.qeCodeFix && run.testCommand) {
      const runTestCommand = deps.runTestCommand ?? runConfiguredTestCommand;
      const baseline = await runTestCommand(worktree.path, run.testCommand, run.id);
      await prisma.devAgentIteration.create({
        data: { devAgentRunId: run.id, iterationNumber: 0, phase: "baseline", summary: "Focused regression test before any change", filesChanged: [], testResult: baseline, costUsd: 0 },
      });
    }
  }

  const current = await prisma.devAgentRun.findUnique({ where: { id: run.id } });
  if (!current || current.status !== "running") return;

  const isCodeFix = !!(opJob as any).contextJson?.qeCodeFix;
  const iterationCount = await prisma.devAgentIteration.count({ where: { devAgentRunId: run.id, phase: { not: "baseline" } } });
  if (iterationCount >= current.maxIterations) {
    if (await endAsPartialIfTestsSaved(current, isCodeFix, `all ${current.maxIterations} iteration(s) were used`)) return;
    const last = await prisma.devAgentIteration.findFirst({ where: { devAgentRunId: run.id, phase: { not: "baseline" } }, orderBy: { iterationNumber: "desc" }, select: { iterationNumber: true, testResult: true } });
    const lastFailure = (last?.testResult as any)?.failureSummary ?? summarizeTestFailure((last?.testResult as any)?.output);
    const error = `Max iterations reached without passing tests${lastFailure ? `. Last failure (iteration ${last!.iterationNumber}): ${lastFailure}` : ""}`;
    await prisma.devAgentRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error },
    });
    await removeDevAgentWorktree(current);
    // Must throw, not return: operator-worker.ts's dispatcher marks the OperatorJob
    // 'succeeded' whenever advanceDevAgentJob resolves without throwing, regardless of
    // the DevAgentRun's own status - a plain return here would report this failed run
    // as a succeeded job.
    throw new Error(error);
  }

  // Correction #2: budget checked BEFORE the expensive operation, not only after.
  if (!canAffordNextStep(current, CONSERVATIVE_LLM_STEP_ESTIMATE_USD)) {
    if (await endAsPartialIfTestsSaved(current, isCodeFix, "the budget was exhausted before another repair")) return;
    const error = "Budget exceeded before next iteration";
    await prisma.devAgentRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error },
    });
    await removeDevAgentWorktree(current);
    throw new Error(error);
  }

  const iterationNumber = iterationCount + 1;
  const codePhase = deps.codePhase ?? defaultCodePhase;
  let codeResult: CodePhaseResult;
  try {
    codeResult = await codePhase({ run: current, iterationNumber, worktreePath: current.worktreePath! });
  } catch (err: any) {
    // Fail closed: an invalid/unsafe code-phase response (malformed JSON, path traversal,
    // or any other thrown error) must never be silently skipped. Record what happened and
    // stop this run rather than retrying blindly against a model that just produced an
    // unsafe response.
    const message = snippet(err?.message ?? String(err), 1000);
    await prisma.devAgentIteration.create({
      data: { devAgentRunId: run.id, iterationNumber, phase: "code", summary: `Code phase failed: ${message}`, filesChanged: [], testResult: { passed: false, output: message }, costUsd: 0 },
    });
    const error = `Code phase failed: ${message}`;
    await prisma.devAgentRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), error },
    });
    await removeDevAgentWorktree(current);
    throw new Error(error);
  }

  // The model reported the requested feature/element does not exist on the target: stop
  // honestly as unable-to-verify rather than iterating toward a substitute that passes.
  if (codeResult.blocked) {
    await prisma.devAgentIteration.create({
      data: { devAgentRunId: run.id, iterationNumber, phase: "code", summary: codeResult.summary, filesChanged: [], testResult: { passed: false, output: `Blocked by agent: ${codeResult.blocked}` }, costUsd: codeResult.costUsd },
    });
    await prisma.devAgentRun.update({
      where: { id: run.id },
      data: { status: "unverified", finishedAt: new Date(), error: `Blocked - requested objective could not be verified: ${codeResult.blocked}` },
    });
    return;
  }

  // Generated tests are project artifacts: save them to Suites now, before execution, so they
  // stay available (and rerunnable) whatever the execution outcome. Code-fix runs never write tests.
  let savedSpecs: string[] = [];
  let suiteSaveError: string | null = null;
  if (!isCodeFix) {
    try {
      savedSpecs = (deps.saveSpecs ?? saveGeneratedSpecsToSuite)(current, codeResult.filesChanged);
    } catch (err: any) {
      suiteSaveError = `Saving generated tests to Suites failed: ${snippet(err?.message ?? String(err), 300)}`;
    }
  }

  // A user-provided command always wins. Otherwise (not for B6 code-fix runs, whose regression
  // command and baseline are explicit) detect the framework/package manager and run the tests
  // this run created or changed across all iterations.
  let testCommand = current.testCommand;
  let detection: DetectedTestCommand | null = null;
  let provisioned: { dependency: string; files: string[] } | null = null;
  const pwOutputDir = path.join(os.tmpdir(), "tm-dev-agent-pw-output", run.id);
  if (!testCommand && !(opJob as any).contextJson?.qeCodeFix) {
    const prior = await prisma.devAgentIteration.findMany({ where: { devAgentRunId: run.id }, select: { filesChanged: true } });
    const touched = [...prior.flatMap((it) => ((Array.isArray(it.filesChanged) ? it.filesChanged : []) as any[]).map((f) => f?.path)), ...codeResult.filesChanged.map((f) => f.path)]
      .filter((p): p is string => typeof p === "string");
    const detect = deps.detectTestCommand ?? detectTestCommand;
    detection = detect(current.worktreePath!, touched, { outputDir: pwOutputDir });
    // Generated Playwright specs but no Playwright in the repository: add a minimal, pinned
    // Playwright setup in this temporary worktree, commit it on the run branch (it becomes part
    // of the disclosed proposal), then detect again. A failed setup is reported, never hidden.
    const needs = "provisionPlaywright" in detection ? detection.provisionPlaywright : undefined;
    const appUrl = needs ? (await (deps.resolveBaseUrl ?? resolveBaseUrlForRun)(current)) ?? null : null;
    if (needs && !appUrl) {
      // Browser specs were generated but there is no authorized URL to run them against:
      // never provision, execute or retry - end unverified with the reason.
      detection = { command: null, reason: NO_APP_URL_REASON };
    } else if (needs) {
      const provision = await (deps.provisionPlaywright ?? provisionPlaywrightSetup)(current.worktreePath!, {
        baseUrl: appUrl,
        specs: needs.specs,
      });
      if (provision.ok) {
        await commitChanges(current.worktreePath!, `dev-agent: add minimal Playwright test setup (${provision.dependency})`);
        provisioned = { dependency: provision.dependency, files: provision.files };
        detection = detect(current.worktreePath!, touched, { outputDir: pwOutputDir });
      } else {
        detection = { command: null, reason: `${detection.reason} Provisioning a Playwright setup failed: ${(provision as { ok: false; error: string }).error}` };
      }
    }
    testCommand = detection.command;
  }
  const hasTestCommand = !!testCommand;
  const runTestCommand = deps.runTestCommand ?? runConfiguredTestCommand;
  const ran = hasTestCommand
    ? await runTestCommand(current.worktreePath!, testCommand!, run.id)
    : { passed: false, output: `No test command configured for this run - the generated changes were not executed or verified.${detection ? ` ${detection.reason}` : ""}` };
  fs.rmSync(pwOutputDir, { recursive: true, force: true }); // run-scoped Playwright artifacts are never kept
  const setupNote = provisioned ? `Added minimal Playwright test setup (disclosed in the proposal): ${provisioned.dependency} as a devDependency; files: ${provisioned.files.join(", ")}\n` : "";
  // The actual test error, extracted for display in TestMind (inspector + run error).
  const failureSummary = hasTestCommand && !ran.passed ? summarizeTestFailure(ran.output) : null;
  const executed = detection?.command
    ? { ...ran, command: detection.command, autoDetected: true, ...(provisioned ? { provisioned } : {}), ...(failureSummary ? { failureSummary } : {}), output: `${setupNote}Auto-detected: ${detection.reason}\n$ ${detection.command}\n${ran.output}` }
    : { ...ran, ...(provisioned ? { provisioned } : {}), ...(failureSummary ? { failureSummary } : {}) };

  // What the agent's test files assert right now, and (if executed and passing) whether
  // that still matches the original instruction. Recorded on every iteration so the
  // FIRST version's assertions are the baseline later repairs are held to.
  const objective = await evaluateObjective(current, iterationNumber, codeResult.filesChanged, executed.passed);
  const testResult = {
    ...executed,
    objectiveTargets: objective.targets,
    ...(objective.check ? { objective: { aligned: objective.check.aligned, reason: objective.check.reason } } : {}),
    // Individual test outcomes and where the generated tests are kept (Suites).
    ...(hasTestCommand ? { tests: parseTestOutcomes(ran.output) } : {}),
    ...(savedSpecs.length ? { savedSpecs } : {}),
    ...(suiteSaveError ? { suiteSaveError } : {}),
  };

  await prisma.devAgentIteration.create({
    data: {
      devAgentRunId: run.id,
      iterationNumber,
      phase: "code",
      summary: codeResult.summary,
      filesChanged: codeResult.filesChanged,
      testResult,
      costUsd: codeResult.costUsd,
    },
  });

  // Re-check cancellation after the (potentially slow) code/test phase, before deciding
  // whether to finalize or schedule another tick.
  const afterWork = await prisma.devAgentRun.findUnique({ where: { id: run.id }, select: { status: true } });
  if (afterWork?.status === "canceled") return;

  // Never report success without a real executed verification: no testCommand means
  // nothing was actually run, so the run ends 'unverified', not 'succeeded'. One iteration
  // only - there is nothing to pass/fail without a real check, so looping would not help.
  if (!hasTestCommand) {
    await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "unverified", finishedAt: new Date(), ...(detection ? { error: `Not verified: ${detection.reason}` } : {}) } });
    return;
  }

  // Success requires BOTH: the test command actually passed AND the tests still verify the
  // original objective. A pass on a substituted/negated/skipped assertion is not success -
  // it ends 'unverified' (never publishable as a PR) with the reason, and stops iterating.
  if (testResult.passed && objective.check && !objective.check.aligned) {
    await prisma.devAgentRun.update({
      where: { id: run.id },
      data: { status: "unverified", finishedAt: new Date(), error: `Tests passed but objective not verified: ${objective.check.reason}` },
    });
    return;
  }

  if (testResult.passed) {
    await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "succeeded", finishedAt: new Date() } });
    // Worktree intentionally left in place on success (not torn down) so a later stage
    // can push/open a PR from it - teardown here would destroy the work just produced.
    return;
  }

  // A failure identical to the previous iteration's means repairs are not changing the outcome:
  // stop now with an actionable explanation instead of spending the remaining iterations.
  const signature = failureSignature(ran.output);
  if (signature && iterationNumber > 1) {
    const prev = await prisma.devAgentIteration.findFirst({ where: { devAgentRunId: run.id, iterationNumber: iterationNumber - 1, phase: "code" }, select: { testResult: true } });
    if (prev && failureSignature((prev.testResult as any)?.output) === signature) {
      const reason = `the same failure repeated in iterations ${iterationNumber - 1} and ${iterationNumber}, so further repairs were stopped`;
      if (await endAsPartialIfTestsSaved(current, isCodeFix, reason)) return;
      const error = `Stopped: ${reason}.${failureSummary ? ` Failure: ${failureSummary}` : ""}`;
      await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "failed", finishedAt: new Date(), error } });
      await removeDevAgentWorktree(current);
      throw new Error(error);
    }
  }

  await reDelay(TICK_DELAY_MS, { kind: "dev_agent_iterate", devAgentRunId: run.id });
}

/**
 * Generated tests that still fail are a partial result, not an engine failure: they stay saved
 * in Suites with their full failure and repair history, and the run ends 'partial' with what is
 * failing and why. Returns false when nothing usable was generated (the caller fails the run).
 * Never used for code-fix runs, whose outcome is the fix itself.
 */
async function endAsPartialIfTestsSaved(current: { id: string; projectId: string; worktreePath: string | null; targetRepo: string }, isCodeFix: boolean, reason: string): Promise<boolean> {
  if (isCodeFix) return false;
  const its = await prisma.devAgentIteration.findMany({ where: { devAgentRunId: current.id, phase: { not: "baseline" } }, orderBy: { iterationNumber: "asc" }, select: { iterationNumber: true, testResult: true } });
  const saved = [...new Set(its.flatMap((it) => (((it.testResult as any)?.savedSpecs ?? []) as unknown[]).filter((p): p is string => typeof p === "string")))];
  if (!saved.length) return false;
  const last = its[its.length - 1];
  const tr = last?.testResult as any;
  const lastFailure = tr?.failureSummary ?? summarizeTestFailure(tr?.output);
  const tests: Array<{ status: string }> = Array.isArray(tr?.tests) ? tr.tests : [];
  const counts = tests.length ? ` Last run: ${tests.filter((t) => t.status === "passed").length} passed, ${tests.filter((t) => t.status === "failed").length} failed.` : "";
  const error = [
    `Partial: ${saved.length} generated test file(s) are saved in Suites (Generated (playwright-ts) > ${suiteRelDir(current.id)}), but the tests did not pass - ${reason}.${counts}`,
    lastFailure ? `Last failure (iteration ${last.iterationNumber}): ${lastFailure}` : "",
    "Review the failing test in Suites against what the page actually renders, then rerun it there or adjust the instruction.",
  ].filter(Boolean).join(" ");
  await prisma.devAgentRun.update({ where: { id: current.id }, data: { status: "partial", finishedAt: new Date(), error } });
  await removeDevAgentWorktree(current as any);
  return true;
}
