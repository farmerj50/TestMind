import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAiGeneratedDir, resolveExistingAiTarget } from "./ai-run-target.js";

test("an autonomous run keeps an existing run-scoped directory exact", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tm-ai-target-"));
  const runDir = path.join(root, "playwright-ts-owner", "project", "qe-runs", "job");
  const spec = path.join(runDir, "home.spec.ts");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(spec, "// fixture");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.deepEqual(resolveExistingAiTarget(runDir, runDir), {
    target: path.resolve(runDir),
    testDir: path.resolve(runDir),
    targetIsDirectory: true,
  });
  assert.deepEqual(resolveExistingAiTarget(spec, runDir), {
    target: path.resolve(spec),
    testDir: path.resolve(runDir),
    targetIsDirectory: false,
  });
});

test("persisted generatedDir is used when the queue payload omits it", () => {
  const persisted = path.join(os.tmpdir(), "mounted-generated", "job");
  assert.equal(resolveAiGeneratedDir(undefined, persisted), path.resolve(persisted));
  assert.equal(resolveAiGeneratedDir("  ", persisted), path.resolve(persisted));
});
