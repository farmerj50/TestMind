// apps/api/src/testmind/runtime/live-page-probe.ts
//
// Tier 2 self-heal repair mechanics: given a real page URL and a list of candidate
// selectors, find out which candidate actually resolves on the live page today. This
// module is deliberately observational-only — see the ObservablePage type below, which
// structurally has no click/fill/press/submit methods, so calling code cannot accidentally
// interact with the page even by mistake. The probe never learns whether a selector "works"
// in the sense of successfully submitting a form; it only learns whether the selector exists,
// is visible, and how many elements it matches. Whether the resulting patched test actually
// passes is decided later, by the normal self-heal rerun — this module has no opinion on that.
import { chromium, type Page } from "playwright";
import { validateUrl } from "../../lib/safe-fetch.js";
import { AUTH_PATH_RE } from "../../routes/url-inspector.js";

export type ProbeTargetKind = "fill" | "click";

export type ProbeTarget = {
  key: string;
  kind: ProbeTargetKind;
  candidates: string[];
};

export type ProbeCandidateResult = {
  key: string;
  selectedSelector: string | null;
  matchCount: number | null;
  attemptedSelectors: string[];
};

export type ProbeOutcome =
  | { ok: true; authGated: false; finalUrl: string; results: ProbeCandidateResult[] }
  | { ok: false; authGated: boolean; reason: string };

export type ProbeOptions = {
  navigationTimeoutMs?: number;
  perCandidateTimeoutMs?: number;
  totalBudgetMs?: number;
  /**
   * Passed straight through to validateUrl's SSRF guard. Left unset in production so the
   * guard's own defaults (reject loopback/private/link-local, https-only, both
   * overridable only via env vars) apply. Tests pass these explicitly to probe a local
   * http fixture server without touching global env state.
   */
  allowPrivateHosts?: boolean;
  allowHttp?: boolean;
};

const DEFAULT_NAVIGATION_TIMEOUT_MS = 8000;
const DEFAULT_PER_CANDIDATE_TIMEOUT_MS = 900; // matches findFirstWorkingLocator's runtime default
const DEFAULT_TOTAL_BUDGET_MS = 12000;

/** Fail-closed auth-gate heuristic, shared with url-inspector.ts's identical check. */
export function looksAuthGated(urlOrPath: string): boolean {
  try {
    const pathname = urlOrPath.startsWith("http")
      ? new URL(urlOrPath).pathname
      : urlOrPath;
    return AUTH_PATH_RE.test(pathname);
  } catch {
    return AUTH_PATH_RE.test(urlOrPath);
  }
}

/**
 * The only surface candidate-checking code can see. No click/fill/press/type/check/
 * selectOption/etc — those simply aren't present on this type, so the observational
 * contract is enforced by the compiler, not by convention.
 */
type ObservablePage = {
  locatorVisible(selector: string, timeoutMs: number): Promise<boolean>;
  locatorCount(selector: string): Promise<number>;
};

function toObservablePage(page: Page): ObservablePage {
  return {
    async locatorVisible(selector, timeoutMs) {
      try {
        await page.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs });
        return true;
      } catch {
        return false;
      }
    },
    async locatorCount(selector) {
      try {
        return await page.locator(selector).count();
      } catch {
        return 0;
      }
    },
  };
}

async function probeOneTarget(
  observable: ObservablePage,
  target: ProbeTarget,
  perCandidateTimeoutMs: number,
  deadline: number
): Promise<ProbeCandidateResult> {
  const attemptedSelectors: string[] = [];
  for (const selector of target.candidates) {
    if (Date.now() >= deadline) break;
    const remaining = deadline - Date.now();
    const timeout = Math.max(150, Math.min(perCandidateTimeoutMs, remaining));
    attemptedSelectors.push(selector);
    const visible = await observable.locatorVisible(selector, timeout);
    if (!visible) continue;
    const matchCount = await observable.locatorCount(selector);
    return { key: target.key, selectedSelector: selector, matchCount, attemptedSelectors };
  }
  return { key: target.key, selectedSelector: null, matchCount: null, attemptedSelectors };
}

/**
 * Navigate once to pageUrl and, against that single loaded page, try each target's
 * candidate selectors in order until one resolves. One browser launch total, regardless
 * of how many targets are passed in. Never throws — any failure (SSRF-rejected
 * destination, auth redirect, navigation timeout, browser launch failure) resolves to
 * `{ ok: false }` so callers can fall through to the next repair tier unconditionally.
 */
export async function probeSelectorCandidates(
  pageUrl: string,
  targets: ProbeTarget[],
  options?: ProbeOptions
): Promise<ProbeOutcome> {
  const navigationTimeoutMs = options?.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const perCandidateTimeoutMs = options?.perCandidateTimeoutMs ?? DEFAULT_PER_CANDIDATE_TIMEOUT_MS;
  const totalBudgetMs = options?.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;

  if (targets.length === 0) {
    return { ok: false, authGated: false, reason: "No probe targets provided" };
  }

  try {
    await validateUrl(pageUrl, {
      allowPrivateHosts: options?.allowPrivateHosts,
      allowHttp: options?.allowHttp,
    });
  } catch (err) {
    return {
      ok: false,
      authGated: false,
      reason: `Destination rejected: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (looksAuthGated(pageUrl)) {
    return { ok: false, authGated: true, reason: "Target URL path looks auth-gated" };
  }

  const startedAt = Date.now();
  const deadline = startedAt + totalBudgetMs;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    try {
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    } catch (err) {
      return {
        ok: false,
        authGated: false,
        reason: `Navigation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const finalUrl = page.url();
    if (looksAuthGated(finalUrl)) {
      return { ok: false, authGated: true, reason: "Post-navigation URL looks auth-gated" };
    }

    const observable = toObservablePage(page);
    // Every target gets a result entry, even ones skipped by the deadline (as "unresolved"),
    // so callers can rely on results.length === targets.length rather than checking for gaps.
    const results: ProbeCandidateResult[] = [];
    for (const target of targets) {
      if (Date.now() >= deadline) {
        results.push({ key: target.key, selectedSelector: null, matchCount: null, attemptedSelectors: [] });
        continue;
      }
      results.push(await probeOneTarget(observable, target, perCandidateTimeoutMs, deadline));
    }

    return { ok: true, authGated: false, finalUrl, results };
  } catch (err) {
    return {
      ok: false,
      authGated: false,
      reason: `Probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}
