import test from "node:test";
import assert from "node:assert/strict";
import {
  requiresProductionApproval,
  requiresAutonomousScanApproval,
  shouldDowngradeToPassive,
} from "./security-approval-policy.js";

test("requiresProductionApproval truth table", () => {
  const cases: Array<[Parameters<typeof requiresProductionApproval>[0], boolean]> = [
    [{ environment: "prod", scanDepth: "standard", enableActive: true }, true],
    [{ environment: "prod", scanDepth: "deep", enableActive: false }, true],
    [{ environment: "prod", scanDepth: "baseline", enableActive: false, safeMode: false }, true],
    [{ environment: "stage", scanDepth: "deep", enableActive: true }, false],
    [{ environment: "qa", scanDepth: "deep", enableActive: true }, false],
    [{ environment: "dev", scanDepth: "deep", enableActive: true, safeMode: false }, false],
    [{ environment: "prod", scanDepth: "baseline", enableActive: false }, false],
    [{ environment: "prod", scanDepth: "baseline", enableActive: false, safeMode: true }, false],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      requiresProductionApproval(input),
      expected,
      `expected ${JSON.stringify(input)} -> ${expected}`
    );
  }
});

test("requiresAutonomousScanApproval is deliberately stricter than requiresProductionApproval", () => {
  // Same inputs, both predicates - autonomous approval must never be looser than the
  // production-only rule (its whole purpose is to be at least as strict, usually stricter).
  const cases: ScanApprovalInputLike[] = [
    { environment: "dev", scanDepth: "standard", enableActive: true },
    { environment: "dev", scanDepth: "deep", enableActive: false },
    { environment: "stage", scanDepth: "baseline", enableActive: false, safeMode: false },
    { environment: "prod", scanDepth: "baseline", enableActive: false },
    { environment: "prod", scanDepth: "standard", enableActive: true },
    { environment: "dev", scanDepth: "baseline", enableActive: false },
  ];
  for (const input of cases) {
    const prod = requiresProductionApproval(input as any);
    const autonomous = requiresAutonomousScanApproval(input as any);
    assert.ok(
      autonomous || !prod,
      `requiresAutonomousScanApproval must be true whenever requiresProductionApproval is, for ${JSON.stringify(input)}`
    );
  }

  // Concrete case where they actually differ: a non-prod active scan is fine for the
  // production-only rule but must still require approval for an autonomous trigger.
  const nonProdActive = { environment: "dev" as const, scanDepth: "standard" as const, enableActive: true };
  assert.equal(requiresProductionApproval(nonProdActive), false);
  assert.equal(requiresAutonomousScanApproval(nonProdActive), true);

  // And a passive prod scan: fine for the production-only rule, still needs approval
  // autonomously (any prod scan at all).
  const passiveProd = { environment: "prod" as const, scanDepth: "baseline" as const, enableActive: false };
  assert.equal(requiresProductionApproval(passiveProd), false);
  assert.equal(requiresAutonomousScanApproval(passiveProd), true);
});

type ScanApprovalInputLike = {
  environment: "dev" | "qa" | "stage" | "prod";
  scanDepth: "baseline" | "standard" | "deep";
  enableActive: boolean;
  safeMode?: boolean;
};

// security-worker.ts's runDynamic imports this exact function as its defense-in-depth
// backstop before running active checks - testing it here covers that behavior without
// importing security-worker.ts itself (which would start a real BullMQ Worker/Redis
// connection as a module-load side effect).
test("shouldDowngradeToPassive: downgrades a prod-active scan with no recorded approval", () => {
  assert.equal(
    shouldDowngradeToPassive({ environment: "prod", scanDepth: "standard", enableActive: true }),
    true
  );
});

test("shouldDowngradeToPassive: does not downgrade once approvalGranted is set", () => {
  assert.equal(
    shouldDowngradeToPassive({
      environment: "prod",
      scanDepth: "standard",
      enableActive: true,
      approvalGranted: true,
    }),
    false
  );
});

test("shouldDowngradeToPassive: does not downgrade a non-prod active scan (never needed approval)", () => {
  assert.equal(
    shouldDowngradeToPassive({ environment: "dev", scanDepth: "standard", enableActive: true }),
    false
  );
});
