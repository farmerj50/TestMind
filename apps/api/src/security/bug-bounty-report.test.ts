import test from "node:test";
import assert from "node:assert/strict";
import { generateBugBountyReport } from "./bug-bounty-report.js";

// Reproduction traceability, Ticket TRC.4: pocSteps() (exercised via generateBugBountyReport's
// public stepsToReproduce field) must never emit the old placeholder literals (OBJECT_ID,
// user A, INPUT) that appeared on every real finding before the fix, because it read evidence
// field names that don't exist on SecurityFindingEvidence's real shape.

const PLACEHOLDER_LITERALS = ["OBJECT_ID", "user A", "user B", "INPUT", "TARGET_ENDPOINT"];

function assertNoPlaceholders(steps: string[]) {
  const joined = steps.join(" | ");
  for (const literal of PLACEHOLDER_LITERALS) {
    assert.ok(!joined.includes(literal), `steps must not contain the placeholder literal "${literal}": ${joined}`);
  }
}

test("generateBugBountyReport: uses the finding's real reproductionSteps directly when present", () => {
  const finding = {
    id: "f1",
    title: "IDOR on order lookup",
    severity: "high",
    location: "https://target.example.com/api/orders/42",
    tool: "idor-engine",
    evidence: {
      vulnerabilityClass: "broken_object_level_authorization",
      reproductionSteps: [
        "1. Send GET https://target.example.com/api/orders/42 as owner; observe status 200.",
        "2. Send GET https://target.example.com/api/orders/42 as lowerPrivilege; observe status 200.",
        "", // blank entries must be dropped
        "1. Send GET https://target.example.com/api/orders/42 as owner; observe status 200.", // exact duplicate must be deduped
      ],
    },
  };
  const report = generateBugBountyReport(finding, "https://target.example.com");
  assert.equal(report.stepsToReproduce.length, 2);
  assert.ok(report.stepsToReproduce[0].includes("/api/orders/42"));
  assertNoPlaceholders(report.stepsToReproduce);
});

test("generateBugBountyReport: without reproductionSteps, builds real steps from requestResponse - no placeholder literals", () => {
  const finding = {
    id: "f2",
    title: "Broken object level authorization on /api/accounts/:id",
    severity: "high",
    location: "https://target.example.com/api/accounts/42",
    tool: "idor-engine",
    evidence: {
      vulnerabilityClass: "broken_object_level_authorization",
      requestResponse: [
        { method: "GET", url: "https://target.example.com/api/accounts/42", profile: "owner", status: 200 },
        { method: "GET", url: "https://target.example.com/api/accounts/42", profile: "otherUser", status: 200 },
      ],
    },
  };
  const report = generateBugBountyReport(finding, "https://target.example.com");
  assert.ok(report.stepsToReproduce.some((s) => s.includes("GET https://target.example.com/api/accounts/42 as owner")));
  assert.ok(report.stepsToReproduce.some((s) => s.includes("as otherUser")));
  assert.ok(report.stepsToReproduce.some((s) => s.includes("HTTP 200")));
  assertNoPlaceholders(report.stepsToReproduce);
});

test("generateBugBountyReport: a sparse finding (no reproductionSteps, no requestResponse) still produces valid, placeholder-free steps without throwing", () => {
  const finding = {
    id: "f3",
    title: "Security misconfiguration",
    severity: "medium",
    location: "https://target.example.com/admin",
    tool: "code-review",
    evidence: { vulnerabilityClass: "security_misconfiguration" },
  };
  assert.doesNotThrow(() => generateBugBountyReport(finding, "https://target.example.com"));
  const report = generateBugBountyReport(finding, "https://target.example.com");
  assert.ok(report.stepsToReproduce.length > 0);
  assertNoPlaceholders(report.stepsToReproduce);
  assert.ok(report.stepsToReproduce.some((s) => s.includes("https://target.example.com/admin")));
});

test("generateBugBountyReport: a finding with no evidence at all still produces valid, placeholder-free steps without throwing", () => {
  const finding = { id: "f4", title: "Unknown finding", severity: "low" };
  assert.doesNotThrow(() => generateBugBountyReport(finding, "https://target.example.com"));
  const report = generateBugBountyReport(finding, "https://target.example.com");
  assert.ok(report.stepsToReproduce.length > 0);
  assertNoPlaceholders(report.stepsToReproduce);
});
