import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import { cloneRepo } from "./git.js";

// Correction #1 (approved plan): every worktree this feature creates/removes must be
// scoped to its own DevAgentRun only. All disposable worktrees live under this one root,
// one subdirectory per run, named exactly by run id - removal re-derives and re-verifies
// this exact path before any destructive filesystem action, never trusting a path handed
// in from elsewhere. This directly guards against the junction-recursion incident earlier
// in this engagement, where a cleanup step was allowed to operate on a path it hadn't
// independently verified.
const WORKTREES_ROOT = path.join(os.tmpdir(), "tm-dev-agent-worktrees");

// Base clones (for external target repos) live in their own disposable root, separate
// from the worktrees themselves, so a worktree is always `git worktree add` off a real
// local .git, never off a path we're simultaneously treating as disposable-and-removable.
const BASE_CLONES_ROOT = path.join(os.tmpdir(), "tm-dev-agent-base-clones");

function worktreePathFor(runId: string): string {
  return path.join(WORKTREES_ROOT, runId);
}

function branchNameFor(runId: string): string {
  return `dev-agent/${runId}`;
}

// "testmind" resolves to this monorepo's own local checkout (no clone needed - we already
// have it on disk). Any other value is treated as a repo URL/identifier and is cloned
// fresh into a disposable, run-scoped base-clone directory.
async function resolveBaseRepoPath(runId: string, targetRepo: string): Promise<string> {
  if (targetRepo === "testmind") {
    // Same TM_LOCAL_REPO_ROOT override convention already used by git.ts/workdir.ts -
    // lets tests point this at a disposable local repo instead of the real monorepo.
    return process.env.TM_LOCAL_REPO_ROOT?.trim()
      ? path.resolve(process.env.TM_LOCAL_REPO_ROOT)
      : path.resolve(process.cwd(), "..", "..");
  }
  const baseClonePath = path.join(BASE_CLONES_ROOT, runId);
  await fs.mkdir(path.dirname(baseClonePath), { recursive: true });
  await cloneRepo(targetRepo, baseClonePath);
  return baseClonePath;
}

export type DevAgentWorktreeRef = { path: string; branch: string; baseRepoPath: string };

export async function createDevAgentWorktree(run: { id: string; targetRepo: string }): Promise<DevAgentWorktreeRef> {
  const worktreePath = worktreePathFor(run.id);
  const branch = branchNameFor(run.id);
  const baseRepoPath = await resolveBaseRepoPath(run.id, run.targetRepo);

  await fs.mkdir(WORKTREES_ROOT, { recursive: true });
  // If a prior attempt for this exact run left a worktree registered, clear it first -
  // still scoped to this run's own deterministic path, not an arbitrary caller-supplied one.
  // The branch must be deleted too, not just the worktree: "git worktree add -b" fails with
  // "a branch named '...' already exists" otherwise, permanently blocking any resumed/retried
  // attempt for this exact run id (same gap already fixed in removeDevAgentWorktree).
  await execa("git", ["worktree", "remove", "--force", worktreePath], { cwd: baseRepoPath }).catch(() => {});
  await execa("git", ["branch", "-D", branch], { cwd: baseRepoPath }).catch(() => {});
  await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});

  await execa("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: baseRepoPath });

  return { path: worktreePath, branch, baseRepoPath };
}

// Ownership check (correction #1): resolves the expected path for this exact run and
// refuses to touch anything else, even if `run.worktreePath` on the DB row were ever
// corrupted or pointed somewhere unexpected - the removal target is always re-derived
// from the run id, never trusted verbatim from a caller-supplied field.
export async function removeDevAgentWorktree(run: { id: string; targetRepo: string; worktreePath?: string | null }): Promise<void> {
  const expectedPath = worktreePathFor(run.id);
  if (run.worktreePath && path.resolve(run.worktreePath) !== path.resolve(expectedPath)) {
    throw new Error(
      `Refusing to remove worktree: recorded path "${run.worktreePath}" does not match the expected owned path "${expectedPath}" for DevAgentRun ${run.id}`
    );
  }
  const resolvedTarget = path.resolve(expectedPath);
  if (path.resolve(WORKTREES_ROOT) === resolvedTarget || !resolvedTarget.startsWith(path.resolve(WORKTREES_ROOT) + path.sep)) {
    throw new Error(`Refusing to remove worktree outside the owned worktrees root: ${resolvedTarget}`);
  }

  const baseRepoPath = await resolveBaseRepoPath(run.id, run.targetRepo).catch(() => null);
  if (baseRepoPath) {
    await execa("git", ["worktree", "remove", "--force", expectedPath], { cwd: baseRepoPath }).catch(() => {});
    // Removing the worktree does not delete its branch - without this, a failed run's
    // branch (named after the run id) lingers forever, and any retry that re-creates a
    // worktree for the same run id fails with "a branch named '...' already exists".
    await execa("git", ["branch", "-D", branchNameFor(run.id)], { cwd: baseRepoPath }).catch(() => {});
  }
  await fs.rm(expectedPath, { recursive: true, force: true });

  if (run.targetRepo !== "testmind") {
    const baseClonePath = path.join(BASE_CLONES_ROOT, run.id);
    if (path.resolve(baseClonePath).startsWith(path.resolve(BASE_CLONES_ROOT) + path.sep)) {
      await fs.rm(baseClonePath, { recursive: true, force: true }).catch(() => {});
    }
  }
}
