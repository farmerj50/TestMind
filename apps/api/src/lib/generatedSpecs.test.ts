import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generatedSpecDir,
  generatedSpecCandidateRoots,
  resolveGeneratedSpecDir,
  ensureGeneratedSpecDir,
} from "./generatedSpecs.js";

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "generated-specs-test-"));
}

test("resolveGeneratedSpecDir never returns a different project's directory", () => {
  const root = makeTmpRoot();
  try {
    const scopeFolder = "playwright-ts-user_abc";
    const projectA = path.join(root, scopeFolder, "project-a");
    const projectB = path.join(root, scopeFolder, "project-b");
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });
    fs.writeFileSync(path.join(projectA, "home.spec.ts"), "// project A spec");
    fs.writeFileSync(path.join(projectB, "home.spec.ts"), "// project B spec");

    const resolvedA = resolveGeneratedSpecDir(
      { adapterId: "playwright-ts", userId: "user_abc", projectId: "project-a" },
      { additionalRoots: [root] }
    );
    const resolvedB = resolveGeneratedSpecDir(
      { adapterId: "playwright-ts", userId: "user_abc", projectId: "project-b" },
      { additionalRoots: [root] }
    );
    assert.equal(resolvedA, projectA);
    assert.equal(resolvedB, projectB);
    assert.notEqual(resolvedA, resolvedB);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveGeneratedSpecDir returns null rather than the flat/shared parent directory", () => {
  const root = makeTmpRoot();
  try {
    const scopeFolder = "playwright-ts-user_abc";
    // Only the flat, unscoped parent exists — no project-a subdirectory.
    fs.mkdirSync(path.join(root, scopeFolder), { recursive: true });
    fs.writeFileSync(path.join(root, scopeFolder, "leftover.spec.ts"), "// stale, unscoped");

    const resolved = resolveGeneratedSpecDir(
      { adapterId: "playwright-ts", userId: "user_abc", projectId: "project-a" },
      { additionalRoots: [root] }
    );
    // additionalRoots is searched via generatedSpecCandidateRoots, which always appends
    // "/{projectId}" — so even though the flat parent exists, the project-scoped candidate
    // under it does not, and resolution must not fall back to the flat parent itself.
    assert.equal(resolved, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generatedSpecDir joins root + adapter-user + projectId, and differs per project", () => {
  const scopeA = { adapterId: "playwright-ts", userId: "user_abc", projectId: "project-a" };
  const scopeB = { adapterId: "playwright-ts", userId: "user_abc", projectId: "project-b" };
  const dirA = generatedSpecDir(scopeA, "/root");
  const dirB = generatedSpecDir(scopeB, "/root");
  assert.equal(dirA, path.join("/root", "playwright-ts-user_abc", "project-a"));
  assert.notEqual(dirA, dirB);
});

test("generatedSpecCandidateRoots always appends the exact projectId, never the bare scope folder", () => {
  const scope = { adapterId: "playwright-ts", userId: "user_abc", projectId: "project-a" };
  const candidates = generatedSpecCandidateRoots(scope, ["/extra/root"]);
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    assert.ok(candidate.endsWith(path.join("playwright-ts-user_abc", "project-a")));
  }
});

test("ensureGeneratedSpecDir creates and returns the project-scoped directory", async () => {
  const root = makeTmpRoot();
  try {
    const scope = { adapterId: "playwright-ts", userId: "user_abc", projectId: "project-a" };
    const dir = await ensureGeneratedSpecDir(scope, root);
    assert.equal(dir, path.join(root, "playwright-ts-user_abc", "project-a"));
    assert.ok(fs.existsSync(dir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
