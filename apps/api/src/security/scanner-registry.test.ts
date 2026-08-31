import test from "node:test";
import assert from "node:assert/strict";
import {
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
