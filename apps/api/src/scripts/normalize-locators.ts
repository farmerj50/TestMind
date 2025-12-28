import { prisma } from "../prisma.js";
import { normalizeSelectorValue } from "../testmind/runtime/locator-store.js";

type SharedSteps = Record<string, any>;

function normalizeBucket(bucket?: Record<string, unknown>): { normalized?: Record<string, string>; changed: boolean } {
  if (!bucket || typeof bucket !== "object") return { normalized: undefined, changed: false };
  const normalized: Record<string, string> = {};
  let changed = false;
  for (const [key, raw] of Object.entries(bucket)) {
    if (typeof raw !== "string") continue;
    const cleaned = normalizeSelectorValue(raw);
    if (!cleaned) continue;
    normalized[key] = cleaned;
    if (cleaned !== raw.trim()) changed = true;
  }
  return { normalized: Object.keys(normalized).length ? normalized : undefined, changed };
}

function normalizePages(pages?: Record<string, any>): { normalized?: Record<string, any>; changed: boolean } {
  if (!pages || typeof pages !== "object") return { normalized: undefined, changed: false };
  let changed = false;
  const normalized: Record<string, any> = {};
  for (const [pageKey, page] of Object.entries(pages)) {
    if (!page || typeof page !== "object") continue;
    const next: Record<string, any> = { ...page };
    const buckets = ["fields", "buttons", "links", "locators"] as const;
    for (const bucket of buckets) {
      const { normalized: normalizedBucket, changed: bucketChanged } = normalizeBucket((page as any)[bucket]);
      if (bucketChanged) changed = true;
      if (normalizedBucket) next[bucket] = normalizedBucket;
    }
    normalized[pageKey] = next;
  }
  return { normalized, changed };
}

async function main() {
  const projects = await prisma.project.findMany({
    select: { id: true, sharedSteps: true },
  });
  let updatedCount = 0;
  for (const project of projects) {
    const sharedSteps = (project.sharedSteps ?? {}) as SharedSteps;
    const pages = sharedSteps.pages as Record<string, any> | undefined;
    const locators = sharedSteps.locators as Record<string, any> | undefined;
    let changed = false;
    let nextSteps: SharedSteps = { ...sharedSteps };

    if (pages && typeof pages === "object") {
      const { normalized, changed: pagesChanged } = normalizePages(pages);
      if (pagesChanged && normalized) {
        nextSteps.pages = normalized;
        changed = true;
      }
    } else if (locators && typeof locators === "object") {
      const wrapped: Record<string, any> = {};
      for (const [pageKey, bucket] of Object.entries(locators)) {
        wrapped[pageKey] = { locators: bucket };
      }
      const { normalized, changed: pagesChanged } = normalizePages(wrapped);
      if (pagesChanged && normalized) {
        nextSteps.locators = Object.fromEntries(
          Object.entries(normalized).map(([pageKey, page]) => [pageKey, page.locators ?? {}])
        );
        changed = true;
      }
    }

    if (!changed) continue;

    await prisma.project.update({
      where: { id: project.id },
      data: { sharedSteps: nextSteps },
    });
    updatedCount += 1;
  }
  console.log(`[normalize-locators] updated projects: ${updatedCount}`);
}

main()
  .catch((err) => {
    console.error("[normalize-locators] failed", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
