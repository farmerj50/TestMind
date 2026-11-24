// B6: Autonomous code-fix proposals - pure logic. The coding itself is the existing Dev Agent
// (isolated worktree, sandboxed tests, objective check, approval gate, budget); this module only
// decides WHEN a fix may be attempted, WHAT the agent is told, and how truthful the result is.
import type { FailureInvestigation } from "./failure-intel.js";

export type CodeFixConfig = {
  /** "testmind" or an authorized external repository (confirmed at run creation). */
  targetRepo: string;
  /** Focused regression command run before and after the fix (inside the worktree). */
  testCommand?: string;
  budgetUsd?: number;
  maxIterations?: number;
};

export function isCodeFixConfig(v: unknown): v is CodeFixConfig {
  const c = v as CodeFixConfig;
  return !!c && typeof c === "object" && typeof c.targetRepo === "string" && !!c.targetRepo.trim()
    && (c.testCommand === undefined || typeof c.testCommand === "string")
    && (c.budgetUsd === undefined || (typeof c.budgetUsd === "number" && c.budgetUsd > 0))
    && (c.maxIterations === undefined || (Number.isInteger(c.maxIterations) && c.maxIterations >= 1 && c.maxIterations <= 10));
}

/** Only a suspected product defect, supported by evidence and not a low-confidence guess. */
export function eligibleForCodeFix(inv: FailureInvestigation): { eligible: boolean; reason: string } {
  if (inv.category !== "product_defect") return { eligible: false, reason: `Not a suspected product defect (${inv.category})` };
  if (inv.confidence === "low") return { eligible: false, reason: "Product-defect classification confidence is too low" };
  const kinds = new Set(inv.evidence.map((e) => e.kind));
  if (!kinds.has("assertion")) return { eligible: false, reason: "No failing assertion recorded as evidence" };
  if (!(kinds.has("observation") || kinds.has("analysis") || kinds.has("network") || inv.objective)) {
    return { eligible: false, reason: "No corroborating evidence (observation, analysis, network, or a stated objective)" };
  }
  return { eligible: true, reason: `${inv.cause} with ${inv.confidence} confidence and ${inv.evidence.length} evidence item(s)` };
}

/** The Dev Agent's instruction: fix the APPLICATION so the unchanged objective holds. */
export function buildFixInstruction(inv: FailureInvestigation, opts: { criteria: Array<{ text: string }>; testCommand?: string }): string {
  const lines = [
    `Fix a suspected product defect in the application code. Do not modify tests, fixtures, or acceptance criteria.`,
    ``,
    `Failing test: ${inv.testTitle}`,
    inv.route ? `Affected route: ${inv.route}` : "",
    `Objective that must hold after the fix (unchanged): ${inv.objective ?? "(see failing test)"}`,
    ...opts.criteria.map((c) => `Acceptance criterion (unchanged): ${c.text}`),
    ``,
    `Diagnosis (${inv.cause}, ${inv.confidence} confidence): ${inv.explanation}`,
    `Evidence:`,
    ...inv.evidence.slice(0, 8).map((e) => `- ${e.kind}: ${e.detail.slice(0, 300)}`),
    ``,
    opts.testCommand ? `Verification: \`${opts.testCommand}\` must pass after your change.` : `No regression command was provided - the change will be reported as an unverified proposal.`,
    `Make the smallest change that restores the expected behavior. If the source of the defect cannot be found in this repository, respond with {"blocked": true, "reason": "..."}.`,
  ];
  return lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n").trim();
}

// ── Risk of the proposed change ─────────────────────────────────────────────

export type ChangedFile = { path: string; additions: number; deletions: number };

const SENSITIVE_PATH = /(^|\/)(auth|login|session|security|crypto|secret|password|permission|rbac|payment|billing|checkout|migrations?|prisma\/schema|\.env|config\/(env|prod)|middleware|webhook)/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|e2e|testmind-generated)\/|\.(spec|test)\.[cm]?[jt]sx?$/i;
/** True for test files (specs, test folders) - used to tell test-only Dev Agent changes from application-code changes. */
export const isTestFilePath = (p: string) => TEST_PATH.test(p.replace(/\\/g, "/"));

export function assessProposalRisk(files: ChangedFile[]): { sensitive: boolean; reasons: string[]; testFilesChanged: string[] } {
  const reasons: string[] = [];
  const sensitive = files.filter((f) => SENSITIVE_PATH.test(f.path)).map((f) => f.path);
  if (sensitive.length) reasons.push(`touches sensitive areas: ${sensitive.slice(0, 5).join(", ")}`);
  const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (lines > 200) reasons.push(`large change (${lines} lines)`);
  if (files.length > 10) reasons.push(`many files (${files.length})`);
  const testFilesChanged = files.filter((f) => TEST_PATH.test(f.path)).map((f) => f.path);
  if (testFilesChanged.length) reasons.push(`modifies tests (${testFilesChanged.slice(0, 3).join(", ")}) - a code fix must not change what is verified`);
  return { sensitive: sensitive.length > 0 || lines > 200, reasons, testFilesChanged };
}

// ── Release gate and scope guard ────────────────────────────────────────────

/**
 * Autonomous application-code fixes (proposals and their publication) are disabled unless
 * TM_APP_CODE_FIX_ENABLED=true. They stay off in production until they demonstrate safe,
 * relevant changes.
 */
export function appCodeFixEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TM_APP_CODE_FIX_ENABLED === "true";
}
export const APP_CODE_FIX_DISABLED_REASON = "Autonomous application-code fixes are disabled (set TM_APP_CODE_FIX_ENABLED=true to enable outside production)";

const FIXTURE_PATH = /(^|\/)(fixtures?|__fixtures__|__snapshots__|__mocks__)\//i;
/** A single file losing more than this many lines is never a plausible focused defect fix. */
export const MAX_FIX_DELETIONS_PER_FILE = 150;

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.?\/+/, "");

/**
 * Reasons a code-fix change must be rejected outright: it modifies tests or fixtures, deletes
 * large amounts of code, or touches files outside the authorized scope (the application files
 * identified for this defect). An empty list means the change is in scope.
 */
export function codeFixScopeViolations(files: ChangedFile[], authorizedPaths: string[] | null | undefined): string[] {
  const out: string[] = [];
  const tests = files.filter((f) => TEST_PATH.test(normPath(f.path)) || FIXTURE_PATH.test(normPath(f.path))).map((f) => f.path);
  if (tests.length) out.push(`modifies tests or fixtures (${tests.slice(0, 3).join(", ")})`);
  for (const f of files) {
    if (f.deletions > MAX_FIX_DELETIONS_PER_FILE || (f.deletions >= 40 && f.deletions > 4 * Math.max(1, f.additions))) {
      out.push(`large deletion in ${f.path} (-${f.deletions}/+${f.additions})`);
    }
  }
  const allowed = new Set((authorizedPaths ?? []).map(normPath));
  if (!allowed.size) out.push("no authorized scope was recorded for this fix, so relevance cannot be established");
  else {
    const outside = files.map((f) => normPath(f.path)).filter((p) => !allowed.has(p));
    if (outside.length) out.push(`changes files outside the authorized objective scope (${outside.slice(0, 3).join(", ")})`);
  }
  return out;
}

// ── Truthful status ─────────────────────────────────────────────────────────

export type ProposalStatus = "in_progress" | "awaiting_approval" | "verified" | "unverified" | "failed" | "rejected";

export function classifyProposal(input: {
  devRunStatus: string;
  hasTestCommand: boolean;
  baselinePassed: boolean | null;
  afterPassed: boolean | null;
  objectiveAligned: boolean | null;
  filesChanged: number;
  testFilesChanged: string[];
  error?: string | null;
}): { status: ProposalStatus; explanation: string } {
  const s = input.devRunStatus;
  if (s === "queued" || s === "running" || s === "paused") return { status: "in_progress", explanation: "The Dev Agent is working on a fix in an isolated worktree" };
  if (s === "awaitingApproval") return { status: "awaiting_approval", explanation: "Waiting for explicit approval before any code is changed" };
  if (s === "failed" || s === "canceled") return { status: "failed", explanation: input.error ?? `Fix attempt ${s}` };
  if (!input.filesChanged) return { status: "failed", explanation: input.error ?? "No code change was produced" };
  if (input.testFilesChanged.length) return { status: "unverified", explanation: `The proposal modifies tests (${input.testFilesChanged.slice(0, 3).join(", ")}); a passing result cannot be trusted as a fix` };
  if (!input.hasTestCommand || input.afterPassed === null) return { status: "unverified", explanation: "No regression command was executed after the change - review manually" };
  if (input.objectiveAligned === false) return { status: "unverified", explanation: "Tests passed but the original objective was not verified" };
  if (!input.afterPassed) return { status: "failed", explanation: "The regression test still fails with the proposed change" };
  if (input.baselinePassed === true) return { status: "unverified", explanation: "The regression test already passed before the change, so it does not demonstrate the fix" };
  if (input.baselinePassed === null) return { status: "unverified", explanation: "No baseline run before the change - cannot show the test caught the defect" };
  return { status: "verified", explanation: "The regression test failed before the change and passes after it, with the objective unchanged" };
}

/** Terms to locate the defect's source: quoted text and observed labels named in the instruction/evidence. */
export function searchTermsForDefect(instruction: string): string[] {
  const terms = new Set<string>();
  for (const m of instruction.matchAll(/["'`]([^"'`\n]{3,60})["'`]/g)) if (!/^(blocked|reason|\.\.\.)$/i.test(m[1]) && !/[{}()<>=]/.test(m[1])) terms.add(m[1].trim());
  for (const m of instruction.matchAll(/observed (?:actions|fields):\s*([^\n|]+)/gi)) for (const t of m[1].split(",")) if (t.trim().length >= 3) terms.add(t.trim());
  return [...terms].slice(0, 12);
}

/** System prompt for code-fix runs: restore expected behavior in APPLICATION code; tests are off-limits. */
export const CODE_FIX_SYSTEM_PROMPT = [
  "You are fixing a confirmed product defect in an isolated git worktree.",
  'Respond with ONLY a JSON array of file operations, no prose, no markdown fence: [{"path":"relative/path","action":"create"|"modify"|"delete","content":"...full file content..."}]',
  "Paths must be relative to the repo root and must never contain '..' or start with '/'.",
  "The expected behavior or element is missing or wrong BECAUSE of the defect: restore it in the application source. That is the fix, not a substitution.",
  "Never modify tests, fixtures, or acceptance criteria, and make the smallest change that satisfies the stated objective.",
  'Only if the code responsible for the behavior is not in this repository, respond with ONLY {"blocked": true, "reason": "..."}.',
].join(" ");
