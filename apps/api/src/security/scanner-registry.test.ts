import test from "node:test";
import assert from "node:assert/strict";
import {
  builtInSecurityScanners,
  runSecurityScannerPhase,
  scannerMetadata,
  securityScannersForPhase,
  type SecurityScannerContext,
  type SecurityScannerExecutionResult,
} from "./scanner-registry.js";

function makeContext(overrides: Partial<SecurityScannerContext> = {}): SecurityScannerContext {
  const payload = {
    jobId: "scan-1",
    projectId: "project-1",
    baseUrl: "https://example.test",
    allowedHosts: ["example.test"],
    allowedPorts: [],
    maxDurationMinutes: 5,
    enableActive: false,
    scanDepth: "standard" as const,
    ...(overrides.payload ?? {}),
  };
  const intelligentConfig = { ...payload, authProfiles: [] } as any;
  return {
    payload,
    payloadWithAuth: intelligentConfig,
    scope: { allowedHosts: payload.allowedHosts, allowedPorts: payload.allowedPorts },
    authProfiles: [],
    intelligentConfig,
    validationConfig: intelligentConfig,
    routeContracts: [],
    apiSpec: null,
    ...overrides,
  };
}

test("openapi scanner only supports jobs with a parsed API spec", () => {
  const withoutSpec = securityScannersForPhase(makeContext(), "openapi_scan").map((scanner) => scanner.id);
  assert.deepEqual(withoutSpec, []);

  const withSpec = securityScannersForPhase(
    makeContext({
      apiSpec: {
        title: "Example API",
        version: "1.0.0",
        endpoints: [],
      },
    }),
    "openapi_scan"
  ).map((scanner) => scanner.id);

  assert.deepEqual(withSpec, ["openapi-scan"]);
});

test("advanced scanner phase exposes typed metadata for policy-aware orchestration", () => {
  const scanners = securityScannersForPhase(makeContext(), "advanced_analysis");
  assert.deepEqual(
    scanners.map((scanner) => scanner.id),
    ["jwt-analyzer", "idor-engine", "race-condition"]
  );
  assert.deepEqual(
    scanners.map((scanner) => scanner.risk),
    ["low", "medium", "high"]
  );
});

test("open-source scanner phase follows selected tool ids", () => {
  const legacyScanners = securityScannersForPhase(makeContext(), "open_source_tools");
  assert.deepEqual(legacyScanners.map((scanner) => scanner.id), ["nuclei"]);

  const selectedScanners = securityScannersForPhase(
    makeContext({
      payload: {
        jobId: "scan-1",
        projectId: "project-1",
        baseUrl: "https://example.test",
        allowedHosts: ["example.test"],
        allowedPorts: [],
        maxDurationMinutes: 5,
        enableActive: false,
        scanDepth: "standard",
        openSourceToolIds: ["nuclei", "zap-baseline"],
      },
    }),
    "open_source_tools"
  );
  assert.deepEqual(
    selectedScanners.map((scanner) => scanner.id),
    ["nuclei", "zap-baseline"]
  );
  assert.deepEqual(
    selectedScanners.map((scanner) => scanner.source),
    ["open_source", "open_source"]
  );
});

test("unsupported scanner phases do not invoke scanners", async () => {
  const results = await runSecurityScannerPhase(makeContext(), "intelligent_validation");
  assert.deepEqual(results, []);
});

// Regression test for a real, confirmed bug: 3 of 14 built-in scanners (intelligent-validation,
// graphql-audit, anomaly-baseline) were missing continueOnError: true. runSecurityScannerPhase's
// catch block re-throws when a scanner lacks this flag, which propagates all the way out of
// runScanPipeline and skips its single, end-of-pipeline addFindings() call - silently discarding
// every finding already gathered from every phase that completed before the throw. Asserting this
// for every registered scanner (not just the 3 fixed) also catches a future scanner being added
// without the flag, not just today's fix.
test("every built-in scanner sets continueOnError so one scanner's failure can never discard the whole scan's findings", () => {
  const missing = builtInSecurityScanners.filter((scanner) => scanner.continueOnError !== true).map((scanner) => scanner.id);
  assert.deepEqual(missing, []);
});

test("scannerMetadata returns metadata for one scanner result", () => {
  const results: SecurityScannerExecutionResult[] = [
    {
      scannerId: "js-endpoint-extractor",
      scannerName: "JavaScript endpoint extraction",
      phase: "js_analysis",
      category: "passive",
      risk: "low",
      source: "testmind",
      durationMs: 12,
      findings: [],
      metadata: { discoveredEndpoints: ["/api/me"], discoveredEndpointCount: 1 },
    },
  ];

  const metadata = scannerMetadata<{ discoveredEndpoints: string[]; discoveredEndpointCount: number }>(
    results,
    "js-endpoint-extractor"
  );
  assert.deepEqual(metadata?.discoveredEndpoints, ["/api/me"]);
  assert.equal(metadata?.discoveredEndpointCount, 1);
});
