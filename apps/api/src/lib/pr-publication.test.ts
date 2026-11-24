import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { approvalAllowsPublish, bindingChanges, bindingFor, fingerprintOf, prBody, prTitle, publishability, repoPathForTest } from "./pr-publication.js";
import { cancelPrProposal, createPrProposal, getPrProposalView, loadPrProposal, publishPrProposal, refreshPrProposal, PrPublicationError, type GitHubDeps } from "./pr-publication-store.js";
import { prisma } from "../prisma.js";
import { REPORT_ROOT } from "./storageRoots.js";

// Application-fix publication is feature-flagged (off by default); the lifecycle tests run with it on.
process.env.TM_APP_CODE_FIX_ENABLED = "true";

// ── Pure rules ──────────────────────────────────────────────────────────────

const files = [{ path: "landing.mjs", content: "export const cta = 'Get Started';\n" }];
const base = bindingFor({ repo: "acme/app", baseBranch: "main", headBranch: "dev-agent/x", commitSha: "a".repeat(40), files });

test("the approval fingerprint binds repository, branches, commit and every byte of the diff", () => {
  const fp = fingerprintOf("app_fix", base);
  assert.equal(fingerprintOf("app_fix", { ...base }), fp);
  const variants = [
    bindingFor({ repo: "acme/other", baseBranch: "main", headBranch: "dev-agent/x", commitSha: "a".repeat(40), files }),
    bindingFor({ repo: "acme/app", baseBranch: "release", headBranch: "dev-agent/x", commitSha: "a".repeat(40), files }),
    bindingFor({ repo: "acme/app", baseBranch: "main", headBranch: "dev-agent/x", commitSha: "b".repeat(40), files }),
    bindingFor({ repo: "acme/app", baseBranch: "main", headBranch: "dev-agent/x", commitSha: "a".repeat(40), files: [{ path: "landing.mjs", content: "export const cta = 'Get started';\n" }] }),
  ];
  for (const v of variants) assert.notEqual(fingerprintOf("app_fix", v), fp);
  assert.notEqual(fingerprintOf("test_suite", base), fp, "test PRs and app PRs are distinct approvals");
  assert.deepEqual(bindingChanges(base, variants[2]), [`commit ${"a".repeat(10)} -> ${"b".repeat(10)}`]);
  assert.deepEqual(bindingChanges(base, variants[3]), ["file contents changed"]);
});

test("never publish an unverified or failed fix as verified", () => {
  assert.equal(publishability("app_fix", { fixStatus: "verified" }).verification.label, "verified");
  const unv = publishability("app_fix", { fixStatus: "unverified" });
  assert.equal(unv.ok, false, "an unverified application fix is never published");
  assert.equal(unv.verification.label, "unverified");
  assert.equal(publishability("app_fix", { fixStatus: "rejected" }).ok, false, "scope-guard rejections are never published");
  assert.match(prTitle("app_fix", unv.verification, "x"), /UNVERIFIED fix proposal/);
  assert.equal(publishability("app_fix", { fixStatus: "failed" }).ok, false);
  assert.equal(publishability("app_fix", { fixStatus: "in_progress" }).ok, false);
  assert.equal(publishability("test_repair", { testsPassed: 1, testsFailed: 1 }).ok, false, "repairs that still fail are not published");
  assert.match(prTitle("test_suite", publishability("test_suite", { testsPassed: 3 }).verification, "x"), /Generated tests/);
  const body = prBody({ kind: "app_fix", verification: unv.verification, objectives: ["Get Started is offered"], evidence: ["after: passed"], risks: [], files: [{ path: "a", status: "added/modified" }], source: "dev_agent r", fingerprint: "f".repeat(64) });
  assert.match(body, /draft PR and is never merged automatically/);
  assert.match(body, /\*\*Verification:\*\* UNVERIFIED/);
  assert.match(body, /Get Started is offered/);
  assert.equal(repoPathForTest("qe/home.qe.spec.ts"), "tests/testmind/qe/home.qe.spec.ts", "tests land apart from application code");
});

test("approval must be live, unused, and for exactly this change", () => {
  const fp = "x";
  const later = new Date(Date.now() + 3600_000);
  assert.match(approvalAllowsPublish(null, fp).reason, /No approval/);
  assert.match(approvalAllowsPublish({ status: "pending", expiresAt: later, fingerprint: fp, consumedAt: null }, fp).reason, /Awaiting/);
  assert.match(approvalAllowsPublish({ status: "denied", expiresAt: later, fingerprint: fp, consumedAt: null }, fp).reason, /denied/);
  assert.match(approvalAllowsPublish({ status: "approved", expiresAt: new Date(Date.now() - 1), fingerprint: fp, consumedAt: null }, fp).reason, /expired/);
  assert.match(approvalAllowsPublish({ status: "approved", expiresAt: later, fingerprint: fp, consumedAt: "t" }, fp).reason, /already used/);
  assert.match(approvalAllowsPublish({ status: "approved", expiresAt: later, fingerprint: "other", consumedAt: null }, fp).reason, /reapproval/);
  assert.equal(approvalAllowsPublish({ status: "approved", expiresAt: later, fingerprint: fp, consumedAt: null }, fp).ok, true);
});

// ── Store lifecycle against a disposable worktree + mocked GitHub ────────────

async function fixture(t: any, opts: { fixVerified?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-pr-"));
  const git = (...a: string[]) => execa("git", a, { cwd: dir });
  await git("init", "-q"); await git("config", "user.email", "t@x.test"); await git("config", "user.name", "T"); await git("config", "core.autocrlf", "false");
  await fs.writeFile(path.join(dir, "landing.mjs"), "export const cta = 'Continue';\n"); await git("add", "."); await git("commit", "-qm", "base");
  await fs.writeFile(path.join(dir, "landing.mjs"), "export const cta = 'Get Started';\n"); await git("commit", "-qam", "dev-agent: iteration 1 - modify landing.mjs");
  const project = await prisma.project.findFirst({ orderBy: { createdAt: "asc" } });
  const job = await prisma.operatorJob.create({ data: { projectId: project!.id, type: "autonomousDev", status: "succeeded", requestedBy: "owner-1", contextJson: { qeCodeFix: { authorizedPaths: ["landing.mjs"] } } } });
  const run = await prisma.devAgentRun.create({ data: { projectId: project!.id, operatorJobId: job.id, targetRepo: "testmind", status: "succeeded", worktreePath: dir, workBranch: "dev-agent/pr-test", testCommand: "node --test", requestedBy: "owner-1" } });
  await prisma.devAgentIteration.createMany({ data: [
    { devAgentRunId: run.id, iterationNumber: 0, phase: "baseline", summary: "b", filesChanged: [], testResult: { passed: opts.fixVerified === false, output: "" }, costUsd: 0 },
    { devAgentRunId: run.id, iterationNumber: 1, phase: "code", summary: "fix", filesChanged: [{ path: "landing.mjs" }], testResult: { passed: true, output: "ok", objective: { aligned: true, reason: "" } }, costUsd: 0 },
  ] });
  const calls: any[] = [];
  let failNext = false;
  const gh: GitHubDeps & { failNext: (v: boolean) => void } = {
    coords: async () => ({ owner: "acme", repo: "app", defaultBranch: "main" }),
    publish: async (p) => { calls.push(p); if (failNext) { failNext = false; throw new Error("GitHub API 502 (token ghp_SECRETSECRETSECRETSECRETSECRET1234)"); } return { prUrl: "https://github.com/acme/app/pull/7", prNumber: 7 }; },
    failNext: (v) => { failNext = v; },
  };
  const source = { type: "dev_agent" as const, devAgentRunId: run.id };
  t.after(async () => {
    await prisma.auditLog.deleteMany({ where: { targetId: `app_fix-${run.id}` } });
    await prisma.operatorApproval.deleteMany({ where: { jobId: job.id } });
    await prisma.devAgentIteration.deleteMany({ where: { devAgentRunId: run.id } });
    await prisma.devAgentRun.delete({ where: { id: run.id } });
    await prisma.operatorJob.delete({ where: { id: job.id } });
    await fs.rm(path.join(REPORT_ROOT, "pr-proposals", `appfix-${run.id}.json`), { force: true });
    await fs.rm(dir, { recursive: true, force: true });
  });
  const approve = async (status: "approved" | "denied" = "approved", expiresAt?: Date) => {
    const p = await loadPrProposal(`app_fix-${run.id}`);
    await prisma.operatorApproval.update({ where: { id: p!.approvalId! }, data: { status, resolvedBy: "owner-1", resolvedAt: new Date(), ...(expiresAt ? { expiresAt } : {}) } });
  };
  return { dir, git, project: project!, job, run, gh, calls, source, approve };
}

const create = (f: Awaited<ReturnType<typeof fixture>>) => createPrProposal({ projectId: f.project.id, jobId: f.job.id, kind: "app_fix", source: f.source, actor: "owner-1" }, f.gh);

test("prepare -> no publish without approval -> approve -> exactly one draft PR with the approved files", async (t) => {
  const f = await fixture(t);
  const p = await create(f);
  assert.equal(p.status, "awaiting_approval");
  assert.equal(p.binding.repo, "acme/app");
  assert.equal(p.binding.headBranch, "dev-agent/pr-test");
  assert.match(p.binding.commitSha ?? "", /^[0-9a-f]{40}$/);
  assert.match(p.title, /Verified fix/);
  const approval = await prisma.operatorApproval.findUnique({ where: { id: p.approvalId! } });
  assert.equal(approval?.actionType, "pr_publish");
  assert.equal((approval?.contextJson as any).fingerprint, p.fingerprint);

  await assert.rejects(publishPrProposal(p.id, "owner-1", f.gh), (e) => e instanceof PrPublicationError && /Awaiting/.test(e.message));
  assert.equal(f.calls.length, 0, "nothing is published before approval");

  await f.approve();
  const pub = await publishPrProposal(p.id, "owner-1", f.gh);
  assert.equal(pub.status, "published");
  assert.equal(pub.prUrl, "https://github.com/acme/app/pull/7");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].files, [{ path: "landing.mjs", content: "export const cta = 'Get Started';\n" }]);
  assert.equal(f.calls[0].baseBranch, "main");
  assert.match(f.calls[0].body, /never merged automatically/);
  const consumed = await prisma.operatorApproval.findUnique({ where: { id: p.approvalId! } });
  assert.ok((consumed?.contextJson as any).consumedAt, "approval is single-use");
  assert.equal((await prisma.devAgentRun.findUnique({ where: { id: f.run.id } }))?.prUrl, pub.prUrl);
  const audits = await prisma.auditLog.findMany({ where: { targetId: p.id }, select: { action: true } });
  assert.ok(audits.some((a) => a.action === "pr.published") && audits.some((a) => a.action === "pr.proposal_prepared"));

  const again = await publishPrProposal(p.id, "owner-1", f.gh);
  assert.equal(again.prUrl, pub.prUrl);
  assert.equal(f.calls.length, 1, "repeated publication never opens a second PR");
});

test("a change after approval makes it stale; refresh requires a NEW approval", async (t) => {
  const f = await fixture(t);
  const p = await create(f);
  await f.approve();
  await fs.writeFile(path.join(f.dir, "landing.mjs"), "export const cta = 'Get Started!';\n");
  await f.git("commit", "-qam", "dev-agent: iteration 2 - tweak");
  await assert.rejects(publishPrProposal(p.id, "owner-1", f.gh), (e) => e instanceof PrPublicationError && /Changed after approval/.test(e.message) && /commit/.test(e.message));
  assert.equal(f.calls.length, 0);
  assert.equal((await getPrProposalView(p.id, f.gh))?.status, "stale");
  const oldApproval = p.approvalId!;
  const r = await refreshPrProposal(p.id, "owner-1", f.gh);
  assert.notEqual(r.approvalId, oldApproval);
  assert.equal((await prisma.operatorApproval.findUnique({ where: { id: oldApproval } }))?.status, "expired");
  assert.equal(r.status, "awaiting_approval");
  await assert.rejects(publishPrProposal(p.id, "owner-1", f.gh), /Awaiting/);
});

test("denial, expiry and cancellation block publication; GitHub errors are recoverable without re-approval", async (t) => {
  const f = await fixture(t);
  const p = await create(f);
  await f.approve("denied");
  await assert.rejects(publishPrProposal(p.id, "owner-1", f.gh), /denied/);
  assert.equal((await loadPrProposal(p.id))?.status, "denied");

  await refreshPrProposal(p.id, "owner-1", f.gh); // request a fresh approval
  await f.approve("approved", new Date(Date.now() - 1000));
  await assert.rejects(publishPrProposal(p.id, "owner-1", f.gh), /expired/);

  await refreshPrProposal(p.id, "owner-1", f.gh);
  await f.approve();
  f.gh.failNext(true);
  await assert.rejects(publishPrProposal(p.id, "owner-1", f.gh), (e) => e instanceof PrPublicationError && e.httpStatus === 502);
  const failed = await loadPrProposal(p.id);
  assert.equal(failed?.status, "publish_failed");
  assert.doesNotMatch(failed?.error ?? "", /ghp_SECRET/, "GitHub errors are redacted");
  const retried = await publishPrProposal(p.id, "owner-1", f.gh);
  assert.equal(retried.status, "published", "the unused approval still covers this exact change");

  const f2 = await fixture(t);
  const p2 = await create(f2);
  await cancelPrProposal(p2.id, "owner-1");
  assert.equal((await prisma.operatorApproval.findUnique({ where: { id: p2.approvalId! } }))?.status, "expired");
  await assert.rejects(publishPrProposal(p2.id, "owner-1", f2.gh), /canceled/);
});

test("unverified and failed fixes, and missing GitHub integration, are blocked", async (t) => {
  const f = await fixture(t, { fixVerified: false }); // baseline passed -> proposal is unverified
  const p = await create(f);
  assert.equal(p.status, "blocked");
  assert.match(p.blockedReason ?? "", /Unverified application fixes cannot be published/);
  assert.equal(p.approvalId, undefined);
  assert.match(p.title, /UNVERIFIED/, "still honestly labelled for review");

  const g = await fixture(t);
  await prisma.devAgentRun.update({ where: { id: g.run.id }, data: { status: "failed", error: "Max iterations" } });
  const blocked = await create(g);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.blockedReason ?? "", /cannot be published/);
  assert.equal(blocked.approvalId, undefined, "no approval is even requested for an unpublishable change");

  const h = await fixture(t);
  const noGh = await createPrProposal({ projectId: h.project.id, jobId: h.job.id, kind: "app_fix", source: h.source, actor: "o" }, { ...h.gh, coords: async () => null });
  assert.equal(noGh.status, "blocked");
  assert.match(noGh.blockedReason ?? "", /No GitHub integration/);
});

test("application-code fixes are disabled unless the feature flag is on", async (t) => {
  const f = await fixture(t);
  process.env.TM_APP_CODE_FIX_ENABLED = "false";
  try {
    const p = await create(f);
    assert.equal(p.status, "blocked");
    assert.match(p.blockedReason ?? "", /application-code fixes are disabled/);
    await assert.rejects(publishPrProposal(p.id, "owner-1", f.gh), /disabled/);
    assert.equal(f.calls.length, 0);
  } finally {
    process.env.TM_APP_CODE_FIX_ENABLED = "true";
  }
});

test("a fix outside its authorized scope is rejected and cannot be published", async (t) => {
  const f = await fixture(t);
  await prisma.operatorJob.update({ where: { id: f.job.id }, data: { contextJson: { qeCodeFix: { authorizedPaths: ["src/landing-page.tsx"] } } } });
  const p = await create(f);
  assert.equal(p.status, "blocked");
  assert.match(p.blockedReason ?? "", /rejected by the scope guard/);
  await assert.rejects(publishPrProposal(p.id, "owner-1", f.gh));
  assert.equal(f.calls.length, 0);
});

test("Dev Agent test-only proposal: repo resolved from the run's own repository (connected account), labelled as generated tests, still approval-gated", async (t) => {
  const f = await fixture(t);
  await prisma.devAgentRun.update({ where: { id: f.run.id }, data: { targetRepo: "acme/app" } });
  const hints: Array<string | undefined> = [];
  const gh: GitHubDeps = { ...f.gh, coords: async (_p, hint) => { hints.push(hint); return { owner: "acme", repo: "app", defaultBranch: "main" }; } };
  t.after(async () => {
    await prisma.auditLog.deleteMany({ where: { targetId: `test_suite-${f.run.id}` } });
    await prisma.operatorApproval.deleteMany({ where: { jobId: f.job.id } });
    await fs.rm(path.join(REPORT_ROOT, "pr-proposals", `testsuite-${f.run.id}.json`), { force: true });
  });
  const p = await createPrProposal({ projectId: f.project.id, jobId: f.job.id, kind: "test_suite", source: f.source, actor: "owner-1" }, gh);
  assert.ok(hints.includes("acme/app"), "coords must authorize the repository the run changed, not a project-level integration");
  assert.equal(p.binding.repo, "acme/app");
  assert.equal(p.status, "awaiting_approval");
  assert.match(p.title, /Generated tests/);
  await assert.rejects(publishPrProposal(p.id, "owner-1", gh), PrPublicationError);
  assert.equal(f.calls.length, 0, "never published without explicit approval");
});
