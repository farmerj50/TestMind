import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma.js";
import { decryptSecret } from "../lib/crypto.js";
import { enqueueOperatorJob } from "../runner/queue.js";
import { validatedEnv } from "../config/env.js";
import type { Prisma } from "@prisma/client";
import { generateJenkinsfileScript, buildJobXml } from "../integrations/providers/jenkins.js";

const WEB_ORIGIN = (validatedEnv.WEB_URL ?? "http://localhost:5173").replace(/\/$/, "");

const WORKFLOW_MAP: Record<string, string> = {
  "qa-execute": "qa",
  "repair": "repair",
  "discovery": "discovery",
  "security": "security",
};

async function verifyToken(token: string): Promise<{ projectId: string } | null> {
  const underscoreIdx = token.indexOf("_");
  const projectId = underscoreIdx > 0 ? token.slice(0, underscoreIdx) : null;
  if (!projectId) return null;

  const secret = await prisma.projectSecret.findUnique({
    where: { projectId_key: { projectId, key: "jenkins_api_token" } },
  });
  if (!secret) return null;

  const decrypted = decryptSecret(secret.value);
  const same =
    decrypted.length === token.length &&
    timingSafeEqual(Buffer.from(decrypted), Buffer.from(token));
  return same ? { projectId } : null;
}

export default async function jenkinsRoutes(app: FastifyInstance) {
  app.post("/jenkins/run", async (req, reply) => {
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    if (!token) return reply.code(401).send({ error: "Missing bearer token" });

    const verified = await verifyToken(token);
    if (!verified) {
      return reply.code(401).send({ error: "Invalid or unconfigured token" });
    }
    const { projectId } = verified;

    const { workflow = "qa-execute", branch, baseUrl: bodyBaseUrl, environment: envName } = (req.body ?? {}) as {
      workflow?: string;
      branch?: string;
      baseUrl?: string;
      environment?: string;
    };

    const jobType = WORKFLOW_MAP[workflow];
    if (!jobType) {
      return reply.code(400).send({
        error: `Unknown workflow: ${workflow}. Valid values: ${Object.keys(WORKFLOW_MAP).join(", ")}`,
      });
    }

    // Idempotency — reject duplicate X-Request-ID within 60 seconds
    const requestId = req.headers["x-request-id"] as string | undefined;
    if (requestId) {
      const recent = await prisma.operatorJob.findFirst({
        where: {
          projectId,
          createdAt: { gte: new Date(Date.now() - 60_000) },
          contextJson: { path: ["requestId"], equals: requestId },
        },
        select: { id: true },
      });
      if (recent) {
        return reply.code(409).send({ error: "Duplicate request", jobId: recent.id });
      }
    }

    const [project, integration] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } }),
      prisma.integration.findFirst({ where: { projectId, provider: "jenkins" }, select: { config: true } }),
    ]);
    if (!project) return reply.code(404).send({ error: "Project not found" });

    // Resolve named environment → id + baseUrl
    let environmentId: string | null = null;
    let envBaseUrl: string | null = null;
    if (envName) {
      const env = await prisma.environment.findUnique({
        where: { projectId_name: { projectId, name: envName } },
        select: { id: true, baseUrl: true },
      });
      environmentId = env?.id ?? null;
      envBaseUrl = env?.baseUrl ?? null;
    }

    const storedBaseUrl = (integration?.config as any)?.baseUrl || null;
    const effectiveBaseUrl = bodyBaseUrl || envBaseUrl || storedBaseUrl || null;

    const job = await prisma.operatorJob.create({
      data: {
        projectId,
        type: jobType as any,
        objective: `Jenkins triggered: ${workflow}${branch ? ` (${branch})` : ""}`,
        requestedBy: project.ownerId,
        environmentId: environmentId ?? undefined,
        contextJson: {
          triggeredBy: "jenkins",
          branch: branch ?? null,
          requestId: requestId ?? null,
          baseUrl: effectiveBaseUrl,
          environmentId: environmentId ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    await enqueueOperatorJob(job.id);

    return reply.code(202).send({ jobId: job.id, type: jobType, status: "queued" });
  });

  // Poll endpoint — Jenkins calls this to check if the operator job completed
  app.get("/jenkins/status/:jobId", async (req, reply) => {
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    if (!token) return reply.code(401).send({ error: "Missing bearer token" });

    const verified = await verifyToken(token);
    if (!verified) return reply.code(401).send({ error: "Invalid or unconfigured token" });

    const { jobId } = req.params as { jobId: string };
    const opJob = await prisma.operatorJob.findUnique({
      where: { id: jobId },
      select: { id: true, projectId: true, status: true, type: true, error: true, startedAt: true, finishedAt: true },
    });

    if (!opJob) return reply.code(404).send({ error: "Job not found" });
    if (opJob.projectId !== verified.projectId) return reply.code(403).send({ error: "Forbidden" });

    // Find the test run linked to this operator job (via the first execute task)
    const task = await prisma.operatorTask.findFirst({
      where: { jobId: opJob.id, type: "execute" },
      select: { testRunId: true },
      orderBy: { createdAt: "asc" },
    });

    let testRun: { runId: string; status: string; passed: number; failed: number; total: number; error: string | null; runUrl: string } | null = null;
    if (task?.testRunId) {
      const run = await prisma.testRun.findUnique({
        where: { id: task.testRunId },
        select: { status: true, summary: true, error: true },
      });
      if (run) {
        // summary is stored as a JSON string (String? column) — must parse before reading fields
        let parsedSummary: { passed?: number; failed?: number; parsedCount?: number } | null = null;
        if (run.summary) {
          try {
            parsedSummary = typeof run.summary === "string" ? JSON.parse(run.summary) : run.summary;
          } catch {
            parsedSummary = null;
          }
        }
        testRun = {
          runId: task.testRunId,
          status: run.status,
          passed: parsedSummary?.passed ?? 0,
          failed: parsedSummary?.failed ?? 0,
          total: parsedSummary?.parsedCount ?? 0,
          error: run.error ?? null,
          runUrl: `${WEB_ORIGIN}/test-runs/${task.testRunId}`,
        };
      }
    }

    // Effective status for Jenkins: promote to the test run's terminal status as soon as
    // it is known — don't wait for the operator job to also finalize (saves one poll cycle).
    const testRunDone = testRun && (testRun.status === "succeeded" || testRun.status === "failed");
    let effectiveStatus = opJob.status;
    if (testRunDone) {
      effectiveStatus = testRun.status === "succeeded" ? "succeeded" : "failed";
    } else if (opJob.status === "succeeded" || opJob.status === "failed") {
      effectiveStatus = opJob.status;
    }

    const effectiveError = effectiveStatus !== "failed" ? null
      : opJob.error
        ?? (testRun?.failed ? `${testRun.failed} test(s) failed, ${testRun.passed} passed out of ${testRun.total}` : null)
        ?? testRun?.error
        ?? null;

    return reply.send({
      jobId: opJob.id,
      status: effectiveStatus,
      type: opJob.type,
      error: effectiveError,
      startedAt: opJob.startedAt,
      finishedAt: opJob.finishedAt ?? (testRunDone ? new Date() : null),
      passed: testRun?.passed ?? 0,
      failed: testRun?.failed ?? 0,
      total: testRun?.total ?? 0,
      testRun,
    });
  });

  // Trigger an actual Jenkins build from the TestMind UI.
  // Uses the Jenkins "Trigger builds remotely" token stored in the integration config.
  app.post("/jenkins/build", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { projectId, environment, workflow = "qa-execute", branch = "main", jobName: bodyJobName } = (req.body ?? {}) as {
      projectId?: string;
      environment?: string;
      workflow?: string;
      branch?: string;
      jobName?: string;
    };
    if (!projectId) return reply.code(400).send({ error: "projectId required" });

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });

    const integration = await prisma.integration.findFirst({
      where: { projectId, provider: "jenkins" },
      select: { id: true, config: true },
    });
    const cfg = (integration?.config as any) ?? {};
    const { jenkinsServerUrl, jenkinsTriggerToken, jenkinsAdminUser } = cfg as {
      jenkinsServerUrl?: string;
      jenkinsTriggerToken?: string;
      jenkinsAdminUser?: string;
    };

    // Use job name from request body (current UI value) or fall back to stored config
    const jenkinsJobName = bodyJobName?.trim() || (cfg.jenkinsJobName as string | undefined);

    if (!jenkinsServerUrl || !jenkinsJobName) {
      return reply.code(422).send({ error: "Jenkins build trigger not configured. Add server URL and job name." });
    }

    // Normalize localhost → 127.0.0.1 for server-side fetches (localhost may resolve to ::1 on some hosts)
    const effectiveServerUrl = jenkinsServerUrl.replace(/\blocalhost\b/g, "127.0.0.1");

    // Prefer admin credentials (stored from Create Pipeline) — no trigger token needed
    const adminSecret = jenkinsAdminUser
      ? await prisma.projectSecret.findUnique({
          where: { projectId_key: { projectId, key: "jenkins_admin_token" } },
          select: { value: true },
        })
      : null;

    const triggerHeaders: Record<string, string> = {};
    let triggerUrl: string;
    let auth: string | null = null;

    if (jenkinsAdminUser && adminSecret) {
      const adminToken = decryptSecret(adminSecret.value);
      auth = Buffer.from(`${jenkinsAdminUser}:${adminToken}`).toString("base64");
      triggerHeaders["Authorization"] = `Basic ${auth}`;

      // Persist the job name if it changed (so subsequent Run Now calls use the right job)
      if (jenkinsJobName !== cfg.jenkinsJobName && integration) {
        await prisma.integration.update({
          where: { id: integration.id },
          data: { config: { ...cfg, jenkinsJobName } },
        });
      }

      // Ensure the pipeline job exists in Jenkins — create/update using stored admin credentials
      const apiPort = validatedEnv.PORT ?? 8787;
      const dockerApiUrl = `http://host.docker.internal:${apiPort}`;
      const script = generateJenkinsfileScript(dockerApiUrl);
      const jobXml = buildJobXml(script);
      const xmlHeaders = { "Authorization": `Basic ${auth}`, "Content-Type": "text/xml;charset=UTF-8" };

      // Try update first (job exists), then create
      const updateRes = await fetch(
        `${effectiveServerUrl}/job/${encodeURIComponent(jenkinsJobName)}/config.xml`,
        { method: "POST", headers: xmlHeaders, body: jobXml }
      ).catch(() => null);

      if (!updateRes?.ok) {
        const createRes = await fetch(
          `${effectiveServerUrl}/createItem?name=${encodeURIComponent(jenkinsJobName)}`,
          { method: "POST", headers: xmlHeaders, body: jobXml }
        ).catch(() => null);
        if (createRes && !createRes.ok) {
          const body = await createRes.text().catch(() => "");
          console.log(`[jenkins/build] pipeline create failed ${createRes.status}: ${body.slice(0, 200)}`);
        } else {
          console.log(`[jenkins/build] created pipeline: ${jenkinsJobName}`);
        }
      } else {
        console.log(`[jenkins/build] updated pipeline: ${jenkinsJobName}`);
      }

      // Fetch CSRF crumb for the build trigger
      try {
        const crumbRes = await fetch(`${effectiveServerUrl}/crumbIssuer/api/json`, {
          headers: { "Authorization": `Basic ${auth}` },
        });
        if (crumbRes.ok) {
          const cd = await crumbRes.json() as { crumb: string; crumbRequestField: string };
          triggerHeaders[cd.crumbRequestField] = cd.crumb;
        }
      } catch {
        // CSRF may be disabled — proceed without crumb
      }

      const params = new URLSearchParams({
        ...(environment ? { ENVIRONMENT: environment } : {}),
        WORKFLOW: workflow,
        BRANCH: branch,
      });
      triggerUrl = `${effectiveServerUrl}/job/${encodeURIComponent(jenkinsJobName)}/buildWithParameters?${params}`;
    } else if (jenkinsTriggerToken) {
      const params = new URLSearchParams({
        token: jenkinsTriggerToken,
        ...(environment ? { ENVIRONMENT: environment } : {}),
        WORKFLOW: workflow,
        BRANCH: branch,
      });
      triggerUrl = `${effectiveServerUrl}/job/${encodeURIComponent(jenkinsJobName)}/buildWithParameters?${params}`;
    } else {
      return reply.code(422).send({ error: "No Jenkins credentials available. Click 'Create pipeline in Jenkins' to set up admin access, or configure a trigger token." });
    }

    let jenkinsRes: Response;
    try {
      jenkinsRes = await fetch(triggerUrl, { method: "POST", headers: triggerHeaders });
    } catch (err: any) {
      return reply.code(502).send({ error: `Could not reach Jenkins at ${jenkinsServerUrl}: ${err?.message}` });
    }

    if (jenkinsRes.status >= 400) {
      const body = await jenkinsRes.text().catch(() => "");
      console.log(`[jenkins/build] trigger failed ${jenkinsRes.status}: ${body.slice(0, 300)}`);
      return reply.code(502).send({ error: `Jenkins responded ${jenkinsRes.status}: ${body.slice(0, 200)}` });
    }

    console.log(`[jenkins/build] build queued for ${jenkinsJobName} (HTTP ${jenkinsRes.status})`);

    // Use effectiveServerUrl (127.0.0.1) so the browser link works when localhost → ::1 fails
    const buildUrl = `${effectiveServerUrl}/job/${encodeURIComponent(jenkinsJobName)}/`;
    return reply.code(202).send({ ok: true, buildUrl, jenkinsJobName, environment, workflow });
  });

  // UI-triggered test run — Clerk auth, no Jenkins token required.
  // Called from the Jenkins card in IntegrationsPage so users can verify
  // the integration works without leaving the browser.
  app.post("/jenkins/trigger", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { projectId, workflow = "qa-execute", environment: envName, branch } = (req.body ?? {}) as {
      projectId?: string;
      workflow?: string;
      environment?: string;
      branch?: string;
    };
    if (!projectId) return reply.code(400).send({ error: "projectId required" });

    const jobType = WORKFLOW_MAP[workflow];
    if (!jobType) {
      return reply.code(400).send({ error: `Unknown workflow: ${workflow}` });
    }

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });

    let environmentId: string | null = null;
    let envBaseUrl: string | null = null;
    if (envName) {
      const env = await prisma.environment.findUnique({
        where: { projectId_name: { projectId, name: envName } },
        select: { id: true, baseUrl: true },
      });
      environmentId = env?.id ?? null;
      envBaseUrl = env?.baseUrl ?? null;
    }

    const integration = await prisma.integration.findFirst({
      where: { projectId, provider: "jenkins" },
      select: { config: true },
    });
    const effectiveBaseUrl = envBaseUrl || (integration?.config as any)?.baseUrl || null;

    const job = await prisma.operatorJob.create({
      data: {
        projectId,
        type: jobType as any,
        objective: `Jenkins UI test: ${workflow}${envName ? ` → ${envName}` : ""}`,
        requestedBy: userId,
        environmentId: environmentId ?? undefined,
        contextJson: {
          triggeredBy: "jenkins-ui",
          branch: branch ?? null,
          baseUrl: effectiveBaseUrl,
          environmentId: environmentId ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    await enqueueOperatorJob(job.id);
    return reply.code(202).send({ jobId: job.id, type: jobType, status: "queued" });
  });
}
