import type { SecurityHttpExchange } from "./http-exchange.js";
import { applyResourceIdMutation, detectResourceIdCandidates } from "./http-exchange.js";
import { probeScoped, type ProbeResult, type ProbeScope } from "./http-client.js";
import { computeDifferential, type ExchangeDiff } from "./differential.js";

export type LiveSecuritySeverity = "info" | "low" | "medium" | "high" | "critical";
export type LiveSecurityCheckStatus = "passed" | "failed" | "skipped" | "info";

export type LiveSecurityCheck = {
  id: string;
  title: string;
  status: LiveSecurityCheckStatus;
  severity: LiveSecuritySeverity;
  vulnerabilityClass: string;
  owaspCategory: string;
  owaspApiCategory?: string;
  description: string;
  evidence?: Record<string, unknown>;
};

export type LiveSecurityProbe = {
  label: string;
  result: ProbeResult;
  diff?: ExchangeDiff;
};

export type LiveSecurityTestResult = {
  exchangeId: string;
  targetUrl: string;
  checks: LiveSecurityCheck[];
  probes: LiveSecurityProbe[];
  idsFound: number;
  derivedUrls: string[];
};

type IdHint = { path: string; value: string };
type RouteKind = "auth" | "current-user" | "collection" | "detail" | "api";
type RouteContext = {
  method: string;
  pathname: string;
  routeKind: RouteKind;
  baselineStatus?: number;
  idsFound: number;
  urlIds: number;
  jsonKeys: number;
  authHeaders: number;
  contentType: string;
};

const AUTH_HEADER_RE =
  /^(authorization|cookie|proxy-authorization|x-api-key|api-key|x-auth-token|x-session|x-session-id|x-csrf-token|x-xsrf-token)$/i;
const SENSITIVE_FIELD_RE =
  /(^|[_-])(password|passwd|pwd|secret|token|jwt|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?id)([_-]|$)/i;
const ERROR_DISCLOSURE_RE =
  /(stack trace|traceback|at\s+\S+\s+\(|sql syntax|prisma|sequelize|mongoose|postgres|mysql|sqlite|mongodb|exception|fatal error)/i;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUID_SHAPE = /^c[a-z0-9]{24,}$/i;
const NUMERIC_ID_SHAPE = /^\d{2,}$/;

function statusIn(status: number | undefined, min: number, max: number) {
  return status !== undefined && status >= min && status <= max;
}

function isSuccess(status: number | undefined) {
  return statusIn(status, 200, 299);
}

function isAuthDeny(status: number | undefined) {
  return status === 401 || status === 403 || status === 407;
}

function headerValue(headers: Record<string, string> | undefined, name: string) {
  if (!headers) return "";
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : "";
}

function isJsonContentType(value: string) {
  return /\bapplication\/(?:json|[\w.+-]+\+json)\b/i.test(value);
}

function isApiLikeUrl(url: string) {
  try {
    return /\/(api|graphql|rest|rpc|v\d+)\b/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isStaticAssetUrl(url: string) {
  try {
    return /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function isJsonExchange(exchange: SecurityHttpExchange) {
  return isJsonContentType(headerValue(exchange.response?.headers, "content-type")) || looksJson(exchange.response?.body ?? "");
}

export function isLiveSecurityTestCandidate(exchange: SecurityHttpExchange) {
  return (
    Boolean(exchange.response) &&
    !isStaticAssetUrl(exchange.request.url) &&
    (isApiLikeUrl(exchange.request.url) || isJsonExchange(exchange))
  );
}

function requireLiveSecurityCandidate(exchange: SecurityHttpExchange) {
  if (!exchange?.id || !exchange.request || !exchange.response) {
    throw new Error("Security test requires a captured baseline with both a request and a response.");
  }
  if (!isLiveSecurityTestCandidate(exchange)) {
    throw new Error("Live security tests require a captured API/JSON baseline.");
  }
}

function stripAuthHeaders(headers: Record<string, string>) {
  const stripped: Record<string, string> = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (AUTH_HEADER_RE.test(key)) {
      removed.push(key.toLowerCase());
      continue;
    }
    stripped[key] = value;
  }
  return { headers: stripped, removed: [...new Set(removed)].sort() };
}

function looksLikeIdValue(value: string) {
  return UUID_SHAPE.test(value) || CUID_SHAPE.test(value) || NUMERIC_ID_SHAPE.test(value);
}

function parseJson(body: string | undefined): unknown | null {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function looksJson(body: string) {
  const trimmed = body.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function collectJsonKeys(value: unknown, keys = new Set<string>(), depth = 0): Set<string> {
  if (depth > 5 || !value || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) collectJsonKeys(item, keys, depth + 1);
    return keys;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    keys.add(key);
    collectJsonKeys(child, keys, depth + 1);
  }
  return keys;
}

function extractIdHints(body: string | undefined, limit = 8): IdHint[] {
  const parsed = parseJson(body);
  if (!parsed) return [];

  const hints: IdHint[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (hints.length >= limit || depth > 6) return;
    if (Array.isArray(value)) {
      value.slice(0, 10).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (hints.length >= limit) return;
      const childPath = path ? `${path}.${key}` : key;
      if ((typeof child === "string" || typeof child === "number") && /(^id$|id$|_id$|uuid|guid)$/i.test(key)) {
        const stringValue = String(child);
        if (looksLikeIdValue(stringValue)) {
          hints.push({ path: childPath, value: stringValue });
          continue;
        }
      }
      visit(child, childPath, depth + 1);
    }
  };

  visit(parsed, "", 0);
  return hints;
}

function extractSensitiveFieldPaths(body: string | undefined, limit = 8) {
  const parsed = parseJson(body);
  if (!parsed) return [];

  const paths: string[] = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (paths.length >= limit || depth > 6 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.slice(0, 10).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (SENSITIVE_FIELD_RE.test(key)) paths.push(childPath);
      visit(child, childPath, depth + 1);
    }
  };

  visit(parsed, "", 0);
  return paths;
}

function bodyLooksSameData(baselineBody: string, probeBody: string, ids: string[]) {
  if (!probeBody || probeBody.length < 10) return false;
  if (ids.some((id) => id && probeBody.includes(id))) return true;

  const baselineJson = parseJson(baselineBody);
  const probeJson = parseJson(probeBody);
  if (baselineJson && probeJson) {
    const baselineKeys = collectJsonKeys(baselineJson);
    const probeKeys = collectJsonKeys(probeJson);
    if (baselineKeys.size > 0 && probeKeys.size > 0) {
      const overlap = [...baselineKeys].filter((key) => probeKeys.has(key)).length;
      const ratio = overlap / Math.max(baselineKeys.size, probeKeys.size);
      if (ratio >= 0.6) return true;
    }
  }

  const min = Math.min(baselineBody.length, probeBody.length);
  const max = Math.max(baselineBody.length, probeBody.length);
  return max > 0 && min / max >= 0.8;
}

function deriveDetailUrls(exchange: SecurityHttpExchange, ids: string[]) {
  if (detectResourceIdCandidates(exchange.request.url).length > 0) return [];

  let parsed: URL;
  try {
    parsed = new URL(exchange.request.url);
  } catch {
    return [];
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  const segments = pathname.split("/").filter(Boolean);
  const last = segments.at(-1)?.toLowerCase() ?? "";
  if (!last || ["me", "session", "sessions", "auth", "login", "logout", "csrf"].includes(last)) return [];
  if (!last.endsWith("s") && !["children", "people"].includes(last)) return [];

  return [...new Set(ids)].slice(0, 3).map((id) => {
    const target = new URL(parsed.toString());
    target.pathname = `${pathname}/${encodeURIComponent(id)}`;
    target.search = "";
    return target.toString();
  });
}

function pathnameFromUrl(rawUrl: string) {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl;
  }
}

function buildRouteContext(exchange: SecurityHttpExchange, ids: string[], authHeaders: number, jsonKeys: number): RouteContext {
  const pathname = pathnameFromUrl(exchange.request.url);
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1]?.toLowerCase() ?? "";
  const lowerPathname = pathname.toLowerCase();
  const urlIds = detectResourceIdCandidates(exchange.request.url).length;
  let routeKind: RouteKind = "api";

  if (/\/(?:me|profile|current-user|current_user)$/.test(lowerPathname)) {
    routeKind = "current-user";
  } else if (/\/(?:auth|login|logout|session|sessions|refresh)(?:\/|$)/.test(lowerPathname)) {
    routeKind = "auth";
  } else if (urlIds > 0) {
    routeKind = "detail";
  } else if (ids.length > 0 || last.endsWith("s")) {
    routeKind = "collection";
  }

  return {
    method: exchange.request.method.toUpperCase(),
    pathname,
    routeKind,
    baselineStatus: exchange.response?.status,
    idsFound: ids.length,
    urlIds,
    jsonKeys,
    authHeaders,
    contentType: headerValue(exchange.response?.headers, "content-type"),
  };
}

function routeKindLabel(kind: RouteKind) {
  if (kind === "current-user") return "current-user/session endpoint";
  if (kind === "auth") return "authentication endpoint";
  if (kind === "collection") return "collection endpoint";
  if (kind === "detail") return "detail/resource endpoint";
  return "API endpoint";
}

function routeEvidence(context: RouteContext, extra: Record<string, unknown> = {}) {
  return {
    route: context.pathname,
    method: context.method,
    routeKind: context.routeKind,
    baselineStatus: context.baselineStatus,
    ...extra,
  };
}

function withProbeMarker(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("tm_probe", "1");
    return url.toString();
  } catch {
    return null;
  }
}

function alternateIdValues(value: string): string[] {
  if (/^\d+$/.test(value)) {
    const id = Number(value);
    if (!Number.isSafeInteger(id)) return [];
    return [id - 1, id + 1, id + 2].filter((candidate) => candidate > 0 && candidate !== id).map(String);
  }
  if (UUID_SHAPE.test(value)) {
    return ["00000000-0000-4000-8000-000000000001"].filter((candidate) => candidate.toLowerCase() !== value.toLowerCase());
  }
  if (CUID_SHAPE.test(value)) {
    return ["c000000000000000000000001"].filter((candidate) => candidate.toLowerCase() !== value.toLowerCase());
  }
  return [];
}

function defaultClassification(id: string) {
  if (id === "sensitive-json-fields") {
    return {
      vulnerabilityClass: "sensitive_data_exposure",
      owaspCategory: "A02:2021 Cryptographic Failures",
      owaspApiCategory: "API3:2023 Broken Object Property Level Authorization",
    };
  }
  if (id === "benign-query-marker") {
    return {
      vulnerabilityClass: "input_validation",
      owaspCategory: "A03:2021 Injection",
      owaspApiCategory: "API8:2023 Security Misconfiguration",
    };
  }
  if (id === "route-context" || id.includes("cors") || id.includes("head") || id === "error-disclosure" || id === "active-get-probes") {
    return {
      vulnerabilityClass: "security_misconfiguration",
      owaspCategory: "A05:2021 Security Misconfiguration",
      owaspApiCategory: "API8:2023 Security Misconfiguration",
    };
  }
  if (id === "unauthenticated-direct-access") {
    return {
      vulnerabilityClass: "broken_authentication",
      owaspCategory: "A01:2021 Broken Access Control",
      owaspApiCategory: "API2:2023 Broken Authentication",
    };
  }
  return {
    vulnerabilityClass: "broken_object_level_authorization",
    owaspCategory: "A01:2021 Broken Access Control",
    owaspApiCategory: "API1:2023 Broken Object Level Authorization",
  };
}

function passedCheck(id: string, title: string, description: string, evidence?: Record<string, unknown>): LiveSecurityCheck {
  const classification = defaultClassification(id);
  return {
    id,
    title,
    status: "passed",
    severity: "info",
    ...classification,
    description,
    evidence,
  };
}

function skippedCheck(id: string, title: string, description: string, evidence?: Record<string, unknown>): LiveSecurityCheck {
  const classification = defaultClassification(id);
  return {
    id,
    title,
    status: "skipped",
    severity: "info",
    ...classification,
    description,
    evidence,
  };
}

function infoCheck(id: string, title: string, description: string, evidence?: Record<string, unknown>): LiveSecurityCheck {
  const classification = defaultClassification(id);
  return {
    id,
    title,
    status: "info",
    severity: "info",
    ...classification,
    description,
    evidence,
  };
}

function failedCheck(
  id: string,
  title: string,
  severity: LiveSecuritySeverity,
  vulnerabilityClass: string,
  owaspCategory: string,
  owaspApiCategory: string,
  description: string,
  evidence?: Record<string, unknown>
): LiveSecurityCheck {
  return {
    id,
    title,
    status: "failed",
    severity,
    vulnerabilityClass,
    owaspCategory,
    owaspApiCategory,
    description,
    evidence,
  };
}

export async function runLiveSecurityTests(
  exchange: SecurityHttpExchange,
  scope: ProbeScope
): Promise<LiveSecurityTestResult> {
  requireLiveSecurityCandidate(exchange);

  const checks: LiveSecurityCheck[] = [];
  const probes: LiveSecurityProbe[] = [];
  const method = exchange.request.method.toUpperCase();
  const activeProbeAllowed = method === "GET";
  const baselineBody = exchange.response?.body ?? "";
  const baselineJson = parseJson(baselineBody);
  const jsonKeys = baselineJson ? collectJsonKeys(baselineJson).size : 0;
  const ids = [...new Set(extractIdHints(baselineBody, 10).map((hint) => hint.value))];
  const authStripped = stripAuthHeaders(exchange.request.headers);
  const context = buildRouteContext(exchange, ids, authStripped.removed.length, jsonKeys);
  const baselineSucceeded = isSuccess(exchange.response?.status);

  checks.push(
    infoCheck(
      "route-context",
      `${method} ${context.pathname}: ${routeKindLabel(context.routeKind)}`,
      `Baseline ${context.baselineStatus ?? "unknown"} captured with ${context.jsonKeys} JSON key${
        context.jsonKeys === 1 ? "" : "s"
      }, ${context.idsFound} response ID${context.idsFound === 1 ? "" : "s"}, and ${context.authHeaders} auth/session header${
        context.authHeaders === 1 ? "" : "s"
      }.`,
      {
        route: context.pathname,
        method,
        routeKind: context.routeKind,
        baselineStatus: context.baselineStatus,
        idsFound: context.idsFound,
        urlIds: context.urlIds,
        jsonKeys: context.jsonKeys,
        authHeaderCount: context.authHeaders,
        contentType: context.contentType || null,
      }
    )
  );

  if (!activeProbeAllowed) {
    checks.push(
      skippedCheck(
        "active-get-probes",
        `${method} ${context.pathname}: same-route GET probes were not sent`,
        "Passive checks and the safe CORS preflight still ran. Same-route replay probes require captured GET baselines.",
        routeEvidence(context)
      )
    );
  }

  const sensitiveFields = extractSensitiveFieldPaths(baselineBody);
  if (sensitiveFields.length > 0) {
    checks.push(
      failedCheck(
        "sensitive-json-fields",
        `Sensitive fields are present in ${context.pathname}`,
        "high",
        "sensitive_data_exposure",
        "A02:2021 Cryptographic Failures",
        "API3:2023 Broken Object Property Level Authorization",
        "The captured JSON response includes fields whose names look like secrets, tokens, sessions, or passwords.",
        routeEvidence(context, { fields: sensitiveFields, jsonKeys: context.jsonKeys })
      )
    );
  } else {
    checks.push(
      passedCheck(
        "sensitive-json-fields",
        `No obvious secret fields in ${context.pathname}`,
        `Checked ${context.jsonKeys} JSON key${context.jsonKeys === 1 ? "" : "s"} for password, token, secret, and API-key style names.`,
        routeEvidence(context, { jsonKeys: context.jsonKeys })
      )
    );
  }

  if (ERROR_DISCLOSURE_RE.test(baselineBody)) {
    checks.push(
      failedCheck(
        "error-disclosure",
        `${context.pathname} appears to disclose internal error details`,
        "medium",
        "security_misconfiguration",
        "A05:2021 Security Misconfiguration",
        "API8:2023 Security Misconfiguration",
        "The response body contains text that looks like a stack trace, database error, framework exception, or internal failure.",
        routeEvidence(context)
      )
    );
  } else {
    checks.push(
      passedCheck(
        "error-disclosure",
        `No obvious error disclosure from ${context.pathname}`,
        `Baseline HTTP ${context.baselineStatus ?? "unknown"} did not include obvious stack traces or framework/database error strings.`,
        routeEvidence(context)
      )
    );
  }

  const acao = headerValue(exchange.response?.headers, "access-control-allow-origin");
  const acac = headerValue(exchange.response?.headers, "access-control-allow-credentials");
  if (acao === "*" && /true/i.test(acac)) {
    checks.push(
      failedCheck(
        "cors-wildcard-credentials",
        `${context.pathname} allows wildcard credentialed CORS`,
        "high",
        "security_misconfiguration",
        "A05:2021 Security Misconfiguration",
        "API8:2023 Security Misconfiguration",
        "The response advertises Access-Control-Allow-Origin: * together with credentialed CORS.",
        routeEvidence(context, { accessControlAllowOrigin: acao, accessControlAllowCredentials: acac })
      )
    );
  } else {
    checks.push(
      passedCheck(
        "cors-wildcard-credentials",
        `Captured CORS headers on ${context.pathname} are not wildcard credentialed`,
        "The captured response did not advertise Access-Control-Allow-Origin: * together with credential support.",
        routeEvidence(context, { accessControlAllowOrigin: acao || null, accessControlAllowCredentials: acac || null })
      )
    );
  }

  const corsProbe = await probeScoped(scope, exchange.request.url, {
    method: "OPTIONS",
    headers: {
      Origin: "https://attacker.invalid",
      "Access-Control-Request-Method": method === "OPTIONS" ? "GET" : method,
      "Access-Control-Request-Headers": "authorization,content-type",
    },
    timeoutMs: 5_000,
  });
  probes.push({ label: "cross-origin preflight probe", result: corsProbe });
  const probedAcao = headerValue(corsProbe.headers, "access-control-allow-origin");
  const probedAcac = headerValue(corsProbe.headers, "access-control-allow-credentials");
  if ((probedAcao === "*" || probedAcao === "https://attacker.invalid") && /true/i.test(probedAcac)) {
    checks.push(
      failedCheck(
        "active-cors-origin-probe",
        `Preflight probe for ${context.pathname} allowed credentialed access`,
        "high",
        "security_misconfiguration",
        "A05:2021 Security Misconfiguration",
        "API8:2023 Security Misconfiguration",
        "A synthetic cross-origin preflight was accepted with credential support.",
        routeEvidence(context, { status: corsProbe.status, accessControlAllowOrigin: probedAcao, accessControlAllowCredentials: probedAcac })
      )
    );
  } else if (probedAcao === "https://attacker.invalid") {
    checks.push(
      failedCheck(
        "active-cors-origin-probe",
        `Preflight probe for ${context.pathname} reflected an untrusted origin`,
        "medium",
        "security_misconfiguration",
        "A05:2021 Security Misconfiguration",
        "API8:2023 Security Misconfiguration",
        "A synthetic cross-origin preflight reflected the supplied untrusted Origin header.",
        routeEvidence(context, { status: corsProbe.status, accessControlAllowOrigin: probedAcao })
      )
    );
  } else {
    checks.push(
      passedCheck(
        "active-cors-origin-probe",
        `Preflight probe for ${context.pathname} returned ${corsProbe.status ?? "no response"}`,
        "A synthetic cross-origin OPTIONS probe did not allow credentialed access from the test origin.",
        routeEvidence(context, { status: corsProbe.status, accessControlAllowOrigin: probedAcao || null, error: corsProbe.error })
      )
    );
  }

  if (activeProbeAllowed) {
    const headProbe = await probeScoped(scope, exchange.request.url, {
      method: "HEAD",
      headers: exchange.request.headers,
      timeoutMs: 5_000,
    });
    probes.push({ label: "HEAD method probe", result: headProbe });
    if (statusIn(headProbe.status, 500, 599)) {
      checks.push(
        failedCheck(
          "head-method-probe",
          `HEAD ${context.pathname} returned ${headProbe.status}`,
          "medium",
          "security_misconfiguration",
          "A05:2021 Security Misconfiguration",
          "API8:2023 Security Misconfiguration",
          "A safe HEAD request to the captured GET URL caused an HTTP 5xx response.",
          routeEvidence(context, { status: headProbe.status, error: headProbe.error })
        )
      );
    } else {
      checks.push(
        infoCheck(
          "head-method-probe",
          `HEAD ${context.pathname} returned ${headProbe.status ?? "no response"}`,
          "Compared method handling by sending a safe HEAD request to the captured GET endpoint.",
          routeEvidence(context, { status: headProbe.status, error: headProbe.error })
        )
      );
    }

    const markerUrl = withProbeMarker(exchange.request.url);
    if (markerUrl && markerUrl !== exchange.request.url) {
      const markerProbe = await probeScoped(scope, markerUrl, {
        method: "GET",
        headers: exchange.request.headers,
        timeoutMs: 5_000,
      });
      probes.push({ label: "benign query marker probe", result: markerProbe, diff: computeDifferential(exchange, markerProbe) });
      if (statusIn(markerProbe.status, 500, 599) || ERROR_DISCLOSURE_RE.test(markerProbe.body)) {
        checks.push(
          failedCheck(
            "benign-query-marker",
            `Benign query marker on ${context.pathname} returned ${markerProbe.status ?? "no response"}`,
            "medium",
            "input_validation",
            "A03:2021 Injection",
            "API8:2023 Security Misconfiguration",
            "Adding a harmless query parameter caused a server error or error disclosure.",
            routeEvidence(context, { status: markerProbe.status, error: markerProbe.error })
          )
        );
      } else {
        checks.push(
          passedCheck(
            "benign-query-marker",
            `Benign query marker on ${context.pathname} returned ${markerProbe.status ?? "no response"}`,
            "Adding tm_probe=1 did not produce a server error or error disclosure.",
            routeEvidence(context, { status: markerProbe.status, error: markerProbe.error })
          )
        );
      }
    }

    const idCandidates = detectResourceIdCandidates(exchange.request.url).slice(0, 2);
    const idProbeFindings: Array<{ url: string; status?: number; candidate: string; value: string }> = [];
    for (const candidate of idCandidates) {
      for (const alternateValue of alternateIdValues(candidate.value).slice(0, 2)) {
        const probeUrl = applyResourceIdMutation(exchange.request.url, candidate, alternateValue);
        const idProbe = await probeScoped(scope, probeUrl, {
          method: "GET",
          headers: exchange.request.headers,
          timeoutMs: 5_000,
        });
        probes.push({ label: "alternate ID probe", result: idProbe, diff: computeDifferential(exchange, idProbe) });
        if (isSuccess(idProbe.status) && idProbe.body.length > 10) {
          idProbeFindings.push({
            url: probeUrl,
            status: idProbe.status,
            candidate: candidate.paramName,
            value: alternateValue,
          });
        }
      }
    }
    if (idProbeFindings.length > 0) {
      checks.push(
        failedCheck(
          "alternate-id-probe",
          `Alternate ID probes for ${context.pathname} returned data`,
          "high",
          "broken_object_level_authorization",
          "A01:2021 Broken Access Control",
          "API1:2023 Broken Object Level Authorization",
          "Changing an ID in the captured GET URL returned a successful response with a body.",
          routeEvidence(context, { probes: idProbeFindings, probeCount: idProbeFindings.length })
        )
      );
    } else if (idCandidates.length > 0) {
      checks.push(
        passedCheck(
          "alternate-id-probe",
          `Alternate ID probes for ${context.pathname} did not return data`,
          "Changing detected URL IDs did not return successful data responses.",
          routeEvidence(context, { candidates: idCandidates.map((candidate) => candidate.paramName) })
        )
      );
    }
  }

  if (!activeProbeAllowed) {
    checks.push(
      skippedCheck(
        "unauthenticated-direct-access",
        `${method} ${context.pathname}: unauthenticated replay not sent`,
        "Auth-removal replay is limited to captured GET baselines; this API response still received passive checks and active CORS preflight.",
        routeEvidence(context, { removedHeaders: authStripped.removed })
      )
    );
  } else if (isAuthDeny(exchange.response?.status)) {
    checks.push(
      passedCheck(
        "unauthenticated-direct-access",
        `GET ${context.pathname} returned ${context.baselineStatus}`,
        "The captured GET baseline returned an authentication/authorization denial, so it did not expose data on this request.",
        routeEvidence(context, { removedHeaders: authStripped.removed })
      )
    );
  } else if (baselineSucceeded && authStripped.removed.length > 0) {
    const unauth = await probeScoped(scope, exchange.request.url, {
      method: "GET",
      headers: authStripped.headers,
    });
    probes.push({ label: "unauthenticated replay", result: unauth, diff: computeDifferential(exchange, unauth) });

    if (isAuthDeny(unauth.status)) {
      checks.push(
        passedCheck(
          "unauthenticated-direct-access",
          `Unauthenticated ${context.pathname} returned ${unauth.status}`,
          "Removing captured auth/session headers caused the endpoint to deny access.",
          routeEvidence(context, { removedHeaders: authStripped.removed, unauthStatus: unauth.status })
        )
      );
    } else if (isSuccess(unauth.status)) {
      const sameData = bodyLooksSameData(baselineBody, unauth.body, ids);
      checks.push(
        failedCheck(
          "unauthenticated-direct-access",
          sameData
            ? `Unauthenticated ${context.pathname} returned protected-looking data`
            : `Unauthenticated ${context.pathname} returned HTTP ${unauth.status}`,
          sameData ? "high" : "medium",
          "broken_authentication",
          "A01:2021 Broken Access Control",
          "API2:2023 Broken Authentication",
          "The endpoint returned a successful response after auth/session headers were removed from the captured request.",
          routeEvidence(context, {
            removedHeaders: authStripped.removed,
            baselineStatus: exchange.response?.status,
            unauthStatus: unauth.status,
            sameData,
          })
        )
      );
    } else {
      checks.push(
        passedCheck(
          "unauthenticated-direct-access",
          `Unauthenticated ${context.pathname} returned ${unauth.status ?? "no response"}`,
          "Removing captured auth/session headers did not return a successful response.",
          routeEvidence(context, { removedHeaders: authStripped.removed, unauthStatus: unauth.status, error: unauth.error })
        )
      );
    }
  } else {
    checks.push(
      skippedCheck(
        "unauthenticated-direct-access",
        `Unauthenticated replay skipped for ${context.pathname}`,
        authStripped.removed.length === 0
          ? "No auth/session headers were captured for this baseline."
          : "The captured baseline did not return a successful response.",
        routeEvidence(context, { removedHeaders: authStripped.removed })
      )
    );
  }

  const derivedUrls = deriveDetailUrls(exchange, ids);
  if (derivedUrls.length === 0 && ids.length > 0) {
    checks.push(
      skippedCheck(
        "derived-detail-auth",
        `No safe detail URL was derived from ${context.pathname}`,
        "IDs were found in the response body, but no safe collection-to-detail URL could be derived from this route.",
        routeEvidence(context, { idsFound: ids.length })
      )
    );
  }

  for (const url of derivedUrls) {
    const authDetail = await probeScoped(scope, url, {
      method: "GET",
      headers: exchange.request.headers,
    });
    probes.push({ label: "authenticated detail probe", result: authDetail });

    if (!isSuccess(authDetail.status)) {
      checks.push(
        skippedCheck(
          `derived-detail-auth:${url}`,
          `Derived detail ${pathnameFromUrl(url)} returned ${authDetail.status ?? "no response"}`,
          "The server did not return a successful response for the derived detail URL using the captured headers.",
          routeEvidence(context, { url, authStatus: authDetail.status, error: authDetail.error })
        )
      );
      continue;
    }

    if (authStripped.removed.length === 0) {
      checks.push(
        skippedCheck(
          `derived-detail-auth:${url}`,
          `Derived detail ${pathnameFromUrl(url)} was reachable, unauthenticated check skipped`,
          "The detail URL was reachable, but no auth/session headers were available to remove.",
          routeEvidence(context, { url, authStatus: authDetail.status })
        )
      );
      continue;
    }

    const unauthDetail = await probeScoped(scope, url, {
      method: "GET",
      headers: authStripped.headers,
    });
    probes.push({ label: "unauthenticated detail probe", result: unauthDetail });

    if (isAuthDeny(unauthDetail.status)) {
      checks.push(
        passedCheck(
          `derived-detail-auth:${url}`,
          `Unauthenticated detail ${pathnameFromUrl(url)} returned ${unauthDetail.status}`,
          "A detail URL built from an ID in the list response denied access after auth/session headers were removed.",
          routeEvidence(context, { url, authStatus: authDetail.status, unauthStatus: unauthDetail.status })
        )
      );
    } else if (isSuccess(unauthDetail.status)) {
      checks.push(
        failedCheck(
          `derived-detail-auth:${url}`,
          `Unauthenticated detail ${pathnameFromUrl(url)} returned ${unauthDetail.status}`,
          bodyLooksSameData(authDetail.body, unauthDetail.body, ids) ? "high" : "medium",
          "broken_access_control",
          "A01:2021 Broken Access Control",
          "API1:2023 Broken Object Level Authorization",
          "A detail URL built from an ID in a captured response returned HTTP 2xx without auth/session headers.",
          routeEvidence(context, { url, authStatus: authDetail.status, unauthStatus: unauthDetail.status })
        )
      );
    } else {
      checks.push(
        passedCheck(
          `derived-detail-auth:${url}`,
          `Unauthenticated detail ${pathnameFromUrl(url)} returned ${unauthDetail.status ?? "no response"}`,
          "The derived detail route did not return HTTP 2xx after auth/session headers were removed.",
          routeEvidence(context, { url, authStatus: authDetail.status, unauthStatus: unauthDetail.status, error: unauthDetail.error })
        )
      );
    }
  }

  return {
    exchangeId: exchange.id,
    targetUrl: exchange.request.url,
    checks,
    probes,
    idsFound: ids.length,
    derivedUrls,
  };
}
