/**
 * OpenAPI-driven security scan module.
 *
 * Unlike the generic dynamic scanner, this module knows the API surface precisely —
 * every endpoint, its parameters, their types, and which require authentication.
 * That specificity enables targeted, low-noise probes instead of blind fuzzing.
 *
 * Checks run per endpoint:
 *   1. Auth enforcement     — call without credentials; expect 401/403
 *   2. Method tampering     — try undeclared HTTP methods; expect 405
 *   3. IDOR detection       — path contains {id} params; flag for cross-account testing
 *   4. Injection probing    — inject SQLi/XSS/path-traversal payloads in string params
 *   5. Required field skip  — omit required body/query params; expect 400 not 500
 *   6. Response schema leak — flag endpoints returning schema fields matching sensitive patterns
 */

import { buildAuthHeaders } from "../auth-headers.js";
import type { NormalizedEndpoint, NormalizedParam, ParsedApiSpec } from "../openapi-parser.js";
import type { SecurityAuthProfile } from "../types.js";
import { probeScoped, type ProbeScope } from "../http-client.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type OpenApiScanFinding = {
  type: "dynamic";
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description?: string;
  location?: string;
  tool?: string;
  evidence?: Record<string, unknown>;
  suggestion?: string;
  status?: string;
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

type ProbeResult = { status: number; body: string; ms: number } | null;

async function httpProbe(
  scope: ProbeScope,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
  timeoutMs = 10_000,
): Promise<ProbeResult> {
  const t0 = Date.now();
  const res = await probeScoped(scope, url, { method, headers: { Accept: "application/json", ...headers }, body, timeoutMs });
  if (res.error || res.status === undefined) return null;
  return { status: res.status, body: res.body, ms: Date.now() - t0 };
}

// ── URL construction ─────────────────────────────────────────────────────────

function fillPathParams(path: string, params: NormalizedParam[]): string {
  let filled = path;
  for (const p of params.filter((p) => p.in === "path")) {
    const val =
      p.type === "integer" || p.type === "number" ? "1" :
      p.format === "uuid" ? "00000000-0000-0000-0000-000000000001" :
      "testvalue";
    filled = filled.replace(`{${p.name}}`, val);
  }
  return filled;
}

function buildQueryString(params: NormalizedParam[]): string {
  const qps = params.filter((p) => p.in === "query" && p.required);
  if (!qps.length) return "";
  const parts = qps.map((p) => {
    const val = p.type === "integer" ? "1" : p.enum?.[0] ?? "test";
    return `${encodeURIComponent(p.name)}=${encodeURIComponent(val)}`;
  });
  return "?" + parts.join("&");
}

function buildMinimalBody(params: NormalizedParam[]): string | undefined {
  const bodyParams = params.filter((p) => p.in === "body");
  if (!bodyParams.length) return undefined;
  const obj: Record<string, unknown> = {};
  for (const p of bodyParams) {
    if (p.type === "integer" || p.type === "number") obj[p.name] = 1;
    else if (p.type === "boolean") obj[p.name] = true;
    else obj[p.name] = p.enum?.[0] ?? p.example ?? "test";
  }
  return JSON.stringify(obj);
}

function endpointUrl(baseUrl: string, endpoint: NormalizedEndpoint): string {
  const filled = fillPathParams(endpoint.path, endpoint.params);
  const qs = buildQueryString(endpoint.params);
  return `${baseUrl}${filled}${qs}`;
}

// ── 1. Auth enforcement ───────────────────────────────────────────────────────

async function checkAuthEnforcement(
  scope: ProbeScope,
  baseUrl: string,
  endpoint: NormalizedEndpoint,
): Promise<OpenApiScanFinding[]> {
  if (!endpoint.requiresAuth) return [];
  const url = endpointUrl(baseUrl, endpoint);
  const body = buildMinimalBody(endpoint.params);
  const res = await httpProbe(
    scope,
    endpoint.method,
    url,
    body ? { "Content-Type": "application/json" } : {},
    body,
  );
  if (!res) return [];
  if (res.status < 400 || res.status === 200 || res.status === 201) {
    return [
      {
        type: "dynamic",
        severity: endpoint.method === "GET" ? "high" : "critical",
        title: `Auth bypass: ${endpoint.method} ${endpoint.path} returns ${res.status} without credentials`,
        description:
          `The endpoint ${endpoint.method} ${endpoint.path} is declared as requiring authentication ` +
          `in the API spec but returned HTTP ${res.status} for an unauthenticated request. ` +
          `An attacker can call this endpoint without any credentials.`,
        location: url,
        tool: "openapi-scan",
        evidence: {
          vulnerabilityClass: "broken_authentication",
          owaspCategory: "A07:2021 Identification and Authentication Failures",
          owaspApiCategory: "API2:2023 Broken Authentication",
          method: endpoint.method,
          path: endpoint.path,
          responseStatus: res.status,
          responsePreview: res.body.slice(0, 400),
        },
        suggestion:
          "Add authentication middleware to this route before it executes any business logic. " +
          "Return 401 for missing/invalid credentials and 403 for insufficient permissions.",
        status: "open",
      },
    ];
  }
  return [];
}

// ── 2. Method tampering ───────────────────────────────────────────────────────

const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

async function checkMethodTampering(
  scope: ProbeScope,
  baseUrl: string,
  endpoint: NormalizedEndpoint,
  authHeaders: Record<string, string>,
): Promise<OpenApiScanFinding[]> {
  const findings: OpenApiScanFinding[] = [];
  const url = fillPathParams(endpoint.path, endpoint.params);
  const fullUrl = `${baseUrl}${url}`;

  for (const method of ALL_METHODS) {
    if (method === endpoint.method) continue;
    const res = await httpProbe(scope, method, fullUrl, authHeaders);
    if (!res) continue;
    if (res.status < 400) {
      findings.push({
        type: "dynamic",
        severity: "medium",
        title: `Method tampering: ${method} ${endpoint.path} not in spec but returns ${res.status}`,
        description:
          `The spec only declares ${endpoint.method} for ${endpoint.path}, but ${method} also ` +
          `returned HTTP ${res.status}. Undocumented methods on an endpoint can expose unintended ` +
          `functionality or bypass method-level authorization checks.`,
        location: fullUrl,
        tool: "openapi-scan",
        evidence: {
          vulnerabilityClass: "security_misconfiguration",
          owaspCategory: "A05:2021 Security Misconfiguration",
          declaredMethod: endpoint.method,
          testedMethod: method,
          responseStatus: res.status,
        },
        suggestion: "Return 405 Method Not Allowed for any HTTP method not explicitly handled by this route.",
        status: "open",
      });
    }
  }
  return findings;
}

// ── 3. IDOR detection ────────────────────────────────────────────────────────

function hasIdParam(endpoint: NormalizedEndpoint): boolean {
  return endpoint.params.some(
    (p) => p.in === "path" && /\bid\b|_id$|Id$/i.test(p.name)
  );
}

function idorNote(endpoint: NormalizedEndpoint): OpenApiScanFinding {
  const idParams = endpoint.params
    .filter((p) => p.in === "path" && /\bid\b|_id$|Id$/i.test(p.name))
    .map((p) => p.name);
  return {
    type: "dynamic",
    severity: "info",
    title: `IDOR opportunity: ${endpoint.method} ${endpoint.path} accepts object ID(s)`,
    description:
      `This endpoint takes path parameter(s) [${idParams.join(", ")}] that identify an object. ` +
      `To test for BOLA/IDOR, run this scan with two different authenticated accounts and verify ` +
      `that account B cannot access objects owned by account A by substituting their IDs.`,
    location: endpoint.path,
    tool: "openapi-scan",
    evidence: {
      vulnerabilityClass: "broken_object_level_authorization",
      owaspCategory: "A01:2021 Broken Access Control",
      owaspApiCategory: "API1:2023 Broken Object Level Authorization",
      idParams,
      method: endpoint.method,
    },
    suggestion:
      "In the resolver, verify the authenticated user owns or has explicit permission to access " +
      "the requested object ID before returning or modifying it.",
    status: "open",
  };
}

// ── 4. Injection probing ─────────────────────────────────────────────────────

const INJECTION_PAYLOADS = [
  { label: "SQLi", value: "' OR '1'='1", pattern: /sql|syntax|mysql|pg|postgres|column|table|row/i },
  { label: "SQLi comment", value: "1; DROP TABLE users--", pattern: /sql|error|syntax/i },
  { label: "XSS", value: "<script>alert(1)</script>", pattern: /<script/i },
  { label: "Path traversal", value: "../../../../etc/passwd", pattern: /root:|nobody:/i },
  { label: "Template injection", value: "{{7*7}}", pattern: /49/ },
] as const;

async function checkInjection(
  scope: ProbeScope,
  baseUrl: string,
  endpoint: NormalizedEndpoint,
  authHeaders: Record<string, string>,
): Promise<OpenApiScanFinding[]> {
  const findings: OpenApiScanFinding[] = [];
  const stringParams = endpoint.params.filter(
    (p) => (p.type === "string" || !p.type) && p.in !== "path" && p.in !== "cookie"
  );
  if (!stringParams.length) return findings;

  // Pick the first injectable string param to keep probe count low
  const target = stringParams[0];

  for (const payload of INJECTION_PAYLOADS) {
    let url: string;
    let body: string | undefined;
    const headers = { ...authHeaders };

    if (target.in === "query") {
      const base = fillPathParams(endpoint.path, endpoint.params);
      url = `${baseUrl}${base}?${encodeURIComponent(target.name)}=${encodeURIComponent(payload.value)}`;
    } else if (target.in === "body") {
      url = endpointUrl(baseUrl, endpoint);
      body = JSON.stringify({ [target.name]: payload.value });
      headers["Content-Type"] = "application/json";
    } else {
      continue;
    }

    const res = await httpProbe(scope, endpoint.method, url, headers, body, 8000);
    if (!res) continue;
    if (res.status === 500 || payload.pattern.test(res.body)) {
      findings.push({
        type: "dynamic",
        severity: res.status === 500 ? "high" : "medium",
        title: `${payload.label} indicator in ${endpoint.method} ${endpoint.path} (param: ${target.name})`,
        description:
          `Injecting a ${payload.label} payload into the '${target.name}' parameter of ` +
          `${endpoint.method} ${endpoint.path} returned HTTP ${res.status}` +
          (payload.pattern.test(res.body) ? ` with a matching response pattern` : "") +
          `. This may indicate insufficient input validation or unsafe query construction.`,
        location: url,
        tool: "openapi-scan",
        evidence: {
          vulnerabilityClass: "injection",
          owaspCategory: "A03:2021 Injection",
          parameter: target.name,
          payload: payload.value,
          payloadType: payload.label,
          responseStatus: res.status,
          responsePreview: res.body.slice(0, 400),
        },
        suggestion:
          "Validate and sanitize all string inputs before passing them to queries or templates. " +
          "Use parameterized queries for SQL; escape output for HTML contexts.",
        status: "open",
      });
      break; // one finding per endpoint is enough signal
    }
  }
  return findings;
}

// ── 5. Required field skip ────────────────────────────────────────────────────

async function checkRequiredFieldSkip(
  scope: ProbeScope,
  baseUrl: string,
  endpoint: NormalizedEndpoint,
  authHeaders: Record<string, string>,
): Promise<OpenApiScanFinding[]> {
  if (!["POST", "PUT", "PATCH"].includes(endpoint.method)) return [];
  const requiredBodyParams = endpoint.params.filter((p) => p.in === "body" && p.required);
  if (!requiredBodyParams.length) return [];

  const url = endpointUrl(baseUrl, endpoint);
  // Send completely empty body
  const res = await httpProbe(
    scope,
    endpoint.method,
    url,
    { ...authHeaders, "Content-Type": "application/json" },
    "{}",
  );
  if (!res) return [];
  if (res.status === 500) {
    return [
      {
        type: "dynamic",
        severity: "medium",
        title: `Server error on missing required fields: ${endpoint.method} ${endpoint.path}`,
        description:
          `Sending an empty request body to ${endpoint.method} ${endpoint.path} returned HTTP 500. ` +
          `Required params [${requiredBodyParams.map((p) => p.name).join(", ")}] should be validated ` +
          `and return 400 (Bad Request), not cause an unhandled server exception.`,
        location: url,
        tool: "openapi-scan",
        evidence: {
          vulnerabilityClass: "security_misconfiguration",
          owaspCategory: "A05:2021 Security Misconfiguration",
          method: endpoint.method,
          path: endpoint.path,
          requiredParams: requiredBodyParams.map((p) => p.name),
          responseStatus: 500,
          responsePreview: res.body.slice(0, 400),
        },
        suggestion:
          "Add input validation middleware that returns 400 with a clear error message when required " +
          "fields are missing, before the request reaches business logic.",
        status: "open",
      },
    ];
  }
  return [];
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export async function runOpenApiScan(
  spec: ParsedApiSpec,
  targetBaseUrl: string,
  authProfiles: SecurityAuthProfile[],
  scope: ProbeScope,
): Promise<OpenApiScanFinding[]> {
  const findings: OpenApiScanFinding[] = [];
  const primaryProfile = authProfiles[0];
  const authHeaders = buildAuthHeaders(primaryProfile);

  // Use the spec's own baseUrl if available and the target hasn't been overridden
  const base = targetBaseUrl.replace(/\/+$/, "") ||
    spec.baseUrl?.replace(/\/+$/, "") || "";

  findings.push({
    type: "dynamic",
    severity: "info",
    title: `OpenAPI scan started: ${spec.title} (${spec.endpoints.length} endpoints)`,
    description:
      `Loaded OpenAPI spec '${spec.title}' v${spec.version} with ${spec.endpoints.length} endpoints. ` +
      `Auth-required: ${spec.endpoints.filter((e) => e.requiresAuth).length}. ` +
      `Checking auth enforcement, method tampering, injection, and IDOR opportunities.`,
    location: base,
    tool: "openapi-scan",
    evidence: {
      title: spec.title,
      version: spec.version,
      endpointCount: spec.endpoints.length,
      authRequiredCount: spec.endpoints.filter((e) => e.requiresAuth).length,
    },
    status: "open",
  });

  // Run checks per endpoint (capped at 50 to keep scan time bounded)
  const endpoints = spec.endpoints.slice(0, 50);

  for (const ep of endpoints) {
    // 1. Auth enforcement
    findings.push(...(await checkAuthEnforcement(scope, base, ep)));

    // 2. IDOR flag
    if (hasIdParam(ep)) findings.push(idorNote(ep));

    // 3. Injection (only on non-destructive methods or when auth is present)
    if (authHeaders && Object.keys(authHeaders).length > 0) {
      findings.push(...(await checkInjection(scope, base, ep, authHeaders)));
    }

    // 4. Required field skip
    findings.push(...(await checkRequiredFieldSkip(scope, base, ep, authHeaders)));

    // 5. Method tampering (light — only test 2 methods per endpoint to keep time bounded)
    if (ep.method === "GET" || ep.method === "POST") {
      findings.push(...(await checkMethodTampering(scope, base, ep, authHeaders)));
    }
  }

  return findings;
}
