import test from "node:test";
import assert from "node:assert/strict";
import { scanForSensitiveData } from "./sensitive-data.js";

// Live Security Testing v1, Ticket LST.1's classifier. Pure, no IO, no DB - real Luhn-valid
// card numbers and real-shaped tokens/SSNs used as fixtures, never live secrets.

test("scanForSensitiveData: flags nothing for ordinary, non-sensitive JSON", () => {
  const result = scanForSensitiveData(JSON.stringify({ name: "Alice", id: 42, city: "Seattle" }));
  assert.equal(result.sensitive, false);
  assert.deepEqual(result.matches, []);
});

test("scanForSensitiveData: flags nothing for an empty body", () => {
  assert.deepEqual(scanForSensitiveData(""), { sensitive: false, matches: [] });
});

test("scanForSensitiveData: detects a credential-named JSON key", () => {
  const result = scanForSensitiveData(JSON.stringify({ password: "hunter2", username: "alice" }));
  assert.equal(result.sensitive, true);
  assert.ok(result.matches.some((m) => m.category === "credential" && m.fieldName === "password"));
  // The username field itself isn't a secret-named key, so it must not be flagged.
  assert.ok(!result.matches.some((m) => m.fieldName === "username"));
});

test("scanForSensitiveData: detects a credential-shaped key=value pair in non-JSON text", () => {
  const result = scanForSensitiveData("Set-Cookie response included token=abcdef1234567890 in the body");
  assert.equal(result.sensitive, true);
  assert.ok(result.matches.some((m) => m.category === "credential"));
});

test("scanForSensitiveData: detects a JWT-shaped string", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const result = scanForSensitiveData(`{"accessToken": "${jwt}"}`);
  assert.equal(result.sensitive, true);
  assert.ok(result.matches.some((m) => m.category === "jwt"));
});

test("scanForSensitiveData: detects a Luhn-valid credit card number, with and without separators", () => {
  const valid = "4111111111111111"; // well-known Luhn-valid Visa test number
  assert.ok(scanForSensitiveData(`card: ${valid}`).matches.some((m) => m.category === "credit_card"));
  assert.ok(scanForSensitiveData(`card: 4111-1111-1111-1111`).matches.some((m) => m.category === "credit_card"));
});

test("scanForSensitiveData: does NOT flag a Luhn-invalid long digit run as a credit card", () => {
  // Same length as a real card number but fails the Luhn checksum - an order/tracking number
  // shape, not a real card, so it must not false-positive.
  const invalid = "1234567890123456";
  const result = scanForSensitiveData(`orderId: ${invalid}`);
  assert.ok(!result.matches.some((m) => m.category === "credit_card"));
});

test("scanForSensitiveData: detects an SSN-shaped string", () => {
  const result = scanForSensitiveData("ssn on file: 078-05-1120");
  assert.equal(result.sensitive, true);
  assert.ok(result.matches.some((m) => m.category === "ssn"));
});

test("scanForSensitiveData: does NOT flag a bare 9-digit number (no dashes) as an SSN - too generic on its own", () => {
  const result = scanForSensitiveData("trackingNumber: 078051120");
  assert.ok(!result.matches.some((m) => m.category === "ssn"));
});

test("scanForSensitiveData: reports every category present, not just the first match", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  // Stays valid JSON throughout: apiSecret is caught by the JSON key-name walk, while the JWT/
  // card/SSN substrings inside the string values are still caught verbatim by the always-run
  // text-shape scan regardless of JSON-parseability.
  const body = JSON.stringify({
    apiSecret: "abc",
    accessToken: jwt,
    backupCard: "4111 1111 1111 1111",
    onFile: "078-05-1120",
  });
  const categories = new Set(scanForSensitiveData(body).matches.map((m) => m.category));
  assert.deepEqual(categories, new Set(["credential", "jwt", "credit_card", "ssn"]));
});
