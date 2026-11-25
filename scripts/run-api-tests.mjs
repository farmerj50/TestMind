#!/usr/bin/env node
// API regression tests (apps/api/src/**/*.test.ts) with bounded concurrency.
//
//   node scripts/run-api-tests.mjs                 # concurrency from TM_API_TEST_CONCURRENCY (default 1)
//   TM_API_TEST_SEED=1 node scripts/run-api-tests.mjs  # CI: seed a fixture project into an empty database first
//
// Several suites share one Postgres database (project rows, approvals, proposal files), so the
// default concurrency is 1; raise TM_API_TEST_CONCURRENCY only where the database is isolated.
// The run fails on any failed, cancelled, skipped or todo test, so coverage cannot silently drop.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = path.join(root, "apps/api");
const concurrency = Math.max(1, Math.min(Number(process.env.TM_API_TEST_CONCURRENCY) || 1, 4));

function findTests(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) findTests(p, out);
    else if (entry.name.endsWith(".test.ts")) out.push(path.relative(apiDir, p).split(path.sep).join("/"));
  }
  return out;
}

async function seedFixtureProject() {
  const require = createRequire(path.join(apiDir, "package.json"));
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  try {
    if (await prisma.project.count()) return;
    await prisma.user.upsert({ where: { id: "ci-fixture-owner" }, update: {}, create: { id: "ci-fixture-owner" } });
    await prisma.project.create({ data: { name: "CI fixture project", repoUrl: "https://example.invalid/ci-fixture.git", ownerId: "ci-fixture-owner" } });
    console.log("[api-tests] seeded CI fixture project");
  } finally {
    await prisma.$disconnect();
  }
}

if (process.env.TM_API_TEST_SEED === "1") await seedFixtureProject();

const files = findTests(path.join(apiDir, "src")).sort();
if (!files.length) { console.error("[api-tests] no test files found"); process.exit(1); }
const tapFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tm-api-tests-")), "api.tap");
// Run the tests exactly as `node` would when invoked directly: package-manager script context
// (npm_* variables and node_modules/.bin on PATH, injected by `pnpm <script>`) would otherwise
// leak into suites that spawn real package managers.
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
const pnpmHome = process.env.PNPM_HOME ? path.resolve(process.env.PNPM_HOME) : null;
childEnv[pathKey] = String(process.env[pathKey] ?? "").split(path.delimiter).filter((p) => {
  if (!/node_modules[\\/]\.bin/i.test(p)) return true;
  return !!pnpmHome && path.resolve(p) === pnpmHome;
}).join(path.delimiter);
childEnv.TM_QE_RECOVERY = "0";
console.log(`[api-tests] ${files.length} file(s), concurrency ${concurrency}`);
const result = spawnSync(process.execPath, [
  "--import", "tsx", "--test", "--test-force-exit", `--test-concurrency=${concurrency}`, "--test-timeout=300000",
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  "--test-reporter=tap", `--test-reporter-destination=${tapFile}`,
  ...files,
], {
  cwd: apiDir,
  env: childEnv,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");

const tap = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, "utf8") : "";
// With --test-force-exit, Node 22 can finish a large run before the secondary TAP
// destination writes its summary. The primary spec reporter has already emitted the same
// terminal counts, so use it as a truthful fallback rather than reporting zero tests.
const summaryOutput = `${tap}\n${result.stdout ?? ""}`;
const count = (k) => {
  const matches = [...summaryOutput.matchAll(new RegExp(`(?:^|\\n)(?:#|ℹ) ${k} (\\d+)`, "g"))];
  return Number(matches.at(-1)?.[1] ?? 0);
};
const summary = { tests: count("tests"), pass: count("pass"), fail: count("fail"), cancelled: count("cancelled"), skipped: count("skipped"), todo: count("todo") };
console.log(`[api-tests] summary: ${JSON.stringify(summary)}`);
const ok = result.status === 0 && summary.tests > 0 && !summary.fail && !summary.cancelled && !summary.skipped && !summary.todo;
if (!ok) console.error("[api-tests] FAILED");
process.exit(ok ? 0 : 1);
