// apps/api/src/lib/dev-agent-pr.ts
// Autonomous Development Mode (Stage F) - protected-branch safety. Reuses the exact same
// confidence-gated push/PR flow github-writeback.ts already uses in production for self-heal:
// always a new branch, never `main` directly, never auto-merged. This module adds no new
// git-write primitive - it only assembles DevAgentIteration.filesChanged into the same
// {path, content}[] shape pushSpecFilesToBranch already expects.
import { prisma } from "../prisma.js";
import { getOctokitForProject, pushSpecFilesToBranch, ensurePullRequest } from "../runner/github-writeback.js";

export type DevAgentFileChange = { path: string; content: string };

// DevAgentIteration.filesChanged is a free-form Json? column (the iteration engine's own
// concern, not this module's) - this narrows it to the shape pushSpecFilesToBranch expects,
// skipping anything that doesn't match rather than throwing, since older/placeholder
// iterations recorded before real diff-application landed may not have this shape yet.
export function collectFileChanges(filesChangedPerIteration: unknown[]): DevAgentFileChange[] {
  const byPath = new Map<string, DevAgentFileChange>();
  for (const entry of filesChangedPerIteration) {
    if (!Array.isArray(entry)) continue;
    for (const file of entry) {
      if (!file || typeof file !== "object") continue;
      const path = (file as any).path;
      const content = (file as any).content;
      if (typeof path === "string" && typeof content === "string") {
        byPath.set(path, { path, content }); // later iterations win for the same path
      }
    }
  }
  return [...byPath.values()];
}

export class DevAgentPrError extends Error {}

/**
 * Pushes a terminal, succeeded DevAgentRun's accumulated file changes to a new branch and
 * opens a PR via the existing confidence-gated flow - never to baseBranch/main directly, never
 * auto-merged. Returns null (not an error) if there is nothing to publish (no real file changes
 * were ever recorded), since that is an expected state while real diff-application is still
 * being wired in by a separate stage - callers should treat "nothing to publish" as normal, not
 * exceptional.
 */
export async function publishDevAgentPullRequest(runId: string): Promise<{ prUrl: string } | null> {
  const run = await prisma.devAgentRun.findUnique({
    where: { id: runId },
    include: { iterations: { orderBy: { iterationNumber: "asc" } } },
  });
  if (!run) throw new DevAgentPrError("Run not found");
  if (run.status !== "succeeded") throw new DevAgentPrError(`Run must be 'succeeded' to publish a PR (status: ${run.status})`);
  if (run.prUrl) return { prUrl: run.prUrl }; // idempotent - already published

  const files = collectFileChanges(run.iterations.map((i) => i.filesChanged));
  if (!files.length) return null;

  // External-repo publishing reuses the same per-project Integration-based credential
  // resolution as getOctokitForProject below - no separate credential path is introduced.
  const coords = await getOctokitForProject(run.projectId);
  if (!coords) throw new DevAgentPrError("No GitHub credentials configured for this project");

  const branch = run.workBranch ?? `testmind/dev-agent-${run.id}`;
  const baseBranch = run.baseBranch ?? coords.defaultBranch;

  await pushSpecFilesToBranch({
    octokit: coords.octokit,
    owner: coords.owner,
    repo: coords.repo,
    branch,
    baseBranch,
    files,
    commitMessage: `Autonomous Dev Mode: ${run.instructionText?.slice(0, 200) ?? run.id}`,
  });

  const { prUrl } = await ensurePullRequest({
    octokit: coords.octokit,
    owner: coords.owner,
    repo: coords.repo,
    branch,
    baseBranch,
    title: `Autonomous Dev Mode: ${(run.instructionText ?? run.id).slice(0, 120)}`,
    body: `Opened by TestMind Autonomous Development Mode (run \`${run.id}\`, mode \`${run.mode}\`). This PR is never auto-merged - review required before merging.`,
    // Always a draft: this feature has no confidence score of its own to gate on (unlike
    // self-heal's TestHealingAttempt.confidence) - defaulting to the more conservative branch
    // of github-writeback.ts's existing confidence bands rather than inventing a new score.
    draft: true,
  });

  await prisma.devAgentRun.update({ where: { id: run.id }, data: { prUrl, workBranch: branch } });
  return { prUrl };
}
