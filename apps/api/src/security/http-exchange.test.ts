import test from "node:test";
import assert from "node:assert/strict";
import {
  detectResourceIdCandidates,
  applyResourceIdMutation,
  looksLikeResourceId,
  detectResourceIdCandidatesInBody,
  applyResourceIdMutationInBody,
} from "./http-exchange.js";

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

// Live Security Testing v1, Ticket LST.4 - body-level counterpart, needed so an IDOR/BOLA
// hypothesis on a PUT/PATCH/POST endpoint can mutate an id that lives in the JSON body, not
// just the URL.

test("detectResourceIdCandidatesInBody finds a top-level id-shaped field", () => {
  const candidates = detectResourceIdCandidatesInBody(JSON.stringify({ orderId: "8721", note: "hello" }));
  assert.deepEqual(candidates, [{ location: "body", paramName: "orderId", path: ["orderId"], value: "8721" }]);
});

test("detectResourceIdCandidatesInBody finds a nested id-shaped field, reporting a readable dotted path", () => {
  const candidates = detectResourceIdCandidatesInBody(JSON.stringify({ order: { id: "8721" } }));
  assert.deepEqual(candidates, [{ location: "body", paramName: "order.id", path: ["order", "id"], value: "8721" }]);
});

test("detectResourceIdCandidatesInBody finds an id inside an array element", () => {
  const candidates = detectResourceIdCandidatesInBody(JSON.stringify({ items: [{ id: "5501" }] }));
  assert.deepEqual(candidates, [{ location: "body", paramName: "items[0].id", path: ["items", 0, "id"], value: "5501" }]);
});

test("detectResourceIdCandidatesInBody returns nothing for a non-JSON or missing body", () => {
  assert.deepEqual(detectResourceIdCandidatesInBody(undefined), []);
  assert.deepEqual(detectResourceIdCandidatesInBody("not json"), []);
  assert.deepEqual(detectResourceIdCandidatesInBody(""), []);
});

test("applyResourceIdMutationInBody swaps exactly the targeted field, leaving the rest of the body untouched", () => {
  const body = JSON.stringify({ order: { id: "8721", note: "hello" }, ref: "abc" });
  const candidates = detectResourceIdCandidatesInBody(body);
  const mutated = applyResourceIdMutationInBody(body, candidates[0], "9999");
  assert.deepEqual(JSON.parse(mutated), { order: { id: "9999", note: "hello" }, ref: "abc" });
});

test("applyResourceIdMutationInBody swaps exactly the targeted array-element field", () => {
  const body = JSON.stringify({ items: [{ id: "5501", qty: 2 }, { id: "5502", qty: 1 }] });
  const candidates = detectResourceIdCandidatesInBody(body);
  const mutated = applyResourceIdMutationInBody(body, candidates[0], "9999");
  assert.deepEqual(JSON.parse(mutated), { items: [{ id: "9999", qty: 2 }, { id: "5502", qty: 1 }] });
});

test("applyResourceIdMutationInBody returns the original body unchanged if the candidate's path is no longer valid against it", () => {
  const body = JSON.stringify({ order: { id: "8721" } });
  const candidates = detectResourceIdCandidatesInBody(body);
  const differentBody = JSON.stringify({ order: "not an object anymore" });
  assert.equal(applyResourceIdMutationInBody(differentBody, candidates[0], "9999"), differentBody);
});
