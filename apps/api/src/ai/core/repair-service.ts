import fs from "fs/promises";
import path from "path";
import { createTwoFilesPatch } from "diff";
import { prisma } from "../../prisma.js";
import type { AiExecutionContext } from "./types.js";
import type { HealFixType } from "./repair-policy.js";
import type { RepairExecutionResult } from "./repair-executor.js";

const toJson = <T>(value: T): any => JSON.parse(JSON.stringify(value));

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
  await fs.mkdir(path.dirname(context.repoAbsolutePath), { recursive: true });
  await fs.writeFile(context.repoAbsolutePath, patchedSpec, "utf8");
  await mirrorPatchedSpecToRunTarget(context, patchedSpec);
  const diff = createTwoFilesPatch(
    context.repoRelativePath,
    context.repoRelativePath,
    context.specContent ?? "",
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
    },
  });
}

export async function recordLlmRepairSuccess(input: {
  attemptId: string;
  context: AiExecutionContext;
  result: Extract<RepairExecutionResult, { kind: "llm" }>;
}) {
  const { attemptId, context, result } = input;
  await fs.mkdir(path.dirname(context.repoAbsolutePath), { recursive: true });
  await fs.writeFile(context.repoAbsolutePath, result.patchedSpec, "utf8");
  await mirrorPatchedSpecToRunTarget(context, result.patchedSpec);

  const diff = createTwoFilesPatch(
    context.repoRelativePath,
    context.repoRelativePath,
    context.specContent ?? "",
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
