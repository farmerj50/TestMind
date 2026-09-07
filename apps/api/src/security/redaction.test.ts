import test from "node:test";
import assert from "node:assert/strict";
import { redactText, snippet } from "./redaction.js";

// Live Security Testing v1, Ticket LST.3: redactText/snippet() is the ONLY redaction path
// sensitiveDataStopCheck's evidence goes through (via http-client.ts's probeEvidence()) - a gap
// here means a circuit-breaker finding could itself leak the raw sensitive value into stored
// evidence. Extended to cover JWT/credit-card/SSN shapes, not just named credential keys.

test("redactText: still redacts known secret-named key=value pairs (pre-existing behavior)", () => {
  const out = redactText("token=abcdef1234567890");
  assert.ok(!out.includes("abcdef1234567890"));
  assert.match(out, /token=\[REDACTED\]/);
});

test("redactText: redacts a JWT-shaped string", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const out = redactText(`accessToken=${jwt}`);
  assert.ok(!out.includes(jwt));
});

test("redactText: redacts a Luhn-valid credit card number but leaves a Luhn-invalid digit run alone", () => {
  const valid = "4111 1111 1111 1111";
  const invalid = "1234567890123456";
  assert.ok(!redactText(`card: ${valid}`).includes("4111"));
  assert.ok(redactText(`orderId: ${invalid}`).includes(invalid), "a non-card-shaped digit run must not be mangled");
});

test("redactText: redacts an SSN-shaped string", () => {
  const out = redactText("ssn on file: 078-05-1120");
  assert.ok(!out.includes("078-05-1120"));
});

test("snippet: a response body that trips the sensitive-data circuit breaker never survives into the truncated evidence snippet", () => {
  const body = JSON.stringify({ orderId: "99", creditCard: "4111 1111 1111 1111" });
  const result = snippet(body);
  assert.ok(!result.includes("4111 1111 1111 1111"));
});
