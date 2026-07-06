import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "../prisma.js";
import { enqueueOperatorJob } from "../runner/queue.js";
import { isLikelyGitRepoUrl } from "../lib/git-url.js";

const WORKFLOW_TYPES = ["qa-execute", "repair", "discovery", "security"] as const;
const TRIGGER_TYPES = ["manual", "jenkins", "github", "webhook"] as const;

const WORKFLOW_TO_JOB_TYPE: Record<(typeof WORKFLOW_TYPES)[number], "qa" | "repair" | "discovery" | "security"> = {
  "qa-execute": "qa",
  repair: "repair",
  discovery: "discovery",
  security: "security",
};

const WorkflowBody = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional().nullable(),
  workflowType: z.enum(WORKFLOW_TYPES).default("qa-execute"),
  triggerType: z.enum(TRIGGER_TYPES).default("manual"),
  environmentId: z.string().optional().nullable(),
  suiteId: z.string().optional().nullable(),
  approvalRequired: z.boolean().optional(),
  notifyOnFailure: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

const WorkflowPatchBody = WorkflowBody.omit({ projectId: true }).partial();

function optionalText(value?: string | null) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resolveBaseUrl(workflow: any) {
  const config = asRecord(workflow.configJson);
  const configBaseUrl = typeof config.baseUrl === "string" ? config.baseUrl.trim() : "";
  if (configBaseUrl) return configBaseUrl;

  const envBaseUrl = typeof workflow.environment?.baseUrl === "string" ? workflow.environment.baseUrl.trim() : "";
  if (envBaseUrl) return envBaseUrl;

  const shared = asRecord(workflow.project?.sharedSteps);
  const sharedBaseUrl = typeof shared.baseUrl === "string" ? shared.baseUrl.trim() : "";
  if (sharedBaseUrl) return sharedBaseUrl;

  const repoUrl = typeof workflow.project?.repoUrl === "string" ? workflow.project.repoUrl.trim() : "";
  if (repoUrl && /^https?:\/\//i.test(repoUrl) && !isLikelyGitRepoUrl(repoUrl)) return repoUrl;

  return null;
}

function deriveRunStatus(runStatus: string, jobStatus?: string | null) {
  if (!jobStatus) return runStatus;
  if (jobStatus === "blocked") return "blocked";
  if (jobStatus === "running") return "running";
  if (jobStatus === "queued") return "queued";
  if (jobStatus === "succeeded") return "succeeded";
  if (jobStatus === "failed") return "failed";
  if (jobStatus === "canceled") return "canceled";
  return runStatus;
}

async function ensureProjectOwned(projectId: string, userId: string) {
  return prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true, ownerId: true },
  });
}

async function ensureWorkflowInputs(projectId: string, environmentId?: string | null, suiteId?: string | null) {
  const cleanEnvironmentId = optionalText(environmentId);
  const cleanSuiteId = optionalText(suiteId);

  if (cleanEnvironmentId) {
    const env = await prisma.environment.findFirst({
      where: { id: cleanEnvironmentId, projectId },
      select: { id: true },
    });
    if (!env) return { ok: false as const, error: "Environment not found for project" };
  }

  if (cleanSuiteId) {
    const curatedSuite = await prisma.curatedSuite.findFirst({
      where: { id: cleanSuiteId, projectId },
      select: { id: true },
    });
    if (!curatedSuite) return { ok: false as const, error: "Suite not found for project" };
  }

  return { ok: true as const };
}

async function getOwnedWorkflow(id: string, userId: string) {
  const workflow = await prisma.workflow.findUnique({
    where: { id },
    include: {
      project: { select: { id: true, name: true, ownerId: true, repoUrl: true, sharedSteps: true } },
      environment: {
        select: {
          id: true,
          name: true,
          baseUrl: true,
          isProtected: true,
          requiresApproval: true,
        },
      },
    },
  });
  if (!workflow || workflow.project.ownerId !== userId) return null;
  return workflow;
}

async function startWorkflowRun(workflow: any, runId: string, userId: string, approvedBy?: string | null) {
  const workflowType = WORKFLOW_TYPES.includes(workflow.workflowType)
    ? (workflow.workflowType as (typeof WORKFLOW_TYPES)[number])
    : "qa-execute";
  const jobType = WORKFLOW_TO_JOB_TYPE[workflowType];
  const baseUrl = resolveBaseUrl(workflow);
  const config = asRecord(workflow.configJson);
  const now = new Date();

  const { job, run } = await prisma.$transaction(async (tx) => {
    const operatorJob = await tx.operatorJob.create({
      data: {
        projectId: workflow.projectId,
        type: jobType as any,
        objective: `Workflow: ${workflow.name}`,
        requestedBy: userId,
        environmentId: workflow.environmentId ?? undefined,
        contextJson: {
          ...config,
          triggeredBy: "workflow",
          workflowId: workflow.id,
          workflowRunId: runId,
          workflowType,
          triggerType: workflow.triggerType,
          environmentId: workflow.environmentId ?? null,
          suiteId: workflow.suiteId ?? null,
          baseUrl,
          notifyOnFailure: workflow.notifyOnFailure,
        } as Prisma.InputJsonValue,
      },
    });

    const updatedRun = await tx.workflowRun.update({
      where: { id: runId },
      data: {
        status: "queued",
        operatorJobId: operatorJob.id,
        startedAt: now,
        approvedBy: approvedBy ?? undefined,
        error: null,
      },
    });

    return { job: operatorJob, run: updatedRun };
  });

  try {
    await enqueueOperatorJob(job.id);
  } catch (err: any) {
    const failedRun = await prisma.workflowRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        error: err?.message ?? "Failed to enqueue operator job",
        finishedAt: new Date(),
      },
    });
    return { run: failedRun, job };
  }

  return { run, job };
}

function hydrateRun(run: any, jobById: Map<string, any>) {
  const job = run.operatorJobId ? jobById.get(run.operatorJobId) ?? null : null;
  const testRunId = job?.tasks?.find((task: any) => task.testRunId)?.testRunId ?? null;
  return {
    ...run,
    status: deriveRunStatus(run.status, job?.status),
    error: run.error ?? job?.error ?? null,
    finishedAt: run.finishedAt ?? job?.finishedAt ?? null,
    operatorJob: job
      ? {
          id: job.id,
          status: job.status,
          error: job.error,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          testRunId,
        }
      : null,
    testRunId,
  };
}

async function hydrateWorkflows(workflows: any[]) {
  const jobIds = Array.from(
    new Set(
      workflows
        .flatMap((workflow) => workflow.runs ?? [])
        .map((run) => run.operatorJobId)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  );

  const jobs = jobIds.length
    ? await prisma.operatorJob.findMany({
        where: { id: { in: jobIds } },
        select: {
          id: true,
          status: true,
          error: true,
          startedAt: true,
          finishedAt: true,
          tasks: {
            select: { id: true, type: true, status: true, testRunId: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          },
        },
      })
    : [];
  const jobById = new Map(jobs.map((job) => [job.id, job]));

  return workflows.map((workflow) => ({
    ...workflow,
    runs: (workflow.runs ?? []).map((run: any) => hydrateRun(run, jobById)),
  }));
}

export default async function workflowsRoutes(app: FastifyInstance) {
  app.get("/workflows", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const query = z.object({ projectId: z.string().optional() }).safeParse(req.query ?? {});
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });

    if (query.data.projectId) {
      const project = await ensureProjectOwned(query.data.projectId, userId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
    }

    const workflows = await prisma.workflow.findMany({
      where: {
        ...(query.data.projectId ? { projectId: query.data.projectId } : {}),
        project: { ownerId: userId },
      },
      include: {
        project: { select: { id: true, name: true } },
        environment: { select: { id: true, name: true, baseUrl: true, isProtected: true, requiresApproval: true } },
        runs: { orderBy: { createdAt: "desc" }, take: 5 },
      },
      orderBy: { createdAt: "desc" },
    });

    return reply.send({ workflows: await hydrateWorkflows(workflows) });
  });

  app.post("/workflows", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const parsed = WorkflowBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const project = await ensureProjectOwned(parsed.data.projectId, userId);
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const inputs = await ensureWorkflowInputs(parsed.data.projectId, parsed.data.environmentId, parsed.data.suiteId);
    if (!inputs.ok) return reply.code(400).send({ error: inputs.error });

    const workflow = await prisma.workflow.create({
      data: {
        projectId: parsed.data.projectId,
        name: parsed.data.name.trim(),
        description: optionalText(parsed.data.description),
        workflowType: parsed.data.workflowType,
        triggerType: parsed.data.triggerType,
        environmentId: optionalText(parsed.data.environmentId),
        suiteId: optionalText(parsed.data.suiteId),
        approvalRequired: parsed.data.approvalRequired ?? false,
        notifyOnFailure: parsed.data.notifyOnFailure ?? true,
        configJson: (parsed.data.config ?? {}) as Prisma.InputJsonValue,
      },
      include: {
        project: { select: { id: true, name: true } },
        environment: { select: { id: true, name: true, baseUrl: true, isProtected: true, requiresApproval: true } },
        runs: { orderBy: { createdAt: "desc" }, take: 5 },
      },
    });

    return reply.code(201).send({ workflow });
  });

  app.patch("/workflows/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { id } = req.params as { id: string };
    const existing = await getOwnedWorkflow(id, userId);
    if (!existing) return reply.code(404).send({ error: "Workflow not found" });

    const parsed = WorkflowPatchBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const inputs = await ensureWorkflowInputs(
      existing.projectId,
      parsed.data.environmentId ?? existing.environmentId,
      parsed.data.suiteId ?? existing.suiteId
    );
    if (!inputs.ok) return reply.code(400).send({ error: inputs.error });

    const workflow = await prisma.workflow.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
        ...(parsed.data.description !== undefined ? { description: optionalText(parsed.data.description) } : {}),
        ...(parsed.data.workflowType !== undefined ? { workflowType: parsed.data.workflowType } : {}),
        ...(parsed.data.triggerType !== undefined ? { triggerType: parsed.data.triggerType } : {}),
        ...(parsed.data.environmentId !== undefined ? { environmentId: optionalText(parsed.data.environmentId) } : {}),
        ...(parsed.data.suiteId !== undefined ? { suiteId: optionalText(parsed.data.suiteId) } : {}),
        ...(parsed.data.approvalRequired !== undefined ? { approvalRequired: parsed.data.approvalRequired } : {}),
        ...(parsed.data.notifyOnFailure !== undefined ? { notifyOnFailure: parsed.data.notifyOnFailure } : {}),
        ...(parsed.data.config !== undefined ? { configJson: parsed.data.config as Prisma.InputJsonValue } : {}),
      },
      include: {
        project: { select: { id: true, name: true } },
        environment: { select: { id: true, name: true, baseUrl: true, isProtected: true, requiresApproval: true } },
        runs: { orderBy: { createdAt: "desc" }, take: 5 },
      },
    });

    const [hydrated] = await hydrateWorkflows([workflow]);
    return reply.send({ workflow: hydrated });
  });

  app.delete("/workflows/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { id } = req.params as { id: string };
    const existing = await getOwnedWorkflow(id, userId);
    if (!existing) return reply.code(404).send({ error: "Workflow not found" });

    await prisma.workflow.delete({ where: { id } });
    return reply.code(204).send();
  });

  app.post("/workflows/:id/run", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { id } = req.params as { id: string };
    const workflow = await getOwnedWorkflow(id, userId);
    if (!workflow) return reply.code(404).send({ error: "Workflow not found" });

    const requiresApproval = Boolean(workflow.approvalRequired || workflow.environment?.requiresApproval);
    const run = await prisma.workflowRun.create({
      data: {
        workflowId: workflow.id,
        status: requiresApproval ? "awaiting_approval" : "queued",
        requestedBy: userId,
      },
    });

    if (requiresApproval) {
      return reply.code(202).send({ run });
    }

    const started = await startWorkflowRun(workflow, run.id, userId);
    return reply.code(202).send({ run: started.run, operatorJob: started.job });
  });

  app.post("/workflows/runs/:id/approve", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { id } = req.params as { id: string };
    const run = await prisma.workflowRun.findUnique({
      where: { id },
      include: {
        workflow: {
          include: {
            project: { select: { id: true, name: true, ownerId: true, repoUrl: true, sharedSteps: true } },
            environment: {
              select: {
                id: true,
                name: true,
                baseUrl: true,
                isProtected: true,
                requiresApproval: true,
              },
            },
          },
        },
      },
    });

    if (!run || run.workflow.project.ownerId !== userId) return reply.code(404).send({ error: "Workflow run not found" });
    if (run.status !== "awaiting_approval") return reply.code(409).send({ error: `Workflow run is ${run.status}` });

    const started = await startWorkflowRun(run.workflow, run.id, userId, userId);
    return reply.send({ run: started.run, operatorJob: started.job });
  });

  app.post("/workflows/runs/:id/deny", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { id } = req.params as { id: string };
    const run = await prisma.workflowRun.findUnique({
      where: { id },
      include: { workflow: { include: { project: { select: { ownerId: true } } } } },
    });
    if (!run || run.workflow.project.ownerId !== userId) return reply.code(404).send({ error: "Workflow run not found" });
    if (run.status !== "awaiting_approval") return reply.code(409).send({ error: `Workflow run is ${run.status}` });

    const updatedRun = await prisma.workflowRun.update({
      where: { id },
      data: { status: "denied", approvedBy: userId, finishedAt: new Date() },
    });
    return reply.send({ run: updatedRun });
  });
}
