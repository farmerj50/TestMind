import test from "node:test";
import assert from "node:assert/strict";
import { logicalProjectIdFromGeneratedPath } from "./generated-suite-access.js";

test("generated Suites paths retain the owning logical project and run scope", () => {
  assert.deepEqual(
    logicalProjectIdFromGeneratedPath("project-1/qe-runs/job-1/qe/home.qe.spec.ts"),
    { projectId: "project-1", normalized: "project-1/qe-runs/job-1/qe/home.qe.spec.ts" },
  );
  assert.deepEqual(
    logicalProjectIdFromGeneratedPath("\\project-1\\qe-runs\\job-1\\qe\\fixtures.ts"),
    { projectId: "project-1", normalized: "project-1/qe-runs/job-1/qe/fixtures.ts" },
  );
  assert.equal(logicalProjectIdFromGeneratedPath("../other-project/spec.ts"), null);
  assert.equal(logicalProjectIdFromGeneratedPath("project-1/../other-project/spec.ts"), null);
  assert.equal(logicalProjectIdFromGeneratedPath(""), null);
});
