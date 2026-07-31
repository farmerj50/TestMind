import path from "node:path";
import fs from "node:fs/promises";
import { prisma } from "../prisma.js";
import { enqueueRun } from "./queue.js";
import { validatedEnv } from "../config/env.js";
import {
  getOctokitForProject,
  pushSpecFilesToBranch,
  ensurePullRequest,
  postPrComment,
  setCommitStatus,
  buildRepairPrBody,
  type GitHubCoords,
} from "./github-writeback.js";
import { recordAgentRunMetrics, type AgentRunMetrics } from "./agent-telemetry.js";

const RUN_POLL_MS = 3_000;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;

export type OrchestratorDeps = {
  prisma: typeof prisma;
};

export type OrchestratorResult = {
  status: "succeeded" | "failed" | "error";
  prUrl?: string;
  prNumber?: number;
  commitSha?: string;
};

export class AgentOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async run(jobId: string): Promise<OrchestratorResult> {
    const job = await this.deps.prisma.operatorJob.findUnique({
      where: { id: jobId },
      select: { id: true, projectId: true, contextJson: true, requestedBy: true },
    });
    if (!job) throw new Error(`OperatorJob ${jobId} not found`);

    const ctx = (job.contextJson ?? {}) as Record<string, any>;
    const sha: string | undefined = ctx.sha;
    const gh = sha ? await getOctokitForProject(job.projectId) : null;

    try {
      if (gh && sha) await this.postStatus(gh, sha, "pending", "Tests running…");

      const result = await this.runTests(job.id, job.projectId, ctx);

      if (result.failed > 0) {
        const repairResult = await this.repairAndRetest(job, ctx, gh, sha);
        if (gh && sha) {
          await this.postStatus(gh, sha, repairResult.retestPassed ? "success" : "failure",
            repairResult.retestPassed ? `${repairResult.retestPassed} passed` : "Retest failed after repair");
        }
        return repairResult.orchestratorResult;
      }

      if (gh && sha) {
        await this.postStatus(gh, sha, "success", `${result.passed} passed`);
      }
      return { status: "succeeded" };
    } catch (err: any) {
      if (gh && sha) {
        await this.postStatus(gh, sha, "error", "Unexpected error").catch(() => {});
      }
      throw err;
    }
  }

  private async runTests(
    jobId: string,
    projectId: string,
    ctx: Record<string, any>
  ): Promise<{ passed: number; failed: number; total: number; runId: string }> {
    const run = await this.deps.prisma.testRun.create({
      data: { projectId, status: "queued", trigger: "operator" },
    });

    await enqueueRun(run.id, {
      projectId,
      baseUrl: ctx.baseUrl,
      mode: ctx.mode ?? "regular",
      file: ctx.file,
      timeoutMs: 12 * 60 * 1000,
    });

    const finished = await this.pollRun(run.id, RUN_TIMEOUT_MS);
    const summary = await this.getRunSummary(run.id);
    return { ...summary, runId: run.id };
  }

  private async repairAndRetest(
    job: { id: string; projectId: string; contextJson: unknown },
    ctx: Record<string, any>,
    gh: GitHubCoords | null,
    sha: string | undefined
  ): Promise<{ retestPassed: number; orchestratorResult: OrchestratorResult }> {
    const startedAt = Date.now();

    // Find all run IDs linked to this job's tasks, then collect healed attempts
    const taskRunIds = await this.deps.prisma.operatorTask.findMany({
      where: { jobId: job.id, testRunId: { not: null } },
      select: { testRunId: true },
    }).then((tasks) => tasks.map((t) => t.testRunId).filter(Boolean) as string[]);

    const attempts = await this.deps.prisma.testHealingAttempt.findMany({
      where: {
        runId: { in: taskRunIds },
        status: "succeeded",
      },
      select: {
        id: true,
        targetSpec: true,
        repairedSpec: true,
        originalSpec: true,
        modelUsed: true,
        repairReason: true,
        confidenceScore: true,
        executionBefore: true,
        diff: true,
      },
    });

    const repairTimeMs = Date.now() - startedAt;

    if (attempts.length === 0 || !gh) {
      return { retestPassed: 0, orchestratorResult: { status: "failed" } };
    }

    // Run retest
    const retestStart = Date.now();
    const retestRun = await this.deps.prisma.testRun.create({
      data: { projectId: job.projectId, status: "queued", trigger: "operator" },
    });
    await enqueueRun(retestRun.id, {
      projectId: job.projectId,
      baseUrl: ctx.baseUrl,
      mode: ctx.mode ?? "regular",
      file: ctx.file,
      timeoutMs: 12 * 60 * 1000,
    });
    await this.pollRun(retestRun.id, RUN_TIMEOUT_MS);
    const retestSummary = await this.getRunSummary(retestRun.id);
    const retestTimeMs = Date.now() - retestStart;

    // Persist executionAfter
    await this.deps.prisma.testHealingAttempt.updateMany({
      where: { id: { in: attempts.map((a) => a.id) } },
      data: { executionAfter: retestSummary as any },
    });

    if (retestSummary.failed > 0) {
      return { retestPassed: 0, orchestratorResult: { status: "failed" } };
    }

    // GitHub writeback
    const minConf = Math.min(...attempts.map((a) => a.confidenceScore ?? 0));
    const files = await Promise.all(
      attempts.map(async (a) => {
        const content = a.repairedSpec ?? (a.targetSpec ? await fs.readFile(a.targetSpec, "utf8").catch(() => "") : "");
        return { path: a.targetSpec ?? "", content };
      })
    ).then((arr) => arr.filter((f) => f.path && f.content));

    if (files.length === 0) {
      return { retestPassed: retestSummary.passed, orchestratorResult: { status: "succeeded" } };
    }

    const branchName = `testmind/heal-${job.id.slice(0, 8)}`;
    const prBody = buildRepairPrBody({ attempts, retestSummary });

    const { commitSha } = await pushSpecFilesToBranch({
      ...gh,
      branch: branchName,
      baseBranch: gh.defaultBranch,
      files,
      commitMessage: `fix(tests): self-heal repair — ${attempts.length} spec(s) [job ${job.id.slice(0, 8)}]\n\nCo-authored-by: TestMind <bot@testmind.ai>`,
    });

    let prNumber: number | undefined;
    let prUrl: string | undefined;

    const title = `TestMind: repaired ${attempts.length} test(s)`;

    if (minConf >= 95) {
      const pr = await ensurePullRequest({ ...gh, branch: branchName, baseBranch: gh.defaultBranch, title, body: prBody, draft: false });
      prNumber = pr.prNumber;
      prUrl = pr.prUrl;
      await postPrComment({ ...gh, prNumber, body: `✅ Retest passed after repair (commit \`${commitSha.slice(0, 7)}\`). [View PR](${prUrl})` });
    } else if (minConf >= 80) {
      const pr = await ensurePullRequest({
        ...gh, branch: branchName, baseBranch: gh.defaultBranch, draft: true,
        title: `[DRAFT] ${title}`,
        body: `⚠️ Confidence: ${minConf}% — QA review recommended before merging.\n\n${prBody}`,
      });
      prNumber = pr.prNumber;
      prUrl = pr.prUrl;
      await postPrComment({ ...gh, prNumber, body: `⚠️ Draft PR opened (confidence ${minConf}%). Manual review required before merge.` });
    } else {
      // Below threshold — mark for review, do not open PR
      await this.deps.prisma.testHealingAttempt.updateMany({
        where: { id: { in: attempts.map((a) => a.id) } },
        data: { status: "needs_review" },
      });
      console.warn(`[agent-orchestrator] repair confidence too low (${minConf}%) — no PR opened for job ${job.id}`);
    }

    // Telemetry
    await recordAgentRunMetrics({
      sessionId: job.id,
      projectId: job.projectId,
      generationTimeMs: 0,
      crawlTimeMs: 0,
      specCount: files.length,
      testsPerPage: 0,
      coveragePercent: 0,
      repairTimeMs,
      retestTimeMs,
      repairSuccessRate: attempts.length > 0 ? 100 : 0,
      averageConfidence: attempts.length > 0
        ? attempts.reduce((s, a) => s + (a.confidenceScore ?? 0), 0) / attempts.length
        : 0,
    }).catch((err) => console.warn("[agent-orchestrator] telemetry error:", err));

    return {
      retestPassed: retestSummary.passed,
      orchestratorResult: { status: "succeeded", prUrl, prNumber, commitSha },
    };
  }

  private async pollRun(runId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await this.deps.prisma.testRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (run?.status === "succeeded" || run?.status === "failed") return;
      await new Promise((r) => setTimeout(r, RUN_POLL_MS));
    }
    throw new Error(`TestRun ${runId} timed out after ${timeoutMs}ms`);
  }

  private async getRunSummary(runId: string): Promise<{ passed: number; failed: number; total: number }> {
    const results = await this.deps.prisma.testResult.findMany({
      where: { runId },
      select: { status: true },
    });
    const passed = results.filter((r) => r.status === "passed").length;
    const failed = results.filter((r) => r.status === "failed").length;
    return { passed, failed, total: results.length };
  }

  private async postStatus(
    gh: GitHubCoords,
    sha: string,
    state: "pending" | "success" | "failure" | "error",
    description: string
  ): Promise<void> {
    await setCommitStatus({
      ...gh,
      sha,
      state,
      context: "TestMind / operator",
      description,
      targetUrl: validatedEnv.TESTMIND_APP_URL || undefined,
    }).catch((err) => console.warn("[agent-orchestrator] status post failed:", err));
  }
}
