import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import { PrismaClient } from "@prisma/client";
import { persistSecurityRegressionTest, buildRunnableSecurityRegressionSpec } from "./security-regression-persist.js";
import { getApplicationBrainSnapshot } from "./application-brain-query.js";

// Ticket VR.3B - certification that the persisted regression test is GENUINELY executable, not
// just a row that exists. Per the frozen contract, this is the specific proof DONE WHEN
// requires: "an actual pass/fail from running the generated assertions, not just
// prisma.testCase.findUnique returning a row." Runs the real, written .spec.ts file through the
// real Playwright CLI against a local (network-free, deterministic) HTTP server - no external
// network dependency, no flakiness.

const prisma = new PrismaClient();

async function withScratchFinding(run: (ctx: { projectId: string; userId: string; findingId: string }) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-vr3b-regression", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  const scan = await prisma.securityScanJob.create({ data: { projectId: project.id, status: "completed" } });
  // "cors" category (security-finding-detail.ts's classifyFinding): matched by title text
  // alone, and its generated assertion (no reflected/wildcard Access-Control-Allow-Origin) is
  // trivially satisfiable by a plain HTTP server that sets no CORS headers at all - a clean,
  // deterministic real-execution proof with no external network dependency.
  const finding = await prisma.securityFinding.create({
    data: {
      scanId: scan.id,
      type: "dynamic",
      severity: "medium",
      title: "CORS misconfiguration: reflects arbitrary Origin",
      status: "open",
      location: "http://127.0.0.1:0/placeholder", // overwritten per-test once the server's real port is known
    },
  });
  try {
    await run({ projectId: project.id, userId: user.id, findingId: finding.id });
  } finally {
    await prisma.testCase.deleteMany({ where: { securityFindingId: finding.id } });
    await prisma.securityFinding.deleteMany({ where: { scan: { projectId: project.id } } });
    await prisma.securityScanJob.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
  }
}

test.after(() => prisma.$disconnect());

test("VR.3B certification: persistSecurityRegressionTest writes a real TestCase linked to the finding, with correct provenance", async () => {
  await withScratchFinding(async ({ projectId, userId, findingId }) => {
    const finding = await prisma.securityFinding.findUniqueOrThrow({ where: { id: findingId } });
    const { testCase, specPath } = await persistSecurityRegressionTest(finding, { userId, projectId });
    try {
      assert.equal(testCase.securityFindingId, finding.id);
      assert.equal(testCase.type, "security");
      assert.equal(testCase.projectId, projectId);
      assert.equal(JSON.parse(testCase.preconditions!).specPath, specPath);

      const written = await fs.readFile(specPath, "utf8");
      assert.match(written, /import \{ test, expect \} from '@playwright\/test';/);
      assert.match(written, /CORS misconfiguration: reflects arbitrary Origin/);
    } finally {
      await fs.rm(specPath, { force: true });
    }
  });
});

test("VR.3B certification: the persisted spec file is genuinely executable and produces a real pass", async () => {
  const server = http.createServer((_req, res) => {
    // Deliberately sets no Access-Control-Allow-Origin header at all - the generated
    // assertion (acao === "*" || acao === origin) must be falsy, i.e. this must PASS.
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a real listening port");
  const targetUrl = `http://127.0.0.1:${address.port}/api/data`;

  await withScratchFinding(async ({ projectId, userId, findingId }) => {
    await prisma.securityFinding.update({ where: { id: findingId }, data: { location: targetUrl } });
    const finding = await prisma.securityFinding.findUniqueOrThrow({ where: { id: findingId } });
    const { specPath } = await persistSecurityRegressionTest(finding, { userId, projectId });

    const configPath = path.join(os.tmpdir(), `tm-vr3b-pw-config-${crypto.randomUUID()}.mjs`);
    const resultPath = path.join(os.tmpdir(), `tm-vr3b-pw-result-${crypto.randomUUID()}.json`);
    const config = `export default {
  testDir: ${JSON.stringify(path.dirname(specPath))},
  testMatch: ${JSON.stringify(path.basename(specPath))},
  reporter: [["json", { outputFile: ${JSON.stringify(resultPath)} }]],
};\n`;
    await fs.writeFile(configPath, config, "utf8");

    try {
      const result = await execa("npx", ["playwright", "test", "--config", configPath], {
        cwd: process.cwd(),
        reject: false,
        timeout: 60_000,
      });

      const reportRaw = await fs.readFile(resultPath, "utf8").catch(() => null);
      assert.ok(reportRaw, `expected a Playwright JSON report to be written; stdout was: ${result.stdout}\nstderr: ${result.stderr}`);
      const report = JSON.parse(reportRaw!);
      const stats = report.stats;
      assert.ok(stats, "expected the report to carry stats");
      assert.equal(stats.unexpected, 0, `expected zero unexpected (failed) results; full report stdout: ${result.stdout}`);
      assert.equal(stats.expected, 1, "expected exactly one passing test result");
      assert.equal(result.exitCode, 0, "playwright's own process exit code must be 0 (all tests passed)");
    } finally {
      await fs.rm(specPath, { force: true });
      await fs.rm(configPath, { force: true });
      await fs.rm(resultPath, { force: true }).catch(() => {});
    }
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Ticket CS.0 (Coverage + Stop Decision v1) - fixes the real, previously-uncaught gap found
// while grounding that item: a VR.3B-created regression TestCase was completely invisible to
// Application Brain's coverage/qaFailures rollup, for every finding regardless of eligibility.

async function withScratchProject(run: (ctx: { projectId: string; userId: string }) => Promise<void>) {
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) throw new Error("No user found in DB to attach a scratch project to");
  const project = await prisma.project.create({
    data: { name: "scratch-cs0-testlink", repoUrl: "https://example.invalid/scratch", ownerId: user.id },
  });
  try {
    await run({ projectId: project.id, userId: user.id });
  } finally {
    await prisma.testCase.deleteMany({ where: { projectId: project.id } });
    await prisma.securityFinding.deleteMany({ where: { scan: { projectId: project.id } } });
    await prisma.securityScanJob.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
  }
}

test("CS.0: a regression test persisted from an eligible (URL-shaped-tool) finding becomes visible in the Brain's coverage rollup", async () => {
  await withScratchProject(async ({ projectId, userId }) => {
    const scan = await prisma.securityScanJob.create({ data: { projectId, status: "completed" } });
    const finding = await prisma.securityFinding.create({
      data: {
        scanId: scan.id,
        type: "dynamic",
        severity: "medium",
        title: "IDOR on order lookup",
        status: "open",
        tool: "idor-engine", // URL-shaped, per URL_SHAPED_FINDING_TOOLS
        location: "https://example.invalid/api/orders/123",
      },
    });

    const { testCase, specPath } = await persistSecurityRegressionTest(finding, { userId, projectId });
    try {
      const preconditions = JSON.parse(testCase.preconditions!);
      assert.equal(preconditions.route, "/api/orders/123", "an eligible finding's route must be normalized and stored");

      const snapshot = await getApplicationBrainSnapshot(projectId);
      const coverageEntry = snapshot.coverage.find((c) => c.testCaseId === testCase.id);
      assert.ok(coverageEntry, "the regression TestCase must now be visible in the Brain's coverage rollup");
      assert.equal(coverageEntry!.routeHint, "/api/orders/123");
      assert.equal(coverageEntry!.confidence, "linked", "written via upsertTestLink, so it's a real link, not a best-effort inference");
    } finally {
      await fs.rm(specPath, { force: true });
    }
  });
});

test("CS.0: a regression test persisted from an ineligible finding is unchanged from pre-CS.0 behavior - no route, no testLink", async () => {
  await withScratchProject(async ({ projectId, userId }) => {
    const scan = await prisma.securityScanJob.create({ data: { projectId, status: "completed" } });
    const finding = await prisma.securityFinding.create({
      data: {
        scanId: scan.id,
        type: "static_analysis",
        severity: "medium",
        title: "hardcoded secret",
        status: "open",
        tool: "code-review", // NOT URL-shaped - location is a file:line, not a route
        location: "apps/api/src/index.ts:42",
      },
    });

    const { testCase, specPath } = await persistSecurityRegressionTest(finding, { userId, projectId });
    try {
      const preconditions = JSON.parse(testCase.preconditions!);
      assert.ok(!("route" in preconditions), "an ineligible finding must never get a fabricated route");
      assert.deepEqual(Object.keys(preconditions), ["specPath"], "preconditions shape must be unchanged from pre-CS.0 for ineligible findings");

      const snapshot = await getApplicationBrainSnapshot(projectId);
      const coverageEntry = snapshot.coverage.find((c) => c.testCaseId === testCase.id);
      assert.equal(coverageEntry, undefined, "an ineligible finding's regression TestCase must remain invisible to the Brain, not corrupted with a wrong route");
    } finally {
      await fs.rm(specPath, { force: true });
    }
  });
});
