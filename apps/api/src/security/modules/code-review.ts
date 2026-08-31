import fs from "node:fs";
import path from "node:path";
import type { SecurityAgentFinding, SecuritySeverity } from "../types.js";

export type CodeReviewScanFinding = SecurityAgentFinding & {
  type: "static_analysis";
  severity: SecuritySeverity;
  tool: "code-review";
};

type SourceFile = {
  absolutePath: string;
  relativePath: string;
  content: string;
};

type FindingDraft = Omit<CodeReviewScanFinding, "type" | "tool">;

export type CodeReviewScanOptions = {
  root?: string;
  limit?: number;
};

const MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_FINDING_LIMIT = 100;
const CODE_REVIEW_SOURCE_PATHS = [
  "apps/api/src/routes/apiTesting.ts",
  "apps/api/src/runner/api-test-worker.ts",
  "apps/api/src/routes/agent.ts",
  "apps/api/src/agent/service.ts",
  "apps/api/src/routes/ci.ts",
  "apps/api/src/routes/environments.ts",
  "apps/api/src/lib/git-url.ts",
  "apps/api/src/index.ts",
  "apps/api/src/routes/mobile.ts",
  "apps/api/src/notifications/runNotifications.ts",
  "apps/api/src/routes/orgs.ts",
  "apps/api/src/routes/researchAuthTest.ts",
  "apps/api/src/routes/run.ts",
  "apps/api/src/routes/secrets.ts",
  "apps/api/src/testmind/routes.ts",
  "apps/api/src/testmind/discover.ts",
  "apps/web/src/main.tsx",
  "apps/web/src/pages/AgentPageDetailPage.tsx",
  "apps/web/src/pages/AgentSessionDetailPage.tsx",
] as const;

export function resolveCodeReviewRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  let firstPackageRoot: string | null = null;

  for (let depth = 0; depth < 8; depth += 1) {
    if (!firstPackageRoot && fs.existsSync(path.join(dir, "package.json"))) {
      firstPackageRoot = dir;
    }
    if (
      fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(dir, "turbo.json")) ||
      fs.existsSync(path.join(dir, ".git"))
    ) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return firstPackageRoot ?? path.resolve(start);
}

export function detectCodeReviewSourceStatus(options: { root?: string } = {}) {
  const root = resolveCodeReviewRoot(options.root);
  const availablePaths = CODE_REVIEW_SOURCE_PATHS.filter((relativePath) => {
    try {
      const stat = fs.statSync(toAbsolutePath(root, relativePath));
      return stat.isFile() && stat.size <= MAX_READ_BYTES;
    } catch {
      return false;
    }
  });

  return {
    root,
    available: availablePaths.length > 0,
    availablePaths: [...availablePaths],
  };
}

function toAbsolutePath(root: string, relativePath: string) {
  return path.join(root, ...relativePath.split("/"));
}

function normalizePath(relativePath: string) {
  return relativePath.replace(/\\/g, "/");
}

function loadFile(root: string, relativePath: string): SourceFile | null {
  const absolutePath = toAbsolutePath(root, relativePath);
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
    return {
      absolutePath,
      relativePath: normalizePath(relativePath),
      content: fs.readFileSync(absolutePath, "utf8"),
    };
  } catch {
    return null;
  }
}

function lineOf(content: string, pattern: string | RegExp): number | undefined {
  const index = typeof pattern === "string" ? content.indexOf(pattern) : content.search(pattern);
  if (index < 0) return undefined;
  return content.slice(0, index).split(/\r?\n/).length;
}

function locationOf(file: SourceFile, pattern?: string | RegExp) {
  const line = pattern ? lineOf(file.content, pattern) : undefined;
  return line ? `${file.relativePath}:${line}` : file.relativePath;
}

function hasAll(content: string, values: string[]) {
  return values.every((value) => content.includes(value));
}

function sliceFrom(file: SourceFile, anchor: string | RegExp, lineCount: number) {
  const start = typeof anchor === "string" ? file.content.indexOf(anchor) : file.content.search(anchor);
  if (start < 0) return "";
  return file.content
    .slice(start)
    .split(/\r?\n/)
    .slice(0, lineCount)
    .join("\n");
}

function routeDeclarations(file: SourceFile, prefix: string) {
  const matches: Array<{ location: string; method: string; path: string }> = [];
  const routePattern = /app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null;

  while ((match = routePattern.exec(file.content)) !== null) {
    const method = match[1]?.toUpperCase() ?? "GET";
    const routePath = match[2] ?? "";
    if (routePath.startsWith(prefix)) {
      const line = file.content.slice(0, match.index).split(/\r?\n/).length;
      matches.push({ location: `${file.relativePath}:${line}`, method, path: routePath });
    }
  }

  return matches;
}

function addPatternMatch(
  matches: Array<{ location: string; pattern: string }>,
  file: SourceFile | null,
  pattern: string | RegExp,
  label: string
) {
  if (!file) return;
  if (typeof pattern === "string") {
    if (!file.content.includes(pattern)) return;
  } else if (!pattern.test(file.content)) {
    return;
  }
  matches.push({ location: locationOf(file, pattern), pattern: label });
}

function evidence(params: {
  vulnerabilityClass: string;
  owaspCategory?: string;
  owaspApiCategory?: string | null;
  confidence?: "low" | "medium" | "high";
  matches?: unknown[];
  remediationSteps?: string[];
}) {
  return {
    vulnerabilityClass: params.vulnerabilityClass,
    owaspCategory: params.owaspCategory ?? "A01:2021",
    owaspApiCategory: params.owaspApiCategory ?? null,
    confidence: {
      score: params.confidence === "high" ? 90 : params.confidence === "low" ? 55 : 75,
      label: params.confidence ?? "medium",
      rationale: "Detected by repository code-review pattern matching.",
    },
    matches: params.matches ?? [],
    remediationSteps: params.remediationSteps ?? [],
  };
}

function addFinding(findings: CodeReviewScanFinding[], draft: FindingDraft) {
  findings.push({
    type: "static_analysis",
    tool: "code-review",
    status: "open",
    ...draft,
  });
}

function readPackageJson(root: string, relativePath: string): Record<string, any> | null {
  const file = loadFile(root, relativePath);
  if (!file) return null;
  try {
    return JSON.parse(file.content);
  } catch {
    return null;
  }
}

function dependencyVersion(pkg: Record<string, any> | null, name: string): string | null {
  if (!pkg) return null;
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null;
}

function storedAuthStateMatches(root: string) {
  const sessionDir = path.join(root, "testmind-auth-sessions");
  const matches: Array<{ location: string; reason: string }> = [];
  try {
    const entries = fs
      .readdirSync(sessionDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .slice(0, 10);

    for (const entry of entries) {
      const absolutePath = path.join(sessionDir, entry.name);
      const stat = fs.statSync(absolutePath);
      if (stat.size > MAX_READ_BYTES) continue;
      const content = fs.readFileSync(absolutePath, "utf8");
      if (/"cookies"|"localStorage"|"sessionStorage"|"accessToken"|"refreshToken"|bearer/i.test(content)) {
        matches.push({
          location: normalizePath(path.relative(root, absolutePath)),
          reason: "auth state JSON contains browser session or token-shaped keys",
        });
      }
    }
  } catch {
    return matches;
  }
  return matches;
}

function generatedRunArtifactCount(root: string) {
  const runDir = path.join(root, "apps", "api", "runs");
  try {
    return fs.readdirSync(runDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isFile())
      .length;
  } catch {
    return 0;
  }
}

export function runCodeReviewScan(options: CodeReviewScanOptions = {}): CodeReviewScanFinding[] {
  const root = resolveCodeReviewRoot(options.root);
  const findings: CodeReviewScanFinding[] = [];

  const apiTesting = loadFile(root, "apps/api/src/routes/apiTesting.ts");
  const apiWorker = loadFile(root, "apps/api/src/runner/api-test-worker.ts");
  const agentRoutes = loadFile(root, "apps/api/src/routes/agent.ts");
  const agentService = loadFile(root, "apps/api/src/agent/service.ts");
  const ciRoutes = loadFile(root, "apps/api/src/routes/ci.ts");
  const environments = loadFile(root, "apps/api/src/routes/environments.ts");
  const gitUrl = loadFile(root, "apps/api/src/lib/git-url.ts");
  const index = loadFile(root, "apps/api/src/index.ts");
  const mobileRoutes = loadFile(root, "apps/api/src/routes/mobile.ts");
  const notificationRoutes = loadFile(root, "apps/api/src/notifications/runNotifications.ts");
  const orgRoutes = loadFile(root, "apps/api/src/routes/orgs.ts");
  const researchAuth = loadFile(root, "apps/api/src/routes/researchAuthTest.ts");
  const runRoutes = loadFile(root, "apps/api/src/routes/run.ts");
  const secretsRoutes = loadFile(root, "apps/api/src/routes/secrets.ts");
  const testmindRoutes = loadFile(root, "apps/api/src/testmind/routes.ts");
  const discover = loadFile(root, "apps/api/src/testmind/discover.ts");
  const webMain = loadFile(root, "apps/web/src/main.tsx");
  const agentPageDetail = loadFile(root, "apps/web/src/pages/AgentPageDetailPage.tsx");
  const agentSessionDetail = loadFile(root, "apps/web/src/pages/AgentSessionDetailPage.tsx");
  const loadedFiles = [
    apiTesting,
    apiWorker,
    agentRoutes,
    agentService,
    ciRoutes,
    environments,
    gitUrl,
    index,
    mobileRoutes,
    notificationRoutes,
    orgRoutes,
    researchAuth,
    runRoutes,
    secretsRoutes,
    testmindRoutes,
    discover,
    webMain,
    agentPageDetail,
    agentSessionDetail,
  ];

  if (loadedFiles.every((file) => !file)) {
    addFinding(findings, {
      severity: "info",
      title: "Code review source files not found",
      description:
        "Built-in code-review checks could not find application source files from the worker's current repository root.",
      location: root,
      evidence: evidence({
        vulnerabilityClass: "scan_configuration",
        owaspCategory: "A05:2021",
        owaspApiCategory: "API8:2023",
        confidence: "high",
        remediationSteps: ["Run the worker from the repository root or package source files where static review should execute."],
      }),
      suggestion: "Set the worker cwd to the repo root or provide source files to the scan environment.",
    });
    return findings;
  }

  if (environments) {
    const envRoutes = routeDeclarations(environments, "/environments");
    const hasAuth = /getAuth|requireUser|req\.auth|request\.auth/.test(environments.content);
    if (envRoutes.length > 0 && !hasAuth) {
      addFinding(findings, {
        severity: "critical",
        title: "Unauthenticated environment management routes",
        description:
          "Environment CRUD routes are registered without an authentication or ownership guard. These records can affect workflow base URLs and approval behavior.",
        location: envRoutes[0]?.location ?? environments.relativePath,
        evidence: evidence({
          vulnerabilityClass: "missing_authorization",
          owaspCategory: "A01:2021",
          owaspApiCategory: "API1:2023",
          confidence: "high",
          matches: envRoutes,
          remediationSteps: [
            "Require getAuth or a shared requireUser guard on every environment route.",
            "Scope reads and writes to the authenticated user's project or organization.",
          ],
        }),
        suggestion: "Add auth and project/org ownership checks before listing, creating, updating, or deleting environments.",
      });
    }
  }

  const artifactMatches: Array<{ location: string; pattern: string }> = [];
  addPatternMatch(artifactMatches, index, /prefix:\s*["']\/_static\/runner-logs\//, "static runner-log mount");
  addPatternMatch(artifactMatches, index, /app\.get\(\s*["']\/runner-logs\/\*/, "public runner-log proxy");
  addPatternMatch(artifactMatches, index, /app\.get\(\s*["']\/assets\/\*/, "referer-gated asset proxy");
  if (artifactMatches.length > 0) {
    addFinding(findings, {
      severity: "high",
      title: "Runner artifacts are exposed through public static routes",
      description:
        "Runner logs and artifacts are mounted or proxied from predictable public paths. Referer checks are not an authorization boundary.",
      location: artifactMatches[0]?.location,
      evidence: evidence({
        vulnerabilityClass: "sensitive_artifact_exposure",
        owaspCategory: "A01:2021",
        owaspApiCategory: "API3:2023",
        confidence: "high",
        matches: artifactMatches,
        remediationSteps: [
          "Serve runner artifacts only through authenticated handlers.",
          "Authorize each request against the run/project owner and remove public static mounts for logs.",
        ],
      }),
      suggestion: "Route artifact downloads through a single owner-checked endpoint and avoid public static prefixes.",
    });
  }

  const outboundMatches: Array<{ location: string; pattern: string }> = [];
  addPatternMatch(outboundMatches, apiTesting, /request\(\s*specUrl/, "OpenAPI spec request without safeFetch");
  addPatternMatch(outboundMatches, apiWorker, /request\(\s*finalUrl/, "API-test worker request without safeFetch");
  addPatternMatch(outboundMatches, researchAuth, /fetch\(\s*(targetUrl|baselineUrl|testUrl|resourceUrl)/, "research auth fetch without safeFetch");
  addPatternMatch(outboundMatches, discover, /page\.goto\(\s*url\b/, "browser navigation without shared URL policy");
  if (
    gitUrl &&
    hasAll(gitUrl.content, ['protocol !== "http:"', 'protocol !== "https:"', "return normalized"]) &&
    !/validateUrl|isPrivate|privateIp|dns\.lookup/.test(gitUrl.content)
  ) {
    outboundMatches.push({
      location: locationOf(gitUrl, "return normalized"),
      pattern: "project URL validation allows arbitrary http(s) hosts without private-host checks",
    });
  }
  if (outboundMatches.length > 0) {
    addFinding(findings, {
      severity: "high",
      title: "Outbound URL handling bypasses centralized SSRF validation",
      description:
        "Several code paths send user- or project-controlled URLs directly to fetch, undici, or Playwright instead of the shared safe-fetch policy.",
      location: outboundMatches[0]?.location,
      evidence: evidence({
        vulnerabilityClass: "ssrf",
        owaspCategory: "A10:2021",
        owaspApiCategory: "API7:2023",
        confidence: "medium",
        matches: outboundMatches,
        remediationSteps: [
          "Use validateUrl or safeFetch before outbound HTTP requests.",
          "Apply the same host, DNS, redirect, and private-network policy to Playwright navigation.",
        ],
      }),
      suggestion: "Centralize all remote URL validation through safe-fetch and reject private, loopback, metadata, and redirect-to-private targets.",
    });
  }

  const activeScanMatches: Array<{ location: string; pattern: string }> = [];
  if (ciRoutes && /enableActive:\s*body\.scanDepth !== ["']baseline["']/.test(ciRoutes.content) && /allowedHosts:\s*\[\]/.test(ciRoutes.content)) {
    activeScanMatches.push({
      location: locationOf(ciRoutes, /enableActive:\s*body\.scanDepth !== ["']baseline["']/),
      pattern: "CI security scan queues active probes with empty scope",
    });
  }
  if (mobileRoutes && /enableActive:\s*true/.test(mobileRoutes.content) && /allowedHosts:\s*\[\]/.test(mobileRoutes.content)) {
    activeScanMatches.push({
      location: locationOf(mobileRoutes, /enableActive:\s*true/),
      pattern: "mobile security scan queues active probes with empty scope",
    });
  }
  if (activeScanMatches.length > 0) {
    addFinding(findings, {
      severity: "high",
      title: "Active security scans can be queued without explicit target scope",
      description:
        "CI and mobile scan routes can enable active probing while passing an empty allowedHosts list, weakening approval and scope enforcement.",
      location: activeScanMatches[0]?.location,
      evidence: evidence({
        vulnerabilityClass: "unsafe_active_scan_control",
        owaspCategory: "A05:2021",
        owaspApiCategory: "API8:2023",
        confidence: "high",
        matches: activeScanMatches,
        remediationSteps: [
          "Require explicit authorization before active probes are queued.",
          "Populate allowedHosts and allowedPorts from a validated scan target.",
        ],
      }),
      suggestion: "Make active scans opt-in per target and fail closed when scope is missing.",
    });
  }

  if (
    orgRoutes &&
    hasAll(orgRoutes.content, ['project.ownerId !== userId', 'callerRole !== "owner"', 'callerRole !== "admin"', "data: { orgId: org.id }"])
  ) {
    addFinding(findings, {
      severity: "high",
      title: "Organization admins can attach projects they do not own",
      description:
        "The project attach route allows org owners/admins to associate a project when the project owner differs from the caller, creating an object-ownership bypass.",
      location: locationOf(orgRoutes, "data: { orgId: org.id }"),
      evidence: evidence({
        vulnerabilityClass: "idor",
        owaspCategory: "A01:2021",
        owaspApiCategory: "API1:2023",
        confidence: "high",
        matches: [{ location: locationOf(orgRoutes, "project.ownerId !== userId"), pattern: "ownership bypass condition" }],
        remediationSteps: ["Require project.ownerId to match the caller or verify an explicit project membership grant."],
      }),
      suggestion: "Do not let org role alone authorize mutations to projects outside the caller's ownership or membership boundary.",
    });
  }

  if (testmindRoutes) {
    const getSpecSection = sliceFrom(testmindRoutes, 'app.get("/suite/spec-content"', 95);
    if (getSpecSection.includes("getCuratedProject(projectId)") && getSpecSection.includes("ownerId: userId")) {
      addFinding(findings, {
        severity: "high",
        title: "Suite spec-content ownership can be bypassed by curated project fallback",
        description:
          "The spec-content route can synthesize a project owned by the caller when a curated manifest entry matches the requested projectId, bypassing database ownership checks.",
        location: locationOf(testmindRoutes, "getCuratedProject(projectId)"),
        evidence: evidence({
          vulnerabilityClass: "idor",
          owaspCategory: "A01:2021",
          owaspApiCategory: "API1:2023",
          confidence: "high",
          matches: [{ location: locationOf(testmindRoutes, "ownerId: userId"), pattern: "fallback owner assignment" }],
          remediationSteps: ["Resolve project ownership from the database before allowing spec file reads or writes."],
        }),
        suggestion: "Remove synthetic ownership from the GET/PUT spec-content paths and require a real authorized project record.",
      });
    }
    if (getSpecSection.includes("fs.promises.writeFile")) {
      addFinding(findings, {
        severity: "medium",
        title: "GET suite spec-content route mutates files",
        description:
          "A GET handler writes coerced spec content back to disk, which makes a read route state-changing and harder to protect, cache, and audit.",
        location: locationOf(testmindRoutes, "fs.promises.writeFile"),
        evidence: evidence({
          vulnerabilityClass: "unsafe_http_method_semantics",
          owaspCategory: "A04:2021",
          owaspApiCategory: "API8:2023",
          confidence: "high",
          matches: [{ location: locationOf(testmindRoutes, "fs.promises.writeFile"), pattern: "write inside GET handler" }],
          remediationSteps: ["Move file repair/write behavior to an authenticated POST or PUT route."],
        }),
        suggestion: "Keep GET routes read-only and perform normalization through an explicit write endpoint.",
      });
    }
  }

  if (
    agentRoutes &&
    agentService &&
    /createAgentSession\(\s*\{[\s\S]*projectId/.test(agentRoutes.content) &&
    /prisma\.agentSession\.create\(\{[\s\S]*projectId/.test(agentService.content) &&
    /projectSecret\.findMany\(\{[\s\S]*projectId/.test(agentService.content)
  ) {
    addFinding(findings, {
      severity: "high",
      title: "Agent sessions can reference arbitrary project secrets",
      description:
        "Agent routes pass a caller-supplied projectId into session creation, and the agent service later resolves OpenAI keys from that project without an ownership check.",
      location: locationOf(agentRoutes, "createAgentSession({"),
      evidence: evidence({
        vulnerabilityClass: "idor_secret_access",
        owaspCategory: "A01:2021",
        owaspApiCategory: "API1:2023",
        confidence: "medium",
        matches: [
          { location: locationOf(agentRoutes, "createAgentSession({"), pattern: "route accepts projectId" },
          { location: locationOf(agentService, "projectSecret.findMany"), pattern: "secret lookup by projectId" },
        ],
        remediationSteps: ["Verify the authenticated user owns or belongs to the project before storing projectId on an agent session."],
      }),
      suggestion: "Scope agent session project IDs through project ownership/membership checks before resolving project secrets.",
    });
  }

  if (
    apiTesting &&
    apiWorker &&
    /environmentId:\s*z\.string\(\)\.optional/.test(apiTesting.content) &&
    /data:\s*\{\s*projectId,\s*name,\s*baseUrl,\s*environmentId\s*\}/.test(apiTesting.content) &&
    /collection\.environment\.variables/.test(apiWorker.content)
  ) {
    addFinding(findings, {
      severity: "high",
      title: "API collections can attach an environment without ownership validation",
      description:
        "Collection creation stores an arbitrary environmentId while the worker later consumes that environment's variables, allowing cross-project data influence if IDs are guessed or leaked.",
      location: locationOf(apiTesting, /data:\s*\{\s*projectId,\s*name,\s*baseUrl,\s*environmentId\s*\}/),
      evidence: evidence({
        vulnerabilityClass: "idor",
        owaspCategory: "A01:2021",
        owaspApiCategory: "API1:2023",
        confidence: "high",
        matches: [
          { location: locationOf(apiTesting, "environmentId: z.string().optional()"), pattern: "environmentId accepted" },
          { location: locationOf(apiWorker, "collection.environment.variables"), pattern: "environment variables consumed by worker" },
        ],
        remediationSteps: ["Require the environment to belong to the same project before saving environmentId on a collection."],
      }),
      suggestion: "Validate environment.projectId equals the collection projectId before create/update.",
    });
  }

  if (
    secretsRoutes &&
    /projectSecret\.update\(\{\s*where:\s*\{\s*id\s*\}/.test(secretsRoutes.content) &&
    /projectSecret\.delete\(\{\s*where:\s*\{\s*id\s*\}/.test(secretsRoutes.content)
  ) {
    addFinding(findings, {
      severity: "high",
      title: "Project secret update/delete routes are scoped only by secret id",
      description:
        "Secret update and delete operations use only the secret id in the Prisma where clause after checking the route project owner, so a mismatched secret id can target another project.",
      location: locationOf(secretsRoutes, /projectSecret\.update\(\{\s*where:\s*\{\s*id\s*\}/),
      evidence: evidence({
        vulnerabilityClass: "idor_secret_mutation",
        owaspCategory: "A01:2021",
        owaspApiCategory: "API1:2023",
        confidence: "high",
        matches: [
          { location: locationOf(secretsRoutes, /projectSecret\.update\(\{\s*where:\s*\{\s*id\s*\}/), pattern: "update by id only" },
          { location: locationOf(secretsRoutes, /projectSecret\.delete\(\{\s*where:\s*\{\s*id\s*\}/), pattern: "delete by id only" },
        ],
        remediationSteps: ["Constrain secret mutations by both id and projectId, or load the secret and check ownership before mutation."],
      }),
      suggestion: "Use a compound where condition or explicit secret.projectId check for update and delete.",
    });
  }

  if (runRoutes) {
    const specsSection = sliceFrom(runRoutes, 'app.get("/projects/:id/specs"', 50);
    if (specsSection.includes("path: p") && !/getAuth|requireUser|req\.auth/.test(specsSection)) {
      addFinding(findings, {
        severity: "medium",
        title: "Generated spec tree route exposes paths without route auth",
        description:
          "The project specs route returns filesystem paths from generated specs without an authentication check inside the handler.",
        location: locationOf(runRoutes, 'app.get("/projects/:id/specs"'),
        evidence: evidence({
          vulnerabilityClass: "information_disclosure",
          owaspCategory: "A01:2021",
          owaspApiCategory: "API3:2023",
          confidence: "high",
          matches: [{ location: locationOf(runRoutes, "path: p"), pattern: "filesystem path returned" }],
          remediationSteps: ["Require project ownership before returning generated spec metadata and avoid returning absolute paths."],
        }),
        suggestion: "Authorize the project id and return repo-relative paths only.",
      });
    }
  }

  const debugMatches: Array<{ location: string; pattern: string }> = [];
  addPatternMatch(debugMatches, index, 'app.get("/__whoami"', "public whoami diagnostic");
  addPatternMatch(debugMatches, index, 'app.get("/runner/debug/list"', "public runner debug list");
  addPatternMatch(debugMatches, index, 'app.post("/runner/seed-project"', "public seed-project mutation");
  addPatternMatch(debugMatches, index, 'app.get("/recorder/helper/status"', "public recorder status helper");
  addPatternMatch(debugMatches, index, 'app.post("/recorder/helper/start"', "public recorder start helper");
  addPatternMatch(debugMatches, testmindRoutes, 'app.get("/tm/health"', "testmind health leaks local roots");
  if (debugMatches.length > 0) {
    addFinding(findings, {
      severity: "medium",
      title: "Debug and helper routes are exposed in the API server",
      description:
        "Diagnostic and helper endpoints are registered in the main API surface; several disclose local runtime details or trigger mutable setup behavior.",
      location: debugMatches[0]?.location,
      evidence: evidence({
        vulnerabilityClass: "debug_endpoint_exposure",
        owaspCategory: "A05:2021",
        owaspApiCategory: "API8:2023",
        confidence: "medium",
        matches: debugMatches,
        remediationSteps: ["Gate diagnostics behind explicit debug configuration plus admin authorization, or remove them from production builds."],
      }),
      suggestion: "Restrict debug/helper endpoints with admin auth and environment gates.",
    });
  }

  if (mobileRoutes) {
    const setupSection = sliceFrom(mobileRoutes, '"/mobile/setup-guide"', 55);
    if (setupSection.includes("mobileConfig.findUnique") && !/ownerId\s*!==|project\.ownerId|config\.project/.test(setupSection)) {
      addFinding(findings, {
        severity: "medium",
        title: "Mobile setup-guide can read config by id without ownership validation",
        description:
          "The setup-guide route is authenticated but fetches a mobile config by id without checking that the config belongs to the caller's project.",
        location: locationOf(mobileRoutes, '"/mobile/setup-guide"'),
        evidence: evidence({
          vulnerabilityClass: "idor",
          owaspCategory: "A01:2021",
          owaspApiCategory: "API1:2023",
          confidence: "medium",
          matches: [{ location: locationOf(mobileRoutes, "mobileConfig.findUnique"), pattern: "lookup by config id" }],
          remediationSteps: ["Include project owner or membership data in the config lookup and return 403 when it does not match the caller."],
        }),
        suggestion: "Scope setup-guide config lookups to the authenticated user's project.",
      });
    }
  }

  const htmlMatches: Array<{ location: string; pattern: string }> = [];
  addPatternMatch(htmlMatches, runRoutes, /<td>\$\{r\.title\}<\/td><td>\$\{r\.file\}<\/td>/, "run report HTML interpolates title/file");
  addPatternMatch(htmlMatches, notificationRoutes, /\$\{params\.projectName\}/, "email HTML interpolates projectName");
  addPatternMatch(htmlMatches, notificationRoutes, /\$\{params\.error\}/, "email HTML interpolates error text");
  if (htmlMatches.length > 0) {
    addFinding(findings, {
      severity: "medium",
      title: "HTML output interpolates unescaped dynamic values",
      description:
        "Report and notification HTML templates include project, error, title, and file values without HTML escaping.",
      location: htmlMatches[0]?.location,
      evidence: evidence({
        vulnerabilityClass: "html_injection",
        owaspCategory: "A03:2021",
        owaspApiCategory: "API8:2023",
        confidence: "medium",
        matches: htmlMatches,
        remediationSteps: ["Escape HTML text and attribute contexts before interpolating dynamic values into reports or emails."],
      }),
      suggestion: "Use a small escapeHtml helper or a templating library that escapes by default.",
    });
  }

  const navMatches: Array<{ location: string; pattern: string }> = [];
  if (webMain && webMain.content.includes("<BrowserRouter>")) {
    addPatternMatch(navMatches, agentPageDetail, "/#/suite?spec=", "hash suite link in BrowserRouter app");
    addPatternMatch(navMatches, agentSessionDetail, "/#/suite?spec=", "hash suite link in BrowserRouter app");
  }
  if (index && runRoutes && /prefix:\s*["']\/runner["']/.test(index.content) && /app\.get\(\s*["']\/runner\/test-runs/.test(runRoutes.content)) {
    navMatches.push({
      location: locationOf(runRoutes, /app\.get\(\s*["']\/runner\/test-runs/),
      pattern: "runner route module defines /runner paths while mounted at /runner",
    });
  }
  if (navMatches.length > 0) {
    addFinding(findings, {
      severity: "low",
      title: "Navigation routes and API mount paths are drifting",
      description:
        "The frontend uses hash-style suite links inside a BrowserRouter app, and the runner route module contains /runner paths while being mounted under a /runner prefix.",
      location: navMatches[0]?.location,
      evidence: evidence({
        vulnerabilityClass: "navigation_drift",
        owaspCategory: "A04:2021",
        owaspApiCategory: "API9:2023",
        confidence: "medium",
        matches: navMatches,
        remediationSteps: ["Use router-native links for suite pages and avoid defining already-prefixed routes inside prefixed Fastify modules."],
      }),
      suggestion: "Normalize suite links to real React Router paths and remove double-prefixed API aliases.",
    });
  }

  const authStateMatches = storedAuthStateMatches(root);
  if (authStateMatches.length > 0) {
    addFinding(findings, {
      severity: "critical",
      title: "Browser auth session state is stored under the repository",
      description:
        "Auth state JSON files with cookie or token-shaped keys exist under testmind-auth-sessions in the repository tree.",
      location: authStateMatches[0]?.location,
      evidence: evidence({
        vulnerabilityClass: "secret_storage",
        owaspCategory: "A02:2021",
        owaspApiCategory: "API8:2023",
        confidence: "high",
        matches: authStateMatches,
        remediationSteps: ["Move auth state outside the repo, rotate exposed sessions, and add repo-level ignore rules for generated secrets."],
      }),
      suggestion: "Store captured browser auth state in an external secret store or temp directory outside source control.",
    });
  }

  const runArtifactCount = generatedRunArtifactCount(root);
  if (runArtifactCount > 0) {
    addFinding(findings, {
      severity: "low",
      title: "Generated run artifacts are stored under the API source tree",
      description:
        "apps/api/runs contains generated run output. Keeping artifacts under the service tree increases the chance of accidental static exposure or source-control leakage.",
      location: "apps/api/runs",
      evidence: evidence({
        vulnerabilityClass: "artifact_hygiene",
        owaspCategory: "A05:2021",
        owaspApiCategory: "API8:2023",
        confidence: "medium",
        matches: [{ location: "apps/api/runs", count: runArtifactCount }],
        remediationSteps: ["Write generated artifacts to a configured data directory outside the application source tree."],
      }),
      suggestion: "Use an external artifact root and require auth for every artifact read.",
    });
  }

  const apiPkg = readPackageJson(root, "apps/api/package.json");
  const webPkg = readPackageJson(root, "apps/web/package.json");
  const dependencyMatches: Array<{ location: string; package: string; version: string }> = [];
  const legacyFaker = dependencyVersion(apiPkg, "faker");
  if (legacyFaker) {
    dependencyMatches.push({ location: "apps/api/package.json", package: "faker", version: legacyFaker });
  }
  const xlsx = dependencyVersion(webPkg, "xlsx");
  if (xlsx) {
    dependencyMatches.push({ location: "apps/web/package.json", package: "xlsx", version: xlsx });
  }
  if (dependencyMatches.length > 0) {
    addFinding(findings, {
      severity: "high",
      title: "Package manifests include dependencies that should be removed or isolated",
      description:
        "The manifests include legacy faker and/or xlsx. These packages have a history of unresolved advisories in common audits and should be replaced, removed, or isolated behind strict upload controls.",
      location: dependencyMatches[0]?.location,
      evidence: evidence({
        vulnerabilityClass: "dependency_risk",
        owaspCategory: "A06:2021",
        owaspApiCategory: "API8:2023",
        confidence: "medium",
        matches: dependencyMatches,
        remediationSteps: ["Remove unused legacy dependencies and run the package-manager audit in CI."],
      }),
      suggestion: "Drop unused faker, prefer @faker-js/faker where needed, and evaluate a safer spreadsheet parser or sandboxed import path.",
    });
  }

  return findings.slice(0, options.limit ?? DEFAULT_FINDING_LIMIT);
}
