#!/usr/bin/env node
// Runs the workflow test suites with guards against silently skipped coverage.
//
//   node scripts/run-workflow-tests.mjs unit     # unit/integration (no Docker sandbox needed)
//   node scripts/run-workflow-tests.mjs sandbox  # live Docker sandbox suites, one file at a time
//   node scripts/run-workflow-tests.mjs all      # both, sequentially
//
// Fails (never skips) when: a partition matches no files, the sandbox image is missing,
// or any test reports skipped/todo. Sandbox suites share Docker resources and assert that
// no owned containers remain, so they always run with --test-concurrency=1.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX_IMAGE = "testmind/pytest-r2-task2:local";
const SANDBOX_DOCKERFILE_DIR = "apps/api/src/runner/python-sandbox";
const TEST_DIR = "tests/workflows";
const LIVE = /-live\.test\.mjs$/;

const mode = process.argv[2];
if (!["unit", "sandbox", "all"].includes(mode)) {
  console.error("usage: run-workflow-tests.mjs <unit|sandbox|all>");
  process.exit(2);
}

const all = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => path.posix.join(TEST_DIR, f));
const partitions = { unit: all.filter((f) => !LIVE.test(f)), sandbox: all.filter((f) => LIVE.test(f)) };

function fail(message) {
  console.error(`\n[workflow-tests] FAILED: ${message}`);
  process.exit(1);
}

function run(name, files, { serial }) {
  if (files.length === 0) fail(`no ${name} test files matched in ${TEST_DIR} - refusing to report success for an empty suite`);
  if (name === "sandbox") {
    const probe = spawnSync("docker", ["image", "inspect", SANDBOX_IMAGE, "--format", "{{.Id}}"], { encoding: "utf8" });
    if (probe.status !== 0) {
      fail(`sandbox image ${SANDBOX_IMAGE} is not available. Build it from source first:\n  docker build --tag ${SANDBOX_IMAGE} ${SANDBOX_DOCKERFILE_DIR}`);
    }
    console.log(`[workflow-tests] sandbox image ${SANDBOX_IMAGE} = ${probe.stdout.trim()}`);
  }

  const tapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tm-wf-tests-")), `${name}.tap`);
  const args = [
    "--import", "tsx", "--test",
    ...(serial ? ["--test-concurrency=1"] : []),
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=tap", `--test-reporter-destination=${tapFile}`,
    ...files,
  ];
  console.log(`[workflow-tests] ${name}: ${files.length} file(s)${serial ? ", sequential" : ""}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });

  const tap = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, "utf8") : "";
  const count = (key) => Number((tap.match(new RegExp(`^# ${key} (\\d+)$`, "m")) ?? [])[1] ?? NaN);
  const summary = { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), todo: count("todo"), cancelled: count("cancelled") };
  console.log(`[workflow-tests] ${name} summary: ${JSON.stringify(summary)}`);

  if (result.status !== 0) fail(`${name} suite exited ${result.status}`);
  if (!(summary.tests > 0)) fail(`${name} suite reported no tests`);
  if (summary.skipped > 0 || summary.todo > 0) fail(`${name} suite has ${summary.skipped} skipped / ${summary.todo} todo test(s) - required tests must run`);
  if (summary.pass !== summary.tests) fail(`${name} suite: ${summary.pass}/${summary.tests} passed`);
}

if (mode === "unit" || mode === "all") run("unit", partitions.unit, { serial: false });
if (mode === "sandbox" || mode === "all") run("sandbox", partitions.sandbox, { serial: true });
console.log(`[workflow-tests] ${mode}: OK`);
