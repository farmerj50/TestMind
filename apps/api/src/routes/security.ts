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
import { issueLiveTestTicket, registerLiveSecuritySessionRoutes, closeLiveSession } from "../runner/live-security-session.js";
import {
  callAuthBypassEndpoint,
  buildStorageStateFromCookieString,
  detectCaptureFormat,
  parseRawHttpRequest,
  parseCurlCommand,
  type CaptureFormat,
  type ParsedAuthCapture,
} from "../security/enterprise-bypass.js";
import { authenticateAuth0, authenticateFirebase, authenticateCognito, authenticateClerk } from "../security/provider-auth.js";
import { parseApiSpec, specSummary } from "../security/openapi-parser.js";
import { buildHtmlReport } from "../security/compliance-report.js";
import { generateBugBountyReport } from "../security/bug-bounty-report.js";
import { safeFetch } from "../lib/safe-fetch.js";
import { AUTH_SESSION_ROOT } from "../lib/storageRoots.js";
import { requiresProductionApproval } from "../lib/security-approval-policy.js";
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

async function validateImportedSession(
  baseUrl: string,
  capture: ParsedAuthCapture
): Promise<{ valid: boolean | null; statusCode?: number }> {
  const headers: Record<string, string> = { ...capture.additionalHeaders };
  if (capture.cookieString) headers["Cookie"] = capture.cookieString;

  const attempts: Array<{ url: string; method: string; body?: string; contentType?: string }> = [];

  if (capture.preferredEndpoint && capture.preferredMethod) {
    try {
      const endpointUrl = new URL(capture.preferredEndpoint, baseUrl).toString();
      attempts.push({
        url: endpointUrl,
        method: capture.preferredMethod,
        body: capture.preferredBody,
        contentType: capture.rawHeaders["Content-Type"],
      });
    } catch {
      // malformed endpoint — skip
    }
  }

  try {
    attempts.push({ url: new URL("/", baseUrl).toString(), method: "HEAD" });
  } catch {
    // malformed baseUrl — skip
  }

  for (const attempt of attempts) {
    try {
      const reqHeaders: Record<string, string> = { ...headers };
      if (attempt.body) reqHeaders["Content-Type"] = attempt.contentType ?? "application/json";
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      let res: Response;
      try {
        res = await safeFetch(
          attempt.url,
          {
            method: attempt.method,
            headers: reqHeaders,
            body: attempt.body && !["GET", "HEAD"].includes(attempt.method) ? attempt.body : undefined,
            signal: controller.signal as any,
          },
          { allowHttp: true, maxRedirects: 3 }
        );
      } finally {
        clearTimeout(timeoutId);
      }
      const status = res.status;
      if (status >= 200 && status < 400) return { valid: true, statusCode: status };
      if (status === 401 || status === 403) return { valid: false, statusCode: status };
      // Other status — try next attempt
    } catch {
      // Network error, SSRF block, abort, or redirect overflow — try next
    }
  }
  return { valid: null };
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
  sourceMode: z.enum(["auto", "url_only", "code_assisted"]).default("auto"),
  useSavedSetup: z.boolean().default(true),
  authSessionId: z.string().optional(),
  apiSpecId: z.string().optional(),
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
          if (!cookieHeader && !parsedState.additionalHeaders) {
            throw new Error("Captured session has no cookies or bearer token.");
          }
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
        // Extend with additional headers captured from Burp/cURL import
        if (
          sessionAuthProfiles.length > 0 &&
          parsedState.additionalHeaders &&
          typeof parsedState.additionalHeaders === "object"
        ) {
          sessionAuthProfiles[0].additionalHeaders = parsedState.additionalHeaders as Record<string, string>;
        }
        if (
          sessionAuthProfiles.length > 0 &&
          parsedState.rawHeaders &&
          typeof parsedState.rawHeaders === "object"
        ) {
          sessionAuthProfiles[0].rawHeaders = parsedState.rawHeaders as Record<string, string>;
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
    if (requiresProductionApproval({
      environment: body.environment,
      scanDepth: body.scanDepth,
      enableActive: body.enableActive,
      safeMode: body.safeMode,
    })) {
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
          sourceMode: body.sourceMode,
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
        sourceMode: body.sourceMode,
        authProfiles,
        apiFixtures: testSetup.apiFixtures,
        expectedControls: testSetup.expectedControls,
        owaspCategories: testSetup.owaspCategories,
        complianceFrameworks: testSetup.complianceFrameworks,
        apiSpecId: body.apiSpecId,
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

  app.get("/security/scans/:id/compliance-report", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const { format = "json" } = req.query as { format?: string };
    const job = await prisma.securityScanJob.findFirst({
      where: { id, project: { ownerId: userId } },
      select: { id: true, status: true, summary: true },
    });
    if (!job) return reply.code(404).send({ error: "Not found" });
    if (job.status !== "completed") {
      return reply.code(400).send({ error: "Compliance report is only available for completed scans." });
    }
    const report = (job.summary as any)?.complianceReport;
    if (!report) return reply.code(404).send({ error: "No compliance report found for this scan. Re-run the scan to generate one." });
    if (format === "html") {
      const html = buildHtmlReport(report);
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="compliance-report-${id.slice(-8)}.html"`)
        .send(html);
    }
    return { report };
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

  app.post("/security/findings/:id/bug-bounty-report", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const finding = await prisma.securityFinding.findFirst({
      where: { id, scan: { project: { ownerId: userId } } },
      include: { scan: { select: { id: true, config: true } } },
    });
    if (!finding) return reply.code(404).send({ error: "Not found" });
    const targetUrl = (finding.scan.config as any)?.baseUrl ?? finding.location ?? "";
    const report = generateBugBountyReport(finding as any, targetUrl);
    const { format = "json" } = (req.body as any) ?? {};
    if (format === "markdown") {
      return reply
        .code(200)
        .header("Content-Type", "text/markdown; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="bug-bounty-report-${id.slice(-8)}.md"`)
        .send(report.markdown);
    }
    return { report };
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

  app.post("/security/auth-sessions/:id/import-cookies", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const session = await prisma.securityAuthSession.findFirst({
      where: { id, project: { ownerId: userId } },
    });
    if (!session) return reply.code(404).send({ error: "Not found" });

    const body = req.body as { cookies?: string; baseUrl?: string } | null;
    const rawCookies = body?.cookies?.trim() ?? "";
    if (!rawCookies) return reply.code(400).send({ error: "cookies is required" });

    const targetUrl = body?.baseUrl?.trim() || session.baseUrl || "https://example.com";
    try {
      const storageState = buildStorageStateFromCookieString(rawCookies, targetUrl);
      if (!storageState.cookies.length) {
        return reply.code(400).send({ error: "No valid cookies found in the provided string." });
      }
      const storagePath = path.join(AUTH_SESSION_ROOT, `${id}.json`);
      await fs.writeFile(storagePath, JSON.stringify(storageState), "utf8");
      const updated = await prisma.securityAuthSession.update({
        where: { id },
        data: { status: "captured", storagePath, error: null },
      });
      return { session: updated };
    } catch (err: any) {
      return reply.code(400).send({ error: `Failed to import cookies: ${err?.message ?? err}` });
    }
  });

  app.post("/security/auth-sessions/:id/import-session", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const session = await prisma.securityAuthSession.findFirst({
      where: { id, project: { ownerId: userId } },
    });
    if (!session) return reply.code(404).send({ error: "Not found" });

    const body = req.body as { payload?: string; baseUrl?: string } | null;
    const payload = body?.payload?.trim() ?? "";
    if (!payload) return reply.code(400).send({ error: "payload is required" });

    const targetUrl = body?.baseUrl?.trim() || session.baseUrl || "https://example.com";

    try {
      const format: CaptureFormat = detectCaptureFormat(payload);
      let capture: ParsedAuthCapture;

      if (format === "raw_http") {
        capture = parseRawHttpRequest(payload);
      } else if (format === "curl") {
        capture = parseCurlCommand(payload);
      } else {
        // cookies mode — strip accidental "Cookie: " prefix
        let cookiePayload = payload;
        if (/^cookie:\s*/i.test(cookiePayload)) {
          cookiePayload = cookiePayload.replace(/^cookie:\s*/i, "");
        }
        capture = {
          cookieString: cookiePayload,
          rawHeaders: {},
          additionalHeaders: {},
          baseUrl: targetUrl,
          warnings: [],
        };
      }

      const effectiveBaseUrl = capture.baseUrl ?? targetUrl;
      const baseStorageState = capture.cookieString
        ? buildStorageStateFromCookieString(capture.cookieString, effectiveBaseUrl)
        : { cookies: [], origins: [] as any[] };

      const storageState: Record<string, unknown> = {
        ...baseStorageState,
        captureMode: format,
        rawCapture: payload.slice(0, 16384),
      };
      if (Object.keys(capture.rawHeaders).length) storageState.rawHeaders = capture.rawHeaders;
      if (Object.keys(capture.additionalHeaders).length) storageState.additionalHeaders = capture.additionalHeaders;
      if (capture.preferredEndpoint) storageState.preferredEndpoint = capture.preferredEndpoint;
      if (capture.preferredMethod) storageState.preferredMethod = capture.preferredMethod;
      if (capture.preferredBody) storageState.preferredBody = capture.preferredBody;
      if (capture.preferredOperation) storageState.preferredOperation = capture.preferredOperation;
      if (capture.warnings.length) storageState.importWarnings = capture.warnings;

      const storagePath = path.join(AUTH_SESSION_ROOT, `${id}.json`);
      await fs.writeFile(storagePath, JSON.stringify(storageState), "utf8");
      await prisma.securityAuthSession.update({
        where: { id },
        data: { status: "captured", storagePath, error: null },
      });

      const validationResult = await validateImportedSession(effectiveBaseUrl, capture);

      return {
        status: "captured",
        detectedFormat: format,
        sessionValid: validationResult.valid,
        statusCode: validationResult.statusCode,
        warnings: capture.warnings,
      };
    } catch (err: any) {
      return reply.code(400).send({ error: `Failed to import session: ${err?.message ?? err}` });
    }
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
    allowInteractiveChallengeHandling: z.boolean().default(false),
    proxyUrl: z.string().url().optional(),
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
    // allowInteractiveChallengeHandling requires the same in-scope acknowledgement already
    // collected at session start.
    const parsed = streamTicketSchema.safeParse(req.body ?? {});
    const allowInteractiveChallengeHandling =
      (parsed.success && parsed.data.allowInteractiveChallengeHandling) && session.scopeAcknowledged;
    const proxyUrl = parsed.success ? parsed.data.proxyUrl : undefined;
    return { ticket: issueStreamTicket(id, allowInteractiveChallengeHandling, proxyUrl) };
  });

  registerAuthSessionStreamRoutes(app);

  // ── Live Security Testing (v0.1 POC) ─────────────────────────────────────────

  app.post("/security/auth-sessions/:id/live-test-ticket", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const session = await prisma.securityAuthSession.findFirst({
      where: { id, project: { ownerId: userId } },
    });
    if (!session) return reply.code(404).send({ error: "Not found" });
    if (session.status !== "captured" || !session.storagePath) {
      return reply.code(400).send({ error: "Session has not completed authentication capture yet" });
    }
    if (!session.scopeAcknowledged) {
      return reply.code(400).send({ error: "Scope must be acknowledged before starting live testing" });
    }
    return { ticket: issueLiveTestTicket(id) };
  });

  app.post("/security/auth-sessions/:id/live-test-stop", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const session = await prisma.securityAuthSession.findFirst({
      where: { id, project: { ownerId: userId } },
    });
    if (!session) return reply.code(404).send({ error: "Not found" });
    await closeLiveSession(id);
    return { ok: true };
  });

  registerLiveSecuritySessionRoutes(app);

  // ── API Spec (OpenAPI / Swagger import) ──────────────────────────────────────

  const importSpecSchema = z.object({
    projectId: z.string(),
    specUrl: z.string().url().optional(),
    specJson: z.record(z.unknown()).optional(),
  }).refine((d) => d.specUrl || d.specJson, { message: "Provide either specUrl or specJson" });

  app.post("/security/api-specs/import", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = importSpecSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const body = parsed.data;

    const project = await prisma.project.findFirst({ where: { id: body.projectId, ownerId: userId }, select: { id: true } });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    let rawSpec: unknown;
    if (body.specUrl) {
      const specUrl = body.specUrl;
      const urlParsed = new URL(specUrl);
      const res = await safeFetch(specUrl, {}, { allowedHosts: [urlParsed.hostname] });
      const text = await res.text();
      if (!res.ok) return reply.code(400).send({ error: `Failed to fetch spec from URL (${res.status}): ${text.slice(0, 200)}` });
      try { rawSpec = JSON.parse(text); } catch {
        return reply.code(400).send({ error: "Fetched spec is not valid JSON. YAML specs must be converted to JSON first." });
      }
    } else {
      rawSpec = body.specJson;
    }

    let spec;
    try { spec = parseApiSpec(rawSpec); } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? "Failed to parse spec" });
    }

    const summary = specSummary(spec);
    const record = await prisma.apiSpec.create({
      data: {
        projectId: body.projectId,
        title: spec.title,
        version: spec.version,
        sourceUrl: body.specUrl,
        specJson: rawSpec as any,
        endpoints: spec.endpoints as any,
        endpointCount: summary.endpointCount,
      },
    });
    return reply.code(201).send({ spec: record, summary });
  });

  app.get("/security/api-specs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { projectId } = req.query as { projectId?: string };
    if (!projectId) return reply.code(400).send({ error: "projectId required" });
    const project = await prisma.project.findFirst({ where: { id: projectId, ownerId: userId }, select: { id: true } });
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const specs = await prisma.apiSpec.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, version: true, sourceUrl: true, endpointCount: true, createdAt: true },
    });
    return { specs };
  });

  app.get("/security/api-specs/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const spec = await prisma.apiSpec.findFirst({ where: { id, project: { ownerId: userId } } });
    if (!spec) return reply.code(404).send({ error: "Not found" });
    return { spec };
  });

  app.delete("/security/api-specs/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const spec = await prisma.apiSpec.findFirst({ where: { id, project: { ownerId: userId } }, select: { id: true } });
    if (!spec) return reply.code(404).send({ error: "Not found" });
    await prisma.apiSpec.delete({ where: { id } });
    return { ok: true };
  });

  // ── Auth integrations registry ───────────────────────────────────────────────
  // Named, reusable auth provider configs. Store once per project, reference by ID
  // in scan configs instead of re-entering the same domain/clientId every scan.

  const authIntegrationSchema = z.object({
    projectId: z.string(),
    name: z.string().min(1).max(80),
    provider: z.enum(["auth0", "firebase", "cognito", "clerk", "custom"]),
    config: z.record(z.string()),
    passwordSecretKey: z.string().optional(),
    clientSecretKey: z.string().optional(),
  });

  app.post("/security/auth/integrations", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const parsed = authIntegrationSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const body = parsed.data;
    const project = await prisma.project.findUnique({ where: { id: body.projectId } });
    if (!project || project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });
    const integration = await prisma.authIntegration.create({
      data: {
        projectId: body.projectId,
        name: body.name,
        provider: body.provider,
        config: body.config,
        passwordSecretKey: body.passwordSecretKey,
        clientSecretKey: body.clientSecretKey,
      },
    });
    return reply.code(201).send(integration);
  });

  app.get<{ Querystring: { projectId?: string } }>("/security/auth/integrations", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    if (!req.query.projectId) return reply.code(400).send({ error: "projectId required" });
    const project = await prisma.project.findUnique({ where: { id: req.query.projectId } });
    if (!project || project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });
    const integrations = await prisma.authIntegration.findMany({
      where: { projectId: req.query.projectId },
      orderBy: { createdAt: "desc" },
    });
    return reply.send(integrations);
  });

  app.put<{ Params: { id: string } }>("/security/auth/integrations/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const existing = await prisma.authIntegration.findFirst({
      where: { id: req.params.id, project: { ownerId: userId } },
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    const parsed = authIntegrationSchema.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const updated = await prisma.authIntegration.update({
      where: { id: req.params.id },
      data: {
        ...(parsed.data.name && { name: parsed.data.name }),
        ...(parsed.data.provider && { provider: parsed.data.provider }),
        ...(parsed.data.config && { config: parsed.data.config }),
        ...(parsed.data.passwordSecretKey !== undefined && { passwordSecretKey: parsed.data.passwordSecretKey }),
        ...(parsed.data.clientSecretKey !== undefined && { clientSecretKey: parsed.data.clientSecretKey }),
      },
    });
    return reply.send(updated);
  });

  app.delete<{ Params: { id: string } }>("/security/auth/integrations/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const existing = await prisma.authIntegration.findFirst({
      where: { id: req.params.id, project: { ownerId: userId } },
      select: { id: true },
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });
    await prisma.authIntegration.delete({ where: { id: req.params.id } });
    return { ok: true };
  });
}
