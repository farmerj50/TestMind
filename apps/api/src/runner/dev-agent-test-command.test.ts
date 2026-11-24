import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeTestSetup, detectTestCommand } from "./dev-agent-test-command.js";
import { commonSpecDir, playwrightConfigSource, testmindPlaywrightVersion } from "./dev-agent-playwright-setup.js";

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-detect-test-cmd-"));
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  return dir;
}
const pw = `import { test, expect } from "@playwright/test";\ntest("x", async () => {});\n`;

test("generated Playwright spec + @playwright/test + pnpm lockfile -> pnpm exec playwright test <spec>", (t) => {
  const dir = repo({ "package.json": JSON.stringify({ devDependencies: { "@playwright/test": "^1.50.0" }, scripts: { test: "vitest" } }), "pnpm-lock.yaml": "", "tests/signup.spec.ts": pw });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const d = detectTestCommand(dir, ["tests/signup.spec.ts", "src/app.ts"]);
  assert.equal(d.command, "pnpm exec playwright test tests/signup.spec.ts");
  assert.equal("framework" in d && d.framework, "playwright");
});

test("npm lockfile uses npx --no-install (never installs anything new); Windows paths are normalized", (t) => {
  const dir = repo({ "package.json": JSON.stringify({ devDependencies: { "@playwright/test": "1.50.0" } }), "package-lock.json": "{}", "e2e/a.spec.ts": pw });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(detectTestCommand(dir, ["e2e\\a.spec.ts"]).command, "npx --no-install playwright test e2e/a.spec.ts");
});

test("Playwright spec (either import style) without Playwright in the repo -> request a provisioned setup", (t) => {
  const dir = repo({ "package.json": JSON.stringify({ scripts: { test: "jest" } }), "tests/a.spec.ts": pw, "e2e/b.spec.ts": `import { test } from 'playwright/test';` });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const d = detectTestCommand(dir, ["tests/a.spec.ts", "e2e/b.spec.ts"]);
  assert.equal(d.command, null);
  assert.deepEqual("provisionPlaywright" in d && d.provisionPlaywright, { specs: ["tests/a.spec.ts", "e2e/b.spec.ts"] });
  assert.match(d.reason, /no Playwright test setup/);
});

test("Playwright output is directed outside the worktree", (t) => {
  const dir = repo({ "package.json": JSON.stringify({ devDependencies: { "@playwright/test": "1.58.2" } }), "package-lock.json": "{}", "e2e/a.spec.ts": pw });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(detectTestCommand(dir, ["e2e/a.spec.ts"], { outputDir: "C:\\tmp\\pw out" }).command, `npx --no-install playwright test e2e/a.spec.ts --output "C:/tmp/pw out"`);
});

test("code-phase guidance: no framework -> Playwright specs under e2e/; existing Playwright is reused", (t) => {
  const none = repo({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
  const has = repo({ "package.json": JSON.stringify({ devDependencies: { "@playwright/test": "1" } }) });
  t.after(() => [none, has].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  assert.match(describeTestSetup(none), /no test framework.*e2e\/.*@playwright\/test/);
  assert.match(describeTestSetup(has), /already uses Playwright/);
});

test("provisioned config: testDir is the specs' common folder and baseURL the authorized URL", () => {
  assert.equal(commonSpecDir(["e2e/a.spec.ts", "e2e/sub/b.spec.ts"]), "./e2e");
  assert.equal(commonSpecDir(["a.spec.ts"]), ".");
  const src = playwrightConfigSource({ baseUrl: "https://app.example.com", testDir: "./e2e" });
  assert.match(src, /testDir: "\.\/e2e"/);
  assert.match(src, /baseURL: process\.env\.BASE_URL \|\| "https:\/\/app\.example\.com"/);
  assert.match(testmindPlaywrightVersion(), /^\d+\.\d+\.\d+$/);
});

test("vitest / jest run only the changed tests; otherwise the package.json test script; npm placeholder is ignored", (t) => {
  const v = repo({ "package.json": JSON.stringify({ devDependencies: { vitest: "^2" } }), "yarn.lock": "", "src/a.test.ts": "import { it } from 'vitest';" });
  const j = repo({ "package.json": JSON.stringify({ devDependencies: { jest: "^29" } }), "src/a.test.js": "test('x',()=>{})" });
  const s = repo({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "pnpm-lock.yaml": "" });
  const ph = repo({ "package.json": JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }) });
  t.after(() => [v, j, s, ph].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  assert.equal(detectTestCommand(v, ["src/a.test.ts"]).command, "yarn vitest run src/a.test.ts");
  assert.equal(detectTestCommand(j, ["src/a.test.js"]).command, "npx --no-install jest src/a.test.js");
  assert.equal(detectTestCommand(s, ["src/x.ts"]).command, "pnpm test");
  assert.equal(detectTestCommand(ph, []).command, null);
});

test("no package.json -> no command", (t) => {
  const dir = repo({ "README.md": "hi" });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const d = detectTestCommand(dir, []);
  assert.equal(d.command, null);
  assert.match(d.reason, /No package\.json/);
});
