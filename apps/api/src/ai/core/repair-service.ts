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
 * When the spec lives in the generated folder, mirror the patch to every
 * curated suite directory that already contains a matching copy of the spec.
 *
 * The original implementation only checked the `agent-{projectId}` suite, which
 * meant that user-created curated suites (e.g. `CURATED_ROOT/my-suite/spec.ts`)
 * were never updated — causing "rerun from suite" to run the unfixed original.
 *
 * Fix: scan ALL immediate subdirectories of CURATED_ROOT and update any
 * existing file whose path ends with the spec's project-relative path.
 *
 * Generated layout:  GENERATED_ROOT/{adapterId}-{userId}/{projectId}/path/to/spec.ts
 * Curated layout:    CURATED_ROOT/{any-suite-name}/path/to/spec.ts
 */
async function mirrorPatchedSpecToCuratedSuite(context: AiExecutionContext, patchedSpec: string) {
  const repoAbs = path.resolve(context.repoAbsolutePath);
  const curatedRootAbs = path.resolve(CURATED_ROOT);
  const generatedRootAbs = path.resolve(GENERATED_ROOT);

  // If the spec is already inside the curated root it was patched directly — nothing extra needed.
  if (repoAbs.startsWith(curatedRootAbs)) return;

  // Only attempt mirroring for specs that live inside the generated root.
  if (!repoAbs.startsWith(generatedRootAbs)) return;

  // Strip generated root + {adapterId}-{userId} + {projectId} → get spec-relative path.
  const relToGen = path.relative(generatedRootAbs, repoAbs); // e.g. playwright-ts-uid/proj-id/path/spec.ts
  const parts = relToGen.split(path.sep);
  if (parts.length < 3) return; // unexpected layout — bail out safely

  const specRel = parts.slice(2).join(path.sep); // path/to/spec.ts (project-relative)

  // Enumerate every direct child directory of CURATED_ROOT and update any
  // pre-existing file that matches `specRel`. We never create new files here
  // — only patch copies that the user already placed in a curated suite.
  let suiteDirs: string[];
  try {
    const entries = await fs.readdir(curatedRootAbs, { withFileTypes: true });
    suiteDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(curatedRootAbs, e.name));
  } catch {
    return; // CURATED_ROOT doesn't exist or is unreadable — nothing to mirror
  }

  await Promise.all(
    suiteDirs.map(async (suiteDir) => {
      const candidate = path.join(suiteDir, specRel);
      try {
        await fs.access(candidate); // throws if file doesn't exist
        await fs.writeFile(candidate, patchedSpec, "utf8");
        console.log(`[self-heal] mirrored patch to curated suite: ${candidate}`);
      } catch {
        // File doesn't exist in this suite dir — skip silently
      }
    })
  );
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
