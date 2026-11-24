// B6: I/O for code-fix proposals. Creates a Dev Agent run (the existing coding engine) for an
// eligible suspected product defect, and builds the reviewable proposal view from it.
import { execa } from "execa";
import fs from "node:fs";
import { prisma } from "../prisma.js";
import { enqueueOperatorJob } from "../runner/queue.js";
import { applyApplicationModelMerge } from "./application-model-store.js";
import { assessProposalRisk, buildFixInstruction, classifyProposal, codeFixScopeViolations, type ChangedFile, type CodeFixConfig } from "./qe-codefix.js";
import type { FailureInvestigation } from "./failure-intel.js";

const MAX_DIFF_CHARS = 200_000;

export async function createCodeFixProposal(input: {
  qeJob: { id: string; projectId: string; requestedBy: string | null };
  investigation: FailureInvestigation;
  criteria: Array<{ text: string }>;
  config: CodeFixConfig;
}) {
  const { qeJob, investigation: inv, config } = input;
  const requestedBy = qeJob.requestedBy ?? "system";
  const opJob = await prisma.operatorJob.create({
    data: {
      projectId: qeJob.projectId, type: "autonomousDev", status: "queued", requestedBy,
      objective: `Code-fix proposal for suspected defect: ${inv.testTitle}`.slice(0, 500),
      contextJson: { qeCodeFix: { qeJobId: qeJob.id, testCaseId: inv.testCaseId, scenarioId: inv.scenarioId } },
    },
  });
  const run = await prisma.devAgentRun.create({
    data: {
      projectId: qeJob.projectId, operatorJobId: opJob.id, mode: "assigned", targetRepo: config.targetRepo,
      instructionText: buildFixInstruction(inv, { criteria: input.criteria, testCommand: config.testCommand }),
      testCommand: config.testCommand ?? null, budgetUsd: config.budgetUsd ?? 1, maxIterations: config.maxIterations ?? 3, requestedBy,
    },
  });
  const createdAt = new Date().toISOString();
  await applyApplicationModelMerge(qeJob.projectId, (store) => {
    const d = store.defects?.[inv.testCaseId];
    if (!d) return store;
    return { ...store, defects: { ...store.defects, [inv.testCaseId]: { ...d, proposals: [...(d.proposals ?? []), { devAgentRunId: run.id, qeJobId: qeJob.id, createdAt }].slice(-10) } } };
  }).catch(() => {});
  await enqueueOperatorJob(opJob.id);
  return { devAgentRunId: run.id, operatorJobId: opJob.id };
}

/** The proposed change in the run's worktree: everything committed after the base (non dev-agent) commit. */
export async function worktreeDiff(worktreePath: string): Promise<{ base: string; files: ChangedFile[]; diff: string; truncated: boolean } | null> {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null;
  const log = await execa("git", ["log", "--format=%H%x09%s", "-n", "50"], { cwd: worktreePath, reject: false });
  if (log.exitCode !== 0) return null;
  const base = log.stdout.split("\n").map((l) => l.split("\t")).find(([, subject]) => !/^dev-agent:/.test(subject ?? ""))?.[0];
  if (!base) return null;
  const numstat = await execa("git", ["diff", "--numstat", base, "HEAD"], { cwd: worktreePath, reject: false });
  const files: ChangedFile[] = numstat.stdout.split("\n").filter(Boolean).map((l) => {
    const [a, d, p] = l.split("\t");
    return { path: p, additions: Number(a) || 0, deletions: Number(d) || 0 };
  });
  const full = await execa("git", ["diff", base, "HEAD"], { cwd: worktreePath, reject: false, maxBuffer: 8 * 1024 * 1024 });
  const diff = full.stdout ?? "";
  return { base, files, diff: diff.slice(0, MAX_DIFF_CHARS), truncated: diff.length > MAX_DIFF_CHARS };
}

export type CodeFixProposalView = Awaited<ReturnType<typeof getCodeFixProposal>>;

/** Reviewable state of one proposal: status, reasoning, before/after evidence, diff, risks. */
export async function getCodeFixProposal(devAgentRunId: string) {
  const run = await prisma.devAgentRun.findUnique({ where: { id: devAgentRunId } });
  if (!run) return null;
  const iterations = await prisma.devAgentIteration.findMany({ where: { devAgentRunId }, orderBy: { iterationNumber: "asc" } });
  const baseline = iterations.find((i) => i.phase === "baseline") ?? null;
  const attempts = iterations.filter((i) => i.phase !== "baseline");
  const last = attempts[attempts.length - 1] ?? null;
  const lastResult = (last?.testResult ?? null) as any;
  const changes = run.worktreePath ? await worktreeDiff(run.worktreePath) : null;
  const filesFromIterations = [...new Set(attempts.flatMap((i) => ((i.filesChanged as any[]) ?? []).map((f) => f?.path).filter(Boolean)))];
  const files: ChangedFile[] = changes?.files ?? filesFromIterations.map((p) => ({ path: p, additions: 0, deletions: 0 }));
  const risk = assessProposalRisk(files);
  const executed = !!run.testCommand && !!lastResult && !/^No test command configured|^Blocked by agent/.test(String(lastResult.output ?? ""));
  const classified = classifyProposal({
    devRunStatus: run.status, hasTestCommand: !!run.testCommand,
    baselinePassed: baseline ? Boolean((baseline.testResult as any)?.passed) : null,
    afterPassed: executed ? Boolean(lastResult.passed) : null,
    objectiveAligned: lastResult?.objective ? Boolean(lastResult.objective.aligned) : null,
    filesChanged: files.length, testFilesChanged: risk.testFilesChanged, error: run.error,
  });
  // Scope guard: unrelated large deletions, test/fixture changes and files outside the
  // authorized scope reject the proposal regardless of test results.
  const authorizedPaths = run.operatorJobId
    ? (((await prisma.operatorJob.findUnique({ where: { id: run.operatorJobId }, select: { contextJson: true } }))?.contextJson as any)?.qeCodeFix?.authorizedPaths ?? null)
    : null;
  const scopeViolations = files.length && ["verified", "unverified"].includes(classified.status) ? codeFixScopeViolations(files, authorizedPaths) : [];
  const status = scopeViolations.length
    ? { status: "rejected" as const, explanation: `Rejected: ${scopeViolations.join("; ")}` }
    : classified;
  return {
    devAgentRunId: run.id, devAgentStatus: run.status, targetRepo: run.targetRepo, workBranch: run.workBranch, prUrl: run.prUrl,
    ...status,
    reasoning: last?.summary?.slice(0, 4000) ?? null,
    baseline: baseline ? { passed: Boolean((baseline.testResult as any)?.passed), output: String((baseline.testResult as any)?.output ?? "").slice(-3000) } : null,
    after: lastResult ? { passed: Boolean(lastResult.passed), output: String(lastResult.output ?? "").slice(-3000), objective: lastResult.objective ?? null } : null,
    attempts: attempts.length, spentUsd: run.spentUsd,
    files, diff: changes?.diff ?? null, diffTruncated: changes?.truncated ?? false,
    risks: [...scopeViolations, ...risk.reasons], scopeViolations, authorizedPaths, requiresApprovalToApply: risk.sensitive || risk.testFilesChanged.length > 0,
    // Never auto-applied: applying or publishing always needs an explicit human action (B7 gates publication).
    applied: false,
  };
}

const SOURCE_SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "test-results", "playwright-report", "testmind-generated", "tests", "test", "__tests__", "e2e"]);
const SOURCE_EXT = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|html)$/;

/** Bounded, read-only search of the worktree for the application files most likely responsible. */
export async function findLikelySourceFiles(root: string, terms: string[], opts: { maxFiles?: number; maxBytes?: number } = {}) {
  const maxFiles = opts.maxFiles ?? 5, maxBytes = opts.maxBytes ?? 12_000;
  if (!terms.length) return [];
  const scored: Array<{ path: string; score: number; content: string }> = [];
  let visited = 0;
  const stack = [root];
  const fsp = fs.promises;
  while (stack.length && visited < 4000) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const abs = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!SOURCE_SKIP.has(e.name) && !e.name.startsWith(".")) stack.push(abs); continue; }
      if (!SOURCE_EXT.test(e.name) || /\.(spec|test)\./.test(e.name)) continue;
      visited++;
      let content: string;
      try { const st = await fsp.stat(abs); if (st.size > 200_000) continue; content = await fsp.readFile(abs, "utf8"); } catch { continue; }
      const score = terms.reduce((n, t) => n + (content.includes(t) ? 1 : 0), 0);
      if (score) scored.push({ path: abs.slice(root.length + 1).split("\\").join("/"), score, content: content.slice(0, maxBytes) });
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, maxFiles);
}
