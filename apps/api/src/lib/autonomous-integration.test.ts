import { pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { autonomousPipeline, qeContextForLegacyRequest } from "./autonomous-routing.js";
import { scenarioCoverage } from "./qe-coverage.js";
import { buildQePlan } from "./qe-plan.js";
import { normalizeApplicationModel } from "./application-model.js";
import { computeCrawlKnowledgeUpdate } from "./app-knowledge.js";
import { generateQeSuite } from "../testmind/pipeline/qe-codegen.js";
import { detectTestCommand, NODE_TEST_REPORTER } from "../runner/dev-agent-test-command.js";
import { parseResults } from "../runner/result-parsers.js";
import { execa } from "execa";
import { saveGeneratedSpecsToSuite, suiteDirForRun } from "../runner/dev-agent-suite.js";
import { computeOverallStatus, QE_STAGES } from "../runner/qe-orchestrator.js";
import { checkObjectiveAlignment } from "../runner/dev-agent-objective.js";
import { repositoryEvidence } from "./repository-evidence.js";

for (const instructionText of ["Generate tests for the entire application", "Test this page", "Test this user story"]) {
  test(`URL request uses B1–B7: ${instructionText}`, () => assert.equal(autonomousPipeline({ instructionText, baseUrl: "https://app.example" }), "qe"));
}
for (const instructionText of ["Fix the login bug and add tests", "Add unit tests for navigation", "Refactor source code"]) {
  test(`Repository request uses Dev: ${instructionText}`, () => {
    assert.equal(autonomousPipeline({ instructionText }), "dev");
    assert.equal(autonomousPipeline({ instructionText, baseUrl: "https://app.example" }), "dev");
  });
}

const makePlan = () => {
  const store = computeCrawlKnowledgeUpdate(normalizeApplicationModel({}), { scans: [{ url: "https://app.example/login", status: 200, fields: [{ name: "password", type: "password" }] }], apiCalls: [], observedAt: "2026-01-01" }).next;
  return { store, plan: buildQePlan({ jobId: "j", projectId: "p", baseUrl: "https://app.example", now: "2026-01-01", store, coverageRoutes: [], failing: [{ title: "Earlier regression", route: "/login", lastRunAt: null, lastFailureMessage: "error" }], generatorCases: [{ title: "Login renders", page: "/login" }], existingTests: [], apiTestPaths: [] }) };
};

test("new legacy operator and schedule requests carry B1–B7 context without changing their controls", () => {
  const context = qeContextForLegacyRequest({ autonomous: true, autonomyLevel: "assisted", maxPages: 999, scope: "page" }, "https://app.example/page");
  assert.equal(context.qe.inputKind, "page");
  assert.equal(context.qe.maxPages, 50);
  assert.equal(context.autonomyLevel, "assisted");
  assert.equal(qeContextForLegacyRequest({ userStory: "As a user, I see my account" }, "https://app.example").qe.inputKind, "user_story");
});

test("every scenario is accounted for, including existing, reverify, blocked and unimplemented cases", () => {
  const { store, plan } = makePlan();
  const generation = { ...generateQeSuite(plan, store, { hasCredentials: false }), availableTitles: ["Login renders"] };
  const before = scenarioCoverage(plan, generation);
  assert.equal(before.total, plan.scenarios.length);
  assert.equal(before.counts.existing, 1);
  assert.equal(before.counts.unimplemented, 1);
  const results = generation.tests.map((t) => ({ title: t.testTitle, status: "passed" }));
  const after = scenarioCoverage(plan, generation, [...results, { title: "Login renders", status: "passed" }]);
  assert.equal(after.complete, false);
  assert.equal(after.counts.unimplemented, 1);
  const stages = QE_STAGES.map((key) => ({ key, outcome: key === "repair" ? "skipped" as const : "succeeded" as const }));
  assert.equal(computeOverallStatus(stages, after).status, "partial");
  assert.equal(computeOverallStatus(stages, null).status, "unverified");
  const complete = scenarioCoverage(plan, generation, [...results, { title: "Login renders", status: "passed" }, { title: "Earlier regression", status: "passed" }]);
  assert.equal(complete.complete, true);
  assert.equal(computeOverallStatus(stages, complete).status, "succeeded");
});

test("skipped, denied and missing results cannot masquerade as passing coverage", () => {
  const { store, plan } = makePlan();
  const generation = generateQeSuite(plan, store, { hasCredentials: false });
  const results = generation.tests.map((t) => ({ title: t.testTitle, status: "skipped" }));
  const coverage = scenarioCoverage(plan, generation, results, [generation.tests[0].testTitle]);
  assert.equal(coverage.counts.passed, 0);
  assert.ok(coverage.counts.blocked >= generation.tests.length);
  assert.equal(coverage.total, plan.scenarios.length);
});

function temporaryRepo(t: any, files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tm-integration-unit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), content); }
  return root;
}

test("monorepo detection retains package cwd and every affected framework", (t) => {
  const root = temporaryRepo(t, { "package.json": "{}", "pnpm-lock.yaml": "", "apps/web/package.json": JSON.stringify({ devDependencies: { vitest: "1", "@playwright/test": "1" } }), "apps/web/a.test.ts": "import { test } from 'vitest';", "apps/web/e2e.spec.ts": "import { test } from '@playwright/test';", "apps/api/package.json": JSON.stringify({ devDependencies: { tsx: "1" } }), "apps/api/api.test.ts": "import test from 'node:test';" });
  const result = detectTestCommand(root, ["apps/web/a.test.ts", "apps/web/e2e.spec.ts", "apps/api/api.test.ts"]);
  assert.ok("commands" in result);
  if (!("commands" in result)) return;
  assert.equal(result.commands?.length, 3);
  assert.deepEqual(result.commands?.map((c) => c.framework), ["vitest", "playwright", "node"]);
  assert.equal(result.commands![2].cwd, path.join(root, "apps/api"));
  assert.match(result.commands![2].command, /tsx --test api.test.ts/);
});

test("Suites retains fixtures, page objects and transitive imports", (t) => {
  const root = temporaryRepo(t, { "e2e/fixtures.ts": "export { PageObject } from './pages/view';", "e2e/pages/view.ts": "export class PageObject {}" });
  const run = { id: "r", projectId: "p", requestedBy: "u" };
  const spec = "import { PageObject } from './fixtures'; test('view', () => {});";
  const saved = saveGeneratedSpecsToSuite(run, [{ path: "e2e/view.spec.ts", content: spec }], path.join(root, "saved"), root);
  assert.equal(saved.length, 3);
  assert.ok(fs.existsSync(path.join(suiteDirForRun(run, path.join(root, "saved")), "e2e/pages/view.ts")));
  assert.throws(() => saveGeneratedSpecsToSuite(run, [{ path: "bad.spec.ts", content: "import './missing';" }], path.join(root, "saved"), root), /incomplete/);
});

test("source evidence includes matching source and tests but excludes secret files", (t) => {
  const root = temporaryRepo(t, { "navigation.ts": "export const home = '/';", "navigation.test.ts": "assert.equal(home, '/');", ".env": "PASSWORD=secret", "credentials.ts": "const password='secret';" });
  assert.deepEqual(repositoryEvidence(root, "navigation").map((f) => f.path), ["navigation.ts", "navigation.test.ts"]);
});

test("source assertions do not require UI text; skipped and deleted assertions remain rejected", () => {
  const base = { instructionText: "Test sum", originalTargets: null, repositoryVerification: true };
  assert.equal(checkObjectiveAlignment({ ...base, finalTestFiles: [{ path: "sum.test.ts", content: "expect(sum(1, 2)).toBe(3);" }] }).aligned, true);
  assert.equal(checkObjectiveAlignment({ ...base, finalTestFiles: [{ path: "sum.test.ts", content: "test.skip('sum', () => expect(1).toBe(1));" }] }).aligned, false);
});

test("repository-only Node verification runs affected tests and produces shared per-test evidence", async (t) => {
  const root = temporaryRepo(t, { "package.json": "{}", "sum.test.cjs": "const test = require('node:test'); const assert = require('node:assert/strict'); test('sum', () => assert.equal(1+2,3)); test('difference', () => assert.equal(3-2,1));", "reporter.cjs": NODE_TEST_REPORTER });
  const detected = detectTestCommand(root, ["sum.test.cjs"]);
  assert.equal(detected.command, "node --test sum.test.cjs");
  const report = path.join(root, "result.json");
  await execa(process.execPath, ["--test", `--test-reporter=${pathToFileURL(path.join(root, "reporter.cjs")).href}`, `--test-reporter-destination=${report}`, "sum.test.cjs"], { cwd: root, timeout: 10_000, env: { NODE_TEST_CONTEXT: undefined } });
  const results = await parseResults(report);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.status === "passed"));
});
