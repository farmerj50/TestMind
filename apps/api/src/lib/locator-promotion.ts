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
