import "dotenv/config";
import { Worker, Job } from 'bullmq';
import path from 'path';
import { redis } from './redis.js';
import { prisma } from '../prisma.js';
import type { SelfHealPayload, RunPayload } from './queue.js';
import { enqueueRun } from './queue.js';
import { GENERATED_ROOT } from "../lib/storageRoots.js";
import { DEFAULT_FRAMEWORK_ID } from "@testmind/core/framework";
import { executeAutonomousRepairAction } from "../ai/core/action-service.js";
import {
  buildSpecCandidates,
  findExistingPath,
  guessRepoRoot,
  toPosix,
} from "../ai/core/context.js";
import {
  recordLlmRepairSuccess,
  recordRepairFailure,
  recordRuleRepairSuccess,
  shouldQueueFinalSuiteRerun,
  shouldQueueTargetedRerun,
} from "../ai/core/repair-service.js";
import { readSelfHealPolicy } from "../ai/core/policy.js";
import {
  isInfraError,
  type HealFixType,
} from "../ai/core/repair-policy.js";

const TestRunStatus = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
} as const;

const HealingStatus = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
} as const;

async function triggerRerun(
  projectId: string,
  rerunOfId: string,
  adapterId?: string,
  grep?: string,
  headed?: boolean,
  baseUrl?: string,
  localRepoRoot?: string,
  targetSpec?: string,
  options?: { healOnly?: boolean }
) {
  const projectRecord = await prisma.project.findUnique({
    where: { id: projectId },
    select: { sharedSteps: true },
  });
  const sharedSteps = projectRecord?.sharedSteps;
  let effectiveBaseUrl = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : undefined;
  if (!effectiveBaseUrl) {
    let currentRunId: string | null = rerunOfId;
    for (let depth = 0; depth < 5 && currentRunId; depth += 1) {
      const runRecord = await prisma.testRun.findUnique({
        where: { id: currentRunId },
        select: { rerunOfId: true, paramsJson: true },
      });
      const inheritedBaseUrl =
        typeof (runRecord?.paramsJson as any)?.baseUrl === "string"
          ? (runRecord?.paramsJson as any).baseUrl.trim()
          : "";
      if (inheritedBaseUrl) {
        effectiveBaseUrl = inheritedBaseUrl;
        break;
      }
      currentRunId = runRecord?.rerunOfId ?? null;
    }
  }
  if (!effectiveBaseUrl) {
    const projectBaseUrl =
      typeof (sharedSteps as any)?.baseUrl === "string"
        ? (sharedSteps as any).baseUrl.trim()
        : "";
    if (projectBaseUrl) {
      effectiveBaseUrl = projectBaseUrl;
    }
  }
  const params: Record<string, any> = {};
  const effectiveAdapterId = adapterId || DEFAULT_FRAMEWORK_ID;
  if (headed !== undefined) params.headful = headed;
  if (effectiveBaseUrl) params.baseUrl = effectiveBaseUrl;
  params.adapterId = effectiveAdapterId;
  if (sharedSteps !== undefined) params.sharedSteps = sharedSteps;
  if (localRepoRoot) params.localRepoRoot = localRepoRoot;
  if (targetSpec) params.targetSpec = targetSpec;
  if (grep) params.requestedGrep = grep;
  const rerun = await prisma.testRun.create({
    data: {
      projectId,
      rerunOfId,
      status: TestRunStatus.running,
      startedAt: new Date(),
      trigger: "self-heal",
      paramsJson: Object.keys(params).length ? params : undefined,
    },
  });

  if (options?.healOnly) {
    console.log(
      `[self-heal] heal-only mode: skipping rerun queue for ${targetSpec ?? "full suite"} (run ${rerun.id})`
    );
    await prisma.testRun.update({
      where: { id: rerun.id },
      data: {
        status: TestRunStatus.succeeded,
        finishedAt: new Date(),
        summary: "Self-heal patch applied; rerun skipped",
      },
    });
    return;
  }

  let resolvedSpec = targetSpec;
  if (targetSpec && !path.isAbsolute(targetSpec)) {
    const repoRoot = localRepoRoot ? path.resolve(localRepoRoot) : guessRepoRoot();
    const normalizedSpecPath =
      targetSpec.replace(/\\/g, "/").replace(/^\.?\/+/, "") || targetSpec;
    if (normalizedSpecPath.startsWith("testmind-generated/")) {
      const preferred = path.join(repoRoot, normalizedSpecPath);
      const generatedRoot = path.resolve(GENERATED_ROOT);
      const strippedGenerated = normalizedSpecPath.replace(/^testmind-generated[\\/]/, "");
      const generatedCandidate = path.join(generatedRoot, strippedGenerated);
      resolvedSpec =
        (await findExistingPath([preferred, generatedCandidate])) ??
        path.join(repoRoot, normalizedSpecPath);
    } else {
      const candidates = buildSpecCandidates(repoRoot, normalizedSpecPath, targetSpec, effectiveAdapterId, projectId);
      resolvedSpec = (await findExistingPath(candidates)) ?? path.join(repoRoot, normalizedSpecPath);
    }
  }
  if (resolvedSpec) {
    const repoRoot = localRepoRoot ? path.resolve(localRepoRoot) : guessRepoRoot();
    const resolvedPosix = toPosix(path.resolve(resolvedSpec));
    const repoRootPosix = toPosix(path.resolve(repoRoot));
    const generatedRootPosix = toPosix(path.resolve(GENERATED_ROOT));
    if (resolvedPosix.startsWith(`${generatedRootPosix}/`)) {
      const rel = resolvedPosix.slice(generatedRootPosix.length + 1);
      resolvedSpec = `testmind-generated/${rel}`;
    } else if (resolvedPosix.startsWith(`${repoRootPosix}/`)) {
      resolvedSpec = resolvedPosix.slice(repoRootPosix.length + 1);
    }
  }

  const payload: RunPayload = {
    projectId,
    adapterId: effectiveAdapterId,
    localRepoRoot,
    file: resolvedSpec,
    grep,
    baseUrl: effectiveBaseUrl,
  };
  if (headed !== undefined) payload.headed = headed;

  try {
    await enqueueRun(rerun.id, payload);
    console.log(
      "[self-heal] queued rerun",
      rerun.id,
      "grep:",
      grep ?? "(full suite)",
      "headed:",
      headed ?? "(default)"
    );
  } catch (err) {
    await prisma.testRun.update({
      where: { id: rerun.id },
      data: {
        status: TestRunStatus.failed,
        finishedAt: new Date(),
        error: String(err),
      },
    });
    console.error(`[self-heal] failed to enqueue rerun ${rerun.id}:`, err);
    throw err;
  }
}

const SELF_HEAL_POLICY = readSelfHealPolicy();

console.log("[self-heal] config", {
  structuredPatch: SELF_HEAL_POLICY.repair.structuredPatch,
  allowFullRewriteFallback: SELF_HEAL_POLICY.repair.allowFullRewriteFallback,
  structuredTimeoutMs: SELF_HEAL_POLICY.repair.structuredTimeoutMs,
  totalTimeoutMs: SELF_HEAL_POLICY.repair.totalTimeoutMs,
  maxPatchOps: SELF_HEAL_POLICY.repair.maxPatchOps,
  maxPatchText: SELF_HEAL_POLICY.repair.maxPatchText,
  healOnly: SELF_HEAL_POLICY.healOnly,
});

export const selfHealWorker = new Worker(
  'self-heal',
  async (job: Job<SelfHealPayload>) => {
    const { attemptId } = job.data;

    await prisma.testHealingAttempt.update({
      where: { id: attemptId },
      data: { status: HealingStatus.running },
    });

    try {
      console.log(
        `[self-heal] starting attempt ${attemptId} for run ${job.data.runId} (testResult=${job.data.testResultId})`
      );

      const { context, repairResult } = await executeAutonomousRepairAction({
        job: job.data,
        policy: SELF_HEAL_POLICY,
      });

      const writeAndRecordSuccess = async (
        patched: string,
        summary: string,
        note: string,
        fixType: HealFixType = "rule_fixed",
        fixDetails?: Record<string, unknown>
      ) => {
        await recordRuleRepairSuccess({
          attemptId,
          context,
          patchedSpec: patched,
          summary,
          note,
          fixType,
          fixDetails,
        });
        // Journey 1: stamp the attempt with rerun intent so the audit trail is complete
        await prisma.testHealingAttempt.update({
          where: { id: attemptId },
          data: {
            summary,
            response: {
              rerunQueued: true,
              queuedAt: new Date().toISOString(),
              targetSpec: context.repoRelativePath ?? null,
              testTitle: context.failure.testTitle ?? null,
              fixType,
              ...(fixDetails ? { fixDetails } : {}),
            } as any,
          },
        });
        await triggerRerun(
          job.data.projectId,
          job.data.runId,
          job.data.adapterId,
          context.failure.testTitle ?? undefined,
          job.data.headed,
          job.data.baseUrl,
          context.repoRoot,
          context.repoRelativePath,
          { healOnly: SELF_HEAL_POLICY.healOnly }
        );
      };

      if (repairResult.kind === "rule") {
        await writeAndRecordSuccess(
          repairResult.patchedSpec,
          repairResult.summary,
          repairResult.note,
          repairResult.fixType,
          repairResult.fixDetails
        );
        return;
      }

      await recordLlmRepairSuccess({
        attemptId,
        context,
        result: repairResult,
      });
      console.log(
        `[self-heal] finished attempt ${attemptId} for run ${job.data.runId} (status=succeeded)`
      );

      if (isInfraError(context.failure.message)) {
        console.log(
          `[self-heal] detected infra-like failure for run ${job.data.runId}; skipping rerun`
        );
        return;
      }

      // Journey 1: stamp LLM repair attempt with rerun intent
      await prisma.testHealingAttempt.update({
        where: { id: attemptId },
        data: {
          response: {
            mode: "llm",
            rerunQueued: true,
            queuedAt: new Date().toISOString(),
            targetSpec: context.repoRelativePath ?? null,
            testTitle: context.failure.testTitle ?? null,
          },
        },
      });

      if (shouldQueueTargetedRerun(job.data.totalFailed)) {
        await triggerRerun(
          job.data.projectId,
          job.data.runId,
          job.data.adapterId,
          context.failure.testTitle ?? undefined,
          job.data.headed,
          job.data.baseUrl,
          context.repoRoot,
          context.repoRelativePath,
          { healOnly: SELF_HEAL_POLICY.healOnly }
        );
      } else {
        if (await shouldQueueFinalSuiteRerun(job.data.runId)) {
          await triggerRerun(
            job.data.projectId,
            job.data.runId,
            job.data.adapterId,
            undefined,
            job.data.headed,
            job.data.baseUrl,
            context.repoRoot,
            context.repoRelativePath,
            { healOnly: SELF_HEAL_POLICY.healOnly }
          );
        }
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      await recordRepairFailure({ attemptId, message: msg });
      console.error(`[self-heal] attempt ${attemptId} failed:`, err);
      throw err;
    }
  },
  { connection: redis, concurrency: SELF_HEAL_POLICY.workerConcurrency }
);

selfHealWorker.on('failed', (job, err) => {
  console.error(`[self-heal] job ${job?.id} failed:`, err);
});

selfHealWorker.on('completed', (job) => {
  console.log(
    `[self-heal] job ${job?.id} (run ${job?.data?.runId ?? 'unknown'}) completed`
  );
});
