import test from "node:test";
import assert from "node:assert/strict";
import { scoreAuthEntryCandidate, rankAuthEntryCandidates } from "./auth-entry-confidence.js";

test("scores an exact 'Sign In' button as high confidence", () => {
  const scored = scoreAuthEntryCandidate({
    selector: 'button:has-text("Sign In")',
    text: "Sign In",
    tag: "button",
    role: "button",
  });
  assert.ok(scored.score >= 60);
  assert.ok(scored.breakdown.some((b) => b.reason.includes("exact auth-entry text")));
});

test("scores a loose match like 'Member Sign In' lower than an exact match", () => {
  const exact = scoreAuthEntryCandidate({
    selector: 'button:has-text("Sign In")',
    text: "Sign In",
    tag: "button",
  });
  const loose = scoreAuthEntryCandidate({
    selector: 'a:has-text("Member Sign In Portal")',
    text: "Member Sign In Portal",
    tag: "a",
    href: "/portal",
  });
  assert.ok(loose.score < exact.score);
});

test("rewards an href that points at a login route", () => {
  const withHref = scoreAuthEntryCandidate({
    selector: 'a:has-text("Log In")',
    text: "Log In",
    tag: "a",
    href: "/login",
  });
  const withoutHref = scoreAuthEntryCandidate({
    selector: 'a:has-text("Log In")',
    text: "Log In",
    tag: "a",
  });
  assert.ok(withHref.score > withoutHref.score);
  assert.ok(withHref.breakdown.some((b) => b.reason.includes("auth route")));
});

test("penalizes candidates with no accessible text", () => {
  const scored = scoreAuthEntryCandidate({ selector: "button", text: "", tag: "button" });
  assert.ok(scored.score <= 20);
  assert.ok(scored.breakdown.some((b) => b.reason.includes("no accessible text")));
});

test("penalizes candidates whose text is too long to be a nav control", () => {
  const scored = scoreAuthEntryCandidate({
    selector: 'a:has-text("...")',
    text: "Learn more about how our platform helps you sign in securely every time",
    tag: "a",
  });
  assert.ok(scored.breakdown.some((b) => b.reason.includes("too long")));
});

test("does not false-positive on unrelated buttons", () => {
  const scored = scoreAuthEntryCandidate({
    selector: 'button:has-text("Learn More")',
    text: "Learn More",
    tag: "button",
    role: "button",
  });
  assert.ok(scored.score < 40);
});

test("scores a framework-rendered clickable div using data-testid", () => {
  // React Native Web / Expo apps render Pressables as a bare <div>, with no
  // semantic tag or role — data-testid/aria-label are the only strong signals.
  const scored = scoreAuthEntryCandidate({
    selector: '[data-testid="landing-sign-in-btn"]',
    text: "Sign In",
    tag: "div",
    testId: "landing-sign-in-btn",
    ariaLabel: "landing-sign-in-btn",
  });
  assert.ok(scored.score >= 80);
  assert.ok(scored.breakdown.some((b) => b.reason.includes("data-testid")));
  assert.ok(scored.breakdown.some((b) => b.reason.includes("aria-label")));
});

test("data-testid/aria-label alone (no visible text) still signals an auth control", () => {
  const scored = scoreAuthEntryCandidate({
    selector: '[data-testid="login-icon-btn"]',
    text: "",
    tag: "div",
    testId: "login-icon-btn",
  });
  assert.ok(scored.score > 10);
  assert.ok(scored.breakdown.some((b) => b.reason.includes("data-testid")));
});

test("rankAuthEntryCandidates sorts highest confidence first", () => {
  const ranked = rankAuthEntryCandidates([
    { selector: 'button:has-text("Learn More")', text: "Learn More", tag: "button" },
    { selector: 'button:has-text("Sign In")', text: "Sign In", tag: "button", role: "button" },
    { selector: 'a:has-text("Create Account")', text: "Create Account", tag: "a" },
  ]);
  assert.equal(ranked[0].text, "Sign In");
});
