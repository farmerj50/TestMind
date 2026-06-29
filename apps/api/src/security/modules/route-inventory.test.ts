import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRouteContracts,
  normalizeRoutePath,
  suggestApiSecurityFixtures,
} from "./route-inventory.js";
import type { IntelligentSecurityScanConfig, RouteInventoryItem } from "../types.js";

const baseConfig: IntelligentSecurityScanConfig = {
  jobId: "job_1",
  projectId: "project_1",
  baseUrl: "https://example.test",
  allowedHosts: ["example.test"],
  allowedPorts: [443],
  maxDurationMinutes: 10,
  enableActive: false,
  safeMode: true,
  scanDepth: "standard",
};

test("normalizeRoutePath generalizes object identifiers", () => {
  assert.equal(normalizeRoutePath("https://example.test/api/orders/123?expand=true"), "/api/orders/:id");
  assert.equal(
    normalizeRoutePath("/api/users/550e8400-e29b-41d4-a716-446655440000"),
    "/api/users/:id"
  );
  assert.equal(normalizeRoutePath("/api/projects/cmiuvokgs00017k8cahewqak3"), "/api/projects/:id");
  assert.equal(normalizeRoutePath("/api/orders/{orderId}"), "/api/orders/:id");
  assert.equal(normalizeRoutePath("/api/users/:userId"), "/api/users/:id");
  assert.equal(normalizeRoutePath("/api/projects/[projectId]"), "/api/projects/:id");
});

test("buildRouteContracts infers protected API route controls", () => {
  const inventory: RouteInventoryItem[] = [
    {
      route: "/api/orders/:id",
      method: "GET",
      source: "openapi",
      url: "https://example.test/api/orders/123",
    },
    {
      route: "/marketing",
      method: "GET",
      source: "html",
      url: "https://example.test/marketing",
    },
  ];

  const contracts = buildRouteContracts(baseConfig, inventory);
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0]?.route, "/api/orders/:id");
  assert.equal(contracts[0]?.confidence, "heuristic");
  assert.ok(contracts[0]?.expectedControls.includes("auth_required"));
  assert.ok(contracts[0]?.expectedControls.includes("object_owner_required"));
});

test("buildRouteContracts preserves declared fixture controls", () => {
  const config: IntelligentSecurityScanConfig = {
    ...baseConfig,
    apiFixtures: [
      {
        route: "/api/admin/users",
        method: "DELETE",
        expectedControls: ["auth_required", "role_admin_required"],
        expectedDenyStatuses: [403],
      },
    ],
  };
  const inventory: RouteInventoryItem[] = [
    {
      route: "/api/admin/users",
      method: "DELETE",
      source: "fixture",
      url: "https://example.test/api/admin/users",
    },
  ];

  const contracts = buildRouteContracts(config, inventory);
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0]?.confidence, "declared");
  assert.deepEqual(contracts[0]?.expectedDenyStatuses, [403]);
  assert.ok(contracts[0]?.expectedControls.includes("role_admin_required"));
});

test("buildRouteContracts treats deep heuristic API routes as anomaly targets", () => {
  const inventory: RouteInventoryItem[] = [
    {
      route: "/api/me",
      method: "GET",
      source: "heuristic",
      url: "https://example.test/api/me",
    },
  ];

  const contracts = buildRouteContracts({ ...baseConfig, scanDepth: "deep" }, inventory);
  assert.equal(contracts.length, 1);
  assert.equal(contracts[0]?.source, "heuristic");
  assert.equal(contracts[0]?.confidence, "heuristic");
  assert.ok(contracts[0]?.expectedControls.includes("auth_required"));
});

test("suggestApiSecurityFixtures proposes object access contracts and skips existing fixtures", () => {
  const inventory: RouteInventoryItem[] = [
    {
      route: "/api/orders/:id",
      method: "GET",
      source: "openapi",
      url: "https://example.test/api/orders/{id}",
    },
    {
      route: "/api/admin/users",
      method: "DELETE",
      source: "openapi",
      url: "https://example.test/api/admin/users",
    },
  ];

  const suggestions = suggestApiSecurityFixtures(baseConfig, inventory);
  assert.equal(suggestions.length, 2);
  assert.equal(suggestions[0]?.route, "/api/orders/:id");
  assert.equal(suggestions[0]?.objectIdRequired, true);
  assert.ok(suggestions[0]?.expectedControls?.includes("object_owner_required"));

  const withExisting = suggestApiSecurityFixtures(
    {
      ...baseConfig,
      apiFixtures: [{ route: "/api/orders/:id", method: "GET" }],
    },
    inventory
  );
  assert.equal(withExisting.length, 1);
  assert.equal(withExisting[0]?.route, "/api/admin/users");
});
