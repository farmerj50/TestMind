// Per-run access for the unified autonomous agent: credentials supplied for ONE run, and optional
// repository access scoped to ONE run through the project's authorized GitHub integration.
//
// - Run credentials are stored encrypted as ProjectSecrets under unique temporary keys, referenced
//   by key exactly like saved credentials (never placed in context, prompts, tests, logs or
//   artifacts), and deleted when the run ends (finalize or cancel).
// - Repositories must be authorized by the project's GitHub integration, or readable by the project
//   owner's connected GitHub account (verified with GitHub). They are fetched as a shallow,
//   run-scoped temporary checkout and deleted after use - no persistent clone or cache.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma } from "../prisma.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { CredentialRef } from "./qe-credentials.js";
import { getOctokitForProject } from "../runner/github-writeback.js";
import { cloneRepo } from "../runner/git.js";

// ── Credentials supplied for one run ────────────────────────────────────────

export const RUN_CREDENTIAL_KEY_PREFIX = "TM_QE_RUN_";

export async function storeRunCredentials(projectId: string, input: { email: string; password: string; loginPath?: string }): Promise<{ ref: CredentialRef; keys: string[] }> {
  const id = randomBytes(6).toString("hex").toUpperCase();
  const emailKey = `${RUN_CREDENTIAL_KEY_PREFIX}${id}_EMAIL`;
  const passwordKey = `${RUN_CREDENTIAL_KEY_PREFIX}${id}_PASSWORD`;
  const name = "Autonomous run credential (temporary - deleted when the run ends)";
  await prisma.projectSecret.createMany({ data: [
    { projectId, name, key: emailKey, value: encryptSecret(input.email) },
    { projectId, name, key: passwordKey, value: encryptSecret(input.password) },
  ] });
  return { ref: { emailKey, passwordKey, ...(input.loginPath ? { loginPath: input.loginPath } : {}) }, keys: [emailKey, passwordKey] };
}

/** Deletes a run's temporary credentials (idempotent). Only keys with the run-credential prefix are ever touched. */
export async function releaseRunCredentials(jobId: string): Promise<number> {
  const job = await prisma.operatorJob.findUnique({ where: { id: jobId }, select: { projectId: true, contextJson: true } });
  const keys: unknown = (job?.contextJson as any)?.qe?.runCredentialKeys;
  if (!job || !Array.isArray(keys)) return 0;
  const safe = keys.filter((k): k is string => typeof k === "string" && k.startsWith(RUN_CREDENTIAL_KEY_PREFIX));
  if (!safe.length) return 0;
  const r = await prisma.projectSecret.deleteMany({ where: { projectId: job.projectId, key: { in: safe } } });
  return r.count;
}

// ── Repository access scoped to one run ─────────────────────────────────────

export type RepoAccess = { url: string; owner: string; repo: string; branch: string; token?: string };

/** "owner/repo", "https://github.com/owner/repo(.git)" or "git@github.com:owner/repo.git" -> owner/repo. */
export function parseGitHubRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}

const validBranch = (b: string) => /^[A-Za-z0-9._\/-]{1,200}$/.test(b) && !b.includes("..");

/** The project owner's connected GitHub account token (Dashboard "Connect GitHub"), or null. Never logged. */
export async function ownerGitHubToken(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
  if (!project) return null;
  const account = await prisma.gitAccount.findUnique({ where: { provider_userId: { provider: "github", userId: project.ownerId } }, select: { token: true } });
  if (!account?.token) return null;
  try { return decryptSecret(account.token); } catch { return account.token; } // legacy plaintext tokens
}

type GitHubRepoInfo = { full_name: string; default_branch?: string; permissions?: { pull?: boolean } };
type RepoLookup = (owner: string, repo: string, token: string) => Promise<{ status: number; body: GitHubRepoInfo | null }>;
const githubRepoLookup: RepoLookup = async (owner, repo, token) => {
  const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "TestMindAI" },
  });
  return { status: r.status, body: r.ok ? ((await r.json()) as GitHubRepoInfo) : null };
};

/**
 * Authorizes repository access for one run. The project's GitHub integration is used when it
 * authorizes the requested repository; otherwise the project OWNER's connected GitHub account is
 * used, and only after GitHub confirms that account can read the repository. Returns the clone URL,
 * branch and token (kept in memory only), or a user-facing reason.
 */
export async function authorizeRunRepository(
  projectId: string,
  input: string,
  branch?: string,
  deps: { lookup?: RepoLookup } = {},
): Promise<{ ok: true; access: RepoAccess } | { ok: false; reason: string }> {
  const wanted = parseGitHubRepo(input);
  if (!wanted) return { ok: false, reason: "Enter a GitHub repository as owner/repo or https://github.com/owner/repo" };
  const requested = (branch ?? "").trim();
  if (requested && !validBranch(requested)) return { ok: false, reason: "Invalid branch name" };

  const gh = await getOctokitForProject(projectId).catch(() => null);
  if (gh && gh.owner.toLowerCase() === wanted.owner.toLowerCase() && gh.repo.toLowerCase() === wanted.repo.toLowerCase()) {
    let token: string | undefined;
    try { token = ((await (gh.octokit as any).auth()) as { token?: string })?.token; } catch { /* public repositories still clone */ }
    return { ok: true, access: { url: `https://github.com/${gh.owner}/${gh.repo}`, owner: gh.owner, repo: gh.repo, branch: requested || gh.defaultBranch || "main", ...(token ? { token } : {}) } };
  }

  const token = await ownerGitHubToken(projectId);
  if (!token) {
    return { ok: false, reason: gh
      ? `This project's GitHub integration authorizes ${gh.owner}/${gh.repo}, not ${wanted.owner}/${wanted.repo}; connect GitHub on the Dashboard to use your other repositories`
      : "Connect GitHub (Dashboard -> Connect GitHub) before giving the agent repository access" };
  }
  const found = await (deps.lookup ?? githubRepoLookup)(wanted.owner, wanted.repo, token).catch(() => ({ status: 0, body: null }));
  if (found.status === 401) return { ok: false, reason: "Your GitHub connection has expired - reconnect GitHub on the Dashboard" };
  if (found.status !== 200 || !found.body || found.body.permissions?.pull === false) {
    return { ok: false, reason: `Your connected GitHub account cannot access ${wanted.owner}/${wanted.repo}` };
  }
  const [owner, repo] = found.body.full_name.split("/");
  return { ok: true, access: { url: `https://github.com/${owner}/${repo}`, owner, repo, branch: requested || found.body.default_branch || "main", token } };
}

const CHECKOUT_ROOT = path.join(os.tmpdir(), "tm-run-repos");

/** Git errors can echo the auth header passed via `-c`; never let a token reach logs or stage reasons. */
export function redactGitError(message: string, token?: string): string {
  let out = message.replace(/Authorization: (?:Basic|Bearer) [A-Za-z0-9+/=._-]+/gi, "Authorization: [redacted]");
  if (token) out = out.split(token).join("[redacted]").split(Buffer.from(`x-access-token:${token}`).toString("base64")).join("[redacted]");
  return out.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]").slice(0, 600);
}

/** Shallow checkout of `access.branch` for one run; always removed afterwards. */
export async function withRunCheckout<T>(runId: string, access: RepoAccess, fn: (root: string) => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error("Invalid run id");
  const dir = path.join(CHECKOUT_ROOT, runId);
  await fs.mkdir(CHECKOUT_ROOT, { recursive: true });
  try {
    try {
      await cloneRepo(access.url, dir, access.token, access.branch);
    } catch (err: any) {
      throw new Error(`Could not fetch ${access.owner}/${access.repo}@${access.branch}: ${redactGitError(String(err?.stderr || err?.message || err), access.token)}`);
    }
    return await fn(dir);
  } finally {
    if (path.resolve(dir).startsWith(path.resolve(CHECKOUT_ROOT) + path.sep)) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
