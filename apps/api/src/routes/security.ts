import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { enqueueSecurityScan } from "../runner/queue.js";
import {
  buildSecurityFindingDetail,
  buildSecurityRegressionTest,
} from "../lib/security-finding-detail.js";
import { redactAuthProfileForStorage } from "../security/redaction.js";
import {
  SECURITY_TEST_SETUP_PROVIDER,
  apiSecurityFixtureSchema,
  emptySecurityTestSetup,
  expectedSecurityControlSchema,
  mergeSecurityTestSetup,
  parseSecurityTestSetup,
  securityAuthProfileSchema,
  securityTestSetupSchema,
} from "../security/setup.js";
import {
  SECURITY_BASELINE_PROVIDER,
  emptySecurityBaselineStore,
  parseSecurityBaselineStore,
  upsertSecurityBehaviorBaseline,
} from "../security/baseline.js";
import {
  discoverRouteInventory,
  suggestApiSecurityFixtures,
} from "../security/modules/route-inventory.js";
import type { ApiSecurityFixture, SecurityAuthProfile, SecurityBehaviorBaseline } from "../security/types.js";

function requireUser(req: any, reply: any) {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

const startSchema = z.object({
  projectId: z.string(),
  baseUrl: z.string().url(),
  allowedHosts: z.array(z.string()).default([]),
  allowedPorts: z.array(z.number()).default([80, 443]),
  maxDurationMinutes: z.number().int().min(1).max(60).default(10),
  enableActive: z.boolean().default(false),
  environment: z.enum(["dev", "qa", "stage", "prod"]).default("qa"),
  scanDepth: z.enum(["baseline", "standard", "deep"]).default("standard"),
  safeMode: z.boolean().default(true),
  useSavedSetup: z.boolean().default(true),
  authProfiles: z.array(securityAuthProfileSchema).default([]),
  apiFixtures: z.array(apiSecurityFixtureSchema).default([]),
  expectedControls: z.array(expectedSecurityControlSchema).default([]),
  owaspCategories: z.array(z.string()).default([]),
  complianceFrameworks: z.array(z.string()).default([]),
});

const contractSuggestionSchema = z.object({
  baseUrl: z.string().url(),
  allowedHosts: z.array(z.string()).default([]),
  allowedPorts: z.array(z.number()).default([80, 443]),
  scanDepth: z.enum(["baseline", "standard", "deep"]).default("standard"),
  expectedControls: z.array(expectedSecurityControlSchema).default([]),
});

async function getSavedSecuritySetup(projectId: string) {
  const integration = await prisma.integration.findFirst({
    where: { projectId, provider: SECURITY_TEST_SETUP_PROVIDER, enabled: true },
    orderBy: { updatedAt: "desc" },
    select: { config: true },
  });
  return integration ? parseSecurityTestSetup(integration.config) : emptySecurityTestSetup();
}

async function putSavedSecuritySetup(projectId: string, setup: ReturnType<typeof parseSecurityTestSetup>) {
  const existing = await prisma.integration.findFirst({
    where: { projectId, provider: SECURITY_TEST_SETUP_PROVIDER },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });

  if (existing) {
    return prisma.integration.update({
      where: { id: existing.id },
      data: {
        name: "Security test setup",
        config: setup as any,
        secrets: undefined,
        enabled: true,
      },
    });
  }

  return prisma.integration.create({
    data: {
      projectId,
      provider: SECURITY_TEST_SETUP_PROVIDER,
      name: "Security test setup",
      config: setup as any,
      enabled: true,
    },
  });
}

async function putApprovedSecurityBaseline(projectId: string, baseline: SecurityBehaviorBaseline) {
  const existing = await prisma.integration.findFirst({
    where: { projectId, provider: SECURITY_BASELINE_PROVIDER },
    orderBy: { updatedAt: "desc" },
    select: { id: true, config: true },
  });
  const store = existing ? parseSecurityBaselineStore(existing.config) : emptySecurityBaselineStore();
  const nextStore = upsertSecurityBehaviorBaseline(store, baseline);

  if (existing) {
    return prisma.integration.update({
      where: { id: existing.id },
      data: {
        name: "Security behavior baseline",
        config: nextStore as any,
        secrets: undefined,
        enabled: true,
      },
    });
  }

  return prisma.integration.create({
    data: {
      projectId,
      provider: SECURITY_BASELINE_PROVIDER,
      name: "Security behavior baseline",
      config: nextStore as any,
      enabled: true,
    },
  });
}

export default async function securityRoutes(app: FastifyInstance) {
  app.get("/projects/:projectId/security-setup", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { projectId } = req.params as { projectId: string };
    const project = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    return { setup: await getSavedSecuritySetup(project.id) };
  });

  app.put("/projects/:projectId/security-setup", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { projectId } = req.params as { projectId: string };
    const project = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const parsed = securityTestSetupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.flatten() });

    await putSavedSecuritySetup(project.id, parsed.data as any);
    return { setup: parsed.data };
  });

  app.post("/projects/:projectId/security-contract-suggestions", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { projectId } = req.params as { projectId: string };
    const project = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const parsed = contractSuggestionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const body = parsed.data;

    const target = new URL(body.baseUrl);
    const allowedHosts = body.allowedHosts.length ? body.allowedHosts : [target.hostname];
    const allowedPorts = body.allowedPorts.length
      ? body.allowedPorts
      : [target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80];
    const savedSetup = await getSavedSecuritySetup(project.id);
    const config = {
      jobId: "contract-suggestions",
      projectId: project.id,
      baseUrl: body.baseUrl,
      allowedHosts,
      allowedPorts,
      maxDurationMinutes: 2,
      enableActive: false,
      environment: "qa",
      scanDepth: body.scanDepth,
      safeMode: true,
      authProfiles: savedSetup.authProfiles,
      apiFixtures: savedSetup.apiFixtures,
      expectedControls: body.expectedControls.length
        ? body.expectedControls
        : savedSetup.expectedControls,
      owaspCategories: savedSetup.owaspCategories,
      complianceFrameworks: savedSetup.complianceFrameworks,
    };

    const inventory = await discoverRouteInventory(config);
    const suggestions = suggestApiSecurityFixtures(config, inventory);
    return {
      suggestions,
      inventory: {
        routes: inventory.length,
        sources: inventory.reduce<Record<string, number>>((acc, route) => {
          acc[route.source] = (acc[route.source] ?? 0) + 1;
          return acc;
        }, {}),
      },
    };
  });

  app.post("/security/scans", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const body = parsed.data;

    const project = await prisma.project.findFirst({
      where: { id: body.projectId, ownerId: userId },
      select: { id: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const target = new URL(body.baseUrl);
    const allowedHosts = body.allowedHosts.length ? body.allowedHosts : [target.hostname];
    const allowedPorts = body.allowedPorts.length
      ? body.allowedPorts
      : [target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80];
    const savedSetup = body.useSavedSetup ? await getSavedSecuritySetup(project.id) : emptySecurityTestSetup();
    const testSetup = mergeSecurityTestSetup(savedSetup, {
      authProfiles: body.authProfiles as SecurityAuthProfile[],
      apiFixtures: body.apiFixtures as ApiSecurityFixture[],
      expectedControls: body.expectedControls,
      owaspCategories: body.owaspCategories,
      complianceFrameworks: body.complianceFrameworks,
    });
    const authProfiles = testSetup.authProfiles;
    const approvalRequired =
      body.environment === "prod" || body.scanDepth === "deep" || body.enableActive || body.safeMode === false;
    if (body.environment === "prod" && (body.scanDepth === "deep" || body.enableActive || body.safeMode === false)) {
      return reply.code(409).send({
        error:
          "Deep, active, or non-safe production security validation requires Operator approval. Use Operator > Security for this target.",
      });
    }

    const job = await prisma.securityScanJob.create({
      data: {
        projectId: project.id,
        status: "queued",
        phase: null,
        config: {
          baseUrl: body.baseUrl,
          allowedHosts,
          allowedPorts,
          maxDurationMinutes: body.maxDurationMinutes,
          enableActive: body.enableActive,
          environment: body.environment,
          scanDepth: body.scanDepth,
          safeMode: body.safeMode,
          approvalRequired,
          useSavedSetup: body.useSavedSetup,
          authProfiles: authProfiles.map((profile) => redactAuthProfileForStorage(profile)),
          apiFixtures: testSetup.apiFixtures,
          expectedControls: testSetup.expectedControls,
          owaspCategories: testSetup.owaspCategories,
          complianceFrameworks: testSetup.complianceFrameworks,
        } as any,
      },
    });

    try {
      await enqueueSecurityScan({
        jobId: job.id,
        projectId: project.id,
        baseUrl: body.baseUrl,
        allowedHosts,
        allowedPorts,
        maxDurationMinutes: body.maxDurationMinutes,
        enableActive: body.enableActive,
        environment: body.environment,
        scanDepth: body.scanDepth,
        safeMode: body.safeMode,
        authProfiles,
        apiFixtures: testSetup.apiFixtures,
        expectedControls: testSetup.expectedControls,
        owaspCategories: testSetup.owaspCategories,
        complianceFrameworks: testSetup.complianceFrameworks,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await prisma.securityScanJob
        .update({
          where: { id: job.id },
          data: {
            status: "failed",
            error: "Security scan queue unavailable. Start Redis and try again.",
            finishedAt: new Date(),
          },
        })
        .catch(() => {});
      return reply.code(503).send({
        error: "Security scan queue unavailable. Start Redis and try again.",
        detail,
        job: { ...job, status: "failed", error: "Security scan queue unavailable. Start Redis and try again." },
      });
    }

    return { job };
  });

  app.get("/security/scans/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const job = await prisma.securityScanJob.findFirst({
      where: { id, project: { ownerId: userId } },
      include: {
        findings: {
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!job) return reply.code(404).send({ error: "Not found" });
    return { job };
  });

  app.post("/security/scans/:id/approve-baseline", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const job = await prisma.securityScanJob.findFirst({
      where: { id, project: { ownerId: userId } },
      select: {
        id: true,
        projectId: true,
        status: true,
        summary: true,
      },
    });
    if (!job) return reply.code(404).send({ error: "Not found" });
    if (job.status !== "completed") {
      return reply.code(409).send({ error: "Only completed scans can be approved as a baseline." });
    }

    const summary = (job.summary ?? {}) as any;
    const candidate = summary?.baseline?.candidate as SecurityBehaviorBaseline | undefined;
    if (!candidate?.fingerprints?.length || !candidate.scopeKey) {
      return reply.code(400).send({ error: "This scan does not contain a baseline candidate." });
    }

    const approvedBaseline: SecurityBehaviorBaseline = {
      ...candidate,
      approvedAt: new Date().toISOString(),
      approvedBy: userId,
    };
    await putApprovedSecurityBaseline(job.projectId, approvedBaseline);

    const updatedSummary = {
      ...summary,
      baseline: {
        ...(summary.baseline ?? {}),
        approved: {
          sourceScanId: approvedBaseline.sourceScanId,
          approvedAt: approvedBaseline.approvedAt,
          approvedBy: approvedBaseline.approvedBy,
          fingerprints: approvedBaseline.fingerprints.length,
        },
        drift: {
          ...(summary.baseline?.drift ?? {}),
          baselinePresent: true,
          approvedAt: approvedBaseline.approvedAt,
          sourceScanId: approvedBaseline.sourceScanId,
          baselineFingerprints: approvedBaseline.fingerprints.length,
          driftFindings: 0,
          deniedToAllowed: 0,
          allowedToDenied: 0,
          statusClassChanges: 0,
          schemaChanges: 0,
          missingProbes: 0,
        },
      },
    };

    const updated = await prisma.securityScanJob.update({
      where: { id: job.id },
      data: { summary: updatedSummary as any },
      include: {
        findings: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    return { job: updated, baseline: approvedBaseline };
  });

  app.get("/security/scans", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const projectId = (req.query as any)?.projectId as string | undefined;
    const jobs = await prisma.securityScanJob.findMany({
      where: {
        project: { ownerId: userId },
        ...(projectId ? { projectId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        projectId: true,
        status: true,
        phase: true,
        summary: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { jobs };
  });

  app.post("/security/findings/:id/explain", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const finding = await prisma.securityFinding.findFirst({
      where: { id, scan: { project: { ownerId: userId } } },
    });
    if (!finding) return reply.code(404).send({ error: "Not found" });
    return { detail: buildSecurityFindingDetail(finding as any) };
  });

  app.post("/security/findings/:id/generate-test", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const finding = await prisma.securityFinding.findFirst({
      where: { id, scan: { project: { ownerId: userId } } },
    });
    if (!finding) return reply.code(404).send({ error: "Not found" });
    return { test: buildSecurityRegressionTest(finding as any) };
  });
}
