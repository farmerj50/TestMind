// Autonomous QE runs (B1): create, inspect, and control. A QE run is an OperatorJob
// (type 'qa', context.autonomous + context.qe) executed by the existing operator worker.
import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { redis } from "../runner/redis.js";
import { enqueueOperatorJob, runQueue } from "../runner/queue.js";
import { validateUrl } from "../lib/safe-fetch.js";
import { GENERATED_ROOT } from "../lib/storageRoots.js";
import { validatedEnv } from "../config/env.js";
import { requiresExternalRepoConfirmation } from "./devAgent.js";
import { cancelQeRun, getStages, pauseQeRun, qeContextOf, resumeQeRun, QE_INPUT_KINDS } from "../runner/qe-orchestrator.js";
import { getProjectKnowledge } from "../lib/app-knowledge-store.js";
import { credentialRefExists, type CredentialRef } from "../lib/qe-credentials.js";
import { storeRunCredentials, authorizeRunRepository, parseGitHubRepo, ownerGitHubToken, RUN_CREDENTIAL_KEY_PREFIX } from "../lib/qe-run-access.js";
import { appCodeFixEnabled } from "../lib/qe-codefix.js";
import { getOctokitForProject } from "../runner/github-writeback.js";
import { getCodeFixProposal } from "../lib/qe-codefix-store.js";
import { createPrProposal, publishPrProposal, refreshPrProposal, cancelPrProposal, getPrProposalView, loadPrProposal, PrPublicationError, type PrSource } from "../lib/pr-publication-store.js";

const MAX_ARTIFACT_BYTES = 512 * 1024;

const CreateQeRunBody = z.object({
  projectId: z.string().min(1),
  inputKind: z.enum(QE_INPUT_KINDS),
  input: z.string().trim().min(1).max(20_000),
  baseUrl: z.string().trim().url().optional(),
  planReview: z.boolean().optional(),
  maxPages: z.number().int().min(1).max(50).optional(),
  environmentId: z.string().optional(),
  confirmExternalRepo: z.boolean().optional(),
  // B4: approved test credentials BY REFERENCE - ProjectSecret keys, never values.
  // B6: authorize code-fix PROPOSALS for suspected product defects (never applied or merged automatically).
  codeFix: z.object({ targetRepo: z.string().trim().min(1).max(500), testCommand: z.string().trim().min(1).max(500).optional(), budgetUsd: z.number().positive().max(20).optional(), maxIterations: z.number().int().min(1).max(10).optional(), confirmExternalRepo: z.boolean().optional() }).strict().optional(),
  credentials: z.object({ emailKey: z.string().min(1).max(200), passwordKey: z.string().min(1).max(200), loginPath: z.string().startsWith("/").max(300).optional() }).strict().optional(),
  // Credentials supplied for THIS run only: stored encrypted under temporary keys, deleted when the run ends.
  runCredentials: z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(500), loginPath: z.string().startsWith("/").max(300).optional() }).strict().optional(),
  // Optional repository access for this run, through the project's authorized GitHub integration.
  repository: z.object({ url: z.string().trim().min(1).max(500), branch: z.string().trim().max(200).optional() }).strict().optional(),
});

function requireUser(req: any, reply: any): string | null {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

async function loadOwnedQeJob(req: any, reply: any) {
  const userId = requireUser(req, reply);
  if (!userId) return null;
  const job = await prisma.operatorJob.findUnique({ where: { id: req.params.id }, include: { project: { select: { ownerId: true, name: true } } } });
  if (!job || !qeContextOf(job.contextJson)) {
    reply.code(404).send({ error: "Autonomous QE run not found" });
    return null;
  }
  if (job.requestedBy !== userId || job.project.ownerId !== userId) {
    reply.code(403).send({ error: "Forbidden" });
    return null;
  }
  return job;
}

// Strips internal checkpoint/rollup plumbing from the client view of the job context.
function publicContext(ctx: unknown) {
  const { _qeCheckpoint, _rollup, ...rest } = (ctx ?? {}) as Record<string, any>;
  return { ...rest, checkpointSavedAt: _qeCheckpoint?.savedAt ?? null, checkpointStage: _qeCheckpoint?.stage ?? null };
}

/** Assembles the run-view payload (stages, step tasks, artifacts, per-test results, approvals). */
export async function buildQeRunDetail(job: { id: string; projectId: string; status: string; objective: string | null; error: string | null; createdAt: Date; startedAt: Date | null; finishedAt: Date | null; contextJson: unknown; project: { name: string } }) {
    const [stages, tasks, artifacts, approvals] = await Promise.all([
      getStages(job.id),
      prisma.operatorTask.findMany({ where: { jobId: job.id, type: { not: "stage" } }, orderBy: { createdAt: "asc" } }),
      prisma.operatorArtifact.findMany({ where: { jobId: job.id }, orderBy: { createdAt: "asc" } }),
      prisma.operatorApproval.findMany({ where: { jobId: job.id }, orderBy: { requestedAt: "desc" } }),
    ]);
    // B6: live review state for each code-fix proposal (status, diff, before/after evidence, risks).
    const proposals = new Map<string, Awaited<ReturnType<typeof getCodeFixProposal>>>();
    const prViews = new Map<string, Awaited<ReturnType<typeof getPrProposalView>>>();
    const prArtifacts = artifacts.filter((x) => x.type === "pr_proposal");
    for (const a of prArtifacts.filter((x) => (x.metaJson as any)?.kind === "pr").slice(0, 10)) {
      const pid = (a.metaJson as any)?.proposalId;
      if (typeof pid === "string") prViews.set(a.id, await getPrProposalView(pid).catch(() => null));
    }
    for (const a of prArtifacts.filter((x) => (x.metaJson as any)?.kind !== "pr").slice(0, 10)) {
      const id = (a.metaJson as any)?.devAgentRunId;
      if (typeof id === "string") proposals.set(a.id, await getCodeFixProposal(id).catch(() => null));
    }
    const runIds = [...new Set(tasks.map((t) => t.testRunId).filter((x): x is string => !!x))];
    const [runRows, resultRows] = runIds.length
      ? await Promise.all([
          prisma.testRun.findMany({ where: { id: { in: runIds } }, select: { id: true, status: true, error: true, startedAt: true, finishedAt: true } }),
          // Per-test outcomes exactly as each run recorded them (no rerun-chain merging), so
          // every stage's execution evidence stays individually truthful.
          prisma.testResult.findMany({
            where: { runId: { in: runIds } },
            orderBy: { createdAt: "asc" },
            take: 2000,
            select: { id: true, runId: true, status: true, durationMs: true, message: true, testCase: { select: { id: true, title: true } } },
          }),
        ])
      : [[], []];
    const runs = runRows.map((r) => ({
      ...r,
      results: resultRows.filter((x) => x.runId === r.id).map((x) => ({ id: x.id, testCaseId: x.testCase.id, title: x.testCase.title, status: x.status, durationMs: x.durationMs, message: x.message ? x.message.slice(0, 2000) : null })),
    }));
  return {
      run: {
        id: job.id,
        projectId: job.projectId,
        projectName: job.project.name,
        status: job.status,
        objective: job.objective,
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        context: publicContext(job.contextJson),
        hold: (job.contextJson as any)?._qeHold ?? null,
      },
      stages: stages.map((s) => ({
        id: s.id,
        stage: s.stageKey,
        order: s.stageOrder,
        outcome: s.outcome,
        reason: s.outcomeReason,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
        checkpointSavedAt: (s.checkpointJson as any)?.savedAt ?? null,
        output: s.outputJson,
        tasks: tasks.filter((t) => t.parentTaskId === s.id).map((t) => ({
          id: t.id, type: t.type, status: t.status, error: t.error, testRunId: t.testRunId,
          phase: (t.inputJson as any)?.phase ?? null, startedAt: t.startedAt, finishedAt: t.finishedAt,
        })),
        artifacts: artifacts.filter((a) => a.taskId === s.id).map((a) => ({ id: a.id, type: a.type, testRunId: a.testRunId, meta: a.metaJson, createdAt: a.createdAt, viewable: a.type === "spec", ...(a.type === "pr_proposal" ? { proposal: proposals.get(a.id) ?? null, pr: prViews.get(a.id) ?? null } : {}) })),
      })),
      testRuns: runs,
      approvals: approvals.map((a) => ({ id: a.id, actionType: a.actionType, status: a.status, prompt: (a.contextJson as any)?.prompt ?? null, requestedAt: a.requestedAt, expiresAt: a.expiresAt, resolvedAt: a.resolvedAt })),
  };
}

export default async function operatorQeRoutes(app: FastifyInstance) {
  // B2: the agent's persistent, evidence-backed understanding of a project + what to test next.
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/projects/:id/knowledge", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { ownerId: true } });
    if (!project || project.ownerId !== userId) return reply.code(404).send({ error: "Project not found" });
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    return reply.send(await getProjectKnowledge(req.params.id, { limit }));
  });

  app.post("/operator/qe/runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = CreateQeRunBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const body = parsed.data;

    if (!validatedEnv.TM_AUTONOMOUS_QA_ENABLED) return reply.code(409).send({ error: "Autonomous QA is not enabled on this server (TM_AUTONOMOUS_QA_ENABLED)" });

    const project = await prisma.project.findUnique({ where: { id: body.projectId }, select: { ownerId: true } });
    if (!project || project.ownerId !== userId) return reply.code(404).send({ error: "Project not found" });

    if (body.environmentId) {
      const env = await prisma.environment.findFirst({ where: { id: body.environmentId, projectId: body.projectId }, select: { id: true } });
      if (!env) return reply.code(400).send({ error: "environmentId does not belong to this project" });
    }

    if (body.codeFix && requiresExternalRepoConfirmation(body.codeFix.targetRepo!, body.codeFix.confirmExternalRepo)) {
      return reply.code(400).send({ error: "Proposing code fixes in a repository other than testmind requires codeFix.confirmExternalRepo: true" });
    }
    if (body.credentials && !(await credentialRefExists(body.projectId, body.credentials as CredentialRef))) {
      return reply.code(400).send({ error: "credentials must reference existing project secrets (by key)" });
    }
    if (body.credentials && body.runCredentials) return reply.code(400).send({ error: "Use either saved credentials or credentials for this run, not both" });
    let repository: { url: string; branch: string } | undefined;
    if (body.repository) {
      const auth = await authorizeRunRepository(body.projectId, body.repository.url, body.repository.branch);
      if (!auth.ok) return reply.code(400).send({ error: (auth as { reason: string }).reason });
      repository = { url: auth.access.url, branch: auth.access.branch }; // never the token
      if (body.codeFix && parseGitHubRepo(body.codeFix.targetRepo)?.repo.toLowerCase() !== auth.access.repo.toLowerCase()) {
        return reply.code(400).send({ error: "Code-fix proposals must target the repository authorized for this run" });
      }
    }

    let baseUrl: string | undefined;
    let targetRepo: string | undefined;
    if (body.inputKind === "app_url" || body.inputKind === "page") {
      baseUrl = body.input;
    } else if (body.inputKind === "user_story") {
      if (!body.baseUrl) return reply.code(400).send({ error: "A user story run requires baseUrl (the application to test)" });
      baseUrl = body.baseUrl;
    } else {
      targetRepo = body.input;
      baseUrl = body.baseUrl; // optional: also discover and test the running application
      if (requiresExternalRepoConfirmation(targetRepo, body.confirmExternalRepo)) {
        return reply.code(400).send({ error: "Targeting a repository other than testmind requires confirmExternalRepo: true" });
      }
    }
    if (baseUrl) {
      try {
        await validateUrl(baseUrl);
      } catch (err: any) {
        return reply.code(400).send({ error: `Target URL rejected: ${err?.message ?? String(err)}` });
      }
    }

    const label = body.inputKind === "user_story" ? body.input.split("\n")[0].slice(0, 120) : body.input.slice(0, 200);
    const runCreds = body.runCredentials ? await storeRunCredentials(body.projectId, body.runCredentials as { email: string; password: string; loginPath?: string }) : null;
    const credentialRef = runCreds?.ref ?? body.credentials;
    let job;
    try {
    job = await prisma.operatorJob.create({
      data: {
        projectId: body.projectId,
        type: "qa",
        objective: `Autonomous QE (${body.inputKind}): ${label}`,
        requestedBy: userId,
        environmentId: body.environmentId ?? null,
        contextJson: {
          autonomous: true,
          ...(baseUrl ? { baseUrl } : {}),
          ...(body.environmentId ? { environmentId: body.environmentId } : {}),
          qe: {
            inputKind: body.inputKind,
            input: body.input,
            ...(baseUrl ? { baseUrl } : {}),
            ...(targetRepo ? { targetRepo } : {}),
            planReview: body.planReview === true,
            ...(body.maxPages ? { maxPages: body.maxPages } : {}),
            ...(credentialRef ? { credentialRef } : {}),
            ...(runCreds ? { runCredentialKeys: runCreds.keys } : {}),
            ...(repository ? { repository } : {}),
            ...(body.codeFix ? { codeFix: { targetRepo: body.codeFix.targetRepo, ...(body.codeFix.testCommand ? { testCommand: body.codeFix.testCommand } : {}), ...(body.codeFix.budgetUsd ? { budgetUsd: body.codeFix.budgetUsd } : {}), ...(body.codeFix.maxIterations ? { maxIterations: body.codeFix.maxIterations } : {}) } } : {}),
          },
        } as Prisma.InputJsonValue,
      },
    });
    } catch (err) {
      // Never leave temporary credentials behind for a run that was not created.
      if (runCreds) await prisma.projectSecret.deleteMany({ where: { projectId: body.projectId, key: { in: runCreds.keys } } }).catch(() => {});
      throw err;
    }
    await enqueueOperatorJob(job.id);
    return reply.code(201).send({ run: { id: job.id, status: job.status } });
  });

  // What the unified run form can offer for this project (no secret values are ever returned).
  app.get("/operator/qe/capabilities", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { projectId } = (req.query ?? {}) as { projectId?: string };
    const project = projectId ? await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } }) : null;
    if (!project || project.ownerId !== userId) return reply.code(404).send({ error: "Project not found" });
    const gh = await getOctokitForProject(projectId!).catch(() => null);
    const secrets = await prisma.projectSecret.findMany({ where: { projectId: projectId!, NOT: { key: { startsWith: RUN_CREDENTIAL_KEY_PREFIX } } }, select: { key: true, name: true }, orderBy: { key: "asc" } });
    return reply.send({
      autonomousQa: validatedEnv.TM_AUTONOMOUS_QA_ENABLED,
      appCodeFix: appCodeFixEnabled(),
      // `repository`: the project's own integration (if any). `connectedAccount`: the owner's connected
      // GitHub account can authorize any repository it can read (listed by GET /github/repos).
      github: {
        repository: gh ? `${gh.owner}/${gh.repo}` : null,
        defaultBranch: gh?.defaultBranch ?? null,
        connectedAccount: !!(await ownerGitHubToken(projectId!).catch(() => null)),
      },
      savedCredentialKeys: secrets.map((s) => ({ key: s.key, name: s.name })),
    });
  });

  app.get("/operator/qe/runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { projectId } = (req.query ?? {}) as { projectId?: string };
    const jobs = await prisma.operatorJob.findMany({
      where: { requestedBy: userId, type: "qa", ...(projectId ? { projectId } : {}), contextJson: { path: ["autonomous"], equals: true } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, projectId: true, status: true, objective: true, contextJson: true, createdAt: true, finishedAt: true, error: true },
    });
    const qeJobs = jobs.filter((j) => qeContextOf(j.contextJson));
    const stages = await prisma.operatorTask.findMany({
      where: { jobId: { in: qeJobs.map((j) => j.id) }, type: "stage" },
      select: { jobId: true, stageKey: true, outcome: true, stageOrder: true },
      orderBy: { stageOrder: "asc" },
    });
    return reply.send({
      runs: qeJobs.map((j) => ({
        id: j.id,
        projectId: j.projectId,
        status: j.status,
        objective: j.objective,
        error: j.error,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
        inputKind: qeContextOf(j.contextJson)!.inputKind,
        stages: stages.filter((s) => s.jobId === j.id).map((s) => ({ stage: s.stageKey, outcome: s.outcome })),
      })),
    });
  });

  app.get<{ Params: { id: string } }>("/operator/qe/runs/:id", async (req, reply) => {
    const job = await loadOwnedQeJob(req, reply);
    if (!job) return;
    return reply.send(await buildQeRunDetail(job));
  });

  // Read-only content of a generated spec artifact - confined to this project's generated suite.
  app.get<{ Params: { id: string; artifactId: string } }>("/operator/qe/runs/:id/artifacts/:artifactId/content", async (req, reply) => {
    const job = await loadOwnedQeJob(req, reply);
    if (!job) return;
    const artifact = await prisma.operatorArtifact.findFirst({ where: { id: req.params.artifactId, jobId: job.id, type: "spec" } });
    if (!artifact) return reply.code(404).send({ error: "Artifact not found" });
    const projectRoot = path.resolve(GENERATED_ROOT, `playwright-ts-${job.project.ownerId}`, job.projectId);
    const abs = path.resolve(GENERATED_ROOT, artifact.path);
    const rel = path.relative(projectRoot, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return reply.code(403).send({ error: "Artifact is outside this project's generated suite" });
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      return reply.code(404).send({ error: "Spec file no longer exists on disk" });
    }
    if (!stat.isFile()) return reply.code(404).send({ error: "Not a file" });
    if (stat.size > MAX_ARTIFACT_BYTES) return reply.code(413).send({ error: "Spec file too large to display" });
    reply.header("Cache-Control", "private, no-store").type("text/plain; charset=utf-8");
    return reply.send(await fs.readFile(abs, "utf8"));
  });

  // B7: prepare a reviewable PR proposal (publication always requires explicit, bound approval).
  app.post<{ Params: { id: string } }>("/operator/qe/runs/:id/pr-proposals", async (req, reply) => {
    const job = await loadOwnedQeJob(req, reply);
    if (!job) return;
    const body = z.object({ kind: z.enum(["test_suite", "test_repair", "app_fix"]), devAgentRunId: z.string().optional() }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const { kind, devAgentRunId } = body.data;
    let source: PrSource;
    if (kind === "app_fix") {
      if (!devAgentRunId) return reply.code(400).send({ error: "devAgentRunId is required for an application-fix PR" });
      const linked = await prisma.operatorArtifact.findFirst({ where: { jobId: job.id, type: "pr_proposal", metaJson: { path: ["devAgentRunId"], equals: devAgentRunId } } });
      if (!linked) return reply.code(404).send({ error: "That code-fix proposal does not belong to this run" });
      source = { type: "dev_agent", devAgentRunId, qeJobId: job.id };
    } else {
      source = kind === "test_suite" ? { type: "qe_suite", qeJobId: job.id } : { type: "qe_repairs", qeJobId: job.id };
    }
    try {
      const p = await createPrProposal({ projectId: job.projectId, jobId: job.id, kind, source, actor: job.requestedBy ?? "user" });
      const exists = await prisma.operatorArtifact.findFirst({ where: { jobId: job.id, type: "pr_proposal", metaJson: { path: ["proposalId"], equals: p.id } } });
      if (!exists) {
        const review = await prisma.operatorTask.findFirst({ where: { jobId: job.id, type: "stage", stageKey: "review" }, select: { id: true } });
        await prisma.operatorArtifact.create({ data: { jobId: job.id, taskId: review?.id ?? null, type: "pr_proposal", path: `pr-proposals/${p.id}.json`, metaJson: { kind: "pr", stage: "review", proposalId: p.id, prKind: kind } } });
      }
      return reply.send({ proposal: await getPrProposalView(p.id) });
    } catch (err: any) {
      return reply.code(409).send({ error: String(err?.message ?? err) });
    }
  });

  const loadOwnedProposal = async (req: any, reply: any) => {
    const userId = requireUser(req, reply);
    if (!userId) return null;
    const p = await loadPrProposal(req.params.pid);
    if (!p) { reply.code(404).send({ error: "Proposal not found" }); return null; }
    const project = await prisma.project.findUnique({ where: { id: p.projectId }, select: { ownerId: true } });
    const opJob = await prisma.operatorJob.findUnique({ where: { id: p.jobId }, select: { requestedBy: true } });
    if (project?.ownerId !== userId || (opJob && opJob.requestedBy !== userId)) { reply.code(403).send({ error: "Forbidden" }); return null; }
    return { p, userId };
  };
  const prAction = (fn: (id: string, actor: string) => Promise<unknown>) => async (req: any, reply: any) => {
    const owned = await loadOwnedProposal(req, reply);
    if (!owned) return;
    try {
      await fn(owned.p.id, owned.userId);
      return reply.send({ proposal: await getPrProposalView(owned.p.id) });
    } catch (err: any) {
      if (err instanceof PrPublicationError) return reply.code(err.httpStatus).send({ error: err.message, proposal: await getPrProposalView(owned.p.id) });
      throw err;
    }
  };
  app.post("/operator/qe/pr-proposals/:pid/publish", prAction((id, actor) => publishPrProposal(id, actor)));
  app.post("/operator/qe/pr-proposals/:pid/refresh", prAction((id, actor) => refreshPrProposal(id, actor)));
  app.post("/operator/qe/pr-proposals/:pid/cancel", prAction((id, actor) => cancelPrProposal(id, actor)));

  app.post<{ Params: { id: string } }>("/operator/qe/runs/:id/pause", async (req, reply) => {
    const job = await loadOwnedQeJob(req, reply);
    if (!job) return;
    if (!(await pauseQeRun(job.id))) return reply.code(409).send({ error: `Cannot pause a run that is ${job.status}` });
    return reply.send({ ok: true, status: "paused" });
  });

  app.post<{ Params: { id: string } }>("/operator/qe/runs/:id/resume", async (req, reply) => {
    const job = await loadOwnedQeJob(req, reply);
    if (!job) return;
    if (!(await resumeQeRun(job.id))) return reply.code(409).send({ error: `Cannot resume a run that is ${job.status}` });
    return reply.send({ ok: true, status: "running" });
  });

  app.post<{ Params: { id: string } }>("/operator/qe/runs/:id/cancel", async (req, reply) => {
    const job = await loadOwnedQeJob(req, reply);
    if (!job) return;
    const result = await cancelQeRun(job.id, {
      setCancelKey: async (runId) => { await redis.set(`cancel:run:${runId}`, "1", "EX", 60 * 60); },
      removeQueuedRun: async (runId) => { const j = await runQueue.getJob(runId); if (j) await j.remove().catch(() => {}); },
    });
    if (!result.canceled) return reply.code(409).send({ error: `Cannot cancel a run that is ${job.status}` });
    return reply.send({ ok: true, status: "canceled", stoppedTestRuns: result.stoppedRunIds });
  });
}
