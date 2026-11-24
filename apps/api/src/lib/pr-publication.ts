// B7: PR review & publication - pure rules. Every PR TestMind opens (QE test suites, repaired
// tests, Dev Agent code fixes, legacy autonomous writeback) goes through ONE gate: an explicit
// human approval bound to the exact repository, branches, commit and file contents. Any change
// after approval makes the approval stale. PRs are always drafts and are never merged here.
import { createHash } from "node:crypto";

export type PrKind = "test_suite" | "test_repair" | "app_fix";
export type PrFile = { path: string; content: string | null };

export type PrBinding = {
  /** "owner/repo" on GitHub, or null when no GitHub integration is configured. */
  repo: string | null;
  baseBranch: string;
  headBranch: string;
  /** The exact commit being proposed (Dev Agent worktree HEAD), or null for file-only proposals. */
  commitSha: string | null;
  /** sha256 over every file path + content - the diff being published. */
  diffHash: string;
  fileCount: number;
};

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export function diffHashOf(files: PrFile[]): string {
  const canonical = [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path}\u0000${f.content === null ? "<deleted>" : sha256(f.content)}`);
  return sha256(canonical.join("\n"));
}

export function bindingFor(input: { repo: string | null; baseBranch: string; headBranch: string; commitSha: string | null; files: PrFile[] }): PrBinding {
  return { repo: input.repo, baseBranch: input.baseBranch, headBranch: input.headBranch, commitSha: input.commitSha, diffHash: diffHashOf(input.files), fileCount: input.files.length };
}

export function fingerprintOf(kind: PrKind, b: PrBinding): string {
  return sha256(JSON.stringify([kind, b.repo, b.baseBranch, b.headBranch, b.commitSha, b.diffHash, b.fileCount]));
}

/** What a change between two bindings means for the approval (empty = identical). */
export function bindingChanges(approved: PrBinding, current: PrBinding): string[] {
  const out: string[] = [];
  if (approved.repo !== current.repo) out.push(`repository ${approved.repo} -> ${current.repo}`);
  if (approved.baseBranch !== current.baseBranch) out.push(`target branch ${approved.baseBranch} -> ${current.baseBranch}`);
  if (approved.headBranch !== current.headBranch) out.push(`head branch ${approved.headBranch} -> ${current.headBranch}`);
  if (approved.commitSha !== current.commitSha) out.push(`commit ${approved.commitSha?.slice(0, 10) ?? "none"} -> ${current.commitSha?.slice(0, 10) ?? "none"}`);
  if (approved.diffHash !== current.diffHash || approved.fileCount !== current.fileCount) out.push("file contents changed");
  return out;
}

// ── Verification honesty ────────────────────────────────────────────────────

export type Verification = { label: "verified" | "unverified" | "passing" | "partially passing" | "failing" | "untested"; detail: string };

/** May this proposal be published at all, and how must it be labelled? Never "verified" unless it is. */
export function publishability(kind: PrKind, input: { fixStatus?: string; testsPassed?: number; testsFailed?: number; testsNotRun?: number }): { ok: boolean; reason: string; verification: Verification } {
  if (kind === "app_fix") {
    const s = input.fixStatus;
    if (s === "verified") return { ok: true, reason: "Verified fix", verification: { label: "verified", detail: "Regression test failed before the change and passes after it; objective unchanged" } };
    // Release rule: an unverified application fix is never published as a PR.
    if (s === "unverified") return { ok: false, reason: "Unverified application fixes cannot be published - only a fix verified by a before/after regression run", verification: { label: "unverified", detail: "Not demonstrated by a before/after regression run" } };
    if (s === "rejected") return { ok: false, reason: "The fix was rejected by the scope guard (unrelated deletions, test changes or files outside the authorized objective)", verification: { label: "unverified", detail: "rejected by scope guard" } };
    return { ok: false, reason: `A ${s ?? "unknown"} fix attempt cannot be published`, verification: { label: "unverified", detail: `fix status: ${s ?? "unknown"}` } };
  }
  const p = input.testsPassed ?? 0, f = input.testsFailed ?? 0, n = input.testsNotRun ?? 0;
  if (kind === "test_repair" && f > 0) return { ok: false, reason: "Repaired tests still fail - nothing verified to publish", verification: { label: "failing", detail: `${p} passed, ${f} failed` } };
  const label: Verification["label"] = p + f === 0 ? "untested" : f === 0 ? (n ? "partially passing" : "passing") : "partially passing";
  return { ok: p + f + n > 0 || kind === "test_suite", reason: "Test changes", verification: { label, detail: `${p} passed, ${f} failed, ${n} not run` } };
}

export function prTitle(kind: PrKind, v: Verification, subject: string): string {
  const prefix = kind === "app_fix" ? (v.label === "verified" ? "[TestMind] Verified fix" : "[TestMind] UNVERIFIED fix proposal") : kind === "test_repair" ? "[TestMind] Repaired tests" : "[TestMind] Generated tests";
  return `${prefix}: ${subject}`.slice(0, 200);
}

export function prBody(input: {
  kind: PrKind;
  verification: Verification;
  objectives: string[];
  evidence: string[];
  risks: string[];
  files: Array<{ path: string; status: string }>;
  source: string;
  fingerprint: string;
}): string {
  const lines = [
    `> Opened by TestMind after explicit human approval. **This is a draft PR and is never merged automatically.**`,
    ``,
    `**Verification:** ${input.verification.label.toUpperCase()} - ${input.verification.detail}`,
    ``,
    input.objectives.length ? `### Objectives this change preserves\n${input.objectives.map((o) => `- ${o}`).join("\n")}` : "",
    input.evidence.length ? `### Evidence\n${input.evidence.map((e) => `- ${e}`).join("\n")}` : "",
    `### Remaining risks\n${input.risks.length ? input.risks.map((r) => `- ${r}`).join("\n") : "- None identified - human review still required"}`,
    `### Files\n${input.files.map((f) => `- \`${f.path}\` (${f.status})`).join("\n")}`,
    ``,
    `<sub>Source: ${input.source} · approval fingerprint \`${input.fingerprint.slice(0, 16)}\`</sub>`,
  ];
  return lines.filter(Boolean).join("\n").slice(0, 60_000);
}

// ── Approval binding ────────────────────────────────────────────────────────

export type ApprovalSnapshot = { status: string; expiresAt: Date | null; fingerprint: string | null; consumedAt: string | null } | null;

export function approvalAllowsPublish(a: ApprovalSnapshot, currentFingerprint: string, now = new Date()): { ok: boolean; reason: string } {
  if (!a) return { ok: false, reason: "No approval has been requested for this exact change" };
  if (a.status === "pending") return { ok: false, reason: "Awaiting explicit approval" };
  if (a.status === "denied") return { ok: false, reason: "Publication was denied" };
  if (a.status === "expired" || (a.expiresAt && a.expiresAt.getTime() < now.getTime())) return { ok: false, reason: "The approval expired - request approval again" };
  if (a.status !== "approved") return { ok: false, reason: `Approval is ${a.status}` };
  if (a.consumedAt) return { ok: false, reason: "This approval was already used to publish" };
  if (a.fingerprint !== currentFingerprint) return { ok: false, reason: "The change differs from what was approved - reapproval required" };
  return { ok: true, reason: "Approved for exactly this repository, branch, commit and diff" };
}

/** Test files land under a dedicated folder in the target repo (separate from app code). */
export function repoPathForTest(relativeToSuite: string): string {
  return `tests/testmind/${relativeToSuite.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}
