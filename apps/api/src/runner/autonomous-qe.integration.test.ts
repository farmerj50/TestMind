import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { execa } from "execa";
import { discoverSite, discoverSiteWithAuth } from "../testmind/discover.js";
import { normalizeApplicationModel, computeApplicationModelUpdate } from "../lib/application-model.js";
import { computeCrawlKnowledgeUpdate } from "../lib/app-knowledge.js";
import { buildQePlan } from "../lib/qe-plan.js";
import { generateQeSuite, QE_AUTH_ENV } from "../testmind/pipeline/qe-codegen.js";
import { scenarioCoverage } from "../lib/qe-coverage.js";
import { parseResults } from "./result-parsers.js";
import { computeOverallStatus, QE_STAGES } from "./qe-orchestrator.js";

// One bounded, local integration. No DB, queue, LLM, GitHub or production credentials.
test("bounded multi-scenario QE: discovery, authenticated evidence, plan, complete bundle, execution and accounting", { timeout: 120_000 }, async (t) => {
  let executing = false;
  const server = http.createServer((req, res) => {
    const route = (req.url ?? "/").split("?")[0];
    if (route === "/session" && req.method === "POST") { res.writeHead(302, { "Set-Cookie": "fixture=approved; Path=/; HttpOnly", Location: "/account" }); res.end(); return; }
    if (route === "/account" && !req.headers.cookie?.includes("fixture=approved")) { res.writeHead(302, { Location: "/login" }); res.end(); return; }
    const pages: Record<string, string> = {
      "/": '<h1>Home</h1><a href="/register">Register</a><a href="/login">Sign In</a><a href="/account">Account</a>',
      "/register": '<h1>Register</h1><form><label>Email<input name="email" type="email" required data-testid="register-email"></label><label>Password<input name="password" type="password" required></label><button type="submit">Continue</button></form>',
      "/login": '<h1>Sign In</h1><form action="/session" method="post"><label>Email<input name="email" type="email" required></label><label>Password<input name="password" type="password" required></label><button type="submit">Sign In</button></form>',
      // One deliberate product regression after planning: the original content assertion must fail.
      "/account": `<h1>${executing ? "Content regression" : "Account"}</h1><a href="/">Home</a>`,
    };
    res.writeHead(pages[route] ? 200 : 404, { "Content-Type": "text/html" }); res.end(pages[route] ?? "Missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const validateRequest = async (url: string) => { assert.equal(new URL(url).origin, baseUrl, "fixture traffic must stay local"); };
  const options = { maxPages: 4, signal: AbortSignal.timeout(35_000), validateRequest };
  const discovery = await discoverSite(baseUrl, [`${baseUrl}/account`], options);
  const auth = await discoverSiteWithAuth(baseUrl, { username: "fixture@example.test", password: "fixture-only" }, [`${baseUrl}/account`], { ...options, maxPages: 2, loginPath: "/login" });
  assert.equal(auth.loginOutcome, "success");
  const now = new Date().toISOString();
  const model = (result: typeof discovery) => {
    const forms: Record<string, any[]> = {};
    for (const form of result.forms) if (form.routeHint) (forms[form.routeHint] ??= []).push(form);
    return computeCrawlKnowledgeUpdate(computeApplicationModelUpdate(normalizeApplicationModel({}), forms, now).next, { scans: result.scans, redirects: result.redirects, apiCalls: [], observedAt: now }).next;
  };
  const store = model(discovery);
  store.authenticatedPages = model(auth).pages;
  store.declared = { repo: "fixture/repo", source: "repository", inspectedAt: now, uiRoutes: [{ path: "/account", file: "src/routes.tsx" }], apiRoutes: [], testFiles: [], truncated: false };
  const plan = buildQePlan({ jobId: "bounded-qe", projectId: "fixture", baseUrl, now, store, coverageRoutes: [], generatorCases: [], failing: [], existingTests: [], apiTestPaths: [] });
  assert.ok(plan.scenarios.length >= 8);
  assert.ok(plan.scenarios.some((s) => s.requiresAuth));
  const generated = generateQeSuite(plan, store, { hasCredentials: true });
  assert.equal(generated.tests.length + generated.notGenerated.length, plan.scenarios.length);
  const dir = await fs.mkdtemp(path.join(process.cwd(), ".qe-integration-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const file of generated.files) { await fs.mkdir(path.dirname(path.join(dir, file.path)), { recursive: true }); await fs.writeFile(path.join(dir, file.path), file.content); }
  await fs.writeFile(path.join(dir, "plan.json"), JSON.stringify(plan));
  const resultsPath = path.join(dir, "results.json");
  await fs.writeFile(path.join(dir, "playwright.config.cjs"), `module.exports = { testDir: './qe', timeout: 10000, expect: { timeout: 1000 }, workers: 1, retries: 0, maxFailures: 0, reporter: [['json', { outputFile: ${JSON.stringify(resultsPath)} }]], use: { baseURL: ${JSON.stringify(baseUrl)}, headless: true, trace: 'off', video: 'off', screenshot: 'off' } };`);
  executing = true;
  const require = createRequire(import.meta.url);
  const run = await execa(process.execPath, [require.resolve("@playwright/test/cli"), "test", "--config", path.join(dir, "playwright.config.cjs")], { cwd: dir, reject: false, timeout: 60_000, env: { ...process.env, PW_BASE_URL: baseUrl, [QE_AUTH_ENV.email]: "fixture@example.test", [QE_AUTH_ENV.password]: "fixture-only", [QE_AUTH_ENV.loginPath]: "/login" } });
  const results = await parseResults(resultsPath);
  assert.equal(results.length, generated.tests.length, run.stdout + run.stderr);
  const coverage = scenarioCoverage(plan, generated, results.map((r) => ({ title: r.fullName, status: r.status, message: r.message })));
  assert.ok(coverage.counts.failed >= 1, "the content regression must remain a failure");
  assert.ok(coverage.counts.passed >= 3, "unrelated tests must still execute");
  assert.equal(coverage.counts.generated + coverage.counts.existing + coverage.counts.blocked + coverage.counts.unimplemented, 0, JSON.stringify(coverage));
  assert.equal(computeOverallStatus(QE_STAGES.map((key) => ({ key, outcome: key === "execute" ? "partial" : key === "repair" ? "skipped" : "succeeded" })), coverage).status, "partial");
  t.diagnostic(JSON.stringify({ discoveredPages: discovery.scans.length, authenticatedPages: auth.scans.length, plannedScenarios: plan.scenarios.length, generatedTests: generated.tests.length, specFiles: generated.files.filter((f) => f.path.endsWith(".spec.ts")).length, supportFiles: generated.files.filter((f) => !f.path.endsWith(".spec.ts")).length, ...coverage.counts }));
});
