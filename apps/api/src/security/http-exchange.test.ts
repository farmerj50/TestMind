import test from "node:test";
import assert from "node:assert/strict";
import { detectResourceIdCandidates, applyResourceIdMutation, looksLikeResourceId } from "./http-exchange.js";

test("detectResourceIdCandidates finds a numeric path segment", () => {
  const candidates = detectResourceIdCandidates("https://example.com/api/orders/8721");
  assert.deepEqual(candidates, [{ location: "path", paramName: "segment2", value: "8721" }]);
});

test("detectResourceIdCandidates finds multiple candidates without cross-contaminating indices", () => {
  const candidates = detectResourceIdCandidates("https://example.com/api/orders/8721/items/55");
  assert.deepEqual(candidates, [
    { location: "path", paramName: "segment2", value: "8721" },
    { location: "path", paramName: "segment4", value: "55" },
  ]);
});

test("detectResourceIdCandidates finds a query-string candidate", () => {
  const candidates = detectResourceIdCandidates("https://example.com/api/search?q=hello&userId=8721");
  assert.deepEqual(candidates, [{ location: "query", paramName: "userId", value: "8721" }]);
});

test("detectResourceIdCandidates finds a UUID path segment", () => {
  const candidates = detectResourceIdCandidates("https://example.com/api/f47ac10b-58cc-4372-a567-0e02b2c3d479/details");
  assert.deepEqual(candidates, [
    { location: "path", paramName: "segment1", value: "f47ac10b-58cc-4372-a567-0e02b2c3d479" },
  ]);
});

test("detectResourceIdCandidates returns nothing for a URL with no ID-shaped values", () => {
  assert.deepEqual(detectResourceIdCandidates("https://example.com/api/orders"), []);
});

test("detectResourceIdCandidates returns nothing for a malformed URL", () => {
  assert.deepEqual(detectResourceIdCandidates("not a url"), []);
});

test("looksLikeResourceId rejects single-digit numbers and plain words", () => {
  assert.equal(looksLikeResourceId("5"), false);
  assert.equal(looksLikeResourceId("orders"), false);
  assert.equal(looksLikeResourceId("8721"), true);
});

test("applyResourceIdMutation swaps exactly the targeted path segment, leaving the rest of the URL untouched", () => {
  const url = "https://example.com/api/orders/8721/items/55?ref=abc";
  const candidates = detectResourceIdCandidates(url);
  const mutated = applyResourceIdMutation(url, candidates[0], "9999");
  assert.equal(mutated, "https://example.com/api/orders/9999/items/55?ref=abc");
});

test("applyResourceIdMutation swaps exactly the targeted query param, leaving path and other params untouched", () => {
  const url = "https://example.com/api/search?q=hello&userId=8721";
  const candidates = detectResourceIdCandidates(url);
  const mutated = applyResourceIdMutation(url, candidates[0], "9999");
  assert.equal(mutated, "https://example.com/api/search?q=hello&userId=9999");
});
