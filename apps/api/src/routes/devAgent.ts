// apps/api/src/routes/devAgent.ts
// Autonomous Development Mode (Stage E). Cloned from routes/evaluations.ts's shape - a run +
// nested history, ownership-checked on every route.

import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { isProjectOwner } from "../lib/project-access.js";
import { enqueueOperatorJob } from "../runner/queue.js";
import { buildInstructionText } from "../lib/dev-agent-self-improvement.js";
import { createPrProposal, publishPrProposal, PrPublicationError } from "../lib/pr-publication-store.js";
import { isLikelyGitRepoUrl } from "../lib/git-url.js";
import { localTestmindRepoPath, NO_LOCAL_TESTMIND_REPO_MESSAGE } from "../runner/dev-agent-worktree.js";
import { parseGitHubRepo } from "../lib/qe-run-access.js";
import { getCodeFixProposal } from "../lib/qe-codefix-store.js";
import { isTestFilePath } from "../lib/qe-codefix.js";

function requireUser(req: any, reply: any): string | null {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

// No implicit external-repo access: pulled out as its own pure function so the rule is
// directly unit-testable without booting the route/HTTP layer.
export function requiresExternalRepoConfirmation(targetRepo: string, confirmExternalRepo?: boolean): boolean {
  return targetRepo !== "testmind" && !confirmExternalRepo;
}

const CreateRunBody = z.object({
  projectId: z.string().min(1),
  mode: z.enum(["assigned", "selfImprovement", "both"]).default("assigned"),
  // No implicit external-repo access: anything other than the default "testmind" requires
  // the caller to explicitly set confirmExternalRepo: true in the same request.
  targetRepo: z.string().min(1).default("testmind"),
  confirmExternalRepo: z.boolean().optional(),
  instructionText: z.string().max(20000).optional(),
  budgetUsd: z.number().positive().optional(),
  maxIterations: z.number().int().min(1).max(50).optional(),
  testCommand: z.string().max(2000).optional(),
  baseUrl: z.string().url().max(2000).optional(),
  environmentId: z.string().min(1).optional(),
  scheduledStartAt: z.string().datetime().optional(),
  timezone: z.string().max(100).optional(),
});

function originOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin.toLowerCase();
  } catch {
    return null;
  }
}

// No implicit/arbitrary baseUrl: a run may only target a URL this project already owns via
// an existing, already-authorized flow (its Environments, or whatever QA Agent/discovery
// has already established on the project) - never a free-form caller-supplied string. This
// is what guards against using Dev Agent Mode as a confused-deputy to point the server's own
// crawler at an unrelated third-party site; the worker's own SSRF guard (validateUrl) is
// defense-in-depth on top of this, not a substitute for it.
export async function isAuthorizedBaseUrl(projectId: string, baseUrl: string): Promise<boolean> {
  const target = originOf(baseUrl);
  if (!target) return false;
  const [project, environments] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { sharedSteps: true, repoUrl: true } }),
    prisma.environment.findMany({ where: { projectId }, select: { baseUrl: true } }),
  ]);
  const known = new Set<string>();
  const shared = (project?.sharedSteps as any)?.baseUrl;
  if (typeof shared === "string") {
    const origin = originOf(shared);
    if (origin) known.add(origin);
  }
  // Same convention resolveBaseUrlForRun (dev-agent-worker.ts) already falls back to: some
  // projects store their app's URL in repoUrl rather than a real git remote. The
  // authorization check must recognize the exact same set of "already known" URLs the
  // worker is willing to resolve to, or a legitimate repoUrl-only project could never pass
  // an explicit baseUrl that matches its own established URL.
  const repoUrl = project?.repoUrl?.trim() ?? "";
  if (repoUrl && !isLikelyGitRepoUrl(repoUrl) && /^https?:\/\//i.test(repoUrl)) {
    const origin = originOf(repoUrl);
    if (origin) known.add(origin);
  }
  for (const env of environments) {
    const origin = originOf(env.baseUrl);
    if (origin) known.add(origin);
  }
  return known.has(target);
}

/**
 * Why a Dev Agent target cannot be a repository, or null when it can. Catches values that would
 * only fail later at clone time, e.g. a GitHub account URL ("https://github.com/farmerj50").
 */
export function devAgentRepoProblem(targetRepo: string): string | null {
  const value = targetRepo.trim();
  if (value === "testmind") return null;
  if (parseGitHubRepo(value)) return null;
  const account = /^(?:https?:\/\/(?:www\.)?github\.com\/)([A-Za-z0-9_.-]+)\/?$/i.exec(value);
  if (account) return `"${value}" is a GitHub account, not a repository. Choose a repository, e.g. ${account[1]}/<repository>.`;
  if (/github\.com/i.test(value)) return `"${value}" is not a GitHub repository. Use owner/repository or https://github.com/owner/repository.`;
  if (isLikelyGitRepoUrl(value)) return null;
  return `"${value}" is not a Git repository URL. Choose a repository from your connected GitHub account, or use https://github.com/owner/repository.`;
}

export async function devAgentRoutes(app: FastifyInstance) {
  app.post("/dev-agent/runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = CreateRunBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const body = parsed.data;

    if (!(await isProjectOwner(body.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    // Autonomous Dev edits code in a Git repository. "testmind" is only valid where a real local
    // checkout exists (not in production containers); website test generation belongs in Autonomous QE.
    if (body.targetRepo === "testmind" && !localTestmindRepoPath()) {
      return reply.code(409).send({ error: NO_LOCAL_TESTMIND_REPO_MESSAGE, code: "DEV_AGENT_NO_LOCAL_REPO", autonomousQeUrl: "/operator/qe" });
    }

    const repoProblem = devAgentRepoProblem(body.targetRepo);
    if (repoProblem) return reply.code(400).send({ error: repoProblem, code: "DEV_AGENT_INVALID_REPO" });

    if (requiresExternalRepoConfirmation(body.targetRepo, body.confirmExternalRepo)) {
      return reply.code(400).send({
        error: "Targeting a repository other than 'testmind' requires explicit confirmExternalRepo: true in the request - there is no implicit external-repo access.",
      });
    }

    if (body.environmentId) {
      const env = await prisma.environment.findFirst({ where: { id: body.environmentId, projectId: body.projectId }, select: { id: true } });
      if (!env) return reply.code(400).send({ error: "environmentId does not belong to this project." });
    }

    if (body.baseUrl && !(await isAuthorizedBaseUrl(body.projectId, body.baseUrl))) {
      return reply.code(400).send({
        error: "baseUrl is not a known/authorized URL for this project - it must match an existing Environment or a base URL this project has already established.",
      });
    }

    // A future scheduledStartAt is meant to register a one-shot-template OperatorSchedule that
    // the scheduler's worker later fires (see scheduler.ts / routes/schedules.ts). That wiring
    // does not exist yet here - this route never creates that OperatorSchedule row - so a
    // DevAgentRun created with scheduledStartAt would stay 'queued' forever with no operatorJobId
    // and no way to ever be picked up. Reject it up front rather than silently accepting a
    // request that can never run. Anything at/near "now" (including a stale/default
    // datetime-local value) is treated as an immediate run, not a schedule.
    const scheduledAtMs = body.scheduledStartAt ? new Date(body.scheduledStartAt).getTime() : null;
    const isMeaningfullyFuture = scheduledAtMs !== null && scheduledAtMs - Date.now() > 60_000;
    if (isMeaningfullyFuture) {
      return reply.code(400).send({
        error: "Scheduling a future Dev Agent run is not implemented yet - use /schedules with a devAgentTemplate, or submit without a scheduled time to run now.",
      });
    }

    const instructionText = await buildInstructionText(body.mode, body.projectId, body.instructionText ?? null);

    const run = await prisma.devAgentRun.create({
      data: {
        projectId: body.projectId,
        mode: body.mode,
        targetRepo: body.targetRepo,
        instructionText,
        budgetUsd: body.budgetUsd,
        maxIterations: body.maxIterations ?? undefined,
        testCommand: body.testCommand,
        baseUrl: body.baseUrl,
        environmentId: body.environmentId,
        timezone: body.timezone,
        requestedBy: userId,
      },
    });

    if (body.instructionText) {
      await prisma.devAgentMessage.create({
        data: { devAgentRunId: run.id, role: "user", content: body.instructionText },
      });
    }

    const operatorJob = await prisma.operatorJob.create({
      data: {
        projectId: body.projectId,
        type: "autonomousDev",
        objective: `Autonomous Dev Mode (${body.mode}): ${body.targetRepo}`,
        requestedBy: userId,
        contextJson: { devAgentRunId: run.id },
      },
    });
    await prisma.devAgentRun.update({ where: { id: run.id }, data: { operatorJobId: operatorJob.id } });
    await enqueueOperatorJob(operatorJob.id, { durable: true });
    return reply.code(202).send({ run: { ...run, operatorJobId: operatorJob.id } });
  });

  app.get("/dev-agent/runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Query = z.object({ projectId: z.string().min(1) });
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    if (!(await isProjectOwner(parsed.data.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const runs = await prisma.devAgentRun.findMany({
      where: { projectId: parsed.data.projectId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return reply.send({ runs });
  });

  app.get<{ Params: { id: string } }>("/dev-agent/runs/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const run = await prisma.devAgentRun.findUnique({
      where: { id: req.params.id },
      include: { iterations: { orderBy: { iterationNumber: "asc" } }, messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (!(await isProjectOwner(run.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    return reply.send({ run });
  });

  async function loadOwnedRun(req: any, reply: any) {
    const userId = requireUser(req, reply);
    if (!userId) return null;
    const run = await prisma.devAgentRun.findUnique({ where: { id: req.params.id } });
    if (!run) {
      reply.code(404).send({ error: "Run not found" });
      return null;
    }
    if (!(await isProjectOwner(run.projectId, userId))) {
      reply.code(403).send({ error: "Forbidden" });
      return null;
    }
    return run;
  }

  app.post<{ Params: { id: string } }>("/dev-agent/runs/:id/pause", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    if (run.status !== "running") return reply.code(409).send({ error: `Cannot pause a run with status '${run.status}'` });
    const updated = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "paused" } });
    return reply.send({ run: updated });
  });

  app.post<{ Params: { id: string } }>("/dev-agent/runs/:id/resume", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    if (run.status !== "paused") return reply.code(409).send({ error: `Cannot resume a run with status '${run.status}'` });
    const updated = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "running" } });
    // The state machine's own paused-check re-delays itself every PAUSE_RECHECK_MS; nudging
    // it here just lets resume take effect sooner rather than waiting out that interval.
    if (run.operatorJobId) await enqueueOperatorJob(run.operatorJobId, { durable: true }).catch(() => {});
    return reply.send({ run: updated });
  });

  app.post<{ Params: { id: string } }>("/dev-agent/runs/:id/stop", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    if (["succeeded", "failed", "canceled"].includes(run.status)) {
      return reply.code(409).send({ error: `Run already terminal ('${run.status}')` });
    }
    const updated = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "canceled", finishedAt: new Date() } });
    if (run.operatorJobId) await prisma.operatorJob.update({ where: { id: run.operatorJobId }, data: { status: "canceled" } }).catch(() => {});
    return reply.send({ run: updated });
  });

  // Emergency stop: same checkpoint-based cancel as /stop. dev-agent-worker.ts's
  // runConfiguredTestCommand already polls DevAgentRun.status every 1s and SIGKILLs its
  // in-flight subprocess the moment status becomes 'canceled' - setting that same status
  // is sufficient to reach the subprocess; there is no separate live-process handle this
  // HTTP route could signal more directly (the subprocess runs inside a different worker
  // process entirely). Documented here rather than inventing a fake "instant" mechanism.
  app.post<{ Params: { id: string } }>("/dev-agent/runs/:id/emergency-stop", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    if (["succeeded", "failed", "canceled"].includes(run.status)) {
      return reply.code(409).send({ error: `Run already terminal ('${run.status}')` });
    }
    const updated = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "canceled", finishedAt: new Date(), error: "Emergency stop requested" } });
    if (run.operatorJobId) await prisma.operatorJob.update({ where: { id: run.operatorJobId }, data: { status: "canceled" } }).catch(() => {});
    return reply.send({ run: updated });
  });

  const PostMessageBody = z.object({ content: z.string().min(1).max(20000) });

  app.post<{ Params: { id: string } }>("/dev-agent/runs/:id/messages", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    const parsed = PostMessageBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const message = await prisma.devAgentMessage.create({
      data: { devAgentRunId: run.id, role: "user", content: parsed.data.content },
    });
    // Nudge the worker so a follow-up instruction is picked up sooner rather than waiting
    // out the next scheduled re-delay, same idiom as /resume above.
    if (run.operatorJobId && run.status === "running") {
      await enqueueOperatorJob(run.operatorJobId, { durable: true }).catch(() => {});
    }
    return reply.code(201).send({ message });
  });

  app.get<{ Params: { id: string } }>("/dev-agent/runs/:id/messages", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    const messages = await prisma.devAgentMessage.findMany({
      where: { devAgentRunId: run.id },
      orderBy: { createdAt: "asc" },
    });
    return reply.send({ messages });
  });

  app.get<{ Params: { id: string } }>("/dev-agent/runs/:id/summary", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    const iterations = await prisma.devAgentIteration.findMany({
      where: { devAgentRunId: run.id },
      orderBy: { iterationNumber: "asc" },
    });

    const filesChanged = new Set<string>();
    for (const it of iterations) {
      if (Array.isArray(it.filesChanged)) {
        for (const f of it.filesChanged as any[]) {
          if (f && typeof f === "object" && typeof f.path === "string") filesChanged.add(f.path);
        }
      }
    }
    const latest = iterations[iterations.length - 1] ?? null;

    return reply.send({
      summary: {
        status: run.status,
        iterationCount: iterations.length,
        filesChanged: [...filesChanged],
        latestTestResult: latest?.testResult ?? null,
        spentUsd: run.spentUsd,
        budgetUsd: run.budgetUsd,
        prUrl: run.prUrl,
        awaitingReview: run.status === "succeeded" && !!run.prUrl,
        iterations: iterations.map((i) => ({
          iterationNumber: i.iterationNumber,
          phase: i.phase,
          summary: i.summary,
          filesChanged: i.filesChanged,
          testResult: i.testResult,
          costUsd: i.costUsd,
          createdAt: i.createdAt,
        })),
      },
    });
  });

  // Never automatic/implicit: the caller (UI) explicitly triggers publishing, and the
  // underlying flow never merges - it only ever opens/updates a draft PR for human review.
  app.post<{ Params: { id: string } }>("/dev-agent/runs/:id/publish-pr", async (req, reply) => {
    const run = await loadOwnedRun(req, reply);
    if (!run) return;
    // B7: publication requires an explicit approval bound to this exact repo/branch/commit/diff.
    // First call prepares the proposal and requests approval; after approval, the same call publishes.
    if (!["succeeded", "unverified"].includes(run.status)) return reply.code(409).send({ error: `Run must be finished to publish a PR (status: ${run.status})` });
    if (!run.operatorJobId) return reply.code(409).send({ error: "Run has no operator job to attach an approval to" });
    const { userId } = getAuth(req);
    // Test-only changes (e.g. generated Playwright specs) are proposed as tests, labelled from the
    // run's real outcome; anything touching application code stays an application fix (feature-
    // flagged and verified-only). Code-fix runs are always application fixes.
    const changed = (await getCodeFixProposal(run.id).catch(() => null))?.files ?? [];
    const opCtx = (await prisma.operatorJob.findUnique({ where: { id: run.operatorJobId }, select: { contextJson: true } }))?.contextJson as any;
    const kind = !opCtx?.qeCodeFix && changed.length > 0 && changed.every((f) => isTestFilePath(f.path)) ? "test_suite" : "app_fix";
    try {
      const proposal = await createPrProposal({ projectId: run.projectId, jobId: run.operatorJobId, kind, source: { type: "dev_agent", devAgentRunId: run.id }, actor: userId ?? run.requestedBy });
      if (proposal.status === "blocked") return reply.code(409).send({ error: proposal.blockedReason, proposalId: proposal.id });
      const published = await publishPrProposal(proposal.id, userId ?? run.requestedBy);
      return reply.send({ prUrl: published.prUrl, proposalId: published.id });
    } catch (err) {
      if (err instanceof PrPublicationError) return reply.code(err.httpStatus).send({ error: err.message, proposalId: err.proposal?.id, approvalId: err.proposal?.approvalId, status: err.proposal?.status });
      throw err;
    }
  });

  // Scheduling itself is handled by the existing routes/schedules.ts (POST/GET/PATCH/DELETE
  // /schedules) - extended there (not duplicated here) to accept `timezone`. A caller
  // schedules a Dev Agent run by POSTing to /schedules with
  // contextJson: { devAgentTemplate: {...} } - that route already accepted arbitrary
  // contextJson before this stage; scheduler.ts's worker now interprets devAgentTemplate
  // when present instead of always creating a type:'qa' job.
}

export default devAgentRoutes;
