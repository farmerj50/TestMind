import type { SecurityHttpExchange } from "./http-exchange.js";
import type { ProbeResult } from "./http-client.js";

// Deliberately simple engineered signals for v0.1 — status match, body-length delta, and a
// top-level JSON key-set diff. No semantic/identity comparison, no confidence score: a human
// reads this diff. Scoring/ML comes later, once there's a real corpus of experiment outcomes
// to train against (see the plan's roadmap).
export type ExchangeDiff = {
  statusMatch: boolean;
  baselineStatus?: number;
  mutatedStatus?: number;
  bodyLengthDelta: number;
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
};

function parseTopLevelKeys(body: string | undefined): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

export function computeDifferential(baseline: SecurityHttpExchange, mutated: ProbeResult): ExchangeDiff {
  const baselineStatus = baseline.response?.status;
  const mutatedStatus = mutated.status;
  const baselineBody = baseline.response?.body ?? "";
  const mutatedBody = mutated.body ?? "";

  const baselineJson = parseTopLevelKeys(baselineBody);
  const mutatedJson = parseTopLevelKeys(mutatedBody);

  const addedKeys: string[] = [];
  const removedKeys: string[] = [];
  const changedKeys: string[] = [];

  if (baselineJson && mutatedJson) {
    const baselineKeys = new Set(Object.keys(baselineJson));
    const mutatedKeys = new Set(Object.keys(mutatedJson));
    for (const key of mutatedKeys) {
      if (!baselineKeys.has(key)) addedKeys.push(key);
    }
    for (const key of baselineKeys) {
      if (!mutatedKeys.has(key)) removedKeys.push(key);
    }
    for (const key of baselineKeys) {
      if (mutatedKeys.has(key) && JSON.stringify(baselineJson[key]) !== JSON.stringify(mutatedJson[key])) {
        changedKeys.push(key);
      }
    }
  }

  return {
    statusMatch: baselineStatus !== undefined && baselineStatus === mutatedStatus,
    baselineStatus,
    mutatedStatus,
    bodyLengthDelta: mutatedBody.length - baselineBody.length,
    addedKeys,
    removedKeys,
    changedKeys,
  };
}
