import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { listGeneratedSpecFiles, adapterDir, adapterProjectDir } from "./generated-files.js";

test("listGeneratedSpecFiles returns [] for a directory that doesn't exist", () => {
  const result = listGeneratedSpecFiles("playwright-ts", "tm-test-nope-user", "tm-test-nope-project");
  assert.deepEqual(result, []);
});

test("listGeneratedSpecFiles lists nested files with forward-slash relative paths and sizes", async (t) => {
  // GENERATED_ROOT is resolved once at module load from an env var - rather than fighting
  // that, use the real root with a throwaway, randomly-named adapter/user/project combo so
  // this never collides with real data, and clean it up afterward.
  const userId = `tm-test-user-${crypto.randomUUID()}`;
  const projectId = `tm-test-project-${crypto.randomUUID()}`;
  const dir = adapterProjectDir("playwright-ts", userId, projectId);
  t.after(() => fs.rm(adapterDir("playwright-ts", userId), { recursive: true, force: true }).catch(() => {}));

  await fs.mkdir(`${dir}/tests`, { recursive: true });
  await fs.writeFile(`${dir}/tests/a.spec.ts`, "hello");
  await fs.writeFile(`${dir}/readme.md`, "doc");

  const files = listGeneratedSpecFiles("playwright-ts", userId, projectId).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(
    files.map((f) => f.path),
    ["readme.md", "tests/a.spec.ts"]
  );
  assert.ok(files.every((f) => typeof f.size === "number" && f.size > 0));
});

test("adapterDir/adapterProjectDir compose the expected path shape", () => {
  const dir = adapterDir("playwright-ts", "tm-test-user1");
  assert.ok(dir.endsWith("playwright-ts-tm-test-user1"));
  const projectDir = adapterProjectDir("playwright-ts", "tm-test-user1", "tm-test-proj1");
  assert.ok(projectDir.endsWith(`playwright-ts-tm-test-user1${path.sep}tm-test-proj1`));
  assert.equal(adapterProjectDir("playwright-ts", "tm-test-user1"), dir);
});
