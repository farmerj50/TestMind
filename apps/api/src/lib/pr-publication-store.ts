// B7: PR proposals - storage, approval binding, and publication. One mechanism for every PR
// TestMind can open. A proposal's payload (exact files) is resolved from its SOURCE each time it
// is shown or published, so any change after approval is detected and requires reapproval.
import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { prisma } from "../prisma.js";
import { REPORT_ROOT, GENERATED_ROOT } from "./storageRoots.js";
import { recordAuditLog } from "./audit-log.js";
import { redactText } from "../security/redaction.js";
import {
  approvalAllowsPublish, bindingChanges, bindingFor, fingerprintOf, prBody, prTitle, publishability, repoPathForTest,
  type PrBinding, type PrFile, type PrKind, type Verification,
} from "./pr-publication.js";
import { getCodeFixProposal, worktreeDiff } from "./qe-codefix-store.js";
import { appCodeFixEnabled, APP_CODE_FIX_DISABLED_REASON } from "./qe-codefix.js";

export type PrSource =
  | { type: "dev_agent"; devAgentRunId: string; qeJobId?: string }
  | { type: "qe_suite"; qeJobId: string }
  | { type: "qe_repairs"; qeJobId: string }
  | { type: "legacy_writeback"; attemptIds: string[] };

export type PrStatus = "awaiting_approval" | "approved" | "publishing" | "published" | "publish_failed" | "denied" | "expired" | "stale" | "canceled" | "blocked";

type StoredProposal = {
  id: string; projectId: string; jobId: string; kind: PrKind; source: PrSource;
  binding: PrBinding; fingerprint: string; title: string; body: string;
  files: PrFile[]; objectives: string[]; evidence: string[]; risks: string[]; verification: Verification;
  status: PrStatus; blockedReason?: string; prUrl?: string; error?: string; approvalId?: string;
  history: Array<{ at: string; event: string; detail?: string; actor?: string }>;
};

export type GitHubDeps = {
  coords: (projectId: string) => Promise<{ owner: string; repo: string; defaultBranch: string } | null>;
  publish: (p: { projectId: string; owner: string; repo: string; baseBranch: string; headBranch: string; files: Array<{ path: string; content: string }>; title: string; body: string; commitMessage: string }) => Promise<{ prUrl: string; prNumber: number }>;
};

/** Real GitHub, via the existing integration and writeback helpers. Always a draft PR; never merged. */
export const realGitHub: GitHubDeps = {
  coords: async (projectId) => {
    const { getOctokitForProject } = await import("../runner/github-writeback.js");
    const c = await getOctokitForProject(projectId);
    return c ? { owner: c.owner, repo: c.repo, defaultBranch: c.defaultBranch } : null;
  },
  publish: async (p) => {
    const { getOctokitForProject, pushSpecFilesToBranch, ensurePullRequest } = await import("../runner/github-writeback.js");
    const c = await getOctokitForProject(p.projectId);
    if (!c || c.owner !== p.owner || c.repo !== p.repo) throw new Error("GitHub integration no longer matches the approved repository");
    await pushSpecFilesToBranch({ octokit: c.octokit, owner: p.owner, repo: p.repo, branch: p.headBranch, baseBranch: p.baseBranch, files: p.files, commitMessage: p.commitMessage });
    return ensurePullRequest({ octokit: c.octokit, owner: p.owner, repo: p.repo, branch: p.headBranch, baseBranch: p.baseBranch, title: p.title, body: p.body, draft: true });
  },
};

const ROOT = () => path.join(REPORT_ROOT, "pr-proposals");
const fileOf = (id: string) => path.join(ROOT(), `${id.replace(/[^a-zA-Z0-9-]/g, "")}.json`);
const now = () => new Date().toISOString();
const locks = new Set<string>();

async function save(p: StoredProposal) {
  await fs.mkdir(ROOT(), { recursive: true });
  await fs.writeFile(fileOf(p.id), JSON.stringify(p));
}
export async function loadPrProposal(id: string): Promise<StoredProposal | null> {
  return fs.readFile(fileOf(id), "utf8").then(JSON.parse).catch(() => null);
}

// ── Source resolution (re-run on every view/publish so drift is detected) ───

type Resolved = { files: PrFile[]; baseBranch: string | null; headBranch: string; commitSha: string | null; objectives: string[]; evidence: string[]; risks: string[]; verificationInput: Parameters<typeof publishability>[1]; subject: string };

async function resolveSource(kind: PrKind, source: PrSource): Promise<Resolved> {
  if (source.type === "dev_agent") {
    const run = await prisma.devAgentRun.findUnique({ where: { id: source.devAgentRunId } });
    if (!run) throw new Error("Dev Agent run not found");
    const view = await getCodeFixProposal(run.id);
    const files: PrFile[] = [];
    let commitSha: string | null = null;
    if (run.worktreePath) {
      const d = await worktreeDiff(run.worktreePath);
      commitSha = (await execa("git", ["rev-parse", "HEAD"], { cwd: run.worktreePath, reject: false })).stdout.trim() || null;
      for (const f of d?.files ?? []) {
        const show = await execa("git", ["show", `HEAD:${f.path}`], { cwd: run.worktreePath, reject: false, maxBuffer: 8 * 1024 * 1024, stripFinalNewline: false });
        files.push({ path: f.path, content: show.exitCode === 0 ? show.stdout : null });
      }
    }
    const qeMeta = source.qeJobId
      ? ((await prisma.operatorArtifact.findFirst({ where: { jobId: source.qeJobId, type: "pr_proposal", metaJson: { path: ["devAgentRunId"], equals: run.id } }, select: { metaJson: true } }))?.metaJson as any)
      : null;
    return {
      files, baseBranch: run.baseBranch ?? null, headBranch: run.workBranch ?? `testmind/dev-agent-${run.id}`, commitSha,
      objectives: [qeMeta?.objective, ...((qeMeta?.criteria ?? []) as any[]).map((c) => c.text)].filter(Boolean),
      evidence: [
        view?.baseline ? `Before the change: regression test ${view.baseline.passed ? "passed" : "failed"}` : "No baseline run",
        view?.after ? `After the change: regression test ${view.after.passed ? "passed" : "failed"}` : "Not executed after the change",
        ...(qeMeta?.explanation ? [`Diagnosis: ${qeMeta.explanation}`] : []),
      ],
      risks: view?.risks ?? [],
      verificationInput: { fixStatus: view?.status },
      subject: (qeMeta?.testTitle ?? run.instructionText ?? run.id).split("\n")[0].slice(0, 120),
    };
  }

  if (source.type === "qe_suite") {
    const gen = await prisma.operatorArtifact.findFirst({ where: { jobId: source.qeJobId, type: "report", metaJson: { path: ["kind"], equals: "qe-generation" } }, orderBy: { createdAt: "desc" }, select: { metaJson: true } });
    const genMeta = gen?.metaJson as any;
    const stage = await prisma.operatorTask.findFirst({ where: { jobId: source.qeJobId, type: "stage", stageKey: "generate" }, select: { outputJson: true } });
    const generatedDir = (stage?.outputJson as any)?.generatedDir as string | undefined;
    if (!generatedDir || !genMeta) throw new Error("This run has no generated QE suite");
    const files: PrFile[] = [];
    for (const rel of (genMeta.files ?? []) as string[]) {
      const abs = path.resolve(generatedDir, rel);
      if (!abs.startsWith(path.resolve(generatedDir))) continue;
      files.push({ path: repoPathForTest(rel), content: await fs.readFile(abs, "utf8").catch(() => null) });
    }
    const exec = await prisma.operatorArtifact.findFirst({ where: { jobId: source.qeJobId, type: "execution_result" }, orderBy: { createdAt: "desc" }, select: { metaJson: true } });
    const outcomes = ((exec?.metaJson as any)?.scenarioOutcomes ?? []) as any[];
    const tally = (s: string) => outcomes.filter((o) => o.status === s).length;
    const job = await prisma.operatorJob.findUnique({ where: { id: source.qeJobId }, select: { objective: true } });
    return {
      files, baseBranch: null, headBranch: `testmind/qe-tests-${source.qeJobId.slice(-10)}`, commitSha: null,
      objectives: ((genMeta.tests ?? []) as any[]).slice(0, 40).map((t) => t.title),
      evidence: [`${tally("passed")} passed, ${tally("failed")} failed, ${tally("not_run")} not run in the latest execution`, `${(genMeta.notGenerated ?? []).length} scenario(s) not generated (reported, not fabricated)`],
      risks: tally("failed") ? [`${tally("failed")} generated test(s) currently fail - they may expose product defects or need review`] : [],
      verificationInput: { testsPassed: tally("passed"), testsFailed: tally("failed"), testsNotRun: tally("not_run") },
      subject: `QE suite from ${job?.objective?.replace(/^Autonomous QE \([a-z_]+\): /, "") ?? source.qeJobId}`,
    };
  }

  // Repaired tests: only repairs that passed the objective guard and were verified by a re-run.
  const attemptIds = source.type === "legacy_writeback" ? source.attemptIds : await verifiedRepairAttemptIds(source.qeJobId);
  const attempts = await prisma.testHealingAttempt.findMany({ where: { id: { in: attemptIds } }, select: { id: true, targetSpec: true, repairedSpec: true, executionAfter: true, testCase: { select: { title: true } } } });
  const generated = path.resolve(GENERATED_ROOT);
  const files: PrFile[] = attempts.filter((a) => a.targetSpec && a.repairedSpec).map((a) => {
    const rel = path.relative(generated, path.resolve(a.targetSpec!));
    return { path: repoPathForTest(rel.startsWith("..") ? path.basename(a.targetSpec!) : rel), content: a.repairedSpec! };
  });
  // A repair counts as verified only if its re-run recorded zero failures.
  const passed = attempts.filter((a) => { const e = a.executionAfter as any; return !!e && e.failed === 0; }).length;
  return {
    files, baseBranch: null, headBranch: source.type === "legacy_writeback" ? `testmind/heal-${attemptIds.join("").slice(0, 8)}` : `testmind/qe-repairs-${source.qeJobId.slice(-10)}`, commitSha: null,
    objectives: attempts.map((a) => `Unchanged assertion intent of "${a.testCase.title}"`),
    evidence: [`${passed}/${attempts.length} repaired test(s) passed their verification re-run`],
    risks: [],
    verificationInput: { testsPassed: passed, testsFailed: attempts.length - passed, testsNotRun: 0 },
    subject: `${attempts.length} repaired test(s)`,
  };
}

async function verifiedRepairAttemptIds(qeJobId: string): Promise<string[]> {
  const tasks = await prisma.operatorTask.findMany({ where: { jobId: qeJobId, type: "repair", status: "succeeded" }, select: { outputJson: true } });
  const ids = tasks.map((t) => (t.outputJson as any)?.healingAttemptId).filter((x): x is string => typeof x === "string");
  const verified = await prisma.testHealingAttempt.findMany({ where: { id: { in: ids }, status: "succeeded" }, select: { id: true, executionAfter: true } });
  return verified.filter((a) => { const e = a.executionAfter as any; return e && (e.failed ?? 1) === 0; }).map((a) => a.id);
}

async function compute(projectId: string, kind: PrKind, source: PrSource, gh: GitHubDeps, fingerprintHint?: string) {
  const r = await resolveSource(kind, source);
  const coords = await gh.coords(projectId);
  const binding = bindingFor({ repo: coords ? `${coords.owner}/${coords.repo}` : null, baseBranch: r.baseBranch ?? coords?.defaultBranch ?? "main", headBranch: r.headBranch, commitSha: r.commitSha, files: r.files });
  const fingerprint = fingerprintOf(kind, binding);
  const pub = publishability(kind, r.verificationInput);
  const title = prTitle(kind, pub.verification, r.subject);
  const body = prBody({ kind, verification: pub.verification, objectives: r.objectives, evidence: r.evidence, risks: r.risks, files: r.files.map((f) => ({ path: f.path, status: f.content === null ? "deleted" : "added/modified" })), source: `${source.type}${"qeJobId" in source && source.qeJobId ? ` ${source.qeJobId}` : ""}`, fingerprint: fingerprintHint ?? fingerprint });
  const blockedReason = kind === "app_fix" && !appCodeFixEnabled() ? APP_CODE_FIX_DISABLED_REASON : !coords ? "No GitHub integration is configured for this project" : !r.files.length ? "Nothing to publish" : r.files.some((f) => f.content === null) ? "File deletions are not supported by the publisher - review manually" : !pub.ok ? pub.reason : undefined;
  return { r, binding, fingerprint, pub, title, body, blockedReason, coords };
}

async function requestApproval(p: StoredProposal, actor: string) {
  const approval = await prisma.operatorApproval.create({
    data: {
      jobId: p.jobId, actionType: "pr_publish", requestedBy: actor, expiresAt: new Date(Date.now() + 24 * 3600_000),
      contextJson: { gateKey: `pr:${p.id}`, proposalId: p.id, fingerprint: p.fingerprint, binding: p.binding, prompt: `Publish ${p.kind.replace("_", " ")} PR "${p.title}" to ${p.binding.repo ?? "(no repo)"} (${p.binding.headBranch} -> ${p.binding.baseBranch}${p.binding.commitSha ? ` @ ${p.binding.commitSha.slice(0, 10)}` : ""}, ${p.binding.fileCount} file(s), diff ${p.binding.diffHash.slice(0, 12)})` } as any,
    },
  });
  p.approvalId = approval.id;
  p.status = "awaiting_approval";
  p.history.push({ at: now(), event: "approval_requested", detail: approval.id, actor });
}

async function latestApproval(p: StoredProposal) {
  if (!p.approvalId) return null;
  return prisma.operatorApproval.findUnique({ where: { id: p.approvalId } });
}

const audit = (p: StoredProposal, actor: string | null, action: string, meta: Record<string, unknown> = {}) =>
  recordAuditLog({ projectId: p.projectId, actorId: actor, action, targetType: "pr_proposal", targetId: p.id, metadataJson: { kind: p.kind, fingerprint: p.fingerprint, binding: p.binding, ...meta } }).catch(() => {});

// ── Public API ──────────────────────────────────────────────────────────────

/** Stable id per source, so repeated "prepare" requests reuse one proposal (never duplicate PRs). */
export function proposalIdFor(kind: PrKind, source: PrSource): string {
  if (source.type === "dev_agent") return `${kind}-${source.devAgentRunId}`;
  if (source.type === "legacy_writeback") return `${kind}-${[...source.attemptIds].sort().join("-").slice(0, 80)}`;
  return `${kind}-${source.qeJobId}`;
}

export async function createPrProposal(input: { projectId: string; jobId: string; kind: PrKind; source: PrSource; actor: string }, gh: GitHubDeps = realGitHub) {
  const existingId = proposalIdFor(input.kind, input.source);
  const existing = await loadPrProposal(existingId);
  if (existing && existing.status !== "canceled") return refreshPrProposal(existingId, input.actor, gh);
  const c = await compute(input.projectId, input.kind, input.source, gh);
  const p: StoredProposal = {
    id: existingId, projectId: input.projectId, jobId: input.jobId, kind: input.kind, source: input.source,
    binding: c.binding, fingerprint: c.fingerprint, title: c.title, body: c.body, files: c.r.files,
    objectives: c.r.objectives, evidence: c.r.evidence, risks: c.r.risks, verification: c.pub.verification,
    status: c.blockedReason ? "blocked" : "awaiting_approval", ...(c.blockedReason ? { blockedReason: c.blockedReason } : {}),
    history: [{ at: now(), event: "prepared", actor: input.actor }],
  };
  if (!c.blockedReason) await requestApproval(p, input.actor);
  await save(p);
  await audit(p, input.actor, "pr.proposal_prepared", { status: p.status, blockedReason: c.blockedReason });
  return p;
}

/** Re-resolve from the source; any change expires the old approval and requests a new one. */
export async function refreshPrProposal(id: string, actor: string, gh: GitHubDeps = realGitHub) {
  const p = await loadPrProposal(id);
  if (!p) throw new PrPublicationError(404, "Proposal not found");
  if (p.status === "published" || p.status === "canceled") return p;
  const c = await compute(p.projectId, p.kind, p.source, gh);
  if (c.fingerprint === p.fingerprint && p.status !== "stale" && p.status !== "denied" && p.status !== "expired") return p;
  if (p.approvalId) await prisma.operatorApproval.updateMany({ where: { id: p.approvalId, status: { in: ["pending", "approved"] } }, data: { status: "expired", resolvedAt: new Date() } });
  Object.assign(p, { binding: c.binding, fingerprint: c.fingerprint, title: c.title, body: c.body, files: c.r.files, objectives: c.r.objectives, evidence: c.r.evidence, risks: c.r.risks, verification: c.pub.verification, error: undefined });
  p.history.push({ at: now(), event: "refreshed", detail: c.fingerprint.slice(0, 16), actor });
  if (c.blockedReason) { p.status = "blocked"; p.blockedReason = c.blockedReason; } else { p.blockedReason = undefined; await requestApproval(p, actor); }
  await save(p);
  await audit(p, actor, "pr.proposal_refreshed", { status: p.status });
  return p;
}

// GitHub tokens are redacted explicitly, in addition to the shared redactor.
const GITHUB_TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;
const redactPublishError = (m: string) => redactText(m).replace(GITHUB_TOKEN_RE, "[redacted-token]").slice(0, 1000);

export class PrPublicationError extends Error {
  constructor(public readonly httpStatus: number, message: string, public readonly proposal?: StoredProposal) { super(message); }
}

/** Publishes ONLY if a live approval binds this exact repo/branches/commit/diff. Draft PR; never merged. */
export async function publishPrProposal(id: string, actor: string, gh: GitHubDeps = realGitHub) {
  if (locks.has(id)) throw new PrPublicationError(409, "A publication for this proposal is already in progress");
  locks.add(id);
  try {
    const p = await loadPrProposal(id);
    if (!p) throw new PrPublicationError(404, "Proposal not found");
    if (p.status === "published" && p.prUrl) return p; // idempotent: never a second PR
    if (p.status === "canceled") throw new PrPublicationError(409, "Proposal was canceled", p);

    const c = await compute(p.projectId, p.kind, p.source, gh, p.fingerprint);
    if (c.fingerprint !== p.fingerprint) {
      const changes = bindingChanges(p.binding, c.binding);
      p.status = "stale";
      p.history.push({ at: now(), event: "stale", detail: changes.join("; "), actor });
      await save(p);
      await audit(p, actor, "pr.publish_refused_stale", { changes });
      throw new PrPublicationError(409, `Changed after approval (${changes.join("; ")}) - refresh and reapprove`, p);
    }
    if (c.blockedReason) throw new PrPublicationError(409, c.blockedReason, p);

    const a = await latestApproval(p);
    const decision = approvalAllowsPublish(a ? { status: a.status, expiresAt: a.expiresAt, fingerprint: (a.contextJson as any)?.fingerprint ?? null, consumedAt: (a.contextJson as any)?.consumedAt ?? null } : null, c.fingerprint);
    if (!decision.ok) {
      if (a?.status === "denied") p.status = "denied";
      else if (a && (a.status === "expired" || (a.expiresAt && a.expiresAt.getTime() < Date.now()))) p.status = "expired";
      await save(p);
      await audit(p, actor, "pr.publish_refused", { reason: decision.reason });
      throw new PrPublicationError(409, decision.reason, p);
    }

    p.status = "publishing";
    p.history.push({ at: now(), event: "publishing", actor });
    await save(p);
    try {
      const { prUrl, prNumber } = await gh.publish({
        projectId: p.projectId, owner: c.coords!.owner, repo: c.coords!.repo, baseBranch: c.binding.baseBranch, headBranch: c.binding.headBranch,
        files: c.r.files.map((f) => ({ path: f.path, content: f.content! })), title: c.title, body: c.body,
        commitMessage: `${c.title}\n\nApproved TestMind proposal ${p.id} (fingerprint ${p.fingerprint.slice(0, 16)}). Not auto-merged.`,
      });
      p.status = "published";
      p.prUrl = prUrl;
      p.error = undefined;
      p.history.push({ at: now(), event: "published", detail: prUrl, actor });
      await prisma.operatorApproval.update({ where: { id: a!.id }, data: { contextJson: { ...(a!.contextJson as any), consumedAt: now(), prUrl, prNumber } } });
      if (p.source.type === "dev_agent") await prisma.devAgentRun.update({ where: { id: p.source.devAgentRunId }, data: { prUrl } }).catch(() => {});
      await save(p);
      await audit(p, actor, "pr.published", { prUrl, prNumber });
      return p;
    } catch (err: any) {
      p.status = "publish_failed";
      p.error = redactPublishError(String(err?.message ?? err));
      p.history.push({ at: now(), event: "publish_failed", detail: p.error, actor });
      await save(p);
      await audit(p, actor, "pr.publish_failed", { error: p.error });
      throw new PrPublicationError(502, `GitHub publication failed: ${p.error} (the approval remains valid for a retry of this exact change)`, p);
    }
  } finally {
    locks.delete(id);
  }
}

export async function cancelPrProposal(id: string, actor: string) {
  const p = await loadPrProposal(id);
  if (!p) throw new PrPublicationError(404, "Proposal not found");
  if (p.status === "published") throw new PrPublicationError(409, "Already published - close the PR on GitHub instead", p);
  if (p.approvalId) await prisma.operatorApproval.updateMany({ where: { id: p.approvalId, status: { in: ["pending", "approved"] } }, data: { status: "expired", resolvedAt: new Date() } });
  p.status = "canceled";
  p.history.push({ at: now(), event: "canceled", actor });
  await save(p);
  await audit(p, actor, "pr.proposal_canceled");
  return p;
}

/** Reviewable view, with live approval state and drift detection. */
export async function getPrProposalView(id: string, gh: GitHubDeps = realGitHub) {
  const p = await loadPrProposal(id);
  if (!p) return null;
  const a = await latestApproval(p);
  let status: PrStatus = p.status;
  let changes: string[] = [];
  if (status === "awaiting_approval" || status === "approved" || status === "publish_failed") {
    if (a?.status === "approved") status = (a.contextJson as any)?.consumedAt ? "published" : status === "publish_failed" ? "publish_failed" : "approved";
    else if (a?.status === "denied") status = "denied";
    else if (a?.status === "expired" || (a?.expiresAt && a.expiresAt.getTime() < Date.now())) status = "expired";
    const c = await compute(p.projectId, p.kind, p.source, gh, p.fingerprint).catch(() => null);
    if (c && c.fingerprint !== p.fingerprint) { changes = bindingChanges(p.binding, c.binding); status = "stale"; }
  }
  let diff: string | null = null;
  if (p.source.type === "dev_agent") {
    const run = await prisma.devAgentRun.findUnique({ where: { id: p.source.devAgentRunId }, select: { worktreePath: true } });
    diff = run?.worktreePath ? (await worktreeDiff(run.worktreePath))?.diff ?? null : null;
  } else {
    diff = p.files.map((f) => `--- /dev/null\n+++ b/${f.path}\n${(f.content ?? "").split("\n").slice(0, 400).map((l) => `+${l}`).join("\n")}`).join("\n").slice(0, 200_000);
  }
  return {
    id: p.id, kind: p.kind, status, blockedReason: p.blockedReason ?? null, title: p.title, binding: p.binding, fingerprint: p.fingerprint,
    files: p.files.map((f) => ({ path: f.path, status: f.content === null ? "deleted" : "added/modified", bytes: f.content?.length ?? 0 })),
    objectives: p.objectives, evidence: p.evidence, risks: p.risks, verification: p.verification, prUrl: p.prUrl ?? null, error: p.error ?? null,
    approval: a ? { id: a.id, status: a.status, expiresAt: a.expiresAt, resolvedBy: a.resolvedBy } : null,
    changesSinceApproval: changes, history: p.history.slice(-20), diff, draft: true, autoMerge: false,
  };
}
