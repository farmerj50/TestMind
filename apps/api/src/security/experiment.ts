import { probeScoped, type ProbeScope, type ProbeResult } from "./http-client.js";
import {
  detectResourceIdCandidates,
  applyResourceIdMutation,
  type SecurityHttpExchange,
  type ResourceIdCandidate,
} from "./http-exchange.js";
import { computeDifferential, type ExchangeDiff } from "./differential.js";

export type ExperimentResult = {
  baseline: SecurityHttpExchange;
  mutatedResult: ProbeResult;
  diff: ExchangeDiff;
};

function requireGetBaseline(exchange: SecurityHttpExchange) {
  if (!exchange?.id || !exchange.request || !exchange.response) {
    throw new Error("Experiment requires a captured baseline with both a request and a response.");
  }
  if (exchange.request.method.toUpperCase() !== "GET") {
    throw new Error("Live security experiments are GET-only in this version.");
  }
}

export async function runReplayExperiment(
  exchange: SecurityHttpExchange,
  scope: ProbeScope
): Promise<ExperimentResult> {
  requireGetBaseline(exchange);

  const replayResult = await probeScoped(scope, exchange.request.url, {
    method: "GET",
    headers: exchange.request.headers,
  });

  return {
    baseline: exchange,
    mutatedResult: replayResult,
    diff: computeDifferential(exchange, replayResult),
  };
}

// The four invariants this function enforces (see the plan's Context section):
//   1. No captured baseline -> no experiment: `exchange` must be a real captured record with
//      a response already on it — this function never accepts a client-supplied URL/headers.
//   2. GET-only, enforced here, not left to the caller.
//   3. Every replay goes through probeScoped — no alternate outbound-request path.
//   4. The mutation target must be one of THIS exchange's own server-detected candidates —
//      re-validated here even though callers are expected to have already checked, since this
//      function is the actual security boundary, not the caller's discipline.
export async function runIdMutationExperiment(
  exchange: SecurityHttpExchange,
  candidate: ResourceIdCandidate,
  newValue: string,
  scope: ProbeScope
): Promise<ExperimentResult> {
  requireGetBaseline(exchange);

  const validCandidates = detectResourceIdCandidates(exchange.request.url);
  const isServerDetected = validCandidates.some(
    (c) => c.location === candidate.location && c.paramName === candidate.paramName
  );
  if (!isServerDetected) {
    throw new Error("Mutation target must be a server-detected candidate from this baseline.");
  }

  const mutatedUrl = applyResourceIdMutation(exchange.request.url, candidate, newValue);

  // Headers cloned verbatim from the captured baseline — the mutated request carries the
  // same identity (cookies/Authorization) the original observed request did. A future
  // cross-identity experiment type would deliberately swap in a different baseline's
  // headers; this function never does that implicitly.
  const mutatedResult = await probeScoped(scope, mutatedUrl, {
    method: "GET",
    headers: exchange.request.headers,
  });

  return {
    baseline: exchange,
    mutatedResult,
    diff: computeDifferential(exchange, mutatedResult),
  };
}
