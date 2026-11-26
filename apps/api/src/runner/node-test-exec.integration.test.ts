import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { runTests } from "./node-test-exec.js";

test("bounded integration: an external target executes without starting the local webServer", async () => {
  const tempRoot = path.resolve("tmp");
  await fs.mkdir(tempRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tempRoot, "tm-external-run-"));
  try {
    const ownerRoot = path.join(dir, "playwright-ts-owner");
    const runDir = path.join(ownerRoot, "testmind-project", "qe-runs", "job-1");
    const historicalDir = path.join(ownerRoot, "justicepath-project");
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(historicalDir, { recursive: true });
    const spec = path.join(runDir, "external.spec.ts");
    const config = path.join(dir, "playwright.config.mjs");
    const report = path.join(dir, "report.json");
    await fs.writeFile(
      spec,
      `import { test, expect } from '@playwright/test';
test('external target policy', async ({ page }) => {
  expect(await page.evaluate(() => document.readyState)).toBe('complete');
  expect(process.env.TM_SKIP_SERVER).toBe('1');
  expect(process.env.PW_BASE_URL).toBe('https://app.example.test');
});\n`
    );
    await fs.writeFile(
      path.join(historicalDir, "historical.spec.ts"),
      `import { test } from '@playwright/test';
test('historical JusticePath test must not run', async () => { throw new Error('cross-project contamination'); });\n`
    );
    await fs.writeFile(
      config,
      `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: process.env.TM_TEST_DIR || ${JSON.stringify(ownerRoot.replace(/\\/g, "/"))},
  reporter: [['json', { outputFile: process.env.PW_JSON_OUTPUT }]],
  webServer: process.env.TM_SKIP_SERVER ? undefined : {
    command: 'node -e "process.exit(91)"',
    port: 65534,
    timeout: 1000,
  },
});\n`
    );

    const result = await runTests({
      workdir: path.resolve("."),
      jsonOutPath: report,
      baseUrl: "https://app.example.test",
      configPath: config,
      extraGlobs: [runDir],
      extraEnv: { TM_TEST_DIR: runDir },
      runTimeout: 30_000,
    });

    assert.equal(result.ok, true, result.stderr || result.stdout);
    assert.equal(result.exitCode, 0);
    assert.equal(await fs.stat(report).then(() => true, () => false), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
