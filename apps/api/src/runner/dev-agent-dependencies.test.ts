import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectPackageManager, provisionWorktreeDependencies } from "./dev-agent-dependencies.js";

async function mkRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-dev-agent-deps-test-"));
  return dir;
}

test("detectPackageManager recognizes each lockfile and returns null for none", async (t) => {
  const dir = await mkRepo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));

  assert.equal(detectPackageManager(dir), null);

  await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  assert.equal(detectPackageManager(dir), "pnpm");
  await fs.rm(path.join(dir, "pnpm-lock.yaml"));

  await fs.writeFile(path.join(dir, "package-lock.json"), "{}");
  assert.equal(detectPackageManager(dir), "npm");
  await fs.rm(path.join(dir, "package-lock.json"));

  await fs.writeFile(path.join(dir, "yarn.lock"), "");
  assert.equal(detectPackageManager(dir), "yarn");
  await fs.rm(path.join(dir, "yarn.lock"));

  await fs.writeFile(path.join(dir, "bun.lockb"), "");
  assert.equal(detectPackageManager(dir), "bun");
  await fs.rm(path.join(dir, "bun.lockb"));

  await fs.writeFile(path.join(dir, "bun.lock"), "{}");
  assert.equal(detectPackageManager(dir), "bun");
  await fs.rm(path.join(dir, "bun.lock"));

  await fs.writeFile(path.join(dir, "npm-shrinkwrap.json"), "{}");
  assert.equal(detectPackageManager(dir), "npm");
  await fs.rm(path.join(dir, "npm-shrinkwrap.json"));
});

test("detectPackageManager distinguishes Yarn Berry (.yarnrc.yml or packageManager yarn@2+) from classic Yarn", async (t) => {
  const dir = await mkRepo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  await fs.writeFile(path.join(dir, "yarn.lock"), "");
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", packageManager: "yarn@1.22.22" }));
  assert.equal(detectPackageManager(dir), "yarn");

  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", packageManager: "yarn@4.5.0" }));
  assert.equal(detectPackageManager(dir), "yarn-berry");

  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  await fs.writeFile(path.join(dir, ".yarnrc.yml"), "nodeLinker: node-modules\n");
  assert.equal(detectPackageManager(dir), "yarn-berry");
});

test("provisionWorktreeDependencies: neither the root nor a dependency lifecycle script runs during install (dependency still installed)", async (t) => {
  const dir = await mkRepo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const prev = process.env.TM_DEPS_TEST_SECRET_KEY;
  process.env.TM_DEPS_TEST_SECRET_KEY = "leaked";
  t.after(() => { if (prev === undefined) delete process.env.TM_DEPS_TEST_SECRET_KEY; else process.env.TM_DEPS_TEST_SECRET_KEY = prev; });

  // A local file: dependency with a postinstall hook that would drop a marker file
  // (including any secret it could read). --ignore-scripts must stop it entirely.
  const depDir = path.join(dir, "evil-dep");
  await fs.mkdir(depDir);
  const marker = path.join(dir, "POSTINSTALL_RAN");
  await fs.writeFile(path.join(depDir, "package.json"), JSON.stringify({
    name: "evil-dep", version: "1.0.0",
    scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.env.TM_DEPS_TEST_SECRET_KEY))"` },
  }));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "tm-test-fixture", version: "1.0.0", private: true,
    scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'root')"` },
    dependencies: { "evil-dep": "file:./evil-dep" },
  }));
  await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), [
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "  excludeLinksFromLockfile: false",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      evil-dep:",
    "        specifier: file:./evil-dep",
    "        version: file:evil-dep",
    "",
    "packages:",
    "",
    "  evil-dep@file:evil-dep:",
    "    resolution: {directory: evil-dep, type: directory}",
    "    requiresBuild: true",
    "",
    "snapshots:",
    "",
    "  evil-dep@file:evil-dep: {}",
    "",
  ].join("\n"));

  const result = await provisionWorktreeDependencies(dir);
  assert.deepEqual(result, { ok: true, packageManager: "pnpm" }, JSON.stringify(result));
  await assert.rejects(fs.stat(marker), "no lifecycle script (root or dependency) may run during provisioning");
  const installed = await fs.lstat(path.join(dir, "node_modules", "evil-dep")).catch(() => null);
  assert.ok(installed, "the dependency itself must still be installed");
});

test("provisionWorktreeDependencies: install timeout is enforced and reported explicitly", async (t) => {
  const dir = await mkRepo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", private: true }));
  await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n");
  const prev = process.env.DEV_AGENT_INSTALL_TIMEOUT_MS;
  process.env.DEV_AGENT_INSTALL_TIMEOUT_MS = "1"; // nothing can finish in 1ms
  t.after(() => { if (prev === undefined) delete process.env.DEV_AGENT_INSTALL_TIMEOUT_MS; else process.env.DEV_AGENT_INSTALL_TIMEOUT_MS = prev; });

  const result = await provisionWorktreeDependencies(dir);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /timed out/);
});

test("provisionWorktreeDependencies: no package.json at all means nothing to provision (not every target repo is a JS project)", async (t) => {
  const dir = await mkRepo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  await fs.writeFile(path.join(dir, "README.md"), "hello\n");

  const result = await provisionWorktreeDependencies(dir);
  assert.deepEqual(result, { ok: true, packageManager: null });
});

test("provisionWorktreeDependencies: package.json with no recognized lockfile fails closed with an explicit reason", async (t) => {
  const dir = await mkRepo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));

  const result = await provisionWorktreeDependencies(dir);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /no recognized lockfile/);
});

test("provisionWorktreeDependencies: a real zero-dependency pnpm-lock.yaml installs reproducibly and offline, never copying node_modules from elsewhere", async (t) => {
  const dir = await mkRepo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "tm-test-fixture", version: "1.0.0", private: true }));
  await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n");

  const before = await fs.stat(dir).then(() => true).catch(() => false);
  assert.ok(before);

  const result = await provisionWorktreeDependencies(dir);
  assert.deepEqual(result, { ok: true, packageManager: "pnpm" });

  // pnpm may omit node_modules entirely for a zero-dependency project on Linux. If it
  // creates one, it must be local storage rather than a link to another checkout.
  const nodeModulesPath = path.join(dir, "node_modules");
  const stat = await fs.lstat(nodeModulesPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat) {
    assert.ok(stat.isDirectory(), "node_modules must be a real directory");
    assert.ok(!stat.isSymbolicLink(), "node_modules must never be a symlink/junction");
  }
});

test("provisionWorktreeDependencies: an unparseable/corrupt lockfile fails closed with the real package-manager error surfaced, not a crash", async (t) => {
  const dir = await mkRepo();
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "this is not valid yaml lockfile content: [[[");

  const result = await provisionWorktreeDependencies(dir);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.error.length > 0);
});
