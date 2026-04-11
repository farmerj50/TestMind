import { prisma } from "../prisma.js";
import type { ParsedCase } from "./result-parsers.js";

/**
 * Normalize a spec file path to a stable, environment-independent key segment.
 *
 * Playwright reports absolute paths inside Docker (/data/testmind-curated/...)
 * or relative paths from the config root (../data/testmind-curated/...).
 * Either way, once the path passes through "testmind-curated/" we strip
 * everything before it so the key is always "testmind-curated/project-X/...".
 * Paths outside the curated tree are left unchanged.
 */
export function normalizeSpecFileKey(file: string): string {
  const posix = file.replace(/\\/g, "/");
  const idx = posix.indexOf("testmind-curated/");
  return idx >= 0 ? posix.slice(idx) : posix;
}

type ResultStatus = "passed" | "failed" | "skipped" | "error";

type LocatorHealthUpdateInput = {
  pagePath: string;
  bucket: "locators";
  name: string;
  selector: string;
  status: "passed" | "failed";
  reason?: string | null;
};

type NavSuggestionUpdateInput = {
  key: string;
  selector: string;
  sourcePath: string;
  confidence: number;
};

const TestResultStatus: Record<ResultStatus, ResultStatus> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  error: "error",
};

function mapStatus(status: string): ResultStatus {
  if (status === "passed") return TestResultStatus.passed;
  if (status === "failed" || status === "error") return TestResultStatus.failed;
  if (status === "skipped") return TestResultStatus.skipped;
  return TestResultStatus.error;
}

export async function persistParsedRunResults({
  runId,
  projectId,
  userId,
  cases,
  curatedSuiteId,
  locatorHealthUpdates,
  navSuggestionUpdates,
}: {
  runId: string;
  projectId: string;
  userId: string;
  cases: ParsedCase[];
  curatedSuiteId?: string;
  locatorHealthUpdates: LocatorHealthUpdateInput[];
  navSuggestionUpdates: NavSuggestionUpdateInput[];
}): Promise<{ parsedCount: number; passed: number; failed: number; skipped: number }> {
  let parsedCount = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  await prisma.$transaction(async (db) => {
    for (const c of cases) {
      // Skip synthetic error entries produced when no JSON report was generated.
      // Storing them creates unresolvable TestCase records that trigger self-heal loops.
      if (c.file === "unknown" || !c.file) continue;

      const key = `${normalizeSpecFileKey(c.file)}#${c.fullName}`.slice(0, 255);

      const existing = await db.testCase.findUnique({
        where: { projectId_key: { projectId, key } },
        select: { id: true, status: true },
      });

      let testCase: { id: string };
      if (existing) {
        if (existing.status === "archived") {
          // Do not resurrect intentionally deleted/archived test cases
          continue;
        }
        testCase = await db.testCase.update({
          where: { id: existing.id },
          data: { title: c.fullName },
          select: { id: true },
        });
      } else {
        testCase = await db.testCase.create({
          data: { projectId, key, title: c.fullName, ...(curatedSuiteId ? { curatedSuiteId } : {}) },
          select: { id: true },
        });
      }

      await db.testResult.create({
        data: {
          run: { connect: { id: runId } },
          testCase: { connect: { id: testCase.id } },
          status: mapStatus(c.status),
          durationMs: c.durationMs ?? null,
          message: c.message ?? null,
        },
      });

      parsedCount += 1;
      if (c.status === "passed") passed += 1;
      else if (c.status === "failed" || c.status === "error") failed += 1;
      else skipped += 1;
    }

    if (locatorHealthUpdates.length || navSuggestionUpdates.length) {
      const projectRecord = await db.project.findUnique({
        where: { id: projectId },
        select: { sharedSteps: true, ownerId: true },
      });
      const sharedSteps = (projectRecord?.sharedSteps ?? {}) as Record<string, any>;
      const locatorHealth =
        sharedSteps.locatorHealth && typeof sharedSteps.locatorHealth === "object"
          ? ({ ...(sharedSteps.locatorHealth as Record<string, any>) } as Record<string, any>)
          : ({} as Record<string, any>);
      const navSuggestions =
        sharedSteps.navSuggestions && typeof sharedSteps.navSuggestions === "object"
          ? ({ ...(sharedSteps.navSuggestions as Record<string, any[]>) } as Record<string, any[]>)
          : ({} as Record<string, any[]>);
      const now = new Date().toISOString();

      for (const item of locatorHealthUpdates) {
        const key = `${item.pagePath}::${item.bucket}::${item.name}`;
        const prev = locatorHealth[key] ?? {};
        const next = {
          pagePath: item.pagePath,
          bucket: item.bucket,
          name: item.name,
          selector: item.selector || prev.selector,
          successCount: Math.max(0, Number(prev.successCount ?? 0)),
          failCount: Math.max(0, Number(prev.failCount ?? 0)),
          lastPassedAt: prev.lastPassedAt,
          lastFailedAt: prev.lastFailedAt,
          lastFailureReason: prev.lastFailureReason,
          updatedAt: now,
          updatedBy: projectRecord?.ownerId ?? userId,
        };
        if (item.status === "passed") {
          next.successCount += 1;
          next.lastPassedAt = now;
        } else {
          next.failCount += 1;
          next.lastFailedAt = now;
          if (item.reason) next.lastFailureReason = item.reason.slice(0, 2000);
        }
        locatorHealth[key] = next;
      }

      for (const nav of navSuggestionUpdates) {
        const existing = Array.isArray(navSuggestions[nav.key]) ? [...navSuggestions[nav.key]] : [];
        const deduped = existing.filter((item) => item?.selector !== nav.selector);
        const entry = {
          selector: nav.selector,
          confidence: nav.confidence,
          confidenceBreakdown: [{ delta: 0, reason: "auto-captured from run title" }],
          sourcePath: nav.sourcePath,
          updatedAt: now,
          updatedBy: projectRecord?.ownerId ?? userId,
        };
        navSuggestions[nav.key] = [entry, ...deduped]
          .sort((a: any, b: any) => {
            const scoreA = typeof a.confidence === "number" ? a.confidence : -1;
            const scoreB = typeof b.confidence === "number" ? b.confidence : -1;
            if (scoreA !== scoreB) return scoreB - scoreA;
            return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
          })
          .slice(0, 10);
      }

      await db.project.update({
        where: { id: projectId },
        data: {
          sharedSteps: {
            ...sharedSteps,
            locatorHealth,
            navSuggestions,
            locatorMeta: {
              ...(sharedSteps.locatorMeta ?? {}),
              updatedAt: now,
              updatedBy: projectRecord?.ownerId ?? userId,
            },
          },
        },
      });
    }
  });

  return { parsedCount, passed, failed, skipped };
}
