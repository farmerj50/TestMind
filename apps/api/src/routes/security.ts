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
import { issueStreamTicket, registerAuthSessionStreamRoutes } from "../runner/auth-session-stream.js";
import { callAuthBypassEndpoint, buildStorageStateFromCookieString } from "../security/enterprise-bypass.js";
import { authenticateAuth0, authenticateFirebase, authenticateCognito, authenticateClerk } from "../security/provider-auth.js";
import { AUTH_SESSION_ROOT } from "../lib/storageRoots.js";
import fs from "node:fs/promises";
import path from "node:path";
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
  authSessionId: z.string().optional(),
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

    // If a captured auth session (Enterprise bypass or Bug Bounty live capture) was selected,
    // turn its stored cookies into a synthetic cookie auth profile for this scan. cookieName
    // "__raw__" tells buildAuthHeaders() to send cookieValue as the full Cookie header verbatim
    // (it may contain multiple name=value pairs), rather than treating it as a single cookie.
    let sessionAuthProfiles: SecurityAuthProfile[] = [];
    if (body.authSessionId) {
      const rawAuthSession = await prisma.securityAuthSession.findFirst({
        where: { id: body.authSessionId, projectId: project.id },
      });
      if (!rawAuthSession) return reply.code(400).send({ error: "Captured auth session not found" });
      const authSession = await expireIfStale(rawAuthSession);
      if (authSession.status === "expired") {
        return reply.code(400).send({ error: "Selected auth session has expired. Re-authenticate before starting this scan." });
      }
      if (!["authenticated", "captured"].includes(authSession.status) || !authSession.storagePath) {
        return reply.code(400).send({ error: "Selected auth session has not completed authentication yet" });
      }
      try {
        const raw = await fs.readFile(authSession.storagePath, "utf8");
        const parsedState = JSON.parse(raw);
        if (typeof parsedState.bearerToken === "string" && parsedState.bearerToken) {
          // Real OAuth/IdP provider auth (Auth0/Firebase) produces a bearer token, not cookies.
          sessionAuthProfiles = [
            {
              label: "Captured session (auth-session)",
              role: authSession.role ?? undefined,
              type: "bearer",
              token: parsedState.bearerToken,
            },
          ];
        } else {
          const cookieHeader = (parsedState.cookies ?? [])
            .map((c: any) => `${c.name}=${c.value}`)
            .join("; ");
          if (!cookieHeader) throw new Error("Captured session has no cookies or bearer token.");
          sessionAuthProfiles = [
            {
              label: "Captured session (auth-session)",
              role: authSession.role ?? undefined,
              type: "cookie",
              cookieName: "__raw__",
              cookieValue: cookieHeader,
            },
          ];
        }
      } catch (err: any) {
        return reply.code(400).send({ error: `Failed to load captured session: ${err?.message ?? err}` });
      }
    }

    const savedSetup = body.useSavedSetup ? await getSavedSecuritySetup(project.id) : emptySecurityTestSetup();
    const testSetup = mergeSecurityTestSetup(savedSetup, {
      authProfiles: [...(body.authProfiles as SecurityAuthProfile[]), ...sessionAuthProfiles],
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

  // ── Auth sessions (Enterprise / Bug Bounty mode) ────────────────────────────
  // Creates/tracks SecurityAuthSession records and their lifecycle. Bug Bounty mode's
  // remote-browser capture engine (live-streamed manual login + MFA, then storageState()
  // capture) lives in auth-session-stream.ts, registered via registerAuthSessionStreamRoutes
  // below. Enterprise mode supports a test-only bypass endpoint and direct Auth0/Firebase/
  // Cognito provider login (provider-auth.ts).

  const providerConfigSchema = z.object({
    domain: z.string().optional(),
    clientId: z.string().optional(),
    audience: z.string().optional(),
    username: z.string().optional(),
    apiKey: z.string().optional(),
    region: z.string().optional(),
    frontendApiUrl: z.string().optional(),
    origin: z.string().optional(),
  });

  const authSessionStartSchema = z.object({
    projectId: z.string(),
    mode: z.enum(["enterprise", "bug_bounty"]),
    provider: z.string().optional(),
    baseUrl: z.string().url().optional(),
    loginUrl: z.string().url().optional(),
    scopeAcknowledged: z.boolean().default(false),
    role: z.string().optional(),
    bypassSecretKey: z.string().optional(),
    providerConfig: providerConfigSchema.optional(),
    providerPasswordSecretKey: z.string().optional(),
    providerClientSecretKey: z.string().optional(),
  });

  // A captured/authenticated session whose expiresAt has passed is stale credentials, not a
  // live session — flip it to "expired" lazily (on read) so the UI's "Session expired /
  // Re-authentication required" states actually fire, and so scans can't silently reuse it.
  const EXPIRABLE_STATUSES = ["authenticated", "captured"];
  async function expireIfStale<T extends { id: string; status: string; expiresAt: Date | null }>(
    session: T
  ): Promise<T> {
    if (!EXPIRABLE_STATUSES.includes(session.status)) return session;
    if (!session.expiresAt || session.expiresAt.getTime() > Date.now()) return session;
    return (await prisma.securityAuthSession.update({
      where: { id: session.id },
      data: { status: "expired", error: "Session expired; re-authenticate to continue." },
    })) as unknown as T;
  }

  app.get("/security/auth-sessions", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { projectId } = req.query as { projectId?: string };
    if (!projectId) return reply.code(400).send({ error: "projectId required" });
    const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: userId }, select: { id: true } });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const sessions = await prisma.securityAuthSession.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const checked = await Promise.all(sessions.map((s) => expireIfStale(s)));
    return { sessions: checked };
  });

  app.post("/security/auth-sessions/start", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = authSessionStartSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const body = parsed.data;

    const project = await prisma.project.findFirst({ where: { id: body.projectId, ownerId: userId }, select: { id: true } });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    if (body.mode === "bug_bounty") {
      if (!body.scopeAcknowledged) {
        return reply.code(400).send({ error: "Bug Bounty mode requires scope/rules acknowledgement before starting a session" });
      }
      if (!body.baseUrl || !body.loginUrl) {
        return reply.code(400).send({ error: "Bug Bounty mode requires both baseUrl and loginUrl" });
      }
    }
    if (body.mode === "enterprise" && body.provider === "bypass" && (!body.baseUrl || !body.bypassSecretKey)) {
      return reply.code(400).send({ error: "Enterprise bypass mode requires baseUrl and a bypassSecretKey" });
    }
    if (body.mode === "enterprise" && (body.provider === "auth0" || body.provider === "firebase" || body.provider === "cognito" || body.provider === "clerk")) {
      if (!body.providerPasswordSecretKey) {
        return reply.code(400).send({ error: `${body.provider} mode requires providerPasswordSecretKey` });
      }
      if (body.provider === "auth0" && (!body.providerConfig?.domain || !body.providerConfig?.clientId || !body.providerConfig?.username)) {
        return reply.code(400).send({ error: "Auth0 mode requires providerConfig.domain, clientId, and username" });
      }
      if (body.provider === "firebase" && (!body.providerConfig?.apiKey || !body.providerConfig?.username)) {
        return reply.code(400).send({ error: "Firebase mode requires providerConfig.apiKey and username (email)" });
      }
      if (body.provider === "cognito" && (!body.providerConfig?.region || !body.providerConfig?.clientId || !body.providerConfig?.username)) {
        return reply.code(400).send({ error: "Cognito mode requires providerConfig.region, clientId, and username" });
      }
      if (body.provider === "clerk" && (!body.providerConfig?.frontendApiUrl || !body.providerConfig?.username)) {
        return reply.code(400).send({ error: "Clerk mode requires providerConfig.frontendApiUrl and username (identifier)" });
      }
    }

    const session = await prisma.securityAuthSession.create({
      data: {
        projectId: body.projectId,
        mode: body.mode,
        provider: body.provider,
        baseUrl: body.baseUrl,
        loginUrl: body.loginUrl,
        scopeAcknowledged: body.scopeAcknowledged,
        role: body.role,
        bypassSecretKey: body.bypassSecretKey,
        providerConfig: body.providerConfig,
        providerPasswordSecretKey: body.providerPasswordSecretKey,
        providerClientSecretKey: body.providerClientSecretKey,
        status: "pending",
      },
    });
    return reply.code(201).send({ session });
  });

  app.get("/security/auth-sessions/:id/status", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const session = await prisma.securityAuthSession.findFirst({
      where: { id, project: { ownerId: userId } },
    });
    if (!session) return reply.code(404).send({ error: "Not found" });
    return { session: await expireIfStale(session) };
  });

  app.post("/security/auth-sessions/:id/refresh", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const existing = await prisma.securityAuthSession.findFirst({
      where: { id, project: { ownerId: userId } },
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });

    const session = await prisma.securityAuthSession.update({
      where: { id },
      data: { status: "pending", error: null, expiresAt: null },
    });
    return { session };
  });

  app.post("/security/auth-sessions/:id/bypass-authenticate", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const session = await prisma.securityAuthSession.findFirst({
      where: { id, project: { ownerId: userId } },
    });
    if (!session) return reply.code(404).send({ error: "Not found" });
    if (session.mode !== "enterprise") {
      return reply.code(400).send({ error: "Bypass authentication is only available for Enterprise mode sessions" });
    }
    if (!session.baseUrl || !session.bypassSecretKey) {
      return reply.code(400).send({ error: "Session is missing baseUrl or bypassSecretKey" });
    }

    const secretRow = await prisma.projectSecret.findUnique({
      where: { projectId_key: { projectId: session.projectId, key: session.bypassSecretKey } },
    });
    if (!secretRow) {
      return reply.code(400).send({ error: `No project secret found for key "${session.bypassSecretKey}"` });
    }

    try {
      const result = await callAuthBypassEndpoint({
        baseUrl: session.baseUrl,
        sharedSecret: secretRow.value,
        role: session.role ?? undefined,
      });
      const storageState = buildStorageStateFromCookieString(result.sessionCookie, session.baseUrl);
      const storagePath = path.join(AUTH_SESSION_ROOT, `${id}.json`);
      await fs.writeFile(storagePath, JSON.stringify(storageState), "utf8");
      const updated = await prisma.securityAuthSession.update({
        where: { id },
        data: {
          status: "authenticated",
          role: result.role,
          storagePath,
          expiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
          error: null,
        },
      });
      return { session: updated };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const updated = await prisma.securityAuthSession.update({
        where: { id },
        data: { status: "failed", error: message },
      });
      return reply.code(400).send({ error: message, session: updated });
    }
  });

  app.post("/security/auth-sessions/:id/provider-authenticate", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const session = await prisma.securityAuthSession.findFirst({
      where: { id, project: { ownerId: userId } },
    });
    if (!session) return reply.code(404).send({ error: "Not found" });
    if (session.mode !== "enterprise" || !["auth0", "firebase", "cognito", "clerk"].includes(session.provider ?? "")) {
      return reply.code(400).send({ error: "Provider authentication is only available for Enterprise Auth0/Firebase/Cognito/Clerk sessions" });
    }
    if (!session.providerPasswordSecretKey) {
      return reply.code(400).send({ error: "Session is missing providerPasswordSecretKey" });
    }

    const passwordRow = await prisma.projectSecret.findUnique({
      where: { projectId_key: { projectId: session.projectId, key: session.providerPasswordSecretKey } },
    });
    if (!passwordRow) {
      return reply.code(400).send({ error: `No project secret found for key "${session.providerPasswordSecretKey}"` });
    }
    let clientSecret: string | undefined;
    if (session.providerClientSecretKey) {
      const clientSecretRow = await prisma.projectSecret.findUnique({
        where: { projectId_key: { projectId: session.projectId, key: session.providerClientSecretKey } },
      });
      if (!clientSecretRow) {
        return reply.code(400).send({ error: `No project secret found for key "${session.providerClientSecretKey}"` });
      }
      clientSecret = clientSecretRow.value;
    }

    const config = (session.providerConfig ?? {}) as Record<string, string | undefined>;

    try {
      let result: { token: string; expiresIn?: number };
      if (session.provider === "auth0") {
        if (!config.domain || !config.clientId || !config.username) {
          throw new Error("Session providerConfig is missing domain/clientId/username for Auth0.");
        }
        result = await authenticateAuth0({
          domain: config.domain,
          clientId: config.clientId,
          clientSecret,
          audience: config.audience,
          username: config.username,
          password: passwordRow.value,
        });
      } else if (session.provider === "firebase") {
        if (!config.apiKey || !config.username) {
          throw new Error("Session providerConfig is missing apiKey/username (email) for Firebase.");
        }
        result = await authenticateFirebase({
          apiKey: config.apiKey,
          email: config.username,
          password: passwordRow.value,
        });
      } else if (session.provider === "cognito") {
        if (!config.region || !config.clientId || !config.username) {
          throw new Error("Session providerConfig is missing region/clientId/username for Cognito.");
        }
        result = await authenticateCognito({
          region: config.region,
          clientId: config.clientId,
          clientSecret,
          username: config.username,
          password: passwordRow.value,
        });
      } else {
        if (!config.frontendApiUrl || !config.username) {
          throw new Error("Session providerConfig is missing frontendApiUrl/username for Clerk.");
        }
        result = await authenticateClerk({
          frontendApiUrl: config.frontendApiUrl,
          identifier: config.username,
          password: passwordRow.value,
          origin: config.origin,
        });
      }

      const storagePath = path.join(AUTH_SESSION_ROOT, `${id}.json`);
      await fs.writeFile(storagePath, JSON.stringify({ bearerToken: result.token }), "utf8");
      const updated = await prisma.securityAuthSession.update({
        where: { id },
        data: {
          status: "authenticated",
          storagePath,
          expiresAt: result.expiresIn ? new Date(Date.now() + result.expiresIn * 1000) : null,
          error: null,
        },
      });
      return { session: updated };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      const updated = await prisma.securityAuthSession.update({
        where: { id },
        data: { status: "failed", error: message },
      });
      return reply.code(400).send({ error: message, session: updated });
    }
  });

  const streamTicketSchema = z.object({
    attemptWafBypass: z.boolean().default(false),
  });

  app.post("/security/auth-sessions/:id/stream-ticket", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const session = await prisma.securityAuthSession.findFirst({
      where: { id, project: { ownerId: userId } },
    });
    if (!session) return reply.code(404).send({ error: "Not found" });
    if (session.mode !== "bug_bounty") {
      return reply.code(400).send({ error: "Live session capture is only available for Bug Bounty sessions" });
    }
    // attemptWafBypass requires the same in-scope acknowledgement already collected at session start.
    const parsed = streamTicketSchema.safeParse(req.body ?? {});
    const attemptWafBypass = (parsed.success && parsed.data.attemptWafBypass) && session.scopeAcknowledged;
    return { ticket: issueStreamTicket(id, attemptWafBypass) };
  });

  registerAuthSessionStreamRoutes(app);
}
