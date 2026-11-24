// B5: Autonomous failure intelligence - pure logic, no Prisma/browser imports.
//
// Explains WHY a test failed by correlating signals that already exist:
//   - investigator.ts (message signals: infra vs automation drift)
//   - workflow-evidence.ts's analyzer verdict + collected network/trace/screenshot evidence
//   - B2 Application Brain observations of the page (access state, observed labels)
//   - B3 scenario objective / acceptance criterion the test verifies
// and decides whether a repair is safe. A repair may fix HOW a test reaches its objective
// (a selector, a wait) - never WHAT it asserts. Suspected product defects are escalated.
import type { ApplicationModelPage } from "./application-model.js";
import type { InvestigatorResult } from "./investigator.js";
import { extractAssertionTargets, hasSkipMarker } from "../runner/dev-agent-objective.js";

export type FailureCategory = "product_defect" | "test_defect" | "environment" | "blocked_inconclusive";
export type FailureCause =
  | "broken_selector" | "stale_assumption" | "redirect" | "auth_required" | "objective_unmet"
  | "assertion_form" | "server_error" | "network" | "infrastructure" | "unknown";
export type Confidence = "high" | "medium" | "low";

export type FailureEvidence = { kind: string; detail: string; artifactId?: string };

export type FailureInvestigation = {
  testResultId: string;
  testCaseId: string;
  testTitle: string;
  scenarioId: string | null;
  route: string | null;
  category: FailureCategory;
  cause: FailureCause;
  confidence: Confidence;
  explanation: string;
  evidence: FailureEvidence[];
  /** Safe to let self-heal repair automatically (subject to authorization). */
  repairable: boolean;
  /** Needs a human: suspected product defect, or a test that cannot be fixed by automation. */
  escalate: boolean;
  objective: string | null;
};

export type ClassifyInput = {
  testResultId: string;
  testCaseId: string;
  testTitle: string;
  message: string | null;
  investigator: InvestigatorResult;
  analyzer?: { verdict: string; hypotheses: string[]; missingEvidence: string[] } | null;
  network: { serverErrors: number[]; requestFailed: string[] };
  attachments: FailureEvidence[];
  scenario?: { id: string; kind: string; objective: string; criteria: Array<{ text: string }> } | null;
  route: string | null;
  page?: ApplicationModelPage | null;
};

const AUTH_PATH = /^\/(login|signin|sign-in|auth|sso)(\/|$)/i;
const SELECTOR = /locator|element\(s\) not found|waiting for (locator|getBy|selector)|strict mode violation|resolved to 0 elements|getBy\w+\(/i;
// Investigator repair classes that are genuinely about locating elements (not URL/text assertions).
const LOCATOR_CLASSES = new Set<string>(["strict_mode_locator", "locator_resolution_failed", "missing_locator_comment", "css_selector_parse_error", "role_locator_missing", "login_selector_timeout"]);
const ASSERTION =/expect\(.*\)\.(not\.)?to\w+|Expected( pattern| string| value)?:/i;

/** The user-visible label a failing locator was looking for, if the message names one. */
export function locatorLabel(message: string): string | null {
  const m = /has-text\(\s*\\?["']([^"'\\]+)\\?["']\s*\)/.exec(message)
    ?? /getBy(?:Text|Label|Placeholder|AltText|Title)\(\s*['"]([^'"]+)['"]/.exec(message)
    ?? /\bname:\s*['"]([^'"]+)['"]/.exec(message);
  return m ? m[1].trim() : null;
}

/** "Received string: https://host/path?x" from an assertion failure. */
export function receivedUrl(message: string): URL | null {
  const m = /Received(?: string)?:\s*"?(https?:\/\/[^\s"]+)/.exec(message);
  try { return m ? new URL(m[1]) : null; } catch { return null; }
}

/** "Expected pattern: /^\/register\/?$/" from an assertion failure. */
function expectedPattern(message: string): RegExp | null {
  const m = /Expected pattern:\s*\/(.+)\/([a-z]*)\s*$/m.exec(message);
  try { return m ? new RegExp(m[1], m[2]) : null; } catch { return null; }
}

const pageLabels = (p?: ApplicationModelPage | null) => [...(p?.observed?.actions ?? []), ...(p?.observed?.fields ?? []), ...(p?.observed?.headings ?? [])].map((l) => l.toLowerCase());

export function classifyFailure(input: ClassifyInput): FailureInvestigation {
  const msg = input.message ?? "";
  const evidence: FailureEvidence[] = [];
  if (msg) evidence.push({ kind: "assertion", detail: msg.replace(/\s+/g, " ").slice(0, 400) });
  evidence.push(...input.attachments.slice(0, 10));
  for (const s of input.network.serverErrors.slice(0, 5)) evidence.push({ kind: "network", detail: `HTTP ${s} observed during the test` });
  for (const f of input.network.requestFailed.slice(0, 5)) evidence.push({ kind: "network", detail: `request failed: ${f}` });
  if (input.analyzer?.hypotheses.length) evidence.push({ kind: "analysis", detail: input.analyzer.hypotheses.join(" ") });
  const access = input.page?.access;
  if (access) evidence.push({ kind: "observation", detail: `Brain: ${input.route} is ${access.state} (${access.evidence}, ${access.observedAt})` });

  const base = {
    testResultId: input.testResultId, testCaseId: input.testCaseId, testTitle: input.testTitle,
    scenarioId: input.scenario?.id ?? null, route: input.route, evidence, objective: input.scenario?.objective ?? null,
  };
  const out = (category: FailureCategory, cause: FailureCause, confidence: Confidence, explanation: string, repairable = false): FailureInvestigation =>
    ({ ...base, category, cause, confidence, explanation, repairable, escalate: category === "product_defect" || (category === "test_defect" && !repairable) });

  if (!msg.trim()) return out("blocked_inconclusive", "unknown", "low", "The run recorded no failure message; there is nothing to diagnose.");

  // 1) Environment: the target or the browser was not reachable/healthy.
  const infraSignals = [input.investigator.verdict === "ENVIRONMENT_FAILURE", input.analyzer?.verdict === "infrastructure-failure", input.network.requestFailed.some((r) => /ERR_(CONNECTION|NAME_NOT_RESOLVED|INTERNET|TIMED_OUT)|net::/i.test(r))].filter(Boolean).length;
  if (infraSignals) {
    return out("environment", input.network.requestFailed.length ? "network" : "infrastructure", infraSignals >= 2 ? "high" : "medium",
      "The application or browser could not be reached reliably during this test (connection/infrastructure error), so its result says nothing about the product.");
  }

  // 2) Redirects and authentication (B2 knows how the route behaves for signed-out visitors).
  const got = receivedUrl(msg);
  const kind = input.scenario?.kind;
  if (kind === "access_denied" && input.route) {
    if (got && got.pathname.replace(/\/$/, "") === input.route.replace(/\/$/, "")) {
      return out("product_defect", "objective_unmet", "high", `A signed-out visitor reached ${input.route}; it was previously observed redirecting away (${access?.evidence ?? "see Brain"}). Possible access-control regression - escalated for review.`);
    }
  }
  if (access && (access.state === "redirected" || access.state === "auth_required") && kind !== "access_denied" && kind !== "auth_access") {
    return out("test_defect", "auth_required", got ? "high" : "medium",
      `This test assumes a signed-out visitor can use ${input.route}, but the app sends signed-out visitors elsewhere (${access.evidence}). The test needs approved credentials or a different objective; automation must not change what it verifies.`);
  }
  if (got && AUTH_PATH.test(got.pathname) && input.route && !AUTH_PATH.test(input.route)) {
    return out("blocked_inconclusive", "auth_required", "medium", `The test was sent to a sign-in page (${got.pathname}) instead of ${input.route}; it cannot proceed without an authenticated session.`);
  }

  // 3) Assertion compares the wrong part of the URL (a generated-test defect, not the product).
  const exp = expectedPattern(msg);
  if (got && exp && !exp.test(got.href) && exp.test(got.pathname)) {
    return out("test_defect", "assertion_form", "high", `The app is on the expected page (${got.pathname}); the assertion compared a path pattern against the full URL. Regenerate the test - its objective is satisfied.`);
  }

  // 4) Missing elements: a broken selector vs. an expected element that is really gone.
  if (SELECTOR.test(msg) || input.investigator.matchedSignals.some((s) => s.source === "repairFailureClass" && LOCATOR_CLASSES.has(s.value))) {
    const label = locatorLabel(msg);
    const observed = pageLabels(input.page);
    const required = !!label && !!input.scenario && [input.scenario.objective, ...input.scenario.criteria.map((c) => c.text)].some((t) => t.toLowerCase().includes(label.toLowerCase()));
    if (label && required && input.page?.observed && !observed.includes(label.toLowerCase())) {
      return out("product_defect", "objective_unmet", "medium",
        `The objective requires "${label}", and it was not among the elements observed on ${input.route} (${input.page.observed.observedAt}). The application no longer shows what the requirement expects - escalated for review instead of rewriting the test.`);
    }
    if (label && observed.includes(label.toLowerCase())) {
      return out("test_defect", "broken_selector", "high", `"${label}" is still observed on ${input.route}, so the element exists and the locator is stale. Safe to repair the selector; the assertion must stay the same.`, true);
    }
    if (input.analyzer?.verdict === "automation-failure") {
      return out("test_defect", "broken_selector", "medium", "Execution evidence points to a locator/automation failure (no product signal). Safe to repair the selector; the assertion must stay the same.", true);
    }
    return out("test_defect", "broken_selector", "low", `A locator${label ? ` for "${label}"` : ""} did not resolve, and current observations can't confirm whether the element still exists. Not auto-repaired at low confidence.`);
  }

  // 5) Server errors without backend evidence stay inconclusive (proxy/dependency/app).
  if (input.network.serverErrors.length) {
    return out("blocked_inconclusive", "server_error", "medium", `The app returned HTTP ${input.network.serverErrors.join("/")} during the test. That could be an application defect, a dependency, or infrastructure - not enough evidence to decide; needs review.`);
  }

  // 6) A real assertion on the scenario's objective did not hold.
  if (ASSERTION.test(msg) && input.scenario) {
    return out("product_defect", "objective_unmet", "medium", `The application did not meet the test's objective: "${input.scenario.objective}". Escalated for review - the expected behavior is not changed to make the test pass.`);
  }
  if (ASSERTION.test(msg)) {
    return out("blocked_inconclusive", "unknown", "low", "An assertion failed, but this test has no recorded objective to judge it against; needs review.");
  }
  return out("blocked_inconclusive", "unknown", "low", "The failure doesn't match a known pattern and the evidence is insufficient to classify it.");
}

// ── Repair safety ───────────────────────────────────────────────────────────

export type RepairDecision = { action: "auto_repair" | "escalate" | "hold"; reason: string };

export function decideRepair(inv: FailureInvestigation, opts: { autonomyAllowsRepair: boolean; sideEffectsApproved: boolean }): RepairDecision {
  if (inv.category === "product_defect") return { action: "escalate", reason: "Suspected product defect - humans decide; the test is not changed to pass" };
  if (!inv.repairable) return { action: inv.escalate ? "escalate" : "hold", reason: inv.explanation };
  if (inv.confidence === "low") return { action: "hold", reason: "Classification confidence too low for an automatic repair" };
  if (!opts.autonomyAllowsRepair) return { action: "hold", reason: "Automatic repair is not authorized at this autonomy level" };
  if (!opts.sideEffectsApproved) return { action: "hold", reason: "Re-running this test has side effects that were not approved" };
  return { action: "auto_repair", reason: "Stale locator for an element that still exists - selector repair only" };
}

/**
 * A repair may change how a test finds things, never what it verifies. The repaired spec must
 * keep every originally asserted text target positively asserted, keep (at least) as many
 * expectations, keep every test (by title), and add no skip/fixme/fail markers.
 */
export function repairPreservesObjective(original: string, repaired: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (hasSkipMarker(repaired) && !hasSkipMarker(original)) reasons.push("repair added a skip/fixme/expected-fail marker");
  const count = (s: string) => (s.match(/\bexpect(?:\.soft)?\s*\(/g) ?? []).length;
  if (count(repaired) < count(original)) reasons.push(`repair removed assertions (${count(original)} -> ${count(repaired)})`);
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const before = extractAssertionTargets(original).filter((t) => !t.negated).map((t) => norm(t.text));
  const after = new Set(extractAssertionTargets(repaired).filter((t) => !t.negated).map((t) => norm(t.text)));
  const afterNegated = new Set(extractAssertionTargets(repaired).filter((t) => t.negated).map((t) => norm(t.text)));
  for (const t of new Set(before)) {
    if (afterNegated.has(t)) reasons.push(`repair inverted the assertion on "${t}"`);
    else if (!after.has(t)) reasons.push(`repair stopped asserting "${t}"`);
  }
  const titles = (s: string) => new Set([...s.matchAll(/\b(?:test|qe)(?:\.(?:only|skip|fixme|fail))?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]));
  const lost = [...titles(original)].filter((t) => !titles(repaired).has(t));
  if (lost.length) reasons.push(`repair removed or renamed test(s): ${lost.slice(0, 3).join(", ")}`);
  return { ok: reasons.length === 0, reasons };
}

// ── Application Brain records ───────────────────────────────────────────────

import type { ApplicationModelStore, InvestigationRecord, DefectRecord } from "./application-model.js";

const MAX_HISTORY = 5;

export function recordInvestigationsInStore(store: ApplicationModelStore, invs: FailureInvestigation[], runId: string, at: string): ApplicationModelStore {
  const investigations: Record<string, InvestigationRecord> = { ...(store.investigations ?? {}) };
  const defects: Record<string, DefectRecord> = { ...(store.defects ?? {}) };
  for (const inv of invs) {
    const summary = { category: inv.category, cause: inv.cause, confidence: inv.confidence, runId, at };
    const prior = investigations[inv.testCaseId];
    investigations[inv.testCaseId] = {
      testCaseId: inv.testCaseId, testTitle: inv.testTitle, scenarioId: inv.scenarioId, route: inv.route,
      latest: { ...summary, explanation: inv.explanation },
      history: [summary, ...(prior?.history ?? [])].slice(0, MAX_HISTORY),
    };
    if (inv.category === "product_defect") {
      const d = defects[inv.testCaseId];
      defects[inv.testCaseId] = {
        testCaseId: inv.testCaseId, testTitle: inv.testTitle, scenarioId: inv.scenarioId, route: inv.route,
        explanation: inv.explanation, evidence: inv.evidence.slice(0, 6).map((e) => `${e.kind}: ${e.detail}`.slice(0, 300)),
        status: "needs_review", firstSeenAt: d?.firstSeenAt ?? at, lastSeenAt: at, occurrences: (d?.occurrences ?? 0) + 1,
        runIds: [runId, ...(d?.runIds ?? []).filter((r) => r !== runId)].slice(0, 10),
      };
    }
  }
  return { ...store, investigations, defects };
}

export function recordRepairOutcomeInStore(store: ApplicationModelStore, testCaseId: string, repair: NonNullable<InvestigationRecord["latest"]["repair"]>): ApplicationModelStore {
  const rec = store.investigations?.[testCaseId];
  if (!rec) return store;
  return { ...store, investigations: { ...store.investigations, [testCaseId]: { ...rec, latest: { ...rec.latest, repair } } } };
}
