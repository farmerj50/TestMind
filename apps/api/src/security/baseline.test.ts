import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSecurityBehaviorBaseline,
  compareSecurityBehaviorBaseline,
  securityBaselineScopeKey,
} from "./baseline.js";
import type { AuthMatrixResult } from "./types.js";

function matrix(status: number): AuthMatrixResult[] {
  return [
    {
      route: "/api/orders/:id",
      method: "GET",
      source: "fixture",
      controls: ["auth_required", "object_owner_required"],
      confidence: "declared",
      objectSwap: true,
      passCount: 1,
      failCount: 0,
      inconclusiveCount: 0,
      probes: [
        {
          label: "other_on_owner_object",
          expected: "deny",
          passed: status === 403,
          profile: "Account B",
          objectId: "order_1",
          signals: [],
          evidence: {
            label: "other_on_owner_object",
            method: "GET",
            url: "https://app.test/api/orders/order_1",
            profile: "Account B",
            status,
            bodyLength: status === 200 ? 240 : 0,
          },
        },
      ],
    },
  ];
}

test("securityBaselineScopeKey scopes by environment and origin", () => {
  assert.equal(
    securityBaselineScopeKey("qa", "https://app.test/path"),
    "qa|https://app.test"
  );
});

test("compareSecurityBehaviorBaseline flags denied-to-allowed drift", () => {
  const approved = {
    ...buildSecurityBehaviorBaseline({
      projectId: "project_1",
      sourceScanId: "scan_1",
      baseUrl: "https://app.test",
      environment: "qa",
      authMatrix: matrix(403),
    }),
    approvedAt: "2026-01-01T00:00:00.000Z",
  };
  const current = buildSecurityBehaviorBaseline({
    projectId: "project_1",
    sourceScanId: "scan_2",
    baseUrl: "https://app.test",
    environment: "qa",
    authMatrix: matrix(200),
  });

  const result = compareSecurityBehaviorBaseline(approved, current);
  assert.equal(result.summary.baselinePresent, true);
  assert.equal(result.summary.deniedToAllowed, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.title, "Security Behavior Drift");
});
