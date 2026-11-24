import fs from "fs/promises";
import path from "path";
import { createTwoFilesPatch } from "diff";
import { prisma } from "../../prisma.js";
import { CURATED_ROOT, GENERATED_ROOT } from "../../lib/storageRoots.js";
import type { AiExecutionContext } from "./types.js";
import type { HealFixType } from "./repair-policy.js";
import type { RepairExecutionResult } from "./repair-executor.js";
import { validateAssertionIntent } from './repair-policy.js';
import { authorizeWorkflowRepair } from '../../lib/workflow-execution-policy.js';
import { approveRepairProposal } from './repair-approval.js';

const toJson = <T>(value: T): any => JSON.parse(JSON.stringify(value));

// Only mirror into registered suites owned by this project. A matching filename
// in another project's directory is not evidence that it is the same test.
async function mirrorPatchedSpecToCuratedSuite(context: AiExecutionContext, patchedSpec: string) {
  const inside = (root: string, file: string) => { const rel = path.relative(root, file); return !rel.startsWith('..') && !path.isAbsolute(rel); };
  const generatedRoot = path.resolve(GENERATED_ROOT);
  const repoAbs = path.resolve(context.repoAbsolutePath);
  if (!inside(generatedRoot, repoAbs)) return;
  const parts = path.relative(generatedRoot, repoAbs).split(path.sep);
  if (parts.length < 3 || parts[1] !== context.scope.projectId) return;
  const specRel = parts.slice(2).join(path.sep);
  const suites = await prisma.curatedSuite.findMany({ where: { projectId: context.scope.projectId }, select: { rootRel: true } });
  const root = await fs.realpath(CURATED_ROOT).catch(() => null);
  if (!root) return;
  for (const suite of suites) {
    try {
      const suiteRoot = await fs.realpath(path.resolve(root, suite.rootRel));
      const candidate = await fs.realpath(path.resolve(suiteRoot, specRel));
      if (!inside(root, suiteRoot) || !inside(suiteRoot, candidate)) continue;
      await fs.writeFile(candidate, patchedSpec, 'utf8');
    } catch { /* No existing owned copy; do not create one. */ }
  }
}

async function mirrorPatchedSpecToRunTarget(context: AiExecutionContext, patchedSpec: string) {
  if (!context.runSpecPath) return;
  const runTarget = path.isAbsolute(context.runSpecPath)
    ? context.runSpecPath
    : path.join(context.repoRoot, context.runSpecPath);
  const repoAbs = path.resolve(context.repoAbsolutePath);
  const runAbs = path.resolve(runTarget);
  if (repoAbs === runAbs) return;
  await fs.mkdir(path.dirname(runAbs), { recursive: true });
  await fs.writeFile(runAbs, patchedSpec, "utf8");
}

export async function recordRuleRepairSuccess(input: {
  attemptId: string;
  context: AiExecutionContext;
  patchedSpec: string;
  summary: string;
  note: string;
  fixType: HealFixType;
  fixDetails?: Record<string, unknown>;
}) {
  const { attemptId, context, patchedSpec, summary, note, fixType, fixDetails } = input;
  const originalSpec = context.specContent ?? "";
  await authorizeWorkflowRepair(context.job.runId, context.scope.projectId);
  const intentError = validateAssertionIntent(originalSpec, patchedSpec);
  if (intentError) throw new Error(intentError);
  await approveRepairProposal(attemptId, context, patchedSpec);
  await authorizeWorkflowRepair(context.job.runId, context.scope.projectId);
  await fs.mkdir(path.dirname(context.repoAbsolutePath), { recursive: true });
  await fs.writeFile(context.repoAbsolutePath, patchedSpec, "utf8");
  await mirrorPatchedSpecToRunTarget(context, patchedSpec);
  await mirrorPatchedSpecToCuratedSuite(context, patchedSpec);
  const diff = createTwoFilesPatch(
    context.repoRelativePath,
    context.repoRelativePath,
    originalSpec,
    patchedSpec
  );
  await prisma.testHealingAttempt.update({
    where: { id: attemptId },
    data: {
      status: "succeeded",
      summary,
      diff,
      prompt: { note },
      response: {
        raw: note,
        fixType,
        fixDetails: toJson(fixDetails ?? { note }),
      },
      targetSpec: context.repoAbsolutePath,
      originalSpec,
      repairedSpec: patchedSpec,
      repairReason: summary,
      confidenceScore: 100,
    },
  });
}

export async function recordLlmRepairSuccess(input: {
  attemptId: string;
  context: AiExecutionContext;
  result: Extract<RepairExecutionResult, { kind: "llm" }>;
}) {
  const { attemptId, context, result } = input;
  const originalSpec = context.specContent ?? "";
  await authorizeWorkflowRepair(context.job.runId, context.scope.projectId);
  const intentError = validateAssertionIntent(originalSpec, result.patchedSpec);
  if (intentError) throw new Error(intentError);
  await approveRepairProposal(attemptId, context, result.patchedSpec);
  await authorizeWorkflowRepair(context.job.runId, context.scope.projectId);
  await fs.mkdir(path.dirname(context.repoAbsolutePath), { recursive: true });
  await fs.writeFile(context.repoAbsolutePath, result.patchedSpec, "utf8");
  await mirrorPatchedSpecToRunTarget(context, result.patchedSpec);
  await mirrorPatchedSpecToCuratedSuite(context, result.patchedSpec);

  const diff = createTwoFilesPatch(
    context.repoRelativePath,
    context.repoRelativePath,
    originalSpec,
    result.patchedSpec
  );

  await prisma.testHealingAttempt.update({
    where: { id: attemptId },
    data: {
      status: "succeeded",
      summary: result.summary,
      diff,
      prompt: result.prompt,
      response: {
        raw: result.raw,
        mode: result.mode,
        structuredFallbackReason: result.structuredFallbackReason,
        operationCount: result.operationCount,
        operationTypes: result.operationTypes,
        fixType: "llm_patch_fixed" as HealFixType,
        fixDetails: toJson({
          mode: result.mode,
          operationCount: result.operationCount,
          operationTypes: result.operationTypes,
          structuredFallbackReason: result.structuredFallbackReason,
        }),
      },
      targetSpec: context.repoAbsolutePath,
      originalSpec,
      repairedSpec: result.patchedSpec,
      modelUsed: process.env.HEALING_LLM_MODEL ?? "gpt-4o-mini",
      repairReason: result.summary,
      confidenceScore: 85,
    },
  });
}

export async function recordRepairFailure(input: {
  attemptId: string;
  message: string;
}) {
  const { attemptId, message } = input;
  const rejectedByPolicy =
    /validation failed|forbidden|payload too large|introduced new import|dynamic import|new Function|eval|patch operations/i.test(
      message
    );
  await prisma.testHealingAttempt.update({
    where: { id: attemptId },
    data: {
      status: "failed",
      error: message,
      response: {
        fixType: (rejectedByPolicy ? "llm_rejected_policy" : "none") as HealFixType,
        fixDetails: toJson({
          reason: message,
          rejectedByPolicy,
        }),
      },
    },
  });
}

export function shouldQueueTargetedRerun(totalFailed: number) {
  return totalFailed <= 1;
}

export async function shouldQueueFinalSuiteRerun(runId: string) {
  const remaining = await prisma.testHealingAttempt.count({
    where: { runId, status: { not: "succeeded" } },
  });
  return remaining === 0;
}
