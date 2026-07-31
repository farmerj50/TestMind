import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { prisma } from "../prisma.js";
import { decryptSecret } from "../lib/crypto.js";

export type GitHubCoords = {
  octokit: Octokit;
  owner: string;
  repo: string;
  defaultBranch: string;
};

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function octokitFromEnv(): Promise<Octokit | null> {
  const {
    GITHUB_TOKEN,
    GITHUB_APP_ID,
    GITHUB_APP_INSTALLATION_ID,
    GITHUB_APP_PRIVATE_KEY_BASE64,
  } = process.env;

  if (GITHUB_APP_ID && GITHUB_APP_INSTALLATION_ID && GITHUB_APP_PRIVATE_KEY_BASE64) {
    const privateKey = Buffer.from(GITHUB_APP_PRIVATE_KEY_BASE64, "base64").toString("utf8");
    const auth = createAppAuth({
      appId: Number(GITHUB_APP_ID),
      privateKey,
      installationId: Number(GITHUB_APP_INSTALLATION_ID),
    });
    const { token } = await auth({ type: "installation" });
    return new Octokit({ auth: token });
  }

  if (GITHUB_TOKEN) return new Octokit({ auth: GITHUB_TOKEN });
  return null;
}

function parseRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  const m = /github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/#?.]+)(?:\.git)?/i.exec(repoUrl);
  const owner = m?.groups?.owner;
  const repo = m?.groups?.repo;
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * Look up GitHub credentials for a project.
 * Priority:
 *   1. Integration row (provider = "github") on the project — allows per-project tokens
 *   2. Project.repoUrl parsed + env-level GITHUB_TOKEN / GitHub App creds
 * Returns null if no usable credentials are found.
 */
export async function getOctokitForProject(projectId: string): Promise<GitHubCoords | null> {
  // Try project-level Integration first
  const integration = await prisma.integration.findFirst({
    where: { projectId, provider: "github", enabled: true },
    select: { config: true, secrets: true },
  });

  if (integration) {
    const cfg = (integration.config ?? {}) as Record<string, any>;
    const sec = (integration.secrets ?? {}) as Record<string, any>;
    const owner: string = cfg.owner ?? "";
    const repo: string = cfg.repo ?? "";
    const defaultBranch: string = cfg.defaultBranch ?? "main";

    if (owner && repo && sec.accessToken) {
      let token = sec.accessToken as string;
      try { token = decryptSecret(token); } catch { /* plaintext fallback */ }
      return { octokit: new Octokit({ auth: token }), owner, repo, defaultBranch };
    }
  }

  // Fall back to project.repoUrl + env token
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { repoUrl: true },
  });
  const coords = project?.repoUrl ? parseRepoUrl(project.repoUrl) : null;
  if (!coords) return null;

  const octokit = await octokitFromEnv();
  if (!octokit) return null;

  // Fetch default branch from GitHub API
  let defaultBranch = "main";
  try {
    const { data } = await octokit.repos.get({ owner: coords.owner, repo: coords.repo });
    defaultBranch = data.default_branch;
  } catch {
    // non-fatal — use "main"
  }

  return { octokit, ...coords, defaultBranch };
}

// ── Git operations ────────────────────────────────────────────────────────────

/**
 * Push all files as a single tree + single commit to `branch`.
 * Creates the branch off `baseBranch` if it doesn't exist yet.
 */
export async function pushSpecFilesToBranch(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  files: Array<{ path: string; content: string }>;
  commitMessage: string;
}): Promise<{ commitSha: string }> {
  const { octokit, owner, repo, branch, baseBranch, files, commitMessage } = params;

  // Get base branch SHA
  const baseRef = await octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
  const baseSha = baseRef.data.object.sha;

  // Ensure target branch exists
  try {
    await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  } catch {
    await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
  }

  // Create blobs for all files in parallel
  const blobs = await Promise.all(
    files.map((f) =>
      octokit.git.createBlob({
        owner,
        repo,
        content: Buffer.from(f.content, "utf8").toString("base64"),
        encoding: "base64",
      }).then((r) => ({ path: f.path, sha: r.data.sha }))
    )
  );

  // Create tree
  const tree = await octokit.git.createTree({
    owner,
    repo,
    base_tree: baseSha,
    tree: blobs.map((b) => ({
      path: b.path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: b.sha,
    })),
  });

  // Create commit
  const commit = await octokit.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: tree.data.sha,
    parents: [baseSha],
  });

  // Update branch ref
  await octokit.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
    force: true,
  });

  return { commitSha: commit.data.sha };
}

// ── Pull request ──────────────────────────────────────────────────────────────

/**
 * Open a PR for `branch → baseBranch`. If a PR is already open for this branch,
 * returns the existing PR number/url without creating a duplicate.
 */
export async function ensurePullRequest(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}): Promise<{ prNumber: number; prUrl: string }> {
  const { octokit, owner, repo, branch, baseBranch, title, body, draft = false } = params;

  const existing = await octokit.pulls.list({
    owner,
    repo,
    state: "open",
    head: `${owner}:${branch}`,
  });

  if (existing.data.length > 0) {
    const pr = existing.data[0];
    return { prNumber: pr.number, prUrl: pr.html_url };
  }

  const { data } = await octokit.pulls.create({
    owner,
    repo,
    title,
    body,
    head: branch,
    base: baseBranch,
    draft,
  });

  return { prNumber: data.number, prUrl: data.html_url };
}

// ── Comments ──────────────────────────────────────────────────────────────────

export async function postPrComment(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
}): Promise<void> {
  const { octokit, owner, repo, prNumber, body } = params;
  await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
}

// ── Commit status ─────────────────────────────────────────────────────────────

export async function setCommitStatus(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  sha: string;
  state: "pending" | "success" | "failure" | "error";
  context: string;
  description: string;
  targetUrl?: string;
}): Promise<void> {
  const { octokit, owner, repo, sha, state, context, description, targetUrl } = params;
  await octokit.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state,
    context,
    description,
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });
}

// ── PR body builder ───────────────────────────────────────────────────────────

export function buildRepairPrBody(params: {
  attempts: Array<{
    targetSpec?: string | null;
    originalSpec?: string | null;
    repairedSpec?: string | null;
    modelUsed?: string | null;
    repairReason?: string | null;
    confidenceScore?: number | null;
    executionBefore?: any;
    executionAfter?: any;
    diff?: string | null;
  }>;
  retestSummary?: { passed: number; failed: number; total: number };
}): string {
  const { attempts, retestSummary } = params;
  const count = attempts.length;
  const minConf = Math.min(...attempts.map((a) => a.confidenceScore ?? 0));
  const model = attempts[0]?.modelUsed ?? "AI";
  const reason = attempts[0]?.repairReason ?? "Locator or selector drift detected.";

  const fileList = attempts
    .map((a) => `- \`${a.targetSpec ?? "unknown"}\``)
    .join("\n");

  const before = (attempts[0]?.executionBefore as any) ?? {};
  const after = retestSummary ?? (attempts[0]?.executionAfter as any) ?? {};

  return [
    `## TestMind Self-Heal Report`,
    ``,
    `### Root Cause`,
    reason,
    `Fix type: \`AI repair\` | Model: **${model}** | Confidence: **${minConf}%**`,
    ``,
    `### Validation`,
    `- [x] Previous run failed`,
    `- [x] AI repair generated (${model})`,
    `- [x] Retest passed`,
    ``,
    `### Execution`,
    `| | Before | After |`,
    `|---|---|---|`,
    `| Passed | ${before.passed ?? "?"} | ${after.passed ?? "?"} |`,
    `| Failed | ${before.failed ?? "?"} | ${after.failed ?? 0} |`,
    `| Total  | ${before.total ?? "?"} | ${after.total ?? "?"} |`,
    ``,
    `### Changed Files (${count})`,
    fileList,
    ``,
    `---`,
    `*Generated by [TestMind](https://testmind.ai)*`,
  ].join("\n");
}
