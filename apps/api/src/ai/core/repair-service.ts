import fs from "fs/promises";
import path from "path";
import { createTwoFilesPatch } from "diff";
import { prisma } from "../../prisma.js";
import { CURATED_ROOT, GENERATED_ROOT } from "../../lib/storageRoots.js";
import type { AiExecutionContext } from "./types.js";
import type { HealFixType } from "./repair-policy.js";
import type { RepairExecutionResult } from "./repair-executor.js";

const toJson = <T>(value: T): any => JSON.parse(JSON.stringify(value));

/**
 * When the spec lives in the generated folder, also patch its copy in the
 * agent curated suite so the next operator/suite run picks up the fix.
 *
 * Generated layout: GENERATED_ROOT/{adapterId}-{userId}/{projectId}/path/to/spec.ts
 * Agent suite layout: CURATED_ROOT/agent-{projectId}/path/to/spec.ts
 */
async function mirrorPatchedSpecToCuratedSuite(context: AiExecutionContext, patchedSpec: string) {
  const repoAbs = path.resolve(context.repoAbsolutePath);
  const curatedRootAbs = path.resolve(CURATED_ROOT);
  const generatedRootAbs = path.resolve(GENERATED_ROOT);

  // If the spec is already inside the curated root it was patched directly — nothing extra needed.
  if (repoAbs.startsWith(curatedRootAbs)) return;

  // Only attempt if the spec is inside the generated root.
  if (!repoAbs.startsWith(generatedRootAbs)) return;

  // Strip generated root + {adapterId}-{userId} + {projectId} → get spec-relative path.
  const relToGen = path.relative(generatedRootAbs, repoAbs); // e.g. playwright-ts-uid/proj-id/path/spec.ts
  const parts = relToGen.split(path.sep);
  if (parts.length < 3) return; // unexpected layout

  const specRel = parts.slice(2).join(path.sep); // path/spec.ts
  const agentCopy = path.join(curatedRootAbs, `agent-${context.scope.projectId}`, specRel);

  // Only write if the curated copy already exists (don't create new files).
  await fs.access(agentCopy).then(async () => {
    await fs.writeFile(agentCopy, patchedSpec, "utf8");
  }).catch(() => { /* curated copy doesn't exist — skip */ });
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
  await fs.mkdir(path.dirname(context.repoAbsolutePath), { recursive: true });
  await fs.writeFile(context.repoAbsolutePath, patchedSpec, "utf8");
  await mirrorPatchedSpecToRunTarget(context, patchedSpec);
  await mirrorPatchedSpecToCuratedSuite(context, patchedSpec);
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
  await mirrorPatchedSpecToCuratedSuite(context, result.patchedSpec);

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
