// apps/api/src/lib/locator-promotion.ts
//
// Extracted from apps/api/src/index.ts's POST /locators handler (and the
// scheduleSpecRegeneration helper shared by several routes in that file) so this write path
// can be reused by the self-heal live-selector-probe auto-promote hook without an HTTP
// round-trip. This is a behavior-preserving move, not a rewrite: computeLocatorPromotion is
// the exact pure transformation the route already performed, extracted so it can be
// regression-tested in isolation from Prisma/Fastify.
import path from "node:path";
import fs from "node:fs";
import { prisma } from "../prisma.js";
import { GENERATED_ROOT } from "./storageRoots.js";
import { generateAndWrite } from "../testmind/service.js";
import { DEFAULT_FRAMEWORK_ID } from "@testmind/core/framework";
import { scoreSelectorConfidence } from "./selector-confidence.js";

export type LocatorBucket = "fields" | "buttons" | "links" | "locators";

export const normalizeLocatorPath = (pathValue: string) => {
  try {
    const url = new URL(pathValue, "http://localhost");
    const pathname = url.pathname || "/";
    const search = url.search || "";
    return `${pathname}${search}` || "/";
  } catch {
    return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  }
};

const resolveRepoRoot = () =>
  process.env.TM_LOCAL_REPO_ROOT
    ? path.resolve(process.env.TM_LOCAL_REPO_ROOT)
    : path.resolve(process.cwd(), "..", "..");

export const scheduleSpecRegeneration = (params: {
  projectId: string;
  userId: string;
  baseUrl?: string;
  sharedSteps: Record<string, any>;
}) => {
  const { projectId, userId, baseUrl, sharedSteps } = params;
  const trimmedBaseUrl = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!trimmedBaseUrl) return;
  setImmediate(async () => {
    try {
      // Shared locator/nav regeneration still targets the stable Playwright layer.
      const adapterId = DEFAULT_FRAMEWORK_ID;
      const repoRoot = resolveRepoRoot();
      const outRoot = path.join(GENERATED_ROOT, `${adapterId}-${userId}`, projectId);
      await generateAndWrite({
        repoPath: repoRoot,
        outRoot,
        baseUrl: trimmedBaseUrl,
        adapterId,
        options: { sharedSteps },
      });
      const webOutRoot = path.join(
        repoRoot,
        "apps",
        "web",
        "testmind-generated",
        `${adapterId}-${userId}`,
        projectId
      );
      await fs.promises.rm(webOutRoot, { recursive: true, force: true }).catch(() => {});
      await fs.promises.mkdir(path.dirname(webOutRoot), { recursive: true });
      await fs.promises.cp(outRoot, webOutRoot, { recursive: true });
      console.log(`[locators] regenerated specs for project ${projectId}`);
    } catch (err) {
      console.warn("[locators] regenerate specs failed", err);
    }
  });
};

export type LocatorPromotionInput = {
  pagePath: string;
  bucket: LocatorBucket;
  name: string;
  primary: string;
  fallbacks?: string[];
  metadata?: Record<string, unknown>;
  userId: string;
};

/**
 * Pure transformation: given the project's current sharedSteps and a promotion request,
 * returns the next sharedSteps value. No I/O — this is what makes the write path
 * regression-testable without a real database.
 */
export function computeLocatorPromotion(
  sharedSteps: Record<string, any>,
  input: LocatorPromotionInput
): Record<string, any> {
  const { bucket, name } = input;
  const normalizedPath = normalizeLocatorPath(input.pagePath);
  const primary = input.primary.trim();

  let pages: Record<string, any> = {};
  if (sharedSteps.pages && typeof sharedSteps.pages === "object") {
    pages = { ...sharedSteps.pages };
  } else if (sharedSteps.locators && typeof sharedSteps.locators === "object") {
    pages = Object.entries(sharedSteps.locators as Record<string, any>).reduce(
      (acc, [key, locators]) => {
        acc[key] = { locators: { ...(locators as Record<string, string>) } };
        return acc;
      },
      {} as Record<string, any>
    );
  }

  const page = { ...(pages[normalizedPath] ?? {}) };
  const bucketMap = { ...(page[bucket] ?? {}) };
  bucketMap[name] = primary;
  page[bucket] = bucketMap;
  pages[normalizedPath] = page;

  const cleanFallbacks = Array.from(
    new Set((input.fallbacks ?? []).map((v) => v.trim()).filter(Boolean))
  ).filter((value) => value !== primary);
  const primaryConfidence = scoreSelectorConfidence(primary);
  const fallbackConfidence = cleanFallbacks.map((value) => ({
    selector: value,
    ...scoreSelectorConfidence(value),
  }));

  const locatorFallbacks: Record<string, any> = {
    ...(sharedSteps.locatorFallbacks ?? {}),
  };
  const pageFallbacks = { ...(locatorFallbacks[normalizedPath] ?? {}) };
  const bucketFallbacks = { ...(pageFallbacks[bucket] ?? {}) };
  bucketFallbacks[name] = {
    primary,
    fallbacks: cleanFallbacks,
    metadata: {
      ...(input.metadata ?? {}),
      confidenceScore: primaryConfidence.score,
      confidenceBreakdown: primaryConfidence.breakdown,
      fallbackConfidence,
    },
    updatedBy: input.userId,
    updatedAt: new Date().toISOString(),
  };
  pageFallbacks[bucket] = bucketFallbacks;
  locatorFallbacks[normalizedPath] = pageFallbacks;

  return {
    ...sharedSteps,
    pages,
    locatorFallbacks,
    locatorMeta: {
      ...(sharedSteps.locatorMeta ?? {}),
      updatedAt: new Date().toISOString(),
      updatedBy: input.userId,
    },
  };
}

export async function promoteLocator(params: {
  projectId: string;
  userId: string;
  pagePath: string;
  bucket: LocatorBucket;
  name: string;
  primary: string;
  fallbacks?: string[];
  metadata?: Record<string, unknown>;
}): Promise<{ sharedSteps: Record<string, any> } | null> {
  const project = await prisma.project.findFirst({
    where: { id: params.projectId, ownerId: params.userId },
    select: { id: true, sharedSteps: true },
  });
  if (!project) return null;

  const sharedSteps = (project.sharedSteps ?? {}) as Record<string, any>;
  const nextSharedSteps = computeLocatorPromotion(sharedSteps, params);

  const updated = await prisma.project.update({
    where: { id: params.projectId },
    data: { sharedSteps: nextSharedSteps },
    select: { sharedSteps: true },
  });

  scheduleSpecRegeneration({
    projectId: params.projectId,
    userId: params.userId,
    baseUrl: (sharedSteps as any)?.baseUrl,
    sharedSteps: nextSharedSteps,
  });

  return { sharedSteps: updated.sharedSteps as Record<string, any> };
}

// What the self-heal live-selector-probe rule (ai/core/live-selector-probe-rule.ts) records
// per resolved missing-locator site, for this module's auto-promote hook to consume later.
// Defined here (not in that module) so both directions of the relationship are plain value
// imports, not a type-only circular import between the two files.
export type PendingLocatorPromotion = {
  projectId: string;
  pagePath: string;
  bucket: LocatorBucket;
  name: string;
  selector: string;
  fallbacks: string[];
  matchCount: number | null;
};

/**
 * Pure decision logic, factored out of promoteVerifiedLiveSelectors so the two safety
 * invariants (exact-test-passed, matchCount === 1) are unit-testable without a database:
 * given the ORIGINAL run's successful healing attempts and the set of testCaseIds the
 * RERUN itself actually passed, returns exactly the entries eligible for promotion.
 */
export function selectPromotableEntries(
  attempts: Array<{ id: string; testCaseId: string; fixDetails: unknown }>,
  passedTestCaseIds: Set<string>
): Array<{ healingAttemptId: string; entry: PendingLocatorPromotion }> {
  const out: Array<{ healingAttemptId: string; entry: PendingLocatorPromotion }> = [];
  for (const attempt of attempts) {
    if (!passedTestCaseIds.has(attempt.testCaseId)) continue;
    const pending = (attempt.fixDetails as any)?.pendingLocatorPromotion;
    if (!Array.isArray(pending)) continue;
    for (const entry of pending as PendingLocatorPromotion[]) {
      if (entry.matchCount !== 1) continue;
      out.push({ healingAttemptId: attempt.id, entry });
    }
  }
  return out;
}

async function isAlreadyPromoted(
  projectId: string,
  entry: Pick<PendingLocatorPromotion, "pagePath" | "bucket" | "name">,
  healingAttemptId: string
): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { sharedSteps: true },
  });
  const sharedSteps = (project?.sharedSteps ?? {}) as Record<string, any>;
  const normalizedPath = normalizeLocatorPath(entry.pagePath);
  const existing = sharedSteps?.locatorFallbacks?.[normalizedPath]?.[entry.bucket]?.[entry.name];
  return existing?.metadata?.promotedFromHealingAttemptId === healingAttemptId;
}

/**
 * The "verify rerun passed, then auto-promote" hookup for Tier 2 (live-selector-probe)
 * repairs. Reads TestHealingAttempt rows recorded for the ORIGINAL run (the ones Tier 2
 * patched, via the existing, unmodified repair-service.ts persistence), and promotes each
 * attempt's pendingLocatorPromotion entries only if:
 *  1. matchCount === 1 (defense in depth - live-selector-probe-rule.ts already filters this
 *     before writing fixDetails, but shared-state mutation should never trust its producer
 *     completely), and
 *  2. the exact test case the attempt patched has a PASSED TestResult on the RERUN itself
 *     (not merely "the rerun's aggregate status is ok") - a targeted rerun that only
 *     re-executed some of the original run's failing tests must not promote fixes for tests
 *     it didn't actually re-verify.
 * Idempotent on a best-effort basis (read-then-write against a JSON column, no transaction/
 * lock): a promotedFromHealingAttemptId marker in the written locatorFallbacks metadata is
 * checked before every write, so a duplicate invocation (self-heal's scheduling is
 * fire-and-forget, not exactly-once) skips the write and the regeneration call rather than
 * repeating them. A rare race between two concurrent invocations could still both pass the
 * check before either writes; the result is a harmless duplicate write of the same value
 * plus one redundant regeneration, not incorrect data.
 */
export async function promoteVerifiedLiveSelectors(params: {
  originalRunId: string;
  rerunId: string;
  projectId: string;
  userId: string;
}): Promise<void> {
  const attempts = await prisma.testHealingAttempt.findMany({
    where: { runId: params.originalRunId, status: "succeeded" },
    select: { id: true, testCaseId: true, response: true },
  });
  if (attempts.length === 0) return;

  const passedResults = await prisma.testResult.findMany({
    where: { runId: params.rerunId, status: "passed" },
    select: { testCaseId: true },
  });
  const passedTestCaseIds = new Set(passedResults.map((r) => r.testCaseId));
  if (passedTestCaseIds.size === 0) return;

  const candidates = attempts.map((a) => ({
    id: a.id,
    testCaseId: a.testCaseId,
    fixDetails: (a.response as any)?.fixDetails,
  }));
  for (const attempt of candidates) {
    const pending = attempt.fixDetails?.pendingLocatorPromotion;
    if (Array.isArray(pending)) {
      for (const entry of pending as PendingLocatorPromotion[]) {
        if (entry.matchCount !== 1) {
          console.log("[self-heal] tier2: live_probe_promotion_rejected_nonunique", {
            name: entry.name,
            matchCount: entry.matchCount,
          });
        }
      }
    }
  }

  const promotable = selectPromotableEntries(candidates, passedTestCaseIds);

  for (const { healingAttemptId, entry } of promotable) {
    if (await isAlreadyPromoted(params.projectId, entry, healingAttemptId)) {
      console.log("[self-heal] tier2: live_probe_promotion_skipped_idempotent", { name: entry.name });
      continue;
    }

    await promoteLocator({
      projectId: params.projectId,
      userId: params.userId,
      pagePath: entry.pagePath,
      bucket: entry.bucket,
      name: entry.name,
      primary: entry.selector,
      fallbacks: entry.fallbacks,
      metadata: {
        source: "live-selector-probe",
        matchCount: entry.matchCount,
        promotedFromHealingAttemptId: healingAttemptId,
        verifiedByRunId: params.rerunId,
      },
    });
    console.log("[self-heal] tier2: live_probe_locator_promoted", { name: entry.name, selector: entry.selector });
  }
}
