import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

// Contract the LLM's "code" response must follow to be mechanically appliable. Full-file
// content (never a unified diff) - this codebase's own self-heal write-back
// (github-writeback.ts) writes whole files too, so this follows that precedent rather than
// inventing diff-parsing/patch-application, which is far more failure-prone to apply correctly.
export type FileOp = {
  path: string;
  action: "create" | "modify" | "delete";
  content?: string;
};

export class InvalidFileOpsError extends Error {}

// Strict parse + shape validation. Tolerates a markdown code fence around the JSON (common
// LLM habit) but otherwise rejects anything that isn't exactly this shape - this is a
// security boundary (path traversal) as well as a correctness one, so "be lenient" is the
// wrong instinct here.
export function parseFileOps(raw: string): FileOp[] {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new InvalidFileOpsError("Code phase response was not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new InvalidFileOpsError("Code phase response must be a JSON array of file operations");
  if (parsed.length === 0) throw new InvalidFileOpsError("Code phase response contained zero file operations");

  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) throw new InvalidFileOpsError(`File op [${index}] is not an object`);
    const { path: p, action, content } = item as Record<string, unknown>;
    if (typeof p !== "string" || p.length === 0) throw new InvalidFileOpsError(`File op [${index}] is missing a valid "path"`);
    if (action !== "create" && action !== "modify" && action !== "delete") {
      throw new InvalidFileOpsError(`File op [${index}] has an invalid "action": ${String(action)}`);
    }
    if ((action === "create" || action === "modify") && typeof content !== "string") {
      throw new InvalidFileOpsError(`File op [${index}] (${action}) is missing string "content"`);
    }
    return { path: p, action, content: typeof content === "string" ? content : undefined };
  });
}

// Path-traversal safety for files that may not exist yet (fs.realpath-based confinedPath,
// used elsewhere in this codebase for already-existing artifacts, requires the path to
// exist - a "create" action's target deliberately does not yet exist, so that function
// doesn't fit here). Same resolve-and-startsWith discipline dev-agent-worktree.ts already
// uses for its own removal-safety check, applied here for writes instead.
export function safeResolveWithinWorktree(worktreePath: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new InvalidFileOpsError(`File op path must be relative, got absolute path: ${relativePath}`);
  const root = path.resolve(worktreePath);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new InvalidFileOpsError(`File op path escapes the worktree root: ${relativePath}`);
  }
  return resolved;
}

export type AppliedFileChange = { path: string; content?: string };

// Applies validated file operations for real inside the run's own worktree. Returns
// {path, content?} per change for DevAgentIteration.filesChanged - content is present for
// create/modify (this is what dev-agent-pr.ts's collectFileChanges later reads to assemble a
// PR, since the worktree may already be torn down by the time a PR is published - a separate,
// later-triggered route, not assumed to run before cleanup) and omitted for delete (nothing to
// show as file content, but the path is still recorded so the dashboard can show it occurred).
// Fails closed: the first invalid op throws before anything is written (parseFileOps already
// validated shape; this function re-validates path safety per-op as a second, independent layer).
export async function applyFileOps(worktreePath: string, ops: FileOp[]): Promise<AppliedFileChange[]> {
  const changed: AppliedFileChange[] = [];
  for (const op of ops) {
    const target = safeResolveWithinWorktree(worktreePath, op.path);
    if (op.action === "delete") {
      await fs.rm(target, { force: true });
      changed.push({ path: op.path });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, op.content ?? "", "utf8");
      changed.push({ path: op.path, content: op.content ?? "" });
    }
  }
  return changed;
}

// `git add -A && git commit` on the run's own worktree/branch. No-op (not an error) if
// there is genuinely nothing to commit, since a "code" response could in principle be a
// pure delete of already-deleted files or re-assert identical content.
// Dev Agent commits always carry this fixed identity, passed per command: production containers
// have no git user configured ("Author identity unknown"), and no global git config is changed.
export const DEV_AGENT_GIT_IDENTITY = ["-c", "user.name=TestMind Dev Agent", "-c", "user.email=dev-agent@testmind.invalid"] as const;

export async function commitChanges(worktreePath: string, message: string): Promise<{ committed: boolean }> {
  await execa("git", ["add", "-A"], { cwd: worktreePath });
  const status = await execa("git", ["status", "--porcelain"], { cwd: worktreePath });
  if (!status.stdout.trim()) return { committed: false };
  await execa("git", [...DEV_AGENT_GIT_IDENTITY, "commit", "-m", message], { cwd: worktreePath });
  return { committed: true };
}
