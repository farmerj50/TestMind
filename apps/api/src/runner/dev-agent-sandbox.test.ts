import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSandboxEnv, parseCommandLine, runSandboxed } from "./dev-agent-sandbox.js";
import { runConfiguredTestCommand } from "./dev-agent-worker.js";

const NODE = process.execPath;

async function mkDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "tm-dev-agent-sandbox-test-"));
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("parseCommandLine: whitespace splitting, quote grouping, escaped quotes, and unterminated-quote rejection", () => {
  assert.deepEqual(parseCommandLine("pnpm test"), ["pnpm", "test"]);
  assert.deepEqual(parseCommandLine("  npx   playwright  test  "), ["npx", "playwright", "test"]);
  assert.deepEqual(parseCommandLine(`npx playwright test --grep "login flow"`), ["npx", "playwright", "test", "--grep", "login flow"]);
  assert.deepEqual(parseCommandLine(`node -e 'console.log(1)'`), ["node", "-e", "console.log(1)"]);
  assert.deepEqual(parseCommandLine(`echo "say \\"hi\\""`), ["echo", `say "hi"`]);
  assert.deepEqual(parseCommandLine(`run ""`), ["run", ""]);
  assert.deepEqual(parseCommandLine(""), []);
  assert.throws(() => parseCommandLine(`npx "unterminated`), /Unterminated/);
});

test("buildSandboxEnv: drops API secrets and non-allowlisted vars, replaces parent NODE_OPTIONS with a heap cap", (t) => {
  const saved = { ...process.env };
  t.after(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  process.env.OPENAI_API_KEY = "sk-should-never-leak";
  process.env.DATABASE_URL = "postgres://user:pw@host/db";
  process.env.TM_RANDOM_SETTING = "x";
  process.env.NODE_OPTIONS = "--require ./evil.js";

  const env = buildSandboxEnv({ CI: "true" }, { nodeHeapMb: 1234 });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.TM_RANDOM_SETTING, undefined);
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=1234");
  assert.equal(env.CI, "true");
  assert.ok(env.PATH || env.Path, "PATH must be kept so toolchains resolve");
});

test("runSandboxed: the child really does not see parent secrets, and the Node heap cap is applied", async (t) => {
  const dir = await mkDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const prev = process.env.TM_SANDBOX_SECRET_PROBE_KEY;
  process.env.TM_SANDBOX_SECRET_PROBE_KEY = "leaked-value";
  t.after(() => { if (prev === undefined) delete process.env.TM_SANDBOX_SECRET_PROBE_KEY; else process.env.TM_SANDBOX_SECRET_PROBE_KEY = prev; });

  const script = "const v8=require('v8');console.log(JSON.stringify({probe:process.env.TM_SANDBOX_SECRET_PROBE_KEY??null,heapMb:Math.round(v8.getHeapStatistics().heap_size_limit/1048576)}))";
  const result = await runSandboxed(NODE, ["-e", script], { cwd: dir, timeoutMs: 30_000, maxOutputChars: 4000, env: buildSandboxEnv({}, { nodeHeapMb: 512 }) });
  assert.equal(result.exitCode, 0, result.output);
  const parsed = JSON.parse(result.output.trim());
  assert.equal(parsed.probe, null);
  assert.ok(parsed.heapMb <= 600, `heap limit should be ~512MB, got ${parsed.heapMb}`);
});

test("runSandboxed: timeout kills the whole process tree, including grandchildren", async (t) => {
  const dir = await mkDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const pidFile = path.join(dir, "grandchild.pid");
  // Parent spawns a long-lived grandchild, records its pid, then hangs itself.
  const script = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;

  const started = Date.now();
  const result = await runSandboxed(NODE, ["-e", script], { cwd: dir, timeoutMs: 2000, maxOutputChars: 1000 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 20_000, "must not hang past the timeout");

  const grandchildPid = Number(await fs.readFile(pidFile, "utf8"));
  // taskkill /T is synchronous but give the OS a moment to reap.
  for (let i = 0; i < 20 && isAlive(grandchildPid); i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(isAlive(grandchildPid), false, "grandchild must be killed with the tree, not orphaned");
});

test("runSandboxed: output is bounded to a rolling tail (never an unbounded buffer)", async (t) => {
  const dir = await mkDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const script = "for(let i=0;i<20000;i++)console.log('line '+i);console.log('FINAL-MARKER')";
  const result = await runSandboxed(NODE, ["-e", script], { cwd: dir, timeoutMs: 30_000, maxOutputChars: 500 });
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.length <= 500);
  assert.equal(result.outputTruncated, true);
  assert.match(result.output, /FINAL-MARKER/, "the tail (where failures are reported) must be kept");
});

test("runSandboxed: a missing binary is reported as a spawn error, not a crash", async (t) => {
  const dir = await mkDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const result = await runSandboxed("tm-definitely-not-a-real-binary-xyz", [], { cwd: dir, timeoutMs: 10_000, maxOutputChars: 1000 });
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.spawnError || result.exitCode !== null);
});

test("runConfiguredTestCommand: passes only on exit 0; non-zero, timeout, bad quoting, and missing binary all fail", async (t) => {
  const dir = await mkDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const fakeRunId = "tm-sandbox-test-nonexistent-run";
  const nodeCmd = `"${NODE}"`;

  const pass = await runConfiguredTestCommand(dir, `${nodeCmd} -e "console.log('all good')"`, fakeRunId);
  assert.equal(pass.passed, true, pass.output);
  assert.match(pass.output, /all good/);

  const fail = await runConfiguredTestCommand(dir, `${nodeCmd} -e "process.exit(3)"`, fakeRunId);
  assert.equal(fail.passed, false);

  const badQuote = await runConfiguredTestCommand(dir, `${nodeCmd} -e "unterminated`, fakeRunId);
  assert.equal(badQuote.passed, false);
  assert.match(badQuote.output, /Invalid test command/);

  const missing = await runConfiguredTestCommand(dir, "tm-definitely-not-a-real-binary-xyz", fakeRunId);
  assert.equal(missing.passed, false);

  const prev = process.env.DEV_AGENT_TEST_TIMEOUT_MS;
  process.env.DEV_AGENT_TEST_TIMEOUT_MS = "1500";
  t.after(() => { if (prev === undefined) delete process.env.DEV_AGENT_TEST_TIMEOUT_MS; else process.env.DEV_AGENT_TEST_TIMEOUT_MS = prev; });
  const hang = await runConfiguredTestCommand(dir, `${nodeCmd} -e "setInterval(()=>{},1000)"`, fakeRunId);
  assert.equal(hang.passed, false);
  assert.match(hang.output, /timed out/);
});

test("runConfiguredTestCommand: the test process cannot read the API's secrets", async (t) => {
  const dir = await mkDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const prev = process.env.TM_SANDBOX_TEST_CMD_SECRET;
  process.env.TM_SANDBOX_TEST_CMD_SECRET = "leaked";
  t.after(() => { if (prev === undefined) delete process.env.TM_SANDBOX_TEST_CMD_SECRET; else process.env.TM_SANDBOX_TEST_CMD_SECRET = prev; });

  // Exits 0 only if the secret is NOT visible - so "passed" proves isolation.
  const result = await runConfiguredTestCommand(dir, `"${NODE}" -e "process.exit(process.env.TM_SANDBOX_TEST_CMD_SECRET ? 1 : 0)"`, "tm-sandbox-test-nonexistent-run");
  assert.equal(result.passed, true, result.output);
});
