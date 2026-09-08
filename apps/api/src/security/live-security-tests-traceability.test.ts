import test from "node:test";
import assert from "node:assert/strict";
import { findSupportingProbes } from "./live-security-tests.js";
import type { LiveSecurityCheck, LiveSecurityProbe } from "./live-security-tests.js";
import type { ProbeResult } from "./http-client.js";

// Reproduction traceability, Ticket TRC.1: findSupportingProbes must never guess a single probe
// when multiple genuinely match - and must never be fooled by a URL collision when the finding's
// own evidence records a method/mutation that disambiguates it.

function probeResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return { method: "GET", url: "https://example.invalid/x", body: "", bodyLength: 0, bodySnippet: "", headers: {}, ...overrides };
}

function probe(label: string, overrides: Partial<ProbeResult> = {}): LiveSecurityProbe {
  return { label, result: probeResult(overrides) };
}

function check(id: string, evidence: Record<string, unknown>): LiveSecurityCheck {
  return { id, title: id, status: "failed", severity: "high", vulnerabilityClass: "x", owaspCategory: "x", description: "x", evidence };
}

test("findSupportingProbes: idor-url-mutation matches by exact url when only one probe hit it", () => {
  const probes = [
    probe("alternate ID probe", { url: "https://example.invalid/orders/99" }),
    probe("alternate ID probe", { url: "https://example.invalid/orders/101" }),
  ];
  const c = check("idor-url-mutation", { probes: [{ url: "https://example.invalid/orders/99", method: "GET" }] });
  const matched = findSupportingProbes(c, probes);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].result.url, "https://example.invalid/orders/99");
});

test("findSupportingProbes: a URL collision between two probes is disambiguated by method, not guessed", () => {
  // Two probes hit the exact same URL - one a GET (e.g. from the benign marker probe), one a
  // PUT (the real IDOR mutation probe, per LST.4's method preservation). The finding's own
  // evidence records PUT: the helper must return only the PUT probe, never the GET one, and
  // never both just because the URL alone matched.
  const probes = [
    probe("benign query marker probe", { url: "https://example.invalid/orders/99", method: "GET" }),
    probe("alternate ID probe", { url: "https://example.invalid/orders/99", method: "PUT" }),
  ];
  const c = check("idor-url-mutation", { probes: [{ url: "https://example.invalid/orders/99", method: "PUT" }] });
  const matched = findSupportingProbes(c, probes);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].label, "alternate ID probe");
  assert.equal(matched[0].result.method, "PUT");
});

test("findSupportingProbes: a URL collision with no method recorded on the evidence returns every matching probe, not a guess", () => {
  const probes = [
    probe("alternate ID probe", { url: "https://example.invalid/orders/99", method: "GET" }),
    probe("alternate ID probe", { url: "https://example.invalid/orders/99", method: "PUT" }),
  ];
  // No method on the evidence entry this time - genuinely ambiguous, so both must come back.
  const c = check("idor-url-mutation", { probes: [{ url: "https://example.invalid/orders/99" }] });
  const matched = findSupportingProbes(c, probes);
  assert.equal(matched.length, 2);
});

test("findSupportingProbes: sensitive-data-stop matches by its correlation key (evidence.probe), not URL", () => {
  const probes = [
    probe("HEAD method probe", { url: "https://example.invalid/orders/100" }),
    probe("alternate ID probe", { url: "https://example.invalid/orders/99" }),
  ];
  const c = check("sensitive-data-stop", { probe: "alternate ID probe", url: "https://example.invalid/orders/99" });
  const matched = findSupportingProbes(c, probes);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].label, "alternate ID probe");
});

test("findSupportingProbes: derived-detail-auth checks match both the authenticated and unauthenticated probe for the same derived url", () => {
  const url = "https://example.invalid/orders/8721";
  const probes = [probe("authenticated detail probe", { url }), probe("unauthenticated detail probe", { url })];
  const c = check(`derived-detail-auth:${url}`, {});
  const matched = findSupportingProbes(c, probes);
  assert.equal(matched.length, 2);
});

test("findSupportingProbes: falls back to label matching when evidence carries no URL at all, returning every repeat", () => {
  const probes = [
    probe("unauthenticated replay", { url: "https://example.invalid/orders/100" }),
    probe("unauthenticated replay validation", { url: "https://example.invalid/orders/100" }),
    probe("unauthenticated replay reproduction", { url: "https://example.invalid/orders/100" }),
  ];
  const c = check("unauthenticated-direct-access", { removedHeaders: ["cookie"], unauthStatus: 200 });
  const matched = findSupportingProbes(c, probes);
  assert.equal(matched.length, 3, "all three repeated proofs genuinely support the same finding");
});

test("findSupportingProbes: returns an empty array rather than throwing when nothing matches", () => {
  const c = check("unknown-check-id", {});
  assert.deepEqual(findSupportingProbes(c, []), []);
});
