import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSecurityFindingDetail,
  buildSecurityRegressionTest,
} from "./security-finding-detail.js";

test("buildSecurityFindingDetail returns structured defensive analysis for header findings", () => {
  const detail = buildSecurityFindingDetail({
    title: "Missing security header: content-security-policy",
    severity: "high",
    type: "dynamic",
    location: "https://example.com",
    tool: "header-check",
    description: "Header content-security-policy not present on response",
  });

  assert.equal(detail.affectedAsset, "https://example.com");
  assert.equal(detail.confidence.label, "high");
  assert.match(detail.summary, /hardening/i);
  assert.ok(detail.evidence.some((line) => line.includes("header-check")));
  assert.ok(detail.safeVerificationSteps.length > 0);
  assert.ok(detail.recommendedFix.length > 0);
});

test("buildSecurityFindingDetail extracts CVE identifiers from dependency findings", () => {
  const detail = buildSecurityFindingDetail({
    title: "axios vulnerable to SSRF (CVE-2024-39338)",
    severity: "high",
    type: "dependency",
    location: "package-lock.json",
    tool: "npm-audit",
    description: "Upgrade axios to a fixed version.",
  });

  assert.equal(detail.cve, "CVE-2024-39338");
  assert.equal(detail.confidence.score, 95);
});

test("buildSecurityRegressionTest generates focused method regression checks", () => {
  const source = buildSecurityRegressionTest({
    title: "TRACE/TRACK method enabled",
    severity: "medium",
    type: "dynamic",
    location: "https://example.com",
    tool: "dast-options",
  });

  assert.match(source, /OPTIONS/);
  assert.match(source, /TRACE/);
  assert.match(source, /TRACK/);
});
