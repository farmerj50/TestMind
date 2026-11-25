import type { QePlan } from "./qe-plan.js";

export type ScenarioState = "existing" | "generated" | "passed" | "failed" | "blocked" | "unimplemented";
export type ScenarioOutcome = { scenarioId: string; title: string; testTitle: string | null; status: ScenarioState; message: string | null; criteria: QePlan["scenarios"][number]["criteria"] };
export type ScenarioCoverage = { total: number; counts: Record<ScenarioState, number>; complete: boolean; scenarios: ScenarioOutcome[] };
type Generation = { tests: Array<{ scenarioId: string; testTitle: string }>; notGenerated: Array<{ scenarioId: string; reason: string }>; availableTitles?: string[] };
type Result = { title: string; status: string; message?: string | null };
const matches = (actual: string, expected: string) => actual === expected || actual.endsWith(` › ${expected}`) || actual.endsWith(` > ${expected}`);

/** Account for the entire frozen plan, including existing cases and absent implementations. */
export function scenarioCoverage(plan: QePlan, generation: Generation, results?: Result[], excluded: string[] = []): ScenarioCoverage {
  const counts: ScenarioCoverage["counts"] = { existing: 0, generated: 0, passed: 0, failed: 0, blocked: 0, unimplemented: 0 };
  const scenarios = plan.scenarios.map((s): ScenarioOutcome => {
    const generated = generation.tests.find((t) => t.scenarioId === s.id);
    const title = generated?.testTitle ?? s.execution.testTitle ?? (s.kind === "existing_case" || s.kind === "reverify" ? s.title : null);
    const omission = generation.notGenerated.find((t) => t.scenarioId === s.id);
    const result = title && results?.filter((r) => matches(r.title, title) || !!generated && r.title.includes(`[qe:${s.id}]`));
    let status: ScenarioState = "unimplemented";
    let message: string | null = omission?.reason ?? "No executable test implements this scenario";
    if (s.status !== "ready" && !generated) { status = "blocked"; message = s.blockedReason ?? message; }
    else if (title && excluded.some((t) => matches(t, title))) { status = "blocked"; message = "Required approval was not granted"; }
    else if (result && result.length) {
      status = result.some((r) => ["failed", "error", "timedOut", "interrupted"].includes(r.status)) ? "failed" : result.every((r) => r.status === "passed") ? "passed" : "blocked";
      message = result.find((r) => r.status !== "passed")?.message?.slice(0, 2000) ?? (status === "blocked" ? "Test did not execute" : null);
    } else if (generated || title && generation.availableTitles?.some((t) => matches(t, title))) {
      status = results ? "blocked" : generated && s.kind !== "reverify" && s.kind !== "existing_case" ? "generated" : "existing";
      message = results ? "No execution result recorded" : null;
    }
    counts[status]++;
    return { scenarioId: s.id, title: s.title, testTitle: title, status, message, criteria: s.criteria };
  });
  return { total: scenarios.length, counts, complete: scenarios.length > 0 && counts.passed === scenarios.length, scenarios };
}
