import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { appCodeFixEnabled, assessProposalRisk, buildFixInstruction, classifyProposal, codeFixScopeViolations, eligibleForCodeFix, isCodeFixConfig } from "./qe-codefix.js";
import { getCodeFixProposal, worktreeDiff } from "./qe-codefix-store.js";
import type { FailureInvestigation } from "./failure-intel.js";
import { prisma } from "../prisma.js";

const defect: FailureInvestigation = {
  testResultId: "tr", testCaseId: "tc", testTitle: "AC: The Get Started button is visible [qe:abc]", scenarioId: "abc", route: "/",
  category: "product_defect", cause: "objective_unmet", confidence: "medium",
  explanation: 'The objective requires "Get Started", and it was not among the elements observed on /.',
  evidence: [
    { kind: "assertion", detail: "locator('button:has-text(\"Get Started\")') element(s) not found" },
    { kind: "observation", detail: "Brain: / is public (HTTP 200, 2026-11-23T22:36:14Z)" },
  ],
  repairable: false, escalate: true, objective: "The Get Started button is visible on the landing page",
};

test("only evidence-backed suspected product defects are eligible for a code-fix proposal", () => {
  assert.equal(eligibleForCodeFix(defect).eligible, true);
  assert.equal(eligibleForCodeFix({ ...defect, confidence: "low" }).eligible, false);
  assert.equal(eligibleForCodeFix({ ...defect, category: "test_defect" }).eligible, false, "test defects are repaired as tests, not app code");
  assert.equal(eligibleForCodeFix({ ...defect, evidence: [{ kind: "observation", detail: "x" }] }).eligible, false, "a failing assertion is required");
  assert.equal(isCodeFixConfig({ targetRepo: "testmind", testCommand: "node --test" }), true);
  assert.equal(isCodeFixConfig({ targetRepo: "" }), false);
  assert.equal(isCodeFixConfig({ targetRepo: "testmind", maxIterations: 50 }), false);
});

test("the Dev Agent is told to fix the application so the UNCHANGED objective holds", () => {
  const text = buildFixInstruction(defect, { criteria: [{ text: "The Get Started button is visible on the landing page" }], testCommand: "node --test test/landing.test.mjs" });
  assert.match(text, /Do not modify tests, fixtures, or acceptance criteria/);
  assert.match(text, /Objective that must hold after the fix \(unchanged\): The Get Started button is visible/);
  assert.match(text, /Acceptance criterion \(unchanged\)/);
  assert.match(text, /element\(s\) not found/, "evidence is included");
  assert.match(text, /node --test test\/landing\.test\.mjs/);
  assert.match(text, /"blocked": true/, "the agent may report it cannot find the source instead of guessing");
  assert.match(buildFixInstruction(defect, { criteria: [] }), /unverified proposal/);
});

test("risk: sensitive areas, large changes and test edits require approval to apply", () => {
  assert.deepEqual(assessProposalRisk([{ path: "src/pages/Landing.tsx", additions: 3, deletions: 1 }]), { sensitive: false, reasons: [], testFilesChanged: [] });
  const auth = assessProposalRisk([{ path: "apps/api/src/auth/session.ts", additions: 5, deletions: 2 }]);
  assert.equal(auth.sensitive, true);
  assert.match(auth.reasons[0], /sensitive/);
  assert.equal(assessProposalRisk([{ path: "src/a.ts", additions: 180, deletions: 40 }]).sensitive, true);
  const tests = assessProposalRisk([{ path: "src/app.ts", additions: 1, deletions: 1 }, { path: "test/landing.test.mjs", additions: 1, deletions: 1 }]);
  assert.deepEqual(tests.testFilesChanged, ["test/landing.test.mjs"]);
});

test("verified, unverified and failed proposals are distinguished truthfully", () => {
  const base = { devRunStatus: "succeeded", hasTestCommand: true, baselinePassed: false, afterPassed: true, objectiveAligned: true, filesChanged: 1, testFilesChanged: [] as string[] };
  assert.equal(classifyProposal(base).status, "verified");
  assert.equal(classifyProposal({ ...base, baselinePassed: true }).status, "unverified", "a test that already passed proves nothing");
  assert.equal(classifyProposal({ ...base, baselinePassed: null }).status, "unverified");
  assert.equal(classifyProposal({ ...base, hasTestCommand: false, afterPassed: null, devRunStatus: "unverified" }).status, "unverified");
  assert.equal(classifyProposal({ ...base, testFilesChanged: ["test/a.test.mjs"] }).status, "unverified", "editing tests can't count as a fix");
  assert.equal(classifyProposal({ ...base, objectiveAligned: false }).status, "unverified");
  assert.equal(classifyProposal({ ...base, afterPassed: false }).status, "failed");
  assert.equal(classifyProposal({ ...base, devRunStatus: "failed", error: "Max iterations reached" }).status, "failed");
  assert.equal(classifyProposal({ ...base, filesChanged: 0 }).status, "failed");
  assert.equal(classifyProposal({ ...base, devRunStatus: "awaitingApproval" }).status, "awaiting_approval");
  assert.equal(classifyProposal({ ...base, devRunStatus: "running" }).status, "in_progress");
});

async function repoWithFix() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-codefix-"));
  const git = (...a: string[]) => execa("git", a, { cwd: dir });
  await git("init", "-q");
  await git("config", "user.email", "t@example.test");
  await git("config", "user.name", "T");
  await fs.writeFile(path.join(dir, "landing.mjs"), "export const cta = 'Continue with Email';\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "initial app");
  await fs.writeFile(path.join(dir, "landing.mjs"), "export const cta = 'Get Started';\n");
  await git("commit", "-q", "-am", "dev-agent: iteration 1 - modify landing.mjs");
  return dir;
}

test("the proposed change is the worktree diff since the base commit", async (t) => {
  const dir = await repoWithFix();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const d = (await worktreeDiff(dir))!;
  assert.deepEqual(d.files, [{ path: "landing.mjs", additions: 1, deletions: 1 }]);
  assert.match(d.diff, /-export const cta = 'Continue with Email';/);
  assert.match(d.diff, /\+export const cta = 'Get Started';/);
  assert.equal(await worktreeDiff(path.join(dir, "missing")), null);
});

test("proposal view: baseline failed -> fix -> passed with objective intact = verified, with diff and evidence, never applied", async (t) => {
  const dir = await repoWithFix();
  const project = await prisma.project.findFirst({ orderBy: { createdAt: "asc" } });
  assert.ok(project, "requires a local project row");
  const job = await prisma.operatorJob.create({ data: { projectId: project!.id, type: "autonomousDev", status: "succeeded", requestedBy: "test", contextJson: { qeCodeFix: { authorizedPaths: ["landing.mjs"] } } } });
  const run = await prisma.devAgentRun.create({ data: { projectId: project!.id, operatorJobId: job.id, targetRepo: "testmind", status: "succeeded", worktreePath: dir, testCommand: "node --test", requestedBy: "test" } });
  await prisma.devAgentIteration.createMany({ data: [
    { devAgentRunId: run.id, iterationNumber: 0, phase: "baseline", summary: "baseline", filesChanged: [], testResult: { passed: false, output: "expected 'Get Started'" }, costUsd: 0 },
    { devAgentRunId: run.id, iterationNumber: 1, phase: "code", summary: "Restored the Get Started CTA text", filesChanged: [{ path: "landing.mjs" }], testResult: { passed: true, output: "1 passed", objective: { aligned: true, reason: "No test files changed" } }, costUsd: 0.001 },
  ] });
  t.after(async () => {
    await prisma.devAgentIteration.deleteMany({ where: { devAgentRunId: run.id } });
    await prisma.devAgentRun.delete({ where: { id: run.id } });
    await prisma.operatorJob.delete({ where: { id: job.id } });
    await fs.rm(dir, { recursive: true, force: true });
  });
  const p = (await getCodeFixProposal(run.id))!;
  assert.equal(p.status, "verified");
  assert.deepEqual(p.scopeViolations, []);

  // The same verified change is rejected when it falls outside the authorized scope.
  await prisma.operatorJob.update({ where: { id: job.id }, data: { contextJson: { qeCodeFix: { authorizedPaths: ["src/other.tsx"] } } } });
  const outside = (await getCodeFixProposal(run.id))!;
  assert.equal(outside.status, "rejected");
  assert.match(outside.explanation, /outside the authorized objective scope/);
  assert.equal(p.baseline?.passed, false);
  assert.equal(p.after?.passed, true);
  assert.equal(p.reasoning, "Restored the Get Started CTA text");
  assert.match(p.diff ?? "", /\+export const cta = 'Get Started'/);
  assert.equal(p.requiresApprovalToApply, false);
  assert.equal(p.applied, false);
});

test("repository inspection: the defect's terms locate the responsible application file, never tests", async (t) => {
  const { searchTermsForDefect } = await import("./qe-codefix.js");
  const { findLikelySourceFiles } = await import("./qe-codefix-store.js");
  const instruction = buildFixInstruction({ ...defect, evidence: [...defect.evidence, { kind: "observation", detail: "Brain: / is public; observed actions: Sign In, Continue with Email" }] }, { criteria: [] });
  const terms = searchTermsForDefect(instruction);
  assert.ok(terms.includes("Get Started") && terms.includes("Continue with Email"), JSON.stringify(terms));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-codefix-src-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "test"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "landing.mjs"), "export const actions = ['Sign In', 'Continue with Email'];\n");
  await fs.writeFile(path.join(dir, "src", "unrelated.mjs"), "export const x = 1;\n");
  await fs.writeFile(path.join(dir, "test", "landing.test.mjs"), "// expects 'Get Started'\n");
  const found = await findLikelySourceFiles(dir, terms);
  assert.deepEqual(found.map((f) => f.path), ["src/landing.mjs"]);
});

test("release gate: application-code fixes are off unless explicitly enabled", () => {
  assert.equal(appCodeFixEnabled({}), false);
  assert.equal(appCodeFixEnabled({ TM_APP_CODE_FIX_ENABLED: "false" }), false);
  assert.equal(appCodeFixEnabled({ TM_APP_CODE_FIX_ENABLED: "1" }), false, "only the explicit value enables it");
  assert.equal(appCodeFixEnabled({ TM_APP_CODE_FIX_ENABLED: "true" }), true);
});

test("scope guard rejects unrelated large deletions, test/fixture edits and out-of-scope files", () => {
  const scope = ["src/pages/Landing.tsx"];
  assert.deepEqual(codeFixScopeViolations([{ path: "src/pages/Landing.tsx", additions: 3, deletions: 1 }], scope), []);
  // The certification case: an irrelevant page gutted by the agent.
  const cert = codeFixScopeViolations([{ path: "apps/web/src/pages/UrlBuilderPage.tsx", additions: 6, deletions: 1085 }], scope);
  assert.ok(cert.some((v) => /large deletion in apps\/web\/src\/pages\/UrlBuilderPage\.tsx \(-1085\/\+6\)/.test(v)), cert.join(" | "));
  assert.ok(cert.some((v) => /outside the authorized objective scope/.test(v)));
  // Even inside scope, a large deletion is rejected.
  assert.ok(codeFixScopeViolations([{ path: "src/pages/Landing.tsx", additions: 2, deletions: 60 }], scope).some((v) => /large deletion/.test(v)));
  assert.ok(codeFixScopeViolations([{ path: "src/pages/Landing.tsx", additions: 1, deletions: 1 }, { path: "test/landing.test.mjs", additions: 1, deletions: 1 }], [...scope, "test/landing.test.mjs"]).some((v) => /modifies tests or fixtures/.test(v)));
  assert.ok(codeFixScopeViolations([{ path: "src/__fixtures__/user.json", additions: 1, deletions: 0 }], ["src/__fixtures__/user.json"]).some((v) => /fixtures/.test(v)));
  assert.ok(codeFixScopeViolations([{ path: "src/pages/Landing.tsx", additions: 1, deletions: 1 }], null).some((v) => /no authorized scope/.test(v)), "no scope -> relevance cannot be established");
});

test("isTestFilePath separates test-only changes from application code (Windows paths too)", async () => {
  const { isTestFilePath } = await import("./qe-codefix.js");
  for (const p of ["tests/signup.spec.ts", "e2e\login.spec.ts", "src/a.test.js", "__tests__/x.ts"]) assert.equal(isTestFilePath(p), true, p);
  for (const p of ["src/app.ts", "landing.mjs", "src/testing-utils.ts"]) assert.equal(isTestFilePath(p), false, p);
});
