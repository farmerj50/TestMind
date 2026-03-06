import test from "node:test";
import assert from "node:assert/strict";
import { scoreSelectorConfidence } from "./selector-confidence.js";

test("confidence scoring rewards data-testid selectors", () => {
  const scored = scoreSelectorConfidence("[data-testid='submit-button']");
  assert.ok(scored.score >= 60);
  assert.ok(scored.breakdown.some((b) => b.reason.includes("data-testid")));
});

test("confidence scoring penalizes nth-child/deep selectors", () => {
  const scored = scoreSelectorConfidence("div > ul > li:nth-child(3) > button");
  assert.ok(scored.score <= 20);
  assert.ok(scored.breakdown.some((b) => b.reason.includes("nth-child")));
});

test("confidence scoring penalizes dynamic text patterns", () => {
  const scored = scoreSelectorConfidence('text=Order 12345 created today');
  assert.ok(scored.breakdown.some((b) => b.reason.includes("dynamic text")));
});

