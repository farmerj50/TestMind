import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildSpecCandidates } from "./context.js";
import { GENERATED_ROOT } from "../../lib/storageRoots.js";

test("self-heal resolves a generated spec to the canonical generated root before legacy copies (B5 live regression)", () => {
  const repoRoot = path.resolve("/repo");
  const rel = "testmind-generated/playwright-ts-u1/p1/login.spec.ts";
  const candidates = [...buildSpecCandidates(repoRoot, rel, rel, "playwright-ts", "p1")];
  const canonical = path.join(path.resolve(GENERATED_ROOT), "playwright-ts-u1/p1/login.spec.ts");
  assert.equal(candidates[0], canonical, "the file the runner executes is tried first");
  const stale = path.join(repoRoot, "apps", "web", rel);
  assert.ok(candidates.indexOf(stale) > candidates.indexOf(canonical), "a stale apps/web copy is only a fallback");
});
