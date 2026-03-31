import type { SelfHealPayload } from "../../runner/queue.js";
import { buildAiExecutionContext } from "./context.js";
import { readSelfHealPolicy, type SelfHealPolicy } from "./policy.js";
import { executeRepairAttempt } from "./repair-executor.js";
import type {
  AiActionMode,
  AiActionSnapshot,
  AiAnalyzeActionResult,
  AiAssistActionResult,
  AiRepairActionResult,
  AiExecutionContext,
} from "./types.js";

export async function prepareAiAction(input: {
  job: SelfHealPayload;
  mode?: AiActionMode;
  policy?: SelfHealPolicy;
}): Promise<{ context: AiExecutionContext; policy: SelfHealPolicy }> {
  const mode = input.mode ?? "autonomous";
  const policy = input.policy ?? readSelfHealPolicy();
  const context = await buildAiExecutionContext(input.job, mode);
  return { context, policy };
}

function buildActionSnapshot(context: AiExecutionContext): AiActionSnapshot {
  return {
    framework: context.scope.framework ?? null,
    specPath: context.repoRelativePath,
    testTitle: context.failure.testTitle ?? null,
    failureMessage: context.failure.message ?? null,
    stdoutSnippet: (context.failure.stdout ?? "").slice(0, 4000),
    stderrSnippet: (context.failure.stderr ?? "").slice(0, 4000),
    specSnippet: (context.specContent ?? "").slice(0, 12000),
    artifactCount: context.evidence.artifacts.length,
    failureClasses: context.evidence.failureClasses,
  };
}

function resolveTargetScope(context: AiExecutionContext): "run" | "spec" | "testcase" {
  if (context.scope.testCaseId) return "testcase";
  if (context.scope.specPath) return "spec";
  return "run";
}

export async function executeAnalyzeAction(input: {
  job: SelfHealPayload;
  policy?: SelfHealPolicy;
}): Promise<AiAnalyzeActionResult> {
  const { context } = await prepareAiAction({
    job: input.job,
    mode: "analyze",
    policy: input.policy,
  });
  return {
    kind: "analyze",
    mode: "analyze",
    actionId: `analyze:${context.scope.runId ?? input.job.runId}:${context.scope.testResultId ?? "run"}`,
    status: "allowed",
    allowed: true,
    reasons: [],
    frameworkId: context.scope.framework ?? null,
    targetScope: resolveTargetScope(context),
    rerunIntent: "ai-rerun",
    context,
    snapshot: buildActionSnapshot(context),
  };
}

export async function executeAssistAction(input: {
  job: SelfHealPayload;
  policy?: SelfHealPolicy;
}): Promise<AiAssistActionResult> {
  const { context, policy } = await prepareAiAction({
    job: input.job,
    mode: "assist",
    policy: input.policy,
  });
  return {
    kind: "assist",
    mode: "assist",
    actionId: `assist:${context.scope.runId ?? input.job.runId}:${context.scope.testResultId ?? "run"}`,
    status: "allowed",
    allowed: true,
    reasons: [],
    frameworkId: context.scope.framework ?? null,
    targetScope: resolveTargetScope(context),
    rerunIntent: "ai-rerun",
    context,
    snapshot: buildActionSnapshot(context),
    capabilities: {
      canAutonomouslyRepair: !policy.healOnly,
      canUseStructuredPatch: policy.repair.structuredPatch,
    },
  };
}

export async function executeRepairAction(input: {
  job: SelfHealPayload;
  policy?: SelfHealPolicy;
}): Promise<AiRepairActionResult> {
  const { context, policy } = await prepareAiAction({
    job: input.job,
    mode: "repair",
    policy: input.policy,
  });
  return {
    kind: "repair",
    mode: "repair",
    actionId: `repair:${context.scope.runId ?? input.job.runId}:${context.scope.testResultId ?? "run"}`,
    status: "allowed",
    allowed: true,
    reasons: [],
    frameworkId: context.scope.framework ?? null,
    targetScope: resolveTargetScope(context),
    rerunIntent: "ai-rerun",
    context,
    snapshot: buildActionSnapshot(context),
    capabilities: {
      canAutonomouslyRepair: !policy.healOnly,
      canUseStructuredPatch: policy.repair.structuredPatch,
      evidenceArtifactCount: context.evidence.artifacts.length,
    },
  };
}

export async function executeAutonomousRepairAction(input: {
  job: SelfHealPayload;
  policy?: SelfHealPolicy;
}) {
  const { context, policy } = await prepareAiAction({
    job: input.job,
    mode: "autonomous",
    policy: input.policy,
  });
  const repairResult = await executeRepairAttempt({
    context,
    projectId: input.job.projectId,
    adapterId: input.job.adapterId,
    config: policy.repair,
  });
  return { context, policy, repairResult };
}
