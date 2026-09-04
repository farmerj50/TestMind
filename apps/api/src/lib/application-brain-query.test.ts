import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { getApplicationBrainSnapshot } from "./application-brain-query.js";
import { applyApplicationModelMerge } from "./application-model-store.js";
import { computeApplicationModelUpdate, computeApiUpdate, upsertTestLink, setWorkflow, normalizeRouteHint } from "./application-model.js";

// Ticket AB.2 - integration tests for the read-only query layer. Seeds real TestCase/
// SecurityFinding rows covering every shape the design has to handle (linked vs inferred
// coverage, both inference sources, and URL-shaped vs non-URL-shaped finding locations).

const prisma = new PrismaClient();

async function withScratchProject(run: (projectId: string) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-ab2-query", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  try {
    await run(project.id);
  } finally {
    await prisma.securityFinding.deleteMany({ where: { scan: { projectId: project.id } } });
    await prisma.securityScanJob.deleteMany({ where: { projectId: project.id } });
    await prisma.testCase.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
  }
}

test.after(() => prisma.$disconnect());

test("getApplicationBrainSnapshot returns the Brain's own stored facts (pages, apis, identities, resources)", async () => {
  await withScratchProject(async (projectId) => {
    await applyApplicationModelMerge(projectId, (store) =>
      computeApplicationModelUpdate(store, { "/checkout": [{ selector: "#pay", fields: [{ name: "cardNumber" }] }] }, "2026-01-01T00:00:00.000Z").next
    );
    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.ok(snapshot.store.pages["/checkout"]);
    assert.deepEqual(snapshot.store.apis, {});
    assert.deepEqual(snapshot.coverage, []);
    assert.deepEqual(snapshot.qaFailures, []);
  });
});

test("coverage: a TestCase linked via testLinks is reported with confidence 'linked'", async () => {
  await withScratchProject(async (projectId) => {
    const tc = await prisma.testCase.create({
      data: { projectId, key: crypto.randomUUID(), title: "checkout works", lastResultStatus: "passed" },
    });
    await applyApplicationModelMerge(projectId, (store) => upsertTestLink(store, tc.id, "/checkout", "2026-01-01T00:00:00.000Z"));

    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.equal(snapshot.coverage.length, 1);
    assert.equal(snapshot.coverage[0].confidence, "linked");
    assert.equal(snapshot.coverage[0].routeHint, "/checkout");
    assert.equal(snapshot.coverage[0].testCaseId, tc.id);
  });
});

test("coverage: a pre-Brain TestCase with a structured preconditions.route is reported as 'inferred' (url-inspector.ts shape)", async () => {
  await withScratchProject(async (projectId) => {
    await prisma.testCase.create({
      data: {
        projectId,
        key: crypto.randomUUID(),
        title: "login works",
        lastResultStatus: "passed",
        preconditions: JSON.stringify({ sourceUrl: "https://example.invalid/login", route: "/login", specPath: null }),
      },
    });
    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.equal(snapshot.coverage.length, 1);
    assert.equal(snapshot.coverage[0].confidence, "inferred");
    assert.equal(snapshot.coverage[0].routeHint, "/login");
  });
});

test("coverage: a pre-Brain TestCase with the discovery compound key is reported as 'inferred' (operator-worker.ts shape)", async () => {
  await withScratchProject(async (projectId) => {
    await prisma.testCase.create({
      data: {
        projectId,
        key: `discovery/${projectId}//settings#Settings page loads`,
        title: "settings page loads",
        lastResultStatus: "failed",
      },
    });
    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.equal(snapshot.coverage.length, 1);
    assert.equal(snapshot.coverage[0].confidence, "inferred");
    assert.equal(snapshot.coverage[0].routeHint, "/settings");
  });
});

test("coverage: a TestCase with no route info anywhere (persist-run-results.ts shape) is excluded, not guessed at", async () => {
  await withScratchProject(async (projectId) => {
    await prisma.testCase.create({
      data: { projectId, key: "orders.spec.ts#creates an order", title: "creates an order", lastResultStatus: "passed" },
    });
    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.equal(snapshot.coverage.length, 0);
  });
});

test("coverage: a link takes precedence over inference when both are available for the same TestCase", async () => {
  await withScratchProject(async (projectId) => {
    const tc = await prisma.testCase.create({
      data: {
        projectId,
        key: crypto.randomUUID(),
        title: "checkout works",
        lastResultStatus: "passed",
        preconditions: JSON.stringify({ route: "/wrong-inferred-route" }),
      },
    });
    await applyApplicationModelMerge(projectId, (store) => upsertTestLink(store, tc.id, "/checkout", "2026-01-01T00:00:00.000Z"));

    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.equal(snapshot.coverage.length, 1, "must not double-count the same case via both paths");
    assert.equal(snapshot.coverage[0].confidence, "linked");
    assert.equal(snapshot.coverage[0].routeHint, "/checkout");
  });
});

test("qaFailures: only failed/error TestCases are included, sourced from lastResultStatus/lastFailureMessage/lastHealedAt, separate from securityFindings", async () => {
  await withScratchProject(async (projectId) => {
    const passing = await prisma.testCase.create({
      data: { projectId, key: crypto.randomUUID(), title: "passes", lastResultStatus: "passed" },
    });
    const failing = await prisma.testCase.create({
      data: { projectId, key: crypto.randomUUID(), title: "fails", lastResultStatus: "failed", lastFailureMessage: "expected 200 got 500" },
    });
    await applyApplicationModelMerge(projectId, (store) =>
      upsertTestLink(upsertTestLink(store, passing.id, "/a", "2026-01-01T00:00:00.000Z"), failing.id, "/b", "2026-01-01T00:00:00.000Z")
    );

    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.equal(snapshot.coverage.length, 2, "both cases show up in coverage regardless of pass/fail");
    assert.equal(snapshot.qaFailures.length, 1, "only the failing one shows up in qaFailures");
    assert.equal(snapshot.qaFailures[0].testCaseId, failing.id);
    assert.equal(snapshot.qaFailures[0].lastFailureMessage, "expected 200 got 500");
    assert.deepEqual(snapshot.securityFindings.attributed, []);
    assert.deepEqual(snapshot.securityFindings.notAttributable, []);
  });
});

async function seedFinding(
  projectId: string,
  tool: string,
  location: string | null,
  title = "finding",
  validationStatus?: "confirmed" | "likely" | "suspected" | "inconclusive" | "not_exploitable" | "false_positive" | "not_applicable"
) {
  const scan = await prisma.securityScanJob.create({ data: { projectId, status: "completed" } });
  return prisma.securityFinding.create({
    data: { scanId: scan.id, type: "dynamic", severity: "medium", title, location, tool, validationStatus },
  });
}

test("securityFindings: URL-shaped tools with a real location are attributed to a routeHint", async () => {
  await withScratchProject(async (projectId) => {
    await seedFinding(projectId, "idor-engine", "https://example.invalid/api/orders/123", "IDOR on orders");
    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.equal(snapshot.securityFindings.attributed.length, 1);
    assert.equal(snapshot.securityFindings.attributed[0].routeHint, "/api/orders/123");
    assert.equal(snapshot.securityFindings.notAttributable.length, 0);
  });
});

test("securityFindings: non-URL-shaped tools (code-review, jwt-analyzer, subdomain-enum, graphql-audit) always land in notAttributable, never mis-route-matched", async () => {
  await withScratchProject(async (projectId) => {
    await seedFinding(projectId, "code-review", "apps/api/src/routes/security.ts:142", "hardcoded secret");
    await seedFinding(projectId, "jwt-analyzer", "jwt-payload-scan", "weak JWT signing");
    await seedFinding(projectId, "subdomain-enum", "example.com", "exposed subdomain");
    await seedFinding(projectId, "graphql-audit", "https://example.invalid/graphql → getUser(id: \"1\")", "GraphQL introspection");

    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.equal(snapshot.securityFindings.attributed.length, 0);
    assert.equal(snapshot.securityFindings.notAttributable.length, 4);
  });
});

test("securityFindings: a URL-shaped tool with a null location falls back to notAttributable rather than crashing", async () => {
  await withScratchProject(async (projectId) => {
    await seedFinding(projectId, "idor-engine", null, "finding with no location");
    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.equal(snapshot.securityFindings.attributed.length, 0);
    assert.equal(snapshot.securityFindings.notAttributable.length, 1);
  });
});

test("securityFindings and qaFailures are independent, additive fields answering the same acceptance question from different sources", async () => {
  await withScratchProject(async (projectId) => {
    const failing = await prisma.testCase.create({
      data: { projectId, key: crypto.randomUUID(), title: "fails", lastResultStatus: "error" },
    });
    await applyApplicationModelMerge(projectId, (store) => upsertTestLink(store, failing.id, "/checkout", "2026-01-01T00:00:00.000Z"));
    await seedFinding(projectId, "cors-audit", "https://example.invalid/checkout", "credentialed CORS");

    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.equal(snapshot.qaFailures.length, 1);
    assert.equal(snapshot.securityFindings.attributed.length, 1);
  });
});

// Ticket AB.3 - workflow coverage percentage: covered route hints / total declared route
// hints, with apiHints reported as a separate observed-count field, never blended into the
// percentage. See the frozen contract's exact wording under Ticket AB.3.

test("workflows: coveragePercent is covered routeHints / total declared routeHints, and apiHints are reported separately, not blended in", async () => {
  await withScratchProject(async (projectId) => {
    const tc = await prisma.testCase.create({
      data: { projectId, key: crypto.randomUUID(), title: "checkout works", lastResultStatus: "passed" },
    });
    await applyApplicationModelMerge(projectId, (store) => {
      const withLink = upsertTestLink(store, tc.id, "/cart", "2026-01-01T00:00:00.000Z");
      const withApi = computeApiUpdate(withLink, { "POST /api/orders": { method: "POST", path: "/api/orders" } }, "2026-01-01T00:00:00.000Z");
      return setWorkflow(withApi, "checkout", {
        name: "Checkout",
        riskTags: ["critical"],
        routeHints: ["/cart", "/checkout"],
        apiHints: ["POST /api/orders", "POST /api/refunds"],
      });
    });

    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.equal(snapshot.workflows.length, 1);
    const wf = snapshot.workflows[0];
    assert.equal(wf.key, "checkout");
    assert.equal(wf.coveredRouteHints, 1, "/cart is linked, /checkout is not");
    assert.equal(wf.totalRouteHints, 2);
    assert.equal(wf.coveragePercent, 50);
    assert.equal(wf.observedApiHints, 1, "POST /api/orders was observed, POST /api/refunds was not");
    assert.equal(wf.totalApiHints, 2);
  });
});

test("workflows: coveragePercent is null (not 0) for a workflow with zero declared routeHints", async () => {
  await withScratchProject(async (projectId) => {
    await applyApplicationModelMerge(projectId, (store) =>
      setWorkflow(store, "empty-workflow", { name: "Empty", riskTags: [], routeHints: [], apiHints: [] })
    );
    const snapshot = await getApplicationBrainSnapshot(projectId);
    assert.equal(snapshot.workflows.length, 1);
    assert.equal(snapshot.workflows[0].coveragePercent, null);
  });
});

// Autonomous Planner v1, Ticket AP.1 - regression test for a real bug found while grounding
// the Planner contract: index.ts's workflow CRUD handlers stored routeHints exactly as
// submitted, never normalized, while every other routeHint in the store (pages{} keys,
// coverage[].routeHint) is always run through normalizeRouteHint. A workflow author typing
// "/checkout/" (trailing slash) instead of "/checkout" made coveragePercent silently read low
// even though the route WAS actually covered. The fix moved normalization into index.ts's
// POST/PATCH handlers (setWorkflow itself stays a dumb store, unaware of the convention, same
// as before) - this test simulates that fixed call pattern directly (normalize, then
// setWorkflow) since there's no HTTP harness for index.ts's routes in this codebase.
test("AP.1 regression: a workflow routeHint is normalized before storage, so an unnormalized author input (trailing slash) still matches normalized coverage", async () => {
  await withScratchProject(async (projectId) => {
    const tc = await prisma.testCase.create({
      data: { projectId, key: crypto.randomUUID(), title: "checkout works", lastResultStatus: "passed" },
    });
    await applyApplicationModelMerge(projectId, (store) => upsertTestLink(store, tc.id, "/checkout", "2026-01-01T00:00:00.000Z"));

    // Simulates index.ts's fixed POST handler: normalize author-submitted routeHints before
    // calling setWorkflow, exactly like the real route now does.
    const authorSubmittedRouteHints = ["/checkout/"]; // trailing slash, as a human might type
    await applyApplicationModelMerge(projectId, (store) =>
      setWorkflow(store, "checkout", {
        name: "Checkout",
        riskTags: [],
        routeHints: authorSubmittedRouteHints.map(normalizeRouteHint),
        apiHints: [],
      })
    );

    const snapshot = await getApplicationBrainSnapshot(projectId);
    const wf = snapshot.workflows.find((w) => w.key === "checkout");
    assert.ok(wf);
    assert.deepEqual(wf!.routeHints, ["/checkout"], "the stored routeHint must be normalized, not the raw author input");
    assert.equal(wf!.coveragePercent, 100, "an unnormalized author input must still correctly match the normalized coverage entry");
  });
});

// Ticket VR.2 (Validation + Regression v1) - validationStatus surfaced through the Brain query,
// for both the attributed and notAttributable branches, including the untriaged (null) default.
// Never blended into any score - Autonomous Planner v1's formula is untouched (see
// autonomous-planner.test.ts's severity-only assertions, unaffected by this addition).
test("securityFindings: validationStatus is carried through for both attributed and notAttributable findings, including untriaged (null)", async () => {
  await withScratchProject(async (projectId) => {
    await seedFinding(projectId, "idor-engine", "https://example.invalid/api/orders/123", "attributed, confirmed", "confirmed");
    await seedFinding(projectId, "idor-engine", "https://example.invalid/api/cart", "attributed, untriaged");
    await seedFinding(projectId, "code-review", "apps/api/src/index.ts:1", "notAttributable, false_positive", "false_positive");
    await seedFinding(projectId, "code-review", "apps/api/src/index.ts:2", "notAttributable, untriaged");

    const snapshot = await getApplicationBrainSnapshot(projectId);

    const attributedConfirmed = snapshot.securityFindings.attributed.find((f) => f.title === "attributed, confirmed");
    const attributedUntriaged = snapshot.securityFindings.attributed.find((f) => f.title === "attributed, untriaged");
    assert.equal(attributedConfirmed?.validationStatus, "confirmed");
    assert.equal(attributedUntriaged?.validationStatus, null);

    const notAttributableFalsePositive = snapshot.securityFindings.notAttributable.find((f) => f.title === "notAttributable, false_positive");
    const notAttributableUntriaged = snapshot.securityFindings.notAttributable.find((f) => f.title === "notAttributable, untriaged");
    assert.equal(notAttributableFalsePositive?.validationStatus, "false_positive");
    assert.equal(notAttributableUntriaged?.validationStatus, null);
  });
});

// QA Agent workspace's Security tab needs to group re-detections of the same finding across
// scans (Last seen / First seen / Occurrences / Source scan), which requires createdAt and
// scanId on every finding - two already-existing SecurityFinding columns this query didn't
// select before. Carried through for both the attributed and notAttributable branches.
test("securityFindings: createdAt and scanId are carried through for both attributed and notAttributable findings, matching the real DB rows", async () => {
  await withScratchProject(async (projectId) => {
    const attributedRow = await seedFinding(projectId, "idor-engine", "https://example.invalid/api/orders/123", "attributed finding");
    const notAttributableRow = await seedFinding(projectId, "code-review", "apps/api/src/index.ts:1", "notAttributable finding");

    const snapshot = await getApplicationBrainSnapshot(projectId);

    const attributed = snapshot.securityFindings.attributed.find((f) => f.id === attributedRow.id);
    assert.ok(attributed);
    assert.equal(attributed!.scanId, attributedRow.scanId);
    assert.equal(attributed!.createdAt, attributedRow.createdAt.toISOString());

    const notAttributable = snapshot.securityFindings.notAttributable.find((f) => f.id === notAttributableRow.id);
    assert.ok(notAttributable);
    assert.equal(notAttributable!.scanId, notAttributableRow.scanId);
    assert.equal(notAttributable!.createdAt, notAttributableRow.createdAt.toISOString());
  });
});
