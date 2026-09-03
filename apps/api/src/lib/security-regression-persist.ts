// apps/api/src/lib/security-regression-persist.ts
//
// Ticket VR.3B (Validation + Regression v1). I/O wrapper: writes a real, executable .spec.ts
// file and creates the TestCase row that provides durable provenance back to the originating
// SecurityFinding. Reuses buildSecurityRegressionTest() unchanged and generatedSpecs.ts's
// project-scoped directory helper (its first real caller - see that file's own header comment).
//
// Per VR.3A's investigation: the standard per-TestCase runner (routes/tests.ts) always
// synthesizes execution content fresh from TestCase.steps/locators at run time and has no code
// path that reads a spec file off disk instead - teaching it to do so would change execution
// semantics for every pre-existing TestCase, which is the hard boundary this ticket does not
// cross. So the TestCase this creates is NOT wired into "click Run" in Suite Explorer; it is
// independently, directly executable (proven in security-regression-persist.test.ts by actually
// running the written file with Playwright) and discoverable via preconditions.specPath -
// matching url-inspector.ts's own established convention for its generated-but-not-yet-synced
// cases, which already requires the same manual "sync from generated" step to become runnable
// via the UI. Not a new gap.
import path from "node:path";
import fs from "node:fs/promises";
import { prisma } from "../prisma.js";
import { DEFAULT_FRAMEWORK_ID } from "@testmind/core/framework";
import { ensureGeneratedSpecDir } from "./generatedSpecs.js";
import { buildSecurityRegressionTest } from "./security-finding-detail.js";
import { URL_SHAPED_FINDING_TOOLS } from "./application-brain-query.js";
import { normalizeRouteHint, upsertTestLink } from "./application-model.js";
import { applyApplicationModelMerge } from "./application-model-store.js";
import type { SecurityFinding } from "@prisma/client";

/**
 * buildSecurityRegressionTest() returns only a `test(...)` body - today its one existing caller
 * (POST /security/findings/:id/generate-test) hands that snippet to a human to paste into an
 * existing spec file, so it was never meant to be a complete standalone file. The import line
 * is the standard convention every other generated spec in this codebase uses (see
 * testmind/adapters/playwright-ts/generator.ts) - added here as file-writing boilerplate, not a
 * change to the generator itself.
 */
export function buildRunnableSecurityRegressionSpec(finding: SecurityFinding): string {
  return `import { test, expect } from '@playwright/test';\n\n${buildSecurityRegressionTest(finding as any)}\n`;
}

/**
 * Ticket CS.0. Same eligibility check AB.2's query layer uses (finding.tool is a URL-shaped
 * tool and finding.location is present) - reused via the shared export, not duplicated, so the
 * two lists can never drift apart. A route is only ever added for eligible findings; for
 * everything else (code-review's file:line, jwt-analyzer's opaque token source, etc.)
 * `preconditions` keeps its pre-CS.0 shape exactly - injecting a route for those would be a
 * worse, now-visibly-wrong failure mode than today's silent invisibility to the Brain.
 */
function eligibleRouteHint(finding: SecurityFinding): string | null {
  if (finding.tool && URL_SHAPED_FINDING_TOOLS.has(finding.tool) && finding.location) {
    return normalizeRouteHint(finding.location);
  }
  return null;
}

export async function persistSecurityRegressionTest(
  finding: SecurityFinding,
  opts: { userId: string; projectId: string }
): Promise<{ testCase: Awaited<ReturnType<typeof prisma.testCase.create>>; specPath: string }> {
  const content = buildRunnableSecurityRegressionSpec(finding);
  const dir = await ensureGeneratedSpecDir({ adapterId: DEFAULT_FRAMEWORK_ID, userId: opts.userId, projectId: opts.projectId });
  const specPath = path.join(dir, `security-regression-${finding.id}.spec.ts`);
  await fs.writeFile(specPath, content, "utf8");

  const routeHint = eligibleRouteHint(finding);
  const testCase = await prisma.testCase.create({
    data: {
      projectId: opts.projectId,
      title: `Security regression: ${finding.title}`,
      type: "security",
      status: "draft",
      lastSource: "security-regression",
      securityFindingId: finding.id,
      preconditions: JSON.stringify(routeHint ? { specPath, route: routeHint } : { specPath }),
    },
  });

  // Best-effort: a Brain-write failure must never fail a successful TestCase persist. Matches
  // the fail-soft convention established by every other AB.4 producer (url-inspector.ts,
  // operator-worker.ts, security.ts's ApiSpec import and auth-session capture).
  if (routeHint) {
    try {
      await applyApplicationModelMerge(opts.projectId, (store) =>
        upsertTestLink(store, testCase.id, routeHint, new Date().toISOString())
      );
    } catch (err) {
      console.warn(`[security-regression-persist] failed to write Application Brain testLink for TestCase ${testCase.id}:`, err);
    }
  }

  return { testCase, specPath };
}
