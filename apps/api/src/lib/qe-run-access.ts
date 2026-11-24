// Per-run access for the unified autonomous agent: credentials supplied for ONE run, and optional
// repository access scoped to ONE run through the project's authorized GitHub integration.
//
// - Run credentials are stored encrypted as ProjectSecrets under unique temporary keys, referenced
//   by key exactly like saved credentials (never placed in context, prompts, tests, logs or
//   artifacts), and deleted when the run ends (finalize or cancel).
// - Repositories must be the one the project's GitHub integration authorizes. They are fetched as a
//   shallow, run-scoped temporary checkout and deleted after use - no persistent clone or cache.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma } from "../prisma.js";
import { encryptSecret } from "./crypto.js";
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

/**
 * The repository must be the one this project's GitHub integration authorizes. Returns the clone
 * URL, branch and integration token (kept in memory only), or a user-facing reason.
 */
export async function authorizeRunRepository(projectId: string, input: string, branch?: string): Promise<{ ok: true; access: RepoAccess } | { ok: false; reason: string }> {
  const wanted = parseGitHubRepo(input);
  if (!wanted) return { ok: false, reason: "Enter a GitHub repository as owner/repo or https://github.com/owner/repo" };
  const gh = await getOctokitForProject(projectId).catch(() => null);
  if (!gh) return { ok: false, reason: "Connect this project's GitHub integration before giving the agent repository access" };
  if (gh.owner.toLowerCase() !== wanted.owner.toLowerCase() || gh.repo.toLowerCase() !== wanted.repo.toLowerCase()) {
    return { ok: false, reason: `This project's GitHub integration authorizes ${gh.owner}/${gh.repo}, not ${wanted.owner}/${wanted.repo}` };
  }
  let token: string | undefined;
  try { token = ((await (gh.octokit as any).auth()) as { token?: string })?.token; } catch { /* public repositories still clone */ }
  const b = (branch ?? "").trim() || gh.defaultBranch || "main";
  if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(b) || b.includes("..")) return { ok: false, reason: "Invalid branch name" };
  return { ok: true, access: { url: `https://github.com/${gh.owner}/${gh.repo}`, owner: gh.owner, repo: gh.repo, branch: b, ...(token ? { token } : {}) } };
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
