import test from "node:test";
import assert from "node:assert/strict";
import { computeDifferential } from "./differential.js";
import type { SecurityHttpExchange } from "./http-exchange.js";
import type { ProbeResult } from "./http-client.js";

function baseline(status: number, body: string): SecurityHttpExchange {
  return {
    id: "ex1",
    sessionId: "s1",
    timestamp: Date.now(),
    request: { method: "GET", url: "https://example.com/api/orders/8721", headers: {} },
    response: { status, headers: {}, body, durationMs: 10 },
  };
}

function mutatedResult(status: number, body: string): ProbeResult {
  return { method: "GET", url: "https://example.com/api/orders/8722", status, body, bodyLength: body.length, bodySnippet: "", headers: {} };
}

test("computeDifferential reports a status match and zero body-length delta for identical responses", () => {
  const diff = computeDifferential(baseline(200, '{"id":8721,"ownerId":413}'), mutatedResult(200, '{"id":8721,"ownerId":413}'));
  assert.equal(diff.statusMatch, true);
  assert.equal(diff.bodyLengthDelta, 0);
  assert.deepEqual(diff.addedKeys, []);
  assert.deepEqual(diff.removedKeys, []);
  assert.deepEqual(diff.changedKeys, []);
});

test("computeDifferential flags a status mismatch (e.g. baseline 200, mutated 403)", () => {
  const diff = computeDifferential(baseline(200, '{"id":8721}'), mutatedResult(403, '{"error":"forbidden"}'));
  assert.equal(diff.statusMatch, false);
  assert.equal(diff.baselineStatus, 200);
  assert.equal(diff.mutatedStatus, 403);
});

test("computeDifferential detects changed/added/removed top-level keys — the BOLA-relevant case: same status, different owner data", () => {
  const diff = computeDifferential(
    baseline(200, '{"id":8721,"ownerId":413,"amount":100}'),
    mutatedResult(200, '{"id":8722,"ownerId":900,"amount":250,"extra":"leaked"}')
  );
  assert.equal(diff.statusMatch, true);
  assert.deepEqual(diff.changedKeys.sort(), ["amount", "id", "ownerId"]);
  assert.deepEqual(diff.addedKeys, ["extra"]);
  assert.deepEqual(diff.removedKeys, []);
});

test("computeDifferential does not crash on non-JSON bodies", () => {
  const diff = computeDifferential(baseline(200, "not json"), mutatedResult(200, "also not json"));
  assert.equal(diff.statusMatch, true);
  assert.deepEqual(diff.changedKeys, []);
});
