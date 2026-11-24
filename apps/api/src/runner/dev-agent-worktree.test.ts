import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { createDevAgentWorktree, removeDevAgentWorktree, localTestmindRepoPath, NO_LOCAL_TESTMIND_REPO_MESSAGE } from "./dev-agent-worktree.js";

async function makeDisposableGitRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-dev-agent-test-repo-"));
  await execa("git", ["init", "-q"], { cwd: dir });
  await execa("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "Test"], { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), "hello\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

test("createDevAgentWorktree creates a real worktree with its own branch off a disposable local repo", async (t) => {
  const repo = await makeDisposableGitRepo();
  const prevRoot = process.env.TM_LOCAL_REPO_ROOT;
  process.env.TM_LOCAL_REPO_ROOT = repo;
  t.after(async () => {
    process.env.TM_LOCAL_REPO_ROOT = prevRoot;
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  const runId = `test-run-${Date.now()}`;
  const ref = await createDevAgentWorktree({ id: runId, targetRepo: "testmind" });

  const stat = await fs.stat(ref.path);
  assert.ok(stat.isDirectory());
  const list = await execa("git", ["worktree", "list"], { cwd: repo });
  assert.ok(list.stdout.includes(ref.path.replace(/\\/g, "/")) || list.stdout.includes(ref.path));
  assert.equal(ref.branch, `dev-agent/${runId}`);

  await removeDevAgentWorktree({ id: runId, targetRepo: "testmind", worktreePath: ref.path });
  await assert.rejects(fs.stat(ref.path));
  const listAfter = await execa("git", ["worktree", "list"], { cwd: repo });
  assert.ok(!listAfter.stdout.includes(ref.path));
});

test("removeDevAgentWorktree refuses to remove a path that doesn't match the run's owned path", async (t) => {
  const repo = await makeDisposableGitRepo();
  const prevRoot = process.env.TM_LOCAL_REPO_ROOT;
  process.env.TM_LOCAL_REPO_ROOT = repo;
  t.after(async () => {
    process.env.TM_LOCAL_REPO_ROOT = prevRoot;
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  const runId = `test-run-${Date.now()}-b`;
  await createDevAgentWorktree({ id: runId, targetRepo: "testmind" });

  // Someone/something corrupted the recorded path to point somewhere unrelated -
  // this must refuse, not delete whatever happens to be at that unrelated path.
  const unrelatedPath = await fs.mkdtemp(path.join(os.tmpdir(), "tm-unrelated-"));
  t.after(() => fs.rm(unrelatedPath, { recursive: true, force: true }).catch(() => {}));

  await assert.rejects(
    removeDevAgentWorktree({ id: runId, targetRepo: "testmind", worktreePath: unrelatedPath }),
    /does not match the expected owned path/
  );
  const stillThere = await fs.stat(unrelatedPath);
  assert.ok(stillThere.isDirectory(), "the unrelated path must be untouched");

  await removeDevAgentWorktree({ id: runId, targetRepo: "testmind" });
});

test("'testmind' without a local Git checkout (production containers) fails fast and points to Autonomous QE", async (t) => {
  const notARepo = await fs.mkdtemp(path.join(os.tmpdir(), "tm-dev-agent-no-git-"));
  const prevRoot = process.env.TM_LOCAL_REPO_ROOT;
  process.env.TM_LOCAL_REPO_ROOT = notARepo;
  t.after(async () => {
    process.env.TM_LOCAL_REPO_ROOT = prevRoot;
    await fs.rm(notARepo, { recursive: true, force: true }).catch(() => {});
  });
  assert.equal(localTestmindRepoPath(), null);
  await assert.rejects(createDevAgentWorktree({ id: `test-run-nogit-${Date.now()}`, targetRepo: "testmind" }), (e: any) => e.message === NO_LOCAL_TESTMIND_REPO_MESSAGE);
  assert.match(NO_LOCAL_TESTMIND_REPO_MESSAGE, /Autonomous QE \(\/operator\/qe\)/);
  // Nothing was created for the rejected run.
  assert.deepEqual((await fs.readdir(notARepo)), []);
});

test("'testmind' with a real local Git checkout is still available (legitimate repository tasks unchanged)", async (t) => {
  const repo = await makeDisposableGitRepo();
  const prevRoot = process.env.TM_LOCAL_REPO_ROOT;
  process.env.TM_LOCAL_REPO_ROOT = repo;
  t.after(async () => {
    process.env.TM_LOCAL_REPO_ROOT = prevRoot;
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  });
  assert.equal(localTestmindRepoPath(), path.resolve(repo));
});
