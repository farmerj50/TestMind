import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRestrictedTraceConfig, removeStaleTraceWrappers, STALE_TRACE_WRAPPER_MS } from "./trace-capture.js";

const uuidName = (n: number) => `.tm-trace-0000000${n}-1111-2222-3333-444444444444.config.mjs`;

test("normal completion removes the wrapper; abandoned wrappers are swept, live and unrelated files are kept", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-trace-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, "playwright.config.mjs");
  await fs.writeFile(config, "export default {};\n");

  // Normal lifecycle: create -> remove leaves nothing behind.
  const w = await createRestrictedTraceConfig(config, path.join(dir, "out"));
  assert.ok((await fs.readdir(dir)).includes(path.basename(w.path)));
  await w.remove();
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.startsWith(".tm-trace-")), []);

  // A restart mid-run skips remove(): the abandoned wrapper is swept once it is older than any run.
  const old = new Date(Date.now() - STALE_TRACE_WRAPPER_MS - 60_000);
  for (const n of [1, 2]) await fs.writeFile(path.join(dir, uuidName(n)), "x");
  await fs.utimes(path.join(dir, uuidName(1)), old, old); // abandoned
  await fs.writeFile(path.join(dir, ".tm-trace-notes.config.mjs"), "x"); // not a wrapper name
  await fs.utimes(path.join(dir, ".tm-trace-notes.config.mjs"), old, old);

  assert.deepEqual(await removeStaleTraceWrappers(dir), [uuidName(1)]);
  const left = await fs.readdir(dir);
  assert.ok(left.includes(uuidName(2)), "a recent (possibly live) wrapper is never removed");
  assert.ok(left.includes(".tm-trace-notes.config.mjs"), "only exact wrapper names are touched");
  assert.ok(left.includes("playwright.config.mjs"), "the user's config is never touched");

  // Creating a new wrapper performs the sweep automatically.
  await fs.utimes(path.join(dir, uuidName(2)), old, old);
  const w2 = await createRestrictedTraceConfig(config, path.join(dir, "out"));
  assert.ok(!(await fs.readdir(dir)).includes(uuidName(2)));
  await w2.remove();
});
