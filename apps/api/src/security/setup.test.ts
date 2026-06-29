import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeSecurityTestSetup,
  parseSecurityTestSetup,
  securityTestSetupSchema,
} from "./setup.js";

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
