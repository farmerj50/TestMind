import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanTestOutput, extractFailureDetail, failureSignature } from "./dev-agent-repair-feedback.js";
import { parseTestOutcomes, saveGeneratedSpecsToSuite, suiteDirForRun } from "./dev-agent-suite.js";
import { buildCodePhasePrompt } from "./dev-agent-worker.js";

const tmp = os.tmpdir();
const pwFailure = (ms: string, line: number) => [
  "Added minimal Playwright test setup (disclosed in the proposal): @playwright/test@1.58.2 as a devDependency; files: package.json",
  "Auto-detected: Playwright (@playwright/test) via npm, running the generated specs",
  `$ npx --no-install playwright test e2e/signup.spec.ts --output ${tmp.replace(/\\/g, "/")}/tm-dev-agent-pw-output/run1`,
  "Running 1 test using 1 worker",
  `  ✘  1 [chromium] › e2e/signup.spec.ts:3:5 › Sign Up page (${ms})`,
  "",
  `  1) [chromium] › e2e/signup.spec.ts:3:5 › Sign Up page`,
  "",
  "    Error: expect(locator).toHaveText(expected) failed",
  "",
  "    Locator: locator('h1')",
  "    Expected: \"Sign Up\"",
  "    Timeout: 5000ms",
  "    Error: element(s) not found",
  "",
  "    Call log:",
  "      - Expect \"toHaveText\" with timeout 5000ms",
  "      - waiting for locator('h1')",
  "",
  `      ${line} |   await page.goto("/signup");`,
  `    > ${line + 1} |   await expect(page.locator("h1")).toHaveText("Sign Up");`,
  `        at ${tmp}${path.sep}tm-wt${path.sep}e2e${path.sep}signup.spec.ts:${line + 1}:37`,
  "",
  `    Error Context: ${tmp.replace(/\\/g, "/")}/tm-dev-agent-pw-output/run1/signup/error-context.md`,
  "",
  "    attachment #2: trace (application/zip) ──────────────────────",
  "    ..\\..\\tm-dev-agent-pw-output\\run1\\signup-chromium\\trace.zip",
  "    Usage:",
  "",
  "        npx playwright show-trace ..\\..\\tm-dev-agent-pw-output\\run1\\signup-chromium\\trace.zip",
  "",
  "    ──────────────────────────────────────────────",
  "",
  "  1 failed",
].join("\n");

test("repair feedback: actual failure block (locator, expected, actual, location, code frame) without setup notices or temp paths", () => {
  const detail = extractFailureDetail(pwFailure("8.2s", 4), { worktreePath: path.join(tmp, "tm-wt") }) ?? "";
  assert.match(detail, /^1\) \[chromium\] › e2e\/signup\.spec\.ts:3:5 › Sign Up page/);
  for (const needle of ["toHaveText(expected) failed", "Locator: locator('h1')", 'Expected: "Sign Up"', "element(s) not found", '> 5 |   await expect(page.locator("h1"))', "at e2e"]) assert.ok(detail.includes(needle), needle);
  assert.doesNotMatch(detail, /Added minimal Playwright|Auto-detected|\$ npx|tm-dev-agent-pw-output\/run1\b.*--output/);
  assert.ok(!detail.includes(tmp) && !detail.includes(tmp.replace(/\\/g, "/")), "no temporary paths");
  assert.doesNotMatch(detail, /tm-dev-agent-pw-output|<tmp>|show-trace|attachment #|Error Context|─{3,}/, "no artifact pointers or decoration");
  assert.doesNotMatch(cleanTestOutput(pwFailure("1s", 4)), /^(Added minimal|Auto-detected|\$ )/m);
});

test("failure signature: identical failures match despite timings/line numbers; a different locator does not", () => {
  assert.equal(failureSignature(pwFailure("8.2s", 4)), failureSignature(pwFailure("1.1s", 9)));
  assert.notEqual(failureSignature(pwFailure("8.2s", 4)), failureSignature(pwFailure("8.2s", 4).replace(/locator\('h1'\)/g, "locator('h3')")));
  assert.equal(failureSignature(""), null);
});

test("repair prompt: the actual failure comes first, then the current test, locator guidance and objective rules", () => {
  const prompt = buildCodePhasePrompt({
    instructionText: "Verify the Sign Up page shows the Sign Up heading",
    iterationNumber: 2,
    discoveryContext: null,
    discoveryUnavailableReason: "crawl-error",
    existingTestPaths: [],
    testSetup: "This repository has no test framework.",
    priorIteration: { iterationNumber: 1, summary: "x", testOutput: pwFailure("8.2s", 4), filesChanged: ["e2e/signup.spec.ts"], failureDetail: "1) [chromium] › e2e/signup.spec.ts › Sign Up page\nLocator: locator('h1')", failingTestFiles: [{ path: "e2e/signup.spec.ts", content: "await expect(page.locator(\"h1\")).toHaveText(\"Sign Up\");" }] },
  });
  const repairAt = prompt.indexOf("## Repair required");
  assert.ok(repairAt > 0 && repairAt < prompt.indexOf("## Test framework") && repairAt < prompt.indexOf("## Site context"));
  assert.match(prompt, /Current e2e\/signup\.spec\.ts:/);
  assert.match(prompt, /getByRole/);
  assert.match(prompt, /never weaken, skip, negate or remove an assertion/);
  assert.doesNotMatch(prompt, /Added minimal Playwright test setup/);
});

test("Suites persistence: only test files, only inside the run's folder; individual outcomes parsed (Linux and Windows reporters)", (t) => {
  const root = fs.mkdtempSync(path.join(tmp, "tm-suite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = { id: "run1", projectId: "proj1", requestedBy: "user1" };
  const saved = saveGeneratedSpecsToSuite(run, [{ path: "e2e/a.spec.ts", content: "A" }, { path: "src/app.ts", content: "B" }, { path: "../../evil.spec.ts", content: "C" }, { path: "e2e/del.spec.ts" }], root);
  assert.deepEqual(saved, ["autonomous-dev/run1/e2e/a.spec.ts"]);
  assert.equal(fs.readFileSync(path.join(suiteDirForRun(run, root), "e2e/a.spec.ts"), "utf8"), "A");
  assert.ok(suiteDirForRun(run, root).startsWith(path.join(root, "playwright-ts-user1", "proj1")));
  assert.deepEqual(parseTestOutcomes(pwFailure("8.2s", 4)), [{ title: "Sign Up page", file: "e2e/signup.spec.ts", status: "failed" }]);
  assert.deepEqual(parseTestOutcomes("  ok 1 [chromium] › e2e\\landing.spec.ts:3:5 › landing offers Get Started (468ms)"), [{ title: "landing offers Get Started", file: "e2e/landing.spec.ts", status: "passed" }]);
});
