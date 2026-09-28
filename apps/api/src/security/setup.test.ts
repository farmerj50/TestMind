import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeSecurityTestSetup,
  parseSecurityTestSetup,
  securityTestSetupSchema,
} from "./setup.js";
import { buildAuthHeaders } from "./auth-headers.js";

test("saved setup rejects raw credentials", () => {
  const result = securityTestSetupSchema.safeParse({
    authProfiles: [{ label: "Owner", type: "bearer", token: "raw-token" }],
  });
  assert.equal(result.success, false);
});

test("saved setup accepts secret-key auth profiles and object fixtures", () => {
  const result = securityTestSetupSchema.safeParse({
    authProfiles: [{ label: "Owner", role: "user", type: "bearer", tokenSecretKey: "OWNER_TOKEN" }],
    apiFixtures: [
      {
        route: "/api/orders/:id",
        ownerProfile: "Owner",
        ownerObjectId: "ord_1",
        expectedControls: ["auth_required", "object_owner_required"],
      },
    ],
  });
  assert.equal(result.success, true);
  assert.equal(result.success && result.data.authProfiles[0]?.tokenSecretKey, "OWNER_TOKEN");
});

// Regression test: additionalHeaders was already a real field on SecurityAuthProfile (used by
// buildAuthHeaders, which every scanner module calls), but securityAuthProfileSchema never
// accepted it - a manually-configured profile submitted through the normal setup/scan-start API
// had it silently stripped (zod drops unknown keys by default), so the only way to actually get
// a custom header onto a profile was the separate Burp/cURL-paste capture flow.
test("saved setup accepts a custom header on a manually-configured auth profile", () => {
  const result = securityTestSetupSchema.safeParse({
    authProfiles: [
      {
        label: "Owner",
        type: "bearer",
        tokenSecretKey: "OWNER_TOKEN",
        additionalHeaders: { "X-Bypass-Secret": "abc123" },
      },
    ],
  });
  assert.equal(result.success, true);
  assert.deepEqual(
    result.success ? result.data.authProfiles[0]?.additionalHeaders : undefined,
    { "X-Bypass-Secret": "abc123" }
  );
});

test("saved setup accepts a custom header on a profile with no auth at all", () => {
  const result = securityTestSetupSchema.safeParse({
    authProfiles: [
      { label: "Anonymous", type: "none", additionalHeaders: { "X-Bypass-Secret": "abc123" } },
    ],
  });
  assert.equal(result.success, true);
});

test("buildAuthHeaders merges additionalHeaders in regardless of auth type", () => {
  const noneProfile = { label: "Anonymous", type: "none" as const, additionalHeaders: { "X-Bypass-Secret": "abc123" } };
  assert.deepEqual(buildAuthHeaders(noneProfile), { "X-Bypass-Secret": "abc123" });

  const bearerProfile = {
    label: "Owner",
    type: "bearer" as const,
    token: "real-token",
    additionalHeaders: { "X-Bypass-Secret": "abc123" },
  };
  assert.deepEqual(buildAuthHeaders(bearerProfile), {
    Authorization: "Bearer real-token",
    "X-Bypass-Secret": "abc123",
  });
});

test("mergeSecurityTestSetup lets per-run overrides replace saved profiles and fixtures", () => {
  const saved = parseSecurityTestSetup({
    authProfiles: [{ label: "Owner", role: "user", type: "bearer", tokenSecretKey: "OWNER_TOKEN" }],
    apiFixtures: [{ route: "/api/orders/:id", method: "GET", ownerObjectId: "ord_1" }],
    expectedControls: ["auth_required"],
  });

  const merged = mergeSecurityTestSetup(saved, {
    authProfiles: [{ label: "Owner", role: "admin", type: "bearer", tokenSecretKey: "ADMIN_TOKEN" }],
    apiFixtures: [{ route: "/api/orders/:id", method: "GET", ownerObjectId: "ord_2" }],
    expectedControls: ["object_owner_required"],
  });

  assert.equal(merged.authProfiles.length, 1);
  assert.equal(merged.authProfiles[0]?.role, "admin");
  assert.equal(merged.apiFixtures.length, 1);
  assert.equal(merged.apiFixtures[0]?.ownerObjectId, "ord_2");
  assert.deepEqual(merged.expectedControls.sort(), ["auth_required", "object_owner_required"].sort());
});
