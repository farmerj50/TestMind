import "dotenv/config";
import { Worker, Job } from "bullmq";
import { prisma } from "../prisma.js";
import { redis } from "./redis.js";
import type { SecurityScanPayload } from "./queue.js";
import { decryptSecret } from "../lib/crypto.js";
import { request } from "undici";
import { probeScoped, isWithinScope, type ProbeScope } from "../security/http-client.js";
import { shouldDowngradeToPassive } from "../lib/security-approval-policy.js";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import {
  detectDirectoryListing,
  extractHttpMethodFindings,
  extractServiceExposureFindings,
  extractVersionDisclosureFindings,
  normalizeHeaderValue,
} from "./security-heuristics.js";
import { parseApiSpec } from "../security/openapi-parser.js";
import { buildComplianceReport } from "../security/compliance-report.js";
import { runSubdomainEnum } from "../security/modules/subdomain-enum.js";
import {
  detectCodeReviewSourceStatus,
  resolveCodeReviewRoot,
  runCodeReviewScan,
} from "../security/modules/code-review.js";
import { authenticateProvider } from "../security/provider-auth.js";
import {
  buildRouteContracts,
  discoverRouteInventory,
} from "../security/modules/route-inventory.js";
import {
  findingsFromScannerResults,
  runSecurityScannerPhase,
  scannerMetadata,
  type AnomalyBaselineScannerMetadata,
  type SecurityScannerExecutionResult,
  type SecurityScannerContext,
} from "../security/scanner-registry.js";
import {
  SECURITY_BASELINE_PROVIDER,
  buildSecurityBehaviorBaseline,
  compareSecurityBehaviorBaseline,
  getSecurityBehaviorBaseline,
  parseSecurityBaselineStore,
} from "../security/baseline.js";
import type { ApiSecurityFixture, AuthMatrixResult, SecurityAgentFinding, SecurityAuthProfile } from "../security/types.js";

type FindingInput = SecurityAgentFinding & {
  type: "recon" | "static_analysis" | "dependency" | "dynamic";
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description?: string;
  location?: string;
  tool?: string;
  evidence?: unknown;
  suggestion?: string;
  status?: string;
};

const DEFAULT_HEADERS = [
  { name: "content-security-policy", severity: "high" },
  { name: "strict-transport-security", severity: "high" },
  { name: "x-frame-options", severity: "medium" },
  { name: "x-content-type-options", severity: "medium" },
  { name: "referrer-policy", severity: "low" },
] as const;

async function updateJob(
  jobId: string,
  data: Partial<{
    status: any;
    phase: string | null;
    summary: any;
    error: string | null;
    finishedAt: Date | null;
  }>
) {
  await prisma.securityScanJob.update({
    where: { id: jobId },
    data,
  });
}

async function addFindings(jobId: string, findings: FindingInput[]) {
  for (const f of findings) {
    await prisma.securityFinding.create({
      data: {
        scanId: jobId,
        type: f.type as any,
        severity: f.severity as any,
        title: f.title,
        description: f.description,
        location: f.location,
        tool: f.tool,
        evidence: (f.evidence ?? {}) as any,
        suggestion: f.suggestion,
        status: f.status,
      },
    });
  }
}

function dedupeFindings(findings: FindingInput[]) {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const evidence = finding.evidence as any;
    const key = [
      finding.title,
      finding.location ?? "",
      finding.description ?? "",
      evidence?.testedControl ?? "",
      evidence?.vulnerabilityClass ?? "",
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeAuthMatrix(matrix: AuthMatrixResult[]) {
  const probes = matrix.flatMap((entry) => entry.probes);
  return {
    routes: matrix.length,
    probes: probes.length,
    passed: probes.filter((probe) => probe.passed === true).length,
    failed: probes.filter((probe) => probe.passed === false).length,
    inconclusive: probes.filter((probe) => probe.passed === null).length,
    objectSwaps: matrix.filter((entry) => entry.objectSwap).length,
    failuresByProbe: probes.reduce<Record<string, number>>((acc, probe) => {
      if (probe.passed === false) acc[probe.label] = (acc[probe.label] || 0) + 1;
      return acc;
    }, {}),
    routesWithFailures: matrix
      .filter((entry) => entry.failCount > 0)
      .slice(0, 20)
      .map((entry) => ({
        route: entry.route,
        method: entry.method,
        controls: entry.controls,
        confidence: entry.confidence,
        failCount: entry.failCount,
        probes: entry.probes.map((probe) => ({
          label: probe.label,
          expected: probe.expected,
          passed: probe.passed,
          profile: probe.profile,
          objectId: probe.objectId,
          status: probe.evidence.status,
          bodyLength: probe.evidence.bodyLength,
          signals: probe.signals,
        })),
      })),
  };
}

function buildDeepAnomalyDiagnostic(
  payload: SecurityScanPayload,
  routeInventory: Array<{ route: string; method: string; source: string }>,
  routeContracts: Array<{ route: string; method: string; source: string }>,
  snapshotCount: number
): FindingInput | null {
  if (payload.scanDepth !== "deep") return null;
  if (routeContracts.length > 0 && snapshotCount > 0) return null;

  const reason =
    routeContracts.length === 0
      ? "Deep discovery did not produce any protected route contracts."
      : "Deep discovery produced route contracts, but none were probeable with the available fixtures.";

  return {
    type: "dynamic",
    severity: "info",
    title: "Deep anomaly validation had no probeable route contracts",
    description:
      `${reason} Add authorized test identities and protected object contracts, or expose an OpenAPI/API route inventory, to enable object-level and auth-matrix anomaly testing.`,
    location: payload.baseUrl,
    tool: "anomaly-baseline-agent",
    status: "needs_setup",
    evidence: {
      scanDepth: payload.scanDepth,
      routeInventoryCount: routeInventory.length,
      routeContractCount: routeContracts.length,
      baselineSnapshots: snapshotCount,
      authProfiles: payload.authProfiles?.length ?? 0,
      apiFixtures: payload.apiFixtures?.length ?? 0,
      routeSources: routeInventory.reduce<Record<string, number>>((acc, route) => {
        acc[route.source] = (acc[route.source] || 0) + 1;
        return acc;
      }, {}),
      sampleRoutes: routeInventory.slice(0, 10).map((route) => `${route.method} ${route.route}`),
    },
    suggestion:
      "Use Security Scan > Authorized test identities and Protected object contracts, then rerun deep mode. For API-heavy apps, add owner/other account fixtures with object IDs.",
  };
}

async function resolveAuthProfiles(
  projectId: string,
  profiles: Array<Record<string, any>> = []
): Promise<SecurityAuthProfile[]> {
  const secretKeys = Array.from(
    new Set(
      profiles
        .flatMap((profile) => [profile.tokenSecretKey, profile.cookieValueSecretKey, profile.passwordSecretKey])
        .filter((key): key is string => typeof key === "string" && key.trim().length > 0)
    )
  );

  const secretRows = secretKeys.length
    ? await prisma.projectSecret.findMany({
        where: { projectId, key: { in: secretKeys } },
        select: { key: true, value: true },
      })
    : [];
  const secrets = new Map(secretRows.map((row) => [row.key, decryptSecret(row.value)]));

  return profiles.map((profile) => ({
    ...profile,
    token: profile.token ?? (profile.tokenSecretKey ? secrets.get(profile.tokenSecretKey) : undefined),
    cookieValue:
      profile.cookieValue ??
      (profile.cookieValueSecretKey ? secrets.get(profile.cookieValueSecretKey) : undefined),
    password: profile.password ?? (profile.passwordSecretKey ? secrets.get(profile.passwordSecretKey) : undefined),
  })) as SecurityAuthProfile[];
}

/**
 * Mid-scan re-auth: if any auth profiles have a sessionId pointing to a
 * SecurityAuthSession with a stored providerConfig, attempt to get a fresh token
 * from that provider. Mutates profiles in-place and persists the new token to the
 * session record so future scans start warm.
 */
async function refreshExpiredProfiles(
  profiles: SecurityAuthProfile[],
  projectId: string,
  baseUrl: string,
  scope: ProbeScope,
): Promise<void> {
  for (const profile of profiles) {
    if (!profile.sessionId) continue;
    try {
      // Quick liveness check — if the token is still valid, skip re-auth
      const testHeaders: Record<string, string> = {};
      if (profile.type === "bearer" && profile.token) testHeaders["Authorization"] = `Bearer ${profile.token}`;
      if (profile.type === "cookie" && profile.cookieValue) {
        testHeaders["Cookie"] = profile.cookieName === "__raw__"
          ? profile.cookieValue
          : `${profile.cookieName || "session"}=${profile.cookieValue}`;
      }
      const liveResult = await probeScoped(scope, `${baseUrl}/api/me`, { method: "GET", headers: testHeaders, timeoutMs: 5_000 });
      const liveCheck = liveResult.status !== undefined ? { status: liveResult.status } : null;
      if (liveCheck && liveCheck.status !== 401 && liveCheck.status !== 403) continue;

      // Token expired — fetch provider config and re-auth
      const session = await prisma.securityAuthSession.findUnique({
        where: { id: profile.sessionId },
        select: {
          provider: true, providerConfig: true, providerPasswordSecretKey: true,
          providerClientSecretKey: true, bypassSecretKey: true,
        },
      });
      if (!session?.provider || !session?.providerConfig) continue;

      const secretKeys = [session.providerPasswordSecretKey, session.providerClientSecretKey, session.bypassSecretKey]
        .filter((k): k is string => typeof k === "string" && k.length > 0);
      const secretRows = secretKeys.length
        ? await prisma.projectSecret.findMany({ where: { projectId, key: { in: secretKeys } }, select: { key: true, value: true } })
        : [];
      const secrets = new Map(secretRows.map((r) => [r.key, decryptSecret(r.value)]));

      const providerConfig = session.providerConfig as Record<string, string>;
      const password = session.providerPasswordSecretKey ? secrets.get(session.providerPasswordSecretKey) : undefined;
      const clientSecret = session.providerClientSecretKey ? secrets.get(session.providerClientSecretKey) : undefined;

      const result = await authenticateProvider(session.provider, {
        ...providerConfig,
        password,
        clientSecret,
      }).catch(() => null);

      if (!result?.token) continue;

      // Update in-memory profile
      profile.token = result.token;
      profile.type = "bearer";

      // Persist to DB so the session record stays fresh
      await prisma.securityAuthSession.update({
        where: { id: profile.sessionId },
        data: {
          status: "authenticated",
          expiresAt: result.expiresIn
            ? new Date(Date.now() + result.expiresIn * 1000)
            : undefined,
        },
      });
      console.info(`[security-worker] Mid-scan re-auth succeeded for session ${profile.sessionId}`);
    } catch (err: any) {
      console.warn(`[security-worker] Mid-scan re-auth failed for session ${profile.sessionId}:`, err?.message);
    }
  }
}

async function loadApprovedBehaviorBaseline(projectId: string, scopeKey: string) {
  const integration = await prisma.integration.findFirst({
    where: { projectId, provider: SECURITY_BASELINE_PROVIDER, enabled: true },
    orderBy: { updatedAt: "desc" },
    select: { config: true },
  });
  const store = parseSecurityBaselineStore(integration?.config);
  return getSecurityBehaviorBaseline(store, scopeKey);
}

// Consolidated onto the shared isWithinScope (http-client.ts) — this local copy diverged
// from it (no subdomain-suffix matching), the exact kind of duplicated-security-check
// drift this migration is meant to eliminate.
function withinScope(urlStr: string, allowedHosts: string[], allowedPorts: number[]) {
  return isWithinScope(urlStr, allowedHosts, allowedPorts);
}

async function runRecon(job: SecurityScanPayload): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  if (!withinScope(job.baseUrl, job.allowedHosts, job.allowedPorts)) {
    findings.push({
      type: "recon",
      severity: "info",
      title: "Base URL out of scope",
      description: `Skipped recon; ${job.baseUrl} not in allowed hosts/ports.`,
      location: job.baseUrl,
      tool: "scope-check",
    });
    return findings;
  }
  try {
    const scope: ProbeScope = { allowedHosts: job.allowedHosts ?? [], allowedPorts: job.allowedPorts ?? [] };
    const res = await probeScoped(scope, job.baseUrl, { method: "GET" });
    if (res.error || res.status === undefined) {
      throw new Error(res.error || "Request failed");
    }
    findings.push({
      type: "recon",
      severity: "info",
      title: `Reachable (${res.status})`,
      description: `Fetched ${job.baseUrl}`,
      location: job.baseUrl,
      tool: "undici",
    });
    const headers = res.headers;
    for (const h of DEFAULT_HEADERS) {
      if (!headers[h.name]) {
        findings.push({
          type: "dynamic",
          severity: h.severity as any,
          title: `Missing security header: ${h.name}`,
          description: `Header ${h.name} not present on response`,
          location: job.baseUrl,
          tool: "header-check",
        });
      }
    }
    findings.push(
      ...extractVersionDisclosureFindings({
        headers,
        location: job.baseUrl,
        tool: "header-check",
      })
    );
    // Cookie flags
    const setCookie = headers["set-cookie"];
    if (Array.isArray(setCookie)) {
      const insecureCookies = setCookie.filter(
        (c) => !/httponly/i.test(c) || !/secure/i.test(c)
      );
      if (insecureCookies.length > 0) {
        findings.push({
          type: "dynamic",
          severity: "medium",
          title: "Cookies missing Secure/HttpOnly",
          description: insecureCookies.slice(0, 3).join("; "),
          location: job.baseUrl,
          tool: "cookie-check",
        });
      }
    }

    // Simple crawl (same host, shallow)
    try {
      const body = res.body;
      findings.push(
        ...detectDirectoryListing({
          body,
          location: job.baseUrl,
          tool: "recon-crawl",
        })
      );
      const hrefs = Array.from(body.matchAll(/href\s*=\s*["']([^"']+)["']/gi))
        .map((m) => m[1])
        .filter((h) => h.startsWith("/"));
      const unique = Array.from(new Set(hrefs)).slice(0, 10);
      if (unique.length > 0) {
        findings.push({
          type: "recon",
          severity: "info",
          title: "Endpoints discovered",
          description: `Found ${unique.length} path(s): ${unique.join(", ")}`,
          location: job.baseUrl,
          tool: "playwright-spider",
        });
      }
    } catch {
      // ignore crawl errors
    }
  } catch (err: any) {
    findings.push({
      type: "recon",
      severity: "medium",
      title: "Failed to reach base URL",
      description: err?.message ?? String(err),
      location: job.baseUrl,
      tool: "undici",
    });
  }

  // Port probe within allowed hosts/ports
  for (const host of job.allowedHosts) {
    for (const port of job.allowedPorts) {
      const isAllowed = withinScope(`http://${host}:${port}`, job.allowedHosts, job.allowedPorts);
      if (!isAllowed) continue;
      const status = await new Promise<"open" | "closed" | "timeout">((resolve) => {
        const socket = new net.Socket();
        const timer = setTimeout(() => {
          socket.destroy();
          resolve("timeout");
        }, 800);
        socket.once("error", () => {
          clearTimeout(timer);
          resolve("closed");
        });
        socket.connect(port, host, () => {
          clearTimeout(timer);
          socket.destroy();
          resolve("open");
        });
      });
      findings.push({
        type: "recon",
        severity: status === "open" ? "info" : "low",
        title: `Port ${port} ${status}`,
        description: `Host ${host}:${port} reported ${status}`,
        location: `${host}:${port}`,
        tool: "port-probe",
      });
      if (status === "open") {
        const banner = await grabBanner(host, port);
        findings.push(
          ...extractServiceExposureFindings({
            host,
            port,
            banner,
            tool: "banner-grab",
          })
        );
      }
    }
  }

  return findings;
}

type SourceScanContext = {
  requestedMode: "auto" | "url_only" | "code_assisted";
  effectiveMode: "url_only" | "code_and_url" | "source_unavailable";
  codeReviewAvailable: boolean;
  sourceRoot?: string;
  sourceFileCount: number;
  reason: string;
};

function requestedSourceMode(payload: SecurityScanPayload): SourceScanContext["requestedMode"] {
  return payload.sourceMode === "url_only" || payload.sourceMode === "code_assisted" ? payload.sourceMode : "auto";
}

function configuredSourceRoot(payload: SecurityScanPayload): string | null {
  const payloadRoot = typeof payload.sourceRoot === "string" ? payload.sourceRoot.trim() : "";
  if (payloadRoot) return payloadRoot;

  const envRoot = process.env.TESTMIND_SECURITY_SOURCE_ROOT?.trim();
  if (envRoot) return envRoot;

  if (process.env.TESTMIND_SECURITY_ALLOW_CWD_SOURCE === "1") {
    return process.cwd();
  }

  return null;
}

function resolveSourceScanContext(payload: SecurityScanPayload): SourceScanContext {
  const requestedMode = requestedSourceMode(payload);
  if (requestedMode === "url_only") {
    return {
      requestedMode,
      effectiveMode: "url_only",
      codeReviewAvailable: false,
      sourceFileCount: 0,
      reason: "url_only_requested",
    };
  }

  const root = configuredSourceRoot(payload);
  if (!root) {
    return {
      requestedMode,
      effectiveMode: "url_only",
      codeReviewAvailable: false,
      sourceFileCount: 0,
      reason: "source_root_not_configured",
    };
  }

  const sourceStatus = detectCodeReviewSourceStatus({ root });
  if (!sourceStatus.available) {
    return {
      requestedMode,
      effectiveMode: "source_unavailable",
      codeReviewAvailable: false,
      sourceRoot: sourceStatus.root,
      sourceFileCount: 0,
      reason: "source_files_not_found",
    };
  }

  return {
    requestedMode,
    effectiveMode: "code_and_url",
    codeReviewAvailable: true,
    sourceRoot: sourceStatus.root,
    sourceFileCount: sourceStatus.availablePaths.length,
    reason: "source_available",
  };
}

async function runStatic(
  job: SecurityScanPayload,
  sourceContext = resolveSourceScanContext(job)
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  if (!sourceContext.codeReviewAvailable || !sourceContext.sourceRoot) {
    findings.push({
      type: "static_analysis",
      severity: sourceContext.requestedMode === "code_assisted" ? "low" : "info",
      title:
        sourceContext.requestedMode === "url_only"
          ? "Static source review skipped for URL-only scan"
          : "Static source review skipped because no source root is configured",
      description:
        sourceContext.requestedMode === "url_only"
          ? "This scan is using URL-only coverage. Runtime API, OpenAPI, JS bundle, auth matrix, and DAST checks still run."
          : "No trusted source root was provided for this scan. Set TESTMIND_SECURITY_SOURCE_ROOT, pass sourceRoot from a trusted worker, or enable TESTMIND_SECURITY_ALLOW_CWD_SOURCE=1 for local development.",
      location: job.baseUrl,
      tool: "code-review",
      evidence: {
        vulnerabilityClass: "scan_coverage",
        owaspCategory: "A05:2021",
        owaspApiCategory: "API9:2023",
        sourceMode: sourceContext.requestedMode,
        effectiveMode: sourceContext.effectiveMode,
        reason: sourceContext.reason,
      },
    });
    return findings;
  }

  const repoRoot = resolveCodeReviewRoot(sourceContext.sourceRoot);
  const pkgJson = path.join(repoRoot, "package.json");
  const exists = fs.existsSync(pkgJson);

  try {
    const reviewFindings = runCodeReviewScan({ root: repoRoot });
    if (reviewFindings.length === 0) {
      findings.push({
        type: "static_analysis",
        severity: "info",
        title: "Code review found no issues",
        description: "Built-in repository code-review checks completed with no findings.",
        location: repoRoot,
        tool: "code-review",
      });
    } else {
      findings.push(...reviewFindings);
    }
  } catch (err: any) {
    findings.push({
      type: "static_analysis",
      severity: "info",
      title: "Code review scan failed",
      description: err?.message ?? String(err),
      location: repoRoot,
      tool: "code-review",
    });
  }

  // Try semgrep if available.
  const semgrepBin = process.env.SEMGREP_BIN || "semgrep";
  if (exists) {
    try {
      const result = await new Promise<{ stdout: string }>((resolve, reject) => {
        execFile(
          semgrepBin,
          ["--config", "p/security-audit", "--json", "--quiet"],
          { cwd: repoRoot, maxBuffer: 5 * 1024 * 1024 },
          (err, stdout) => {
            // Semgrep exits with code 1 when findings are present; treat that as success
            if (err && (err as any).code !== 1) return reject(err);
            resolve({ stdout: stdout || "{}" });
          }
        );
      });
      let parsed: any = {};
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = {};
      }
      const semgrepFindings = Array.isArray(parsed?.results) ? parsed.results : [];
      if (semgrepFindings.length === 0) {
        findings.push({
          type: "static_analysis",
          severity: "info",
          title: "Semgrep found no issues",
          description: "Semgrep scan completed with no findings.",
          location: repoRoot,
          tool: "semgrep",
        });
      } else {
        for (const f of semgrepFindings.slice(0, 50)) {
          findings.push({
            type: "static_analysis",
            severity: "medium",
            title: f?.check_id || "Semgrep finding",
            description: f?.extra?.message,
            location: `${f?.path}:${f?.start?.line ?? ""}`,
            tool: "semgrep",
          });
        }
      }
    } catch (err: any) {
      findings.push({
        type: "static_analysis",
        severity: "info",
        title: "Semgrep not available",
        description: err?.code === "ENOENT" ? "Semgrep binary not found." : err?.message,
        location: repoRoot,
        tool: "semgrep",
      });
    }
  } else {
    findings.push({
      type: "static_analysis",
      severity: "info",
      title: "No package.json found",
      description: "Skipping SAST; cannot find repository files in worker context.",
      location: repoRoot,
      tool: "sast",
    });
  }

  return findings;
}

function normalizeAuditSeverity(value: unknown): FindingInput["severity"] {
  const severity = String(value ?? "").toLowerCase();
  if (severity === "critical") return "critical";
  if (severity === "high") return "high";
  if (severity === "medium" || severity === "moderate") return "medium";
  if (severity === "low") return "low";
  if (severity === "info") return "info";
  return "medium";
}

function auditEntries(parsed: any): Array<[string, any]> {
  const vulnerabilities = parsed?.vulnerabilities;
  if (vulnerabilities && typeof vulnerabilities === "object" && !Array.isArray(vulnerabilities)) {
    return Object.entries(vulnerabilities);
  }

  const advisories = parsed?.advisories;
  if (advisories && typeof advisories === "object" && !Array.isArray(advisories)) {
    return Object.entries(advisories).map(([id, advisory]) => {
      const name = (advisory as any)?.module_name ?? (advisory as any)?.name ?? id;
      return [name, advisory];
    });
  }

  return [];
}

function auditCountSummary(parsed: any) {
  const counts = parsed?.metadata?.vulnerabilities;
  if (!counts || typeof counts !== "object") return null;
  const parts = ["critical", "high", "moderate", "medium", "low", "info"]
    .map((key) => {
      const value = Number((counts as Record<string, unknown>)[key] ?? 0);
      return value > 0 ? `${value} ${key}` : null;
    })
    .filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function auditViaSummary(vuln: any) {
  const via = vuln?.via;
  if (!Array.isArray(via)) {
    return typeof via === "string" ? via : "";
  }

  return via
    .map((entry) => {
      if (typeof entry === "string") return entry;
      return entry?.title ?? entry?.source ?? entry?.name ?? entry?.url;
    })
    .filter(Boolean)
    .join("; ");
}

function auditDescription(name: string, vuln: any) {
  const title = vuln?.title ?? vuln?.name;
  const range = vuln?.range ? `Range: ${vuln.range}.` : "";
  const effects = Array.isArray(vuln?.effects) && vuln.effects.length ? `Effects: ${vuln.effects.join(", ")}.` : "";
  const via = auditViaSummary(vuln);
  const viaText = via ? `Via: ${via}.` : "";
  return [`Affected: ${name}.`, title && title !== name ? String(title) : "", range, effects, viaText]
    .filter(Boolean)
    .join(" ")
    .slice(0, 800);
}

async function runDeps(
  job: SecurityScanPayload,
  sourceContext = resolveSourceScanContext(job)
): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  if (!sourceContext.codeReviewAvailable || !sourceContext.sourceRoot) {
    findings.push({
      type: "dependency",
      severity: sourceContext.requestedMode === "code_assisted" ? "low" : "info",
      title:
        sourceContext.requestedMode === "url_only"
          ? "Dependency audit skipped for URL-only scan"
          : "Dependency audit skipped because no source root is configured",
      description:
        sourceContext.requestedMode === "url_only"
          ? "Dependency checks need repository files or lockfiles. URL-only API checks still run."
          : "No trusted source root was provided for this scan, so package-manager audit cannot run.",
      location: job.baseUrl,
      tool: "sca",
      evidence: {
        vulnerabilityClass: "scan_coverage",
        owaspCategory: "A06:2021",
        owaspApiCategory: "API8:2023",
        sourceMode: sourceContext.requestedMode,
        effectiveMode: sourceContext.effectiveMode,
        reason: sourceContext.reason,
      },
    });
    return findings;
  }

  const repoRoot = resolveCodeReviewRoot(sourceContext.sourceRoot);
  const lockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
  const searchRoots = [
    repoRoot,
    path.join(repoRoot, "apps", "api"),
    path.join(repoRoot, "apps", "web"),
    path.resolve(repoRoot, ".."),
    path.resolve(repoRoot, "..", ".."),
  ];

  let lockfilePath: string | null = null;
  for (const root of searchRoots) {
    const found = lockfiles.find((f) => fs.existsSync(path.join(root, f)));
    if (found) {
      lockfilePath = path.join(root, found);
      break;
    }
  }

  if (!lockfilePath) {
    findings.push({
      type: "dependency",
      severity: "low",
      title: "No lockfile found",
      description: "Add a lockfile to enable dependency scanning.",
      location: repoRoot,
      tool: "sca",
    });
    return findings;
  }

  let auditTool = "npm-audit";
  try {
    const lockName = path.basename(lockfilePath).toLowerCase();
    const isPnpm = lockName === "pnpm-lock.yaml";
    const isYarn = lockName === "yarn.lock";
    auditTool = isPnpm ? "pnpm-audit" : "npm-audit";
    if (isYarn) {
      findings.push({
        type: "dependency",
        severity: "info",
        title: "yarn lockfile detected",
        description: "yarn.lock found. Configure a yarn audit-compatible scanner for this workspace.",
        location: lockfilePath,
        tool: "sca",
      });
      return findings;
    }

    const auditBin = isPnpm
      ? process.env.PNPM_BIN || (process.platform === "win32" ? "pnpm.cmd" : "pnpm")
      : process.env.NPM_BIN || (process.platform === "win32" ? "npm.cmd" : "npm");
    const auditArgs = isPnpm
      ? ["audit", "--json", "--audit-level", "moderate"]
      : ["audit", "--json", "--production"];
    const audit = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        auditBin,
        auditArgs,
        {
          cwd: path.dirname(lockfilePath),
          maxBuffer: 15 * 1024 * 1024,
          shell: process.platform === "win32",
        },
        (err, stdout) => {
          // npm/pnpm audit exit non-zero when vulns are found; ignore that code.
          if (err && (err as any).code !== 1) return reject(err);
          resolve({ stdout: stdout || "{}" });
        }
      );
    });
    const parsed = JSON.parse(audit.stdout);
    const entries = auditEntries(parsed);
    if (entries.length === 0) {
      const countSummary = auditCountSummary(parsed);
      if (countSummary) {
        findings.push({
          type: "dependency",
          severity: "medium",
          title: "Dependency vulnerabilities reported",
          description: `Audit reported ${countSummary}, but did not include package-level advisory details in JSON output.`,
          location: lockfilePath,
          tool: auditTool,
        });
        return findings;
      }
      findings.push({
        type: "dependency",
        severity: "info",
        title: "No dependency vulnerabilities found",
        description: `${auditTool} reported no issues.`,
        location: lockfilePath,
        tool: auditTool,
      });
    } else {
      for (const [name, vuln] of entries.slice(0, 50)) {
        findings.push({
          type: "dependency",
          severity: normalizeAuditSeverity((vuln as any)?.severity),
          title: `Vulnerability: ${name}`,
          description: auditDescription(name, vuln),
          location: lockfilePath,
          tool: auditTool,
        });
      }
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      findings.push({
        type: "dependency",
        severity: "info",
        title: `${auditTool === "pnpm-audit" ? "pnpm" : "npm"} not available`,
        description: `Failed to run ${auditTool}. Ensure the package manager is on PATH or set PNPM_BIN/NPM_BIN.`,
        location: lockfilePath,
        tool: auditTool,
      });
      return findings;
    }
    findings.push({
      type: "dependency",
      severity: "info",
      title: "Audit failed",
      description: err?.message ?? String(err),
      location: lockfilePath,
      tool: auditTool,
    });
  }

  return findings;
}

// ── DAST probes ──────────────────────────────────────────────────────────────

/**
 * Fire a single HTTP probe, return { status, body, headers } or null on error.
 * Delegates to probeScoped (http-client.ts) instead of an unscoped raw request() -
 * this is the DAST pipeline's own choke point for outbound requests, so every scope
 * check (including redirect-hop re-validation) lives in one place. Keeps the original
 * { status, body, headers } | null return shape so existing call sites are unchanged.
 */
async function probe(
  scope: ProbeScope,
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; followRedirects?: boolean } = {}
) {
  const result = await probeScoped(scope, url, opts);
  if (result.error || result.status === undefined) return null;
  return { status: result.status, body: result.body, headers: result.headers };
}

async function grabBanner(host: string, port: number, timeoutMs = 1200): Promise<string | null> {
  return await new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let buffer = "";
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(buffer.trim() || null), timeoutMs);

    socket.once("error", () => finish(buffer.trim() || null));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length >= 512 || /(\r?\n){1,2}/.test(buffer)) {
        finish(buffer.slice(0, 512).trim() || null);
      }
    });
    socket.connect(port, host, () => {
      if ([80, 81, 3000, 4000, 5000, 8000, 8080, 8888].includes(port)) {
        socket.write(`HEAD / HTTP/1.0\r\nHost: ${host}\r\n\r\n`);
      }
    });
  });
}

/**
 * Passive dynamic checks that do NOT mutate state — safe without approval.
 * Tests: auth-required endpoints, open redirect indicators, CORS misconfiguration,
 * error disclosure, clickjacking, HTTPS enforcement.
 */
async function runPassiveDynamic(baseUrl: string, scope: ProbeScope): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const base = baseUrl.replace(/\/$/, "");

  // 1. HTTPS enforcement
  if (base.startsWith("http://")) {
    findings.push({
      type: "dynamic",
      severity: "high",
      title: "Non-HTTPS base URL",
      description: "Application is served over HTTP. All traffic is unencrypted.",
      location: base,
      tool: "dast-passive",
    });
  }

  // 2. CORS misconfiguration — send Origin: evil.example.com
  const corsRes = await probe(scope, base, { headers: { Origin: "https://evil.example.com" } });
  if (corsRes) {
    const acao = corsRes.headers["access-control-allow-origin"] as string | undefined;
    if (acao === "*" || acao === "https://evil.example.com") {
      findings.push({
        type: "dynamic",
        severity: "high",
        title: "CORS misconfiguration — overly permissive Allow-Origin",
        description: `Access-Control-Allow-Origin: ${acao}`,
        location: base,
        tool: "dast-cors",
      });
    }
  }

  // 3. Error disclosure — request a path that likely 404s and check for stack traces
  const optionsRes = await probe(scope, base, { method: "OPTIONS" });
  if (optionsRes) {
    findings.push(
      ...extractHttpMethodFindings({
        allowHeader:
          normalizeHeaderValue(optionsRes.headers["allow"] as string | string[] | undefined) ??
          normalizeHeaderValue(optionsRes.headers["public"] as string | string[] | undefined) ??
          null,
        location: base,
        tool: "dast-options",
      })
    );
  }

  const errRes = await probe(scope, `${base}/__tm_dast_probe_404__`);
  if (errRes) {
    const body = errRes.body.toLowerCase();
    const stackLeaks = ["traceback", "stack trace", "at node:", "error: ", "exception in"].some(
      (s) => body.includes(s)
    );
    if (stackLeaks) {
      findings.push({
        type: "dynamic",
        severity: "medium",
        title: "Error disclosure — stack trace in 404 response",
        description: "Server returns internal error details in error pages.",
        location: `${base}/__tm_dast_probe_404__`,
        tool: "dast-error",
      });
    }
  }

  // 4. Common sensitive paths exposed
  const sensitivePaths = [
    "/.env", "/.git/config", "/config.json", "/api-docs", "/swagger.json",
    "/openapi.json", "/metrics", "/actuator/health", "/admin",
  ];
  for (const p of sensitivePaths) {
    const r = await probe(scope, `${base}${p}`);
    if (r && r.status === 200) {
      findings.push({
        type: "dynamic",
        severity: p.startsWith("/.") ? "critical" : "medium",
        title: `Sensitive path exposed: ${p}`,
        description: `GET ${base}${p} returned HTTP 200`,
        location: `${base}${p}`,
        tool: "dast-paths",
      });
    }
  }

  // 5. Clickjacking — check X-Frame-Options or CSP frame-ancestors (already in recon;
  //    add here as dynamic confirmation with actual framing attempt indicator)
  const frameRes = await probe(scope, base);
  if (frameRes) {
    const xfo = frameRes.headers["x-frame-options"] as string | undefined;
    const csp = frameRes.headers["content-security-policy"] as string | undefined;
    const hasFrameProtection =
      (xfo && ["deny", "sameorigin"].includes(xfo.toLowerCase())) ||
      (csp && csp.includes("frame-ancestors"));
    if (!hasFrameProtection) {
      findings.push({
        type: "dynamic",
        severity: "medium",
        title: "Clickjacking — no frame protection headers",
        description: "Neither X-Frame-Options nor CSP frame-ancestors is set.",
        location: base,
        tool: "dast-clickjacking",
      });
    }
  }

  return findings;
}

/**
 * Active dynamic checks — mutate state or inject payloads.
 * Only run when enableActive=true (caller must ensure approval was obtained).
 */
async function runActiveDynamic(baseUrl: string, scope: ProbeScope): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const base = baseUrl.replace(/\/$/, "");

  // 1. Open redirect probe
  const redirectPayloads = [
    `${base}/?next=https://evil.example.com`,
    `${base}/?redirect=https://evil.example.com`,
    `${base}/?url=https://evil.example.com`,
    `${base}/?return=https://evil.example.com`,
  ];
  for (const url of redirectPayloads) {
    // followRedirects: false - this check needs the raw 3xx response to inspect its
    // Location header, not the followed destination (which would also just get
    // scope-blocked now, since evil.example.com is never in scope).
    const r = await probe(scope, url, { followRedirects: false });
    if (r && r.status >= 301 && r.status <= 303) {
      const loc = r.headers["location"] as string | undefined;
      if (loc?.includes("evil.example.com")) {
        findings.push({
          type: "dynamic",
          severity: "high",
          title: "Open redirect",
          description: `${url} redirected to ${loc}`,
          location: url,
          tool: "dast-open-redirect",
        });
      }
    }
  }

  // 2. Reflected XSS probe (GET params)
  const xssPayload = encodeURIComponent('<script>alert(1)</script>');
  const xssUrls = [
    `${base}/?q=${xssPayload}`,
    `${base}/?search=${xssPayload}`,
    `${base}/?query=${xssPayload}`,
  ];
  for (const url of xssUrls) {
    const r = await probe(scope, url);
    if (r && r.body.includes('<script>alert(1)</script>')) {
      findings.push({
        type: "dynamic",
        severity: "high",
        title: "Reflected XSS",
        description: `Payload reflected unescaped in response: ${url}`,
        location: url,
        tool: "dast-xss",
      });
    }
  }

  // 3. SQL injection error probe (GET params)
  const sqliPayloads = ["'", "1' OR '1'='1", `" OR ""="`];
  for (const payload of sqliPayloads) {
    const url = `${base}/?id=${encodeURIComponent(payload)}`;
    const r = await probe(scope, url);
    if (r) {
      const body = r.body.toLowerCase();
      const sqlErrors = ["sql", "syntax error", "unclosed quotation", "mysql", "pg_query", "ora-"];
      if (sqlErrors.some((s) => body.includes(s))) {
        findings.push({
          type: "dynamic",
          severity: "critical",
          title: "SQL injection error disclosure",
          description: `Database error exposed when sending payload: ${payload}`,
          location: url,
          tool: "dast-sqli",
        });
        break; // one finding per category is enough
      }
    }
  }

  // 4. Path traversal probe
  const traversalPayload = encodeURIComponent("../../../etc/passwd");
  const traversalUrls = [
    `${base}/?file=${traversalPayload}`,
    `${base}/?path=${traversalPayload}`,
    `${base}/?page=${traversalPayload}`,
  ];
  for (const url of traversalUrls) {
    const r = await probe(scope, url);
    if (r && r.body.includes("root:x:0:0")) {
      findings.push({
        type: "dynamic",
        severity: "critical",
        title: "Path traversal — /etc/passwd disclosed",
        description: `File content leaked via ${url}`,
        location: url,
        tool: "dast-traversal",
      });
    }
  }

  return findings;
}

async function runDynamic(job: SecurityScanPayload): Promise<FindingInput[]> {
  const scope: ProbeScope = { allowedHosts: job.allowedHosts ?? [], allowedPorts: job.allowedPorts ?? [] };
  const passive = await runPassiveDynamic(job.baseUrl, scope);
  if (!job.enableActive) return passive;

  if (shouldDowngradeToPassive(job)) {
    // Downgrade to passive-only rather than throw - a queued job silently completing with
    // reduced coverage is safer here than a hard failure, since this is a safety net, not
    // the main gate.
    console.warn(
      `[security-worker] job ${job.jobId}: active checks require production approval and none was granted - downgrading to passive-only.`
    );
    return passive;
  }

  const active = await runActiveDynamic(job.baseUrl, scope);
  return [...passive, ...active];
}

export const securityWorker = new Worker(
  "security-scan",
  async (job: Job<SecurityScanPayload>) => {
    const payload = job.data;

    // Race the entire scan pipeline against the configured duration cap.
    // Individual probe functions have their own per-request timeouts; this is the
    // job-level wall-clock limit. If the deadline fires first we throw so BullMQ's
    // "failed" handler marks the job terminated — the background probes finish
    // naturally (they all have sub-10-second individual timeouts).
    const deadlineMs = (payload.maxDurationMinutes ?? 10) * 60 * 1000;
    let deadlineHandle: ReturnType<typeof setTimeout> | null = null;
    const deadlinePromise = new Promise<never>((_, reject) => {
      deadlineHandle = setTimeout(
        () => reject(new Error(`Scan exceeded the ${payload.maxDurationMinutes ?? 10}-minute limit and was stopped.`)),
        deadlineMs,
      );
    });

    try {
      await Promise.race([runScanPipeline(payload), deadlinePromise]);
    } finally {
      if (deadlineHandle !== null) clearTimeout(deadlineHandle);
    }
  },
  { connection: redis }
);

// isWithinScope treats an empty allowedHosts/allowedPorts as "allow everything" - a
// reasonable default for the utility itself, but ci.ts/mobile.ts/security.ts all pass []
// today, making every probeScoped check in this pipeline a no-op. Derive a real default
// here, once, for every caller: constrain to the job's own declared target host rather
// than leaving scope unrestricted. This is what actually closes the SSRF-pivot gap (a
// scan of example.com being redirected/tricked into fetching an unrelated internal
// address) while still allowing a legitimately internal baseUrl to be scanned at all.
function deriveEffectiveScope(payload: SecurityScanPayload): { allowedHosts: string[]; allowedPorts: number[] } {
  if (payload.allowedHosts?.length) {
    return { allowedHosts: payload.allowedHosts, allowedPorts: payload.allowedPorts ?? [] };
  }
  try {
    const hostname = new URL(payload.baseUrl).hostname.toLowerCase();
    return { allowedHosts: [hostname], allowedPorts: payload.allowedPorts ?? [] };
  } catch {
    return { allowedHosts: payload.allowedHosts ?? [], allowedPorts: payload.allowedPorts ?? [] };
  }
}

function routeSourceCounts(routeInventory: Array<{ source?: string }>) {
  return routeInventory.reduce<Record<string, number>>((acc, route) => {
    const source = route.source ?? "unknown";
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
}

function summarizeScannerRegistry(results: SecurityScannerExecutionResult[]) {
  return {
    total: results.length,
    byPhase: results.reduce<Record<string, number>>((acc, result) => {
      acc[result.phase] = (acc[result.phase] || 0) + 1;
      return acc;
    }, {}),
    modules: results.map((result) => ({
      id: result.scannerId,
      name: result.scannerName,
      phase: result.phase,
      category: result.category,
      risk: result.risk,
      durationMs: result.durationMs,
      findingCount: result.findings.length,
      error: result.error ?? null,
    })),
  };
}

function buildScanCoverageFinding(params: {
  payload: SecurityScanPayload;
  sourceContext: SourceScanContext;
  routeInventory: Array<{ source?: string }>;
  routeContracts: unknown[];
  authProfiles: unknown[];
  jsEndpointCount: number;
  apiSpecAttached: boolean;
}): FindingInput {
  const modeLabel = params.sourceContext.codeReviewAvailable ? "URL and code-assisted" : "URL-only";
  return {
    type: "recon",
    severity: "info",
    title: `Scan coverage: ${modeLabel}`,
    description: params.sourceContext.codeReviewAvailable
      ? "This scan combined repository source review, dependency audit, and URL-based API probing."
      : "This scan ran without trusted repository source. URL-based crawl, route inventory, OpenAPI discovery, JS endpoint extraction, auth matrix, and DAST modules still ran.",
    location: params.payload.baseUrl,
    tool: "scan-coverage",
    evidence: {
      vulnerabilityClass: "scan_coverage",
      owaspCategory: "A05:2021",
      owaspApiCategory: "API9:2023",
      sourceMode: params.sourceContext.requestedMode,
      effectiveMode: params.sourceContext.effectiveMode,
      sourceAvailable: params.sourceContext.codeReviewAvailable,
      sourceFileCount: params.sourceContext.sourceFileCount,
      sourceReason: params.sourceContext.reason,
      urlCoverage: {
        baseUrl: params.payload.baseUrl,
        allowedHosts: params.payload.allowedHosts,
        allowedPorts: params.payload.allowedPorts,
        routeInventory: params.routeInventory.length,
        routeContracts: params.routeContracts.length,
        routeSources: routeSourceCounts(params.routeInventory),
        authProfiles: params.authProfiles.length,
        apiSpecAttached: params.apiSpecAttached,
        jsEndpoints: params.jsEndpointCount,
        scanDepth: params.payload.scanDepth ?? "standard",
      },
    },
  };
}

async function runScanPipeline(payload: SecurityScanPayload) {
    const effectiveScope = deriveEffectiveScope(payload);
    payload.allowedHosts = effectiveScope.allowedHosts;
    payload.allowedPorts = effectiveScope.allowedPorts;
    // Single scope object passed to every scanner module below, instead of each call site
    // re-deriving {allowedHosts, allowedPorts} from payload independently.
    const scope: ProbeScope = { allowedHosts: effectiveScope.allowedHosts, allowedPorts: effectiveScope.allowedPorts };
    const sourceContext = resolveSourceScanContext(payload);

    await updateJob(payload.jobId, { status: "running", phase: "recon" });

    const allFindings: FindingInput[] = [];
    const scannerResults: SecurityScannerExecutionResult[] = [];

    // Recon, SAST, and SCA are all independent — run them in parallel to cut wall-clock
    // time. Dynamic probing depends on knowing the live target is reachable, so it runs
    // after, but is also independent of static analysis and deps.
    const [reconFindings, staticFindings, depsFindings, subdomainResult] = await Promise.all([
      runRecon(payload).catch((e) => { console.warn("[security-worker] recon error:", e?.message); return [] as FindingInput[]; }),
      runStatic(payload, sourceContext).catch((e) => { console.warn("[security-worker] static error:", e?.message); return [] as FindingInput[]; }),
      runDeps(payload, sourceContext).catch((e) => { console.warn("[security-worker] deps error:", e?.message); return [] as FindingInput[]; }),
      runSubdomainEnum(payload.baseUrl).catch((e) => {
        console.warn("[security-worker] subdomain enum error:", e?.message);
        return { findings: [] as any[], liveSubdomains: [] as string[] };
      }),
    ]);
    allFindings.push(...reconFindings, ...staticFindings, ...depsFindings, ...(subdomainResult.findings as any));

    await updateJob(payload.jobId, { phase: "dynamic" });
    allFindings.push(...(await runDynamic(payload)));

    await updateJob(payload.jobId, { phase: "intelligent_validation" });
    const authProfiles = await resolveAuthProfiles(payload.projectId, payload.authProfiles);
    const intelligentConfig = { ...(payload as any), authProfiles };
    const routeInventory = await discoverRouteInventory(intelligentConfig);
    const routeContracts = buildRouteContracts(intelligentConfig, routeInventory);

    const userFixtures = intelligentConfig.apiFixtures ?? [];
    const supportedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    const seenFixtures = new Set<string>();

    const syntheticFixtures: ApiSecurityFixture[] =
      userFixtures.length === 0
        ? routeContracts
            .map((contract) => ({
              contract,
              method: (contract.method ?? "GET").trim().toUpperCase(),
            }))
            .filter(({ contract, method }) => {
              if (!contract.route || !supportedMethods.has(method)) return false;
              const key = `${method}:${contract.route}`;
              if (seenFixtures.has(key)) return false;
              seenFixtures.add(key);
              return true;
            })
            .map(({ contract, method }) => ({
              route: contract.route,
              method,
              expectedControls: contract.expectedControls ?? [],
            }))
            .slice(0, 40)
        : [];

    console.info(
      `[security-worker] intelligent-validation fixtures: user=${userFixtures.length} synthetic=${syntheticFixtures.length} contracts=${routeContracts.length}`,
    );

    const validationConfig =
      syntheticFixtures.length > 0
        ? { ...intelligentConfig, apiFixtures: syntheticFixtures }
        : intelligentConfig;

    let apiSpec: ReturnType<typeof parseApiSpec> | null = null;
    if (payload.apiSpecId) {
      const specRecord = await prisma.apiSpec.findUnique({ where: { id: payload.apiSpecId } });
      if (specRecord) {
        try {
          apiSpec = parseApiSpec(specRecord.specJson);
        } catch (err: any) {
          console.warn(`[security-worker] OpenAPI spec parse failed for spec ${payload.apiSpecId}:`, err?.message);
        }
      }
    }

    const scannerContext: SecurityScannerContext = {
      payload,
      payloadWithAuth: intelligentConfig as SecurityScanPayload & { authProfiles?: SecurityAuthProfile[] },
      scope,
      authProfiles,
      intelligentConfig,
      validationConfig,
      routeContracts,
      apiSpec,
    };

    const validationResults = await runSecurityScannerPhase(scannerContext, "intelligent_validation");
    scannerResults.push(...validationResults);
    allFindings.push(...findingsFromScannerResults(validationResults));

    // GraphQL-specific audit — runs after intelligent validation so auth profiles are
    // already resolved. Detects endpoint, tries introspection, tests auth enforcement,
    // cross-account BOLA, batching abuse, and sensitive field exposure.
    await updateJob(payload.jobId, { phase: "graphql_audit" });
    const graphqlResults = await runSecurityScannerPhase(scannerContext, "graphql_audit");
    scannerResults.push(...graphqlResults);
    allFindings.push(...findingsFromScannerResults(graphqlResults));

    // OpenAPI spec-driven scan — if a spec was attached to this scan job, load it from
    // the DB and run targeted probes against every declared endpoint.
    if (payload.apiSpecId) {
      await updateJob(payload.jobId, { phase: "openapi_scan" });
      const openApiResults = await runSecurityScannerPhase(scannerContext, "openapi_scan");
      scannerResults.push(...openApiResults);
      allFindings.push(...findingsFromScannerResults(openApiResults));
    }

    // JS bundle analysis: extract hidden API endpoints from the SPA's JavaScript bundles.
    // Run before the advanced modules so discovered endpoints can enrich the IDOR scan.
    await updateJob(payload.jobId, { phase: "js_analysis" });
    const jsResults = await runSecurityScannerPhase(scannerContext, "js_analysis");
    scannerResults.push(...jsResults);
    allFindings.push(...findingsFromScannerResults(jsResults));
    const jsMetadata = scannerMetadata<{ discoveredEndpoints?: string[]; discoveredEndpointCount?: number }>(
      jsResults,
      "js-endpoint-extractor"
    );
    const discoveredJsEndpoints = Array.isArray(jsMetadata?.discoveredEndpoints) ? jsMetadata.discoveredEndpoints : [];

    // Mid-scan re-auth: before firing the expensive parallel modules, check whether any
    // bearer token profiles have gone stale (target returns 401) and re-auth if so.
    await refreshExpiredProfiles(authProfiles, payload.projectId, payload.baseUrl, {
      allowedHosts: payload.allowedHosts ?? [],
      allowedPorts: payload.allowedPorts ?? [],
    });

    // Advanced modules: JWT analysis, IDOR engine, race condition testing, and Nuclei.
    // All independent — run in parallel to keep wall-clock time bounded.
    await updateJob(payload.jobId, { phase: "advanced_analysis" });
    const advancedResults = await runSecurityScannerPhase(scannerContext, "advanced_analysis");
    scannerResults.push(...advancedResults);
    allFindings.push(...findingsFromScannerResults(advancedResults));

    // Business logic + CORS: two independent modules, run in parallel.
    // Business logic probes financial mutation endpoints for invalid inputs (negative amounts,
    // overflow, zero-value, mass assignment, parameter pollution).
    // CORS audit tests 7 distinct attack patterns against discovered API endpoints.
    await updateJob(payload.jobId, { phase: "business_logic_cors" });
    const businessLogicCorsResults = await runSecurityScannerPhase(scannerContext, "business_logic_cors");
    scannerResults.push(...businessLogicCorsResults);
    allFindings.push(...findingsFromScannerResults(businessLogicCorsResults));

    // Mobile security: runs in parallel with perf baseline — independent checks
    await updateJob(payload.jobId, { phase: "mobile_scan" });
    const mobileResults = await runSecurityScannerPhase(scannerContext, "mobile_scan");
    scannerResults.push(...mobileResults);
    allFindings.push(...findingsFromScannerResults(mobileResults));

    await updateJob(payload.jobId, { phase: "anomaly_baseline" });
    const anomalyResults = await runSecurityScannerPhase(scannerContext, "anomaly_baseline");
    scannerResults.push(...anomalyResults);
    allFindings.push(...findingsFromScannerResults(anomalyResults));
    const anomalyMetadata = scannerMetadata<AnomalyBaselineScannerMetadata>(anomalyResults, "anomaly-baseline");
    const anomalyResult = {
      snapshots: anomalyMetadata?.snapshots ?? [],
      authMatrix: anomalyMetadata?.authMatrix ?? [],
    };
    const deepDiagnostic = buildDeepAnomalyDiagnostic(
      payload,
      routeInventory,
      routeContracts,
      anomalyResult.snapshots.length
    );
    if (deepDiagnostic) allFindings.push(deepDiagnostic);

    const baselineCandidate = buildSecurityBehaviorBaseline({
      projectId: payload.projectId,
      sourceScanId: payload.jobId,
      baseUrl: payload.baseUrl,
      environment: payload.environment ?? "qa",
      authMatrix: anomalyResult.authMatrix,
      snapshots: anomalyResult.snapshots,
    });
    const approvedBaseline = await loadApprovedBehaviorBaseline(payload.projectId, baselineCandidate.scopeKey);
    const driftResult = compareSecurityBehaviorBaseline(approvedBaseline, baselineCandidate);
    allFindings.push(...driftResult.findings);
    allFindings.push(
      buildScanCoverageFinding({
        payload,
        sourceContext,
        routeInventory,
        routeContracts,
        authProfiles,
        jsEndpointCount: discoveredJsEndpoints.length,
        apiSpecAttached: Boolean(payload.apiSpecId),
      })
    );

    const finalFindings = dedupeFindings(allFindings);

    await addFindings(payload.jobId, finalFindings);

    const owaspCounts = finalFindings.reduce<Record<string, number>>((acc, f) => {
      const category = (f.evidence as any)?.owaspCategory;
      if (category) acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {});

    const owaspApiCounts = finalFindings.reduce<Record<string, number>>((acc, f) => {
      const category = (f.evidence as any)?.owaspApiCategory;
      if (category) acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {});

    await updateJob(payload.jobId, {
      status: "completed",
      phase: null,
      finishedAt: new Date(),
      summary: {
        counts: finalFindings.reduce<Record<string, number>>((acc, f) => {
          acc[f.severity] = (acc[f.severity] || 0) + 1;
          return acc;
        }, {}),
        owaspCounts,
        owaspApiCounts,
        intelligentChecks: {
          fixtures: payload.apiFixtures?.length ?? 0,
          authProfiles: payload.authProfiles?.length ?? 0,
          scanDepth: payload.scanDepth ?? "standard",
          environment: payload.environment ?? "qa",
        },
        scannerRegistry: summarizeScannerRegistry(scannerResults),
        coverage: {
          mode: sourceContext.codeReviewAvailable ? "code_and_url" : "url_only",
          sourceMode: sourceContext.requestedMode,
          sourceAvailable: sourceContext.codeReviewAvailable,
          sourceConfigured: Boolean(sourceContext.sourceRoot),
          sourceFileCount: sourceContext.sourceFileCount,
          sourceReason: sourceContext.reason,
          url: {
            baseUrl: payload.baseUrl,
            allowedHosts: payload.allowedHosts,
            allowedPorts: payload.allowedPorts,
            apiSpecAttached: Boolean(payload.apiSpecId),
            authProfiles: authProfiles.length,
            jsEndpoints: discoveredJsEndpoints.length,
          },
        },
        routeInventory: {
          routes: routeInventory.length,
          contracts: routeContracts.length,
          anomalyBaselines: anomalyResult.snapshots.length,
          sources: routeInventory.reduce<Record<string, number>>((acc, route) => {
            acc[route.source] = (acc[route.source] || 0) + 1;
            return acc;
          }, {}),
        },
        authMatrix: summarizeAuthMatrix(anomalyResult.authMatrix),
        baseline: {
          scopeKey: baselineCandidate.scopeKey,
          candidate: baselineCandidate,
          approved: approvedBaseline
            ? {
                sourceScanId: approvedBaseline.sourceScanId,
                approvedAt: approvedBaseline.approvedAt,
                approvedBy: approvedBaseline.approvedBy,
                fingerprints: approvedBaseline.fingerprints.length,
              }
            : null,
          drift: driftResult.summary,
        },
        complianceReport: buildComplianceReport(
          payload.jobId,
          payload.baseUrl,
          finalFindings as any[],
          {
            phases: ["recon", "static_analysis", "dependency", "dynamic", "intelligent_validation",
                     "graphql_audit", "js_analysis", "advanced_analysis", "business_logic_cors",
                     "mobile_scan", "anomaly_baseline"],
            authProfileCount: payload.authProfiles?.length ?? 0,
          }
        ),
      },
    });
}

securityWorker.on("failed", async (job, err) => {
  if (job?.data?.jobId) {
    await updateJob(job.data.jobId, {
      status: "failed",
      error: err?.message ?? String(err),
      finishedAt: new Date(),
    });
  }
});

securityWorker.on("completed", async (job) => {
  if (job?.data?.jobId) {
    await updateJob(job.data.jobId, { phase: null, finishedAt: new Date() });
  }
});
