// apps/api/src/ai/core/live-selector-probe-rule.ts
//
// Tier 2 repair: when a generated test hit a "// Missing locator ..." placeholder (Tier 1's
// deterministic rules found nothing to do with it), try resolving a real selector against
// the live public page before falling through to the LLM (Tier 3). See the plan for the
// full Tier 1 -> Tier 2 -> Tier 3 model. This module owns turning AiExecutionContext into
// probe inputs and probe outputs into a patch — the actual browser mechanics live in
// testmind/runtime/live-page-probe.ts and are observational-only.
import type { AiExecutionContext } from "./types.js";
import {
  findSelectedTestBlock,
  replaceSelectedTestBlock,
  type RuleRepairResult,
} from "./repair-executor.js";
import { withTimeout } from "./repair-policy.js";
import {
  looksAuthGated,
  probeSelectorCandidates,
  type ProbeTarget,
} from "../../testmind/runtime/live-page-probe.js";
import { generateSelectorSuggestions } from "../../testmind/adapters/playwright-ts/generator.js";
import { guessValue } from "../../testmind/pipeline/generate-plan.js";
import type { LocatorBucket } from "../../lib/locator-promotion.js";

export type PendingLocatorPromotion = {
  projectId: string;
  pagePath: string;
  bucket: LocatorBucket;
  name: string;
  selector: string;
  fallbacks: string[];
  matchCount: number | null;
};

export type LiveSelectorProbeOptions = {
  navigationTimeoutMs?: number;
  perCandidateTimeoutMs?: number;
  totalBudgetMs?: number;
  maxSitesPerAttempt?: number;
};

const DEFAULT_MAX_SITES_PER_ATTEMPT = 4;
// Small buffer over the probe's own internal budget, so a rare hang inside browser launch
// (which starts the internal deadline clock but isn't itself timeout-wrapped) can't block
// executeRepairAttempt indefinitely.
const OUTER_TIMEOUT_BUFFER_MS = 3000;

const MISSING_LOCATOR_COMMENT_RE =
  /\/\/ Missing locator (\w+)\.(\S+?) on (\S+?); add it to shared locators and rerun generation\./;

type ExtractedSite = {
  kind: "fill" | "click";
  rawSelectorText: string;
  bucket: LocatorBucket;
  name: string;
  pagePath: string;
  commentText: string;
};

/**
 * Splits a test block on its `test.step(...)` boundaries and, for each step whose title is
 * "N. Fill <selector>" or "N. Click <selector>" (the exact format generator.ts's
 * describeStep emits) and whose body contains a missing-locator placeholder, extracts what's
 * needed to probe and repair it. Mirrors generator.ts's own emission format exactly rather
 * than guessing at a shape.
 */
function extractMissingLocatorSites(blockText: string): ExtractedSite[] {
  const sites: ExtractedSite[] = [];
  const stepStartRe = /await test\.step\((".*?(?<!\\)")\s*,\s*async/g;
  const starts: Array<{ index: number; titleJson: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = stepStartRe.exec(blockText))) {
    starts.push({ index: m.index, titleJson: m[1] });
  }

  for (let i = 0; i < starts.length; i++) {
    const chunkStart = starts[i].index;
    const chunkEnd = i + 1 < starts.length ? starts[i + 1].index : blockText.length;
    const chunk = blockText.slice(chunkStart, chunkEnd);

    let title: string;
    try {
      title = JSON.parse(starts[i].titleJson);
    } catch {
      continue;
    }
    const titleMatch = title.match(/^\d+\.\s*(Fill|Click)\s+(.+)$/);
    if (!titleMatch) continue;

    const commentMatch = chunk.match(MISSING_LOCATOR_COMMENT_RE);
    if (!commentMatch) continue;

    sites.push({
      kind: titleMatch[1].toLowerCase() as "fill" | "click",
      rawSelectorText: titleMatch[2],
      bucket: commentMatch[1] as LocatorBucket,
      name: commentMatch[2],
      pagePath: commentMatch[3],
      commentText: commentMatch[0],
    });
  }

  return sites;
}

function buildPageUrl(baseUrl: string, pagePath: string): string | null {
  try {
    return new URL(pagePath, baseUrl).toString();
  } catch {
    return null;
  }
}

function logMetric(event: string, detail?: Record<string, unknown>) {
  console.log(`[self-heal] tier2: ${event}`, detail ?? {});
}

export type LiveSelectorProbeDeps = {
  /** Injectable for tests; defaults to the real browser-driving implementation. */
  probe?: typeof probeSelectorCandidates;
};

export async function tryLiveSelectorProbeRepair(
  context: AiExecutionContext,
  options?: LiveSelectorProbeOptions,
  deps: LiveSelectorProbeDeps = {}
): Promise<RuleRepairResult | null> {
  const probe = deps.probe ?? probeSelectorCandidates;
  if (!context.evidence.failureClasses.includes("missing_locator_comment")) return null;
  const baseUrl = context.job?.baseUrl;
  if (!baseUrl) return null;

  const specContent = context.specContent;
  if (!specContent) return null;
  const selectedBlock = findSelectedTestBlock(specContent, context.failure.testTitle);
  if (!selectedBlock) return null;

  const allSites = extractMissingLocatorSites(selectedBlock.block);
  if (allSites.length === 0) return null;

  const sharedPagePath = allSites[0].pagePath;
  if (looksAuthGated(sharedPagePath)) {
    logMetric("live_probe_skipped_auth", { pagePath: sharedPagePath });
    return null;
  }

  const maxSites = options?.maxSitesPerAttempt ?? DEFAULT_MAX_SITES_PER_ATTEMPT;
  const sites = allSites.filter((s) => s.pagePath === sharedPagePath).slice(0, maxSites);
  if (sites.length === 0) return null;

  const pageUrl = buildPageUrl(baseUrl, sharedPagePath);
  if (!pageUrl) return null;

  const targets: ProbeTarget[] = sites.map((site) => ({
    key: `${site.bucket}.${site.name}`,
    kind: site.kind,
    candidates: generateSelectorSuggestions(site.name, site.rawSelectorText, undefined),
  }));

  const totalBudgetMs = options?.totalBudgetMs;
  logMetric("live_probe_attempted", { pagePath: sharedPagePath, sites: sites.length });

  const outcome = await withTimeout(
    probe(pageUrl, targets, {
      navigationTimeoutMs: options?.navigationTimeoutMs,
      perCandidateTimeoutMs: options?.perCandidateTimeoutMs,
      totalBudgetMs,
    }),
    (totalBudgetMs ?? 12000) + OUTER_TIMEOUT_BUFFER_MS
  ).catch(() => null);

  if (!outcome) {
    logMetric("live_probe_timeout", { pagePath: sharedPagePath });
    return null;
  }
  if (!outcome.ok) {
    if (outcome.authGated) logMetric("live_probe_skipped_auth", { pagePath: sharedPagePath, reason: outcome.reason });
    else logMetric("live_probe_navigation_failed", { pagePath: sharedPagePath, reason: outcome.reason });
    return null;
  }

  let nextBlock = selectedBlock.block;
  const resolved: Array<{ site: ExtractedSite; selector: string; matchCount: number | null }> = [];

  for (const site of sites) {
    const result = outcome.results.find((r) => r.key === `${site.bucket}.${site.name}`);
    if (!result?.selectedSelector) continue;

    const replacement =
      site.kind === "fill"
        ? `await page.fill(${JSON.stringify(result.selectedSelector)}, ${JSON.stringify(guessValue(site.name))});`
        : `await page.click(${JSON.stringify(result.selectedSelector)});`;

    const withPatch = nextBlock.replace(site.commentText, replacement);
    if (withPatch === nextBlock) continue; // comment text not found (shouldn't happen); skip this site
    nextBlock = withPatch;
    resolved.push({ site, selector: result.selectedSelector, matchCount: result.matchCount });
  }

  if (resolved.length === 0) {
    logMetric("live_probe_navigation_failed", { pagePath: sharedPagePath, reason: "no candidate resolved" });
    return null;
  }

  logMetric("live_probe_selector_found", { pagePath: sharedPagePath, resolvedCount: resolved.length });

  const pendingLocatorPromotion: PendingLocatorPromotion[] = [];
  for (const r of resolved) {
    if (r.matchCount === 1) {
      logMetric("live_probe_unique_selector_found", { name: r.site.name, selector: r.selector });
      pendingLocatorPromotion.push({
        projectId: context.scope.projectId,
        pagePath: sharedPagePath,
        bucket: r.site.bucket,
        name: r.site.name,
        selector: r.selector,
        fallbacks: [],
        matchCount: r.matchCount,
      });
    }
  }

  logMetric("live_probe_patch_generated", { resolvedCount: resolved.length, promotable: pendingLocatorPromotion.length });

  return {
    kind: "rule",
    patchedSpec: replaceSelectedTestBlock(specContent, selectedBlock, nextBlock),
    summary: `Auto-replaced ${resolved.length} missing locator(s) via live-page verification`,
    note: "rule-based live-selector-probe",
    fixType: "rule_fixed",
    fixDetails: {
      tier: "live-probe",
      healingAttemptId: context.job.attemptId,
      testCaseId: context.job.testCaseId,
      resolved: resolved.map((r) => ({ name: r.site.name, bucket: r.site.bucket, selector: r.selector, matchCount: r.matchCount })),
      pendingLocatorPromotion,
    },
  };
}
