import type { SecurityHttpExchange } from "./http-exchange.js";
import { applyResourceIdMutation, detectResourceIdCandidates } from "./http-exchange.js";
import { probeScoped, type ProbeResult, type ProbeScope } from "./http-client.js";
import { computeDifferential, type ExchangeDiff } from "./differential.js";
import { buildValidation, type SecurityValidation } from "./validation.js";

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
  validation?: SecurityValidation;
};

export type LiveSecurityProbe = {
  label: string;
  result: ProbeResult;
  diff?: ExchangeDiff;
};

export type BrowserCorsReadResult = ProbeResult & {
  browserReadable: boolean;
  browserBlocked: boolean;
  browserSkipped?: boolean;
  browserOrigin: string;
};

export type LiveSecurityTestOptions = {
  browserCorsRead?: (url: string, timeoutMs: number) => Promise<BrowserCorsReadResult>;
  browserCorsReadAttempts?: number;
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
const TEST_ORIGIN = "https://attacker.invalid";
const VALIDATION_REPEAT_COUNT = 2;
const REFLECTION_PROBE_PARAM = "tm_xss_probe";
const INJECTION_PROBE_PARAM = "tm_injection_probe";

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

function hasRequestHeader(headers: Record<string, string>, name: string) {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
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

function withProbeParam(rawUrl: string, name: string, value: string): string | null {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set(name, value);
    return url.toString();
  } catch {
    return null;
  }
}

function withProbeMarker(rawUrl: string): string | null {
  return withProbeParam(rawUrl, "tm_probe", "1");
}

function reflectionProbe(rawUrl: string, exchangeId: string) {
  const token = `tmxss-${exchangeId.replace(/[^a-z0-9]/gi, "").slice(0, 16) || "probe"}`;
  const value = `<testmind-xss-probe data-token="${token}">`;
  return { token, value, url: withProbeParam(rawUrl, REFLECTION_PROBE_PARAM, value) };
}

function injectionProbeUrl(rawUrl: string) {
  return withProbeParam(rawUrl, INJECTION_PROBE_PARAM, "'\"\\");
}

function isHtmlLikeContentType(contentType: string) {
  return /\b(text\/html|application\/xhtml\+xml|image\/svg\+xml)\b/i.test(contentType);
}

function reflectedRawMarkup(body: string, token: string) {
  return body.includes("<testmind-xss-probe") && body.includes(token);
}

function reflectedProbeToken(body: string, token: string) {
  return body.includes(token);
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
  if (id.includes("xss") || id.includes("reflection")) {
    return {
      vulnerabilityClass: "xss",
      owaspCategory: "A03:2021 Injection",
      owaspApiCategory: "API8:2023 Security Misconfiguration",
    };
  }
  if (id.includes("injection")) {
    return {
      vulnerabilityClass: "injection",
      owaspCategory: "A03:2021 Injection",
      owaspApiCategory: "API8:2023 Security Misconfiguration",
    };
  }
  if (id === "benign-query-marker") {
    return {
      vulnerabilityClass: "input_validation",
      owaspCategory: "A03:2021 Injection",
      owaspApiCategory: "API8:2023 Security Misconfiguration",
    };
  }
  if (id.includes("method") || id.includes("head")) {
    return {
      vulnerabilityClass: "method_tampering",
      owaspCategory: "A05:2021 Security Misconfiguration",
      owaspApiCategory: "API8:2023 Security Misconfiguration",
    };
  }
  if (id === "route-context" || id.includes("cors") || id === "error-disclosure" || id === "active-get-probes") {
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
  if (id.includes("idor") || id === "alternate-id-probe" || id.startsWith("derived-detail-auth")) {
    return {
      vulnerabilityClass: "broken_object_level_authorization",
      owaspCategory: "A01:2021 Broken Access Control",
      owaspApiCategory: "API1:2023 Broken Object Level Authorization",
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
  evidence?: Record<string, unknown>,
  validation?: SecurityValidation
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
    validation,
  };
}

function validationAwareCorsCheck(
  id: string,
  title: string,
  potentialSeverity: LiveSecuritySeverity,
  description: string,
  evidence: Record<string, unknown>,
  validation: SecurityValidation
): LiveSecurityCheck {
  const confirmed = validation.status === "confirmed";
  const severity =
    validation.status === "confirmed"
      ? potentialSeverity
      : validation.status === "likely"
        ? "medium"
        : validation.status === "suspected"
          ? "low"
          : "info";

  return {
    id,
    title,
    status: confirmed ? "failed" : "info",
    severity,
    vulnerabilityClass: "security_misconfiguration",
    owaspCategory: "A05:2021 Security Misconfiguration",
    owaspApiCategory: "API8:2023 Security Misconfiguration",
    description,
    evidence: { ...evidence, potentialSeverity },
    validation,
  };
}

function isBrowserCorsReadResult(result: ProbeResult): result is BrowserCorsReadResult {
  return typeof (result as BrowserCorsReadResult).browserReadable === "boolean";
}

function successfulProtocolCorsReadAttempts(attempts: ProbeResult[], baselineBody: string, ids: string[]) {
  return attempts.filter((attempt) => {
    if (isBrowserCorsReadResult(attempt)) return false;
    const acao = headerValue(attempt.headers, "access-control-allow-origin");
    const acac = headerValue(attempt.headers, "access-control-allow-credentials");
    return isSuccess(attempt.status) && acao === TEST_ORIGIN && /true/i.test(acac) && bodyLooksSameData(baselineBody, attempt.body, ids);
  }).length;
}

function successfulBrowserCorsReadAttempts(attempts: ProbeResult[], baselineBody: string, ids: string[]) {
  return attempts.filter(
    (attempt) => isBrowserCorsReadResult(attempt) && attempt.browserReadable && isSuccess(attempt.status) && bodyLooksSameData(baselineBody, attempt.body, ids)
  ).length;
}

function buildCorsValidation(
  context: RouteContext,
  corsProbe: ProbeResult,
  actualReadAttempts: ProbeResult[],
  baselineBody: string,
  ids: string[],
  hasCookieSession: boolean,
  capturedCors?: { acao: string; acac: string }
): SecurityValidation {
  const probedAcao = headerValue(corsProbe.headers, "access-control-allow-origin");
  const probedAcac = headerValue(corsProbe.headers, "access-control-allow-credentials");
  const preflightSucceeded = isSuccess(corsProbe.status);
  const originAllowed = probedAcao === TEST_ORIGIN || probedAcao === "*";
  const browserCompatibleOrigin = probedAcao === TEST_ORIGIN;
  const credentialsAllowed = /true/i.test(probedAcac);
  const capturedWildcardCredentialed = capturedCors?.acao === "*" && /true/i.test(capturedCors.acac);
  const probedWildcardCredentialed = probedAcao === "*" && credentialsAllowed;
  const browserAttempts = actualReadAttempts.filter(isBrowserCorsReadResult);
  const browserAttempted = browserAttempts.length > 0;
  const browserProofCompleted = browserAttempts.some((attempt) => attempt.browserReadable || attempt.browserBlocked);
  const protocolReadSuccesses = successfulProtocolCorsReadAttempts(actualReadAttempts, baselineBody, ids);
  const browserReadSuccesses = successfulBrowserCorsReadAttempts(actualReadAttempts, baselineBody, ids);
  const readSuccesses = protocolReadSuccesses + browserReadSuccesses;
  const repeatedProtocolRead = protocolReadSuccesses >= VALIDATION_REPEAT_COUNT;
  const browserConfirmationsRequired = Math.max(1, browserAttempts.filter((attempt) => !attempt.browserSkipped).length);
  const repeatedBrowserRead = browserReadSuccesses >= browserConfirmationsRequired;
  const browserBlocked = browserProofCompleted && browserReadSuccesses === 0 && browserAttempts.some((attempt) => attempt.browserBlocked);
  const browserOrigin = (browserAttempts[0] as BrowserCorsReadResult | undefined)?.browserOrigin;

  const status =
    repeatedBrowserRead && hasCookieSession
      ? "confirmed"
      : !browserAttempted && repeatedProtocolRead && hasCookieSession
        ? "confirmed"
        : readSuccesses > 0
        ? "likely"
        : browserBlocked && (capturedWildcardCredentialed || probedWildcardCredentialed)
          ? "not_exploitable"
          : capturedWildcardCredentialed || (originAllowed && credentialsAllowed)
          ? "suspected"
          : "inconclusive";
  const confidence =
    status === "confirmed" ? 96 : status === "likely" ? 82 : status === "not_exploitable" ? 88 : status === "suspected" ? 45 : 25;

  return buildValidation({
    status,
    confidence,
    proofLevel: browserAttempted ? "browser" : repeatedProtocolRead ? "repeated" : "protocol",
    attempts: 1 + actualReadAttempts.length,
    successfulReproductions: readSuccesses,
    requirements: [
      { id: "baseline_response", label: "Captured baseline response exists", passed: true },
      {
        id: "captured_wildcard_credentials",
        label: "Captured wildcard credentialed CORS",
        passed: capturedCors ? capturedWildcardCredentialed : null,
      },
      { id: "preflight_success", label: "Preflight returned 2xx", passed: preflightSucceeded },
      { id: "untrusted_origin_allowed", label: "Untrusted origin was allowed", passed: originAllowed },
      { id: "credentials_allowed", label: "Credentialed CORS was advertised", passed: credentialsAllowed },
      { id: "browser_origin_compatible", label: "Origin is browser-compatible for credentials", passed: browserCompatibleOrigin },
      {
        id: "browser_credentialed_read",
        label: "Browser credentialed read proven",
        passed: browserAttempted ? (browserProofCompleted ? browserReadSuccesses > 0 : null) : null,
      },
      { id: "cookie_session", label: "Captured session uses cookies", passed: actualReadAttempts.length > 0 ? hasCookieSession : null },
    ],
    expectedBehavior: "An untrusted origin should not receive credentialed CORS approval for this route.",
    observedBehavior:
      browserReadSuccesses > 0
        ? `${browserReadSuccesses}/${browserAttempts.length} browser credentialed read probe${
            browserAttempts.length === 1 ? "" : "s"
          } from ${browserOrigin ?? "the test origin"} returned matching data.`
        : browserBlocked
          ? `${browserAttempts.length} browser credentialed read probe${
              browserAttempts.length === 1 ? " was" : "s were"
            } blocked or did not return matching data from ${browserOrigin ?? "the test origin"}.`
          : browserAttempted
            ? `Browser credentialed read proof was skipped or could not complete for ${browserOrigin ?? "the test origin"}.`
          : protocolReadSuccesses > 0
            ? `${protocolReadSuccesses}/${actualReadAttempts.length} protocol read probe${
                actualReadAttempts.length === 1 ? "" : "s"
              } returned matching data with readable CORS headers.`
            : `Preflight returned ${corsProbe.status ?? "no response"} with ACAO=${probedAcao || "none"} and ACAC=${
                probedAcac || "none"
              }.`,
    conclusion:
      status === "confirmed"
        ? "Repeated validation shows this cookie-backed route can expose matching data to an untrusted origin."
        : status === "likely"
          ? "The route returned matching data to a credentialed CORS probe, but browser/session proof is not complete."
          : status === "not_exploitable"
            ? "CORS headers are misconfigured, but TestMind could not demonstrate browser-readable credentialed data exposure for this captured session."
            : "The CORS response is suspicious, but TestMind did not prove browser-readable data exposure.",
  });
}

function buildPassiveFieldValidation(context: RouteContext, fields: string[]): SecurityValidation {
  return buildValidation({
    status: "confirmed",
    confidence: 90,
    proofLevel: "passive",
    attempts: 1,
    successfulReproductions: 1,
    requirements: [
      { id: "json_response", label: "Captured response is JSON", passed: context.jsonKeys > 0 },
      { id: "sensitive_key_present", label: "Sensitive key pattern present", passed: fields.length > 0 },
    ],
    expectedBehavior: "API responses should not expose fields named like secrets, tokens, sessions, or passwords unless explicitly intended.",
    observedBehavior: `${fields.length} sensitive-looking field${fields.length === 1 ? "" : "s"} found in the captured response.`,
    conclusion: "The field-name evidence is present in the captured payload; human review should decide whether the data is actually sensitive.",
  });
}

function buildErrorDisclosureValidation(context: RouteContext): SecurityValidation {
  return buildValidation({
    status: "confirmed",
    confidence: 88,
    proofLevel: "passive",
    attempts: 1,
    successfulReproductions: 1,
    requirements: [
      { id: "baseline_response", label: "Captured baseline response exists", passed: true },
      { id: "error_marker_present", label: "Internal error marker present", passed: true },
    ],
    expectedBehavior: "API responses should not expose stack traces, database errors, framework exceptions, or internal failure details.",
    observedBehavior: `${context.pathname} contained an internal error marker in the captured response body.`,
    conclusion: "The disclosure marker was observed directly in the baseline response.",
  });
}

function buildReflectionValidation(
  context: RouteContext,
  probe: ProbeResult,
  rawMarkupReflected: boolean,
  markerReflected: boolean,
  browserRelevantResponse: boolean
): SecurityValidation {
  const status = rawMarkupReflected && browserRelevantResponse ? "suspected" : markerReflected ? "inconclusive" : "not_exploitable";
  return buildValidation({
    status,
    confidence: status === "suspected" ? 62 : status === "inconclusive" ? 35 : 82,
    proofLevel: "protocol",
    attempts: 1,
    successfulReproductions: rawMarkupReflected ? 1 : 0,
    requirements: [
      { id: "baseline_success", label: "Captured baseline returned 2xx", passed: isSuccess(context.baselineStatus) },
      { id: "safe_get_probe", label: "Safe GET reflection probe was sent", passed: true },
      { id: "marker_reflected", label: "Reflection marker appeared in response", passed: markerReflected },
      { id: "raw_markup_reflected", label: "Markup was reflected without encoding", passed: rawMarkupReflected },
      { id: "browser_relevant_content_type", label: "Response is browser-rendered HTML/XML", passed: browserRelevantResponse },
    ],
    expectedBehavior: "User-controlled input should not be reflected into browser-rendered responses without output encoding.",
    observedBehavior: `Reflection probe returned ${probe.status ?? "no response"} for ${context.pathname}.`,
    conclusion:
      status === "suspected"
        ? "The inert markup marker was reflected into a browser-rendered response without encoding. Manual browser proof is needed before marking this confirmed XSS."
        : markerReflected
          ? "The marker was reflected, but TestMind did not observe browser-relevant unencoded markup."
          : "The reflection marker was not observed in the response.",
  });
}

function buildInjectionProbeValidation(context: RouteContext, probe: ProbeResult): SecurityValidation {
  const errored = statusIn(probe.status, 500, 599) || ERROR_DISCLOSURE_RE.test(probe.body);
  return buildValidation({
    status: errored ? "suspected" : "not_exploitable",
    confidence: errored ? 65 : 80,
    proofLevel: "protocol",
    attempts: 1,
    successfulReproductions: errored ? 1 : 0,
    requirements: [
      { id: "baseline_success", label: "Captured baseline returned 2xx", passed: isSuccess(context.baselineStatus) },
      { id: "safe_get_probe", label: "Safe GET parser probe was sent", passed: true },
      { id: "server_error", label: "Probe produced HTTP 5xx", passed: statusIn(probe.status, 500, 599) },
      { id: "error_disclosure", label: "Probe exposed framework/database error text", passed: ERROR_DISCLOSURE_RE.test(probe.body) },
    ],
    expectedBehavior: "Parser and query handling should reject unusual input safely without server errors or internal error disclosure.",
    observedBehavior: `Injection parser probe returned ${probe.status ?? "no response"} for ${context.pathname}.`,
    conclusion: errored
      ? "A harmless parser-stress probe caused a server error or internal error disclosure. This is an injection-adjacent signal requiring targeted validation."
      : "The parser-stress probe did not produce a server error or obvious internal error disclosure.",
  });
}

function buildUnauthenticatedAccessValidation(
  context: RouteContext,
  attempts: ProbeResult[],
  baselineBody: string,
  ids: string[],
  removedHeaders: string[]
): SecurityValidation {
  const successCount = attempts.filter((attempt) => isSuccess(attempt.status)).length;
  const matchingDataCount = attempts.filter((attempt) => isSuccess(attempt.status) && bodyLooksSameData(baselineBody, attempt.body, ids)).length;
  const repeatedMatchingData = matchingDataCount >= VALIDATION_REPEAT_COUNT;
  const status = repeatedMatchingData ? "confirmed" : successCount > 0 ? "likely" : "inconclusive";
  const confidence = status === "confirmed" ? 96 : status === "likely" ? 76 : 35;

  return buildValidation({
    status,
    confidence,
    proofLevel: repeatedMatchingData ? "repeated" : "protocol",
    attempts: attempts.length,
    successfulReproductions: matchingDataCount,
    requirements: [
      { id: "baseline_success", label: "Authenticated baseline returned 2xx", passed: isSuccess(context.baselineStatus) },
      { id: "auth_removed", label: "Auth/session headers were removed", passed: removedHeaders.length > 0 },
      { id: "unauth_success", label: "Unauthenticated request returned 2xx", passed: successCount > 0 },
      { id: "protected_data_match", label: "Unauthenticated body matched protected data", passed: matchingDataCount > 0 },
      { id: "reproduced", label: "Result reproduced", passed: repeatedMatchingData },
    ],
    expectedBehavior: "Removing auth/session headers should cause this route to deny access or return only public data.",
    observedBehavior: `${successCount}/${attempts.length} unauthenticated probe${attempts.length === 1 ? "" : "s"} returned 2xx; ${matchingDataCount} matched protected-looking data.`,
    conclusion:
      status === "confirmed"
        ? "Repeated auth-removal probes returned protected-looking data, so this finding is confirmed at protocol level."
        : "Auth removal returned a successful response, but repeated protected-data proof is not complete.",
  });
}

function buildIdorValidation(
  context: RouteContext,
  findings: Array<{ sameData: boolean }>
): SecurityValidation {
  const matchedData = findings.some((finding) => finding.sameData);
  return buildValidation({
    status: matchedData ? "likely" : "suspected",
    confidence: matchedData ? 72 : 55,
    proofLevel: "protocol",
    attempts: findings.length,
    successfulReproductions: findings.length,
    requirements: [
      { id: "url_id_mutated", label: "URL ID was safely mutated", passed: context.urlIds > 0 },
      { id: "alternate_id_success", label: "Alternate ID returned 2xx data", passed: findings.length > 0 },
      { id: "same_shape_or_data", label: "Response matched protected data shape", passed: matchedData },
      { id: "cross_identity", label: "Second authorized identity verified ownership", passed: null },
      { id: "negative_control", label: "Owner/non-owner control pair checked", passed: null },
    ],
    expectedBehavior: "Changing a resource identifier should deny access unless the captured identity owns the alternate object.",
    observedBehavior: `${findings.length} alternate ID probe${findings.length === 1 ? "" : "s"} returned successful data.`,
    conclusion:
      "The route is suspicious for object-level authorization weakness, but TestMind needs a second identity or ownership control to confirm exploitability.",
  });
}

function buildDerivedDetailAuthValidation(
  context: RouteContext,
  authDetail: ProbeResult,
  unauthDetail: ProbeResult,
  ids: string[]
): SecurityValidation {
  const sameData = bodyLooksSameData(authDetail.body, unauthDetail.body, ids);
  return buildValidation({
    status: sameData ? "likely" : "suspected",
    confidence: sameData ? 78 : 62,
    proofLevel: "protocol",
    attempts: 1,
    successfulReproductions: isSuccess(unauthDetail.status) ? 1 : 0,
    requirements: [
      { id: "derived_detail_success", label: "Derived detail returned 2xx with auth", passed: isSuccess(authDetail.status) },
      { id: "unauth_detail_success", label: "Derived detail returned 2xx without auth", passed: isSuccess(unauthDetail.status) },
      { id: "protected_data_match", label: "Unauthenticated detail matched protected data", passed: sameData },
      { id: "repeat_validation", label: "Repeated unauthenticated detail validation", passed: null },
    ],
    expectedBehavior: "A detail URL derived from a protected list response should deny access when auth/session headers are removed.",
    observedBehavior: `Derived detail returned ${unauthDetail.status ?? "no response"} without auth/session headers.`,
    conclusion: "The derived detail route needs repeat and ownership validation before it can be marked confirmed.",
  });
}

export async function runLiveSecurityTests(
  exchange: SecurityHttpExchange,
  scope: ProbeScope,
  options: LiveSecurityTestOptions = {}
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
  const activeBaselineProbeAllowed = activeProbeAllowed && baselineSucceeded;
  const idCandidates = detectResourceIdCandidates(exchange.request.url).slice(0, 2);

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
    checks.push(
      skippedCheck(
        "method-tampering-head",
        `Method handling skipped for ${method} ${context.pathname}`,
        "Safe method probing currently uses captured GET baselines so TestMind does not replay state-changing requests.",
        routeEvidence(context)
      )
    );
    checks.push(
      skippedCheck(
        "xss-reflection-probe",
        `XSS reflection probe skipped for ${method} ${context.pathname}`,
        "Live XSS/reflection probes currently use safe GET query markers only; this captured request was not a GET baseline.",
        routeEvidence(context)
      )
    );
    checks.push(
      skippedCheck(
        "injection-error-probe",
        `Injection parser probe skipped for ${method} ${context.pathname}`,
        "Live injection probes currently use safe GET query markers only; this captured request was not a GET baseline.",
        routeEvidence(context)
      )
    );
    checks.push(
      skippedCheck(
        "idor-url-mutation",
        `IDOR/BOLA URL mutation skipped for ${method} ${context.pathname}`,
        "Live IDOR URL mutation probes currently use captured GET baselines so TestMind does not replay state-changing requests.",
        routeEvidence(context, { idsFound: ids.length, urlIds: context.urlIds })
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
        routeEvidence(context, { fields: sensitiveFields, jsonKeys: context.jsonKeys }),
        buildPassiveFieldValidation(context, sensitiveFields)
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
        routeEvidence(context),
        buildErrorDisclosureValidation(context)
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
  const capturedWildcardCredentialed = acao === "*" && /true/i.test(acac);

  const corsProbe = await probeScoped(scope, exchange.request.url, {
    method: "OPTIONS",
    headers: {
      Origin: TEST_ORIGIN,
      "Access-Control-Request-Method": method === "OPTIONS" ? "GET" : method,
      "Access-Control-Request-Headers": "authorization,content-type",
    },
    timeoutMs: 5_000,
  });
  probes.push({ label: "cross-origin preflight probe", result: corsProbe });
  const probedAcao = headerValue(corsProbe.headers, "access-control-allow-origin");
  const probedAcac = headerValue(corsProbe.headers, "access-control-allow-credentials");
  const credentialedCorsSuspicious = (probedAcao === "*" || probedAcao === TEST_ORIGIN) && /true/i.test(probedAcac);
  const corsReadAttempts: ProbeResult[] = [];
  const browserCorsReadAttempts = Math.max(
    0,
    Math.min(VALIDATION_REPEAT_COUNT, Math.trunc(options.browserCorsReadAttempts ?? VALIDATION_REPEAT_COUNT))
  );
  if (credentialedCorsSuspicious && activeProbeAllowed && baselineSucceeded && authStripped.removed.length > 0 && probedAcao === TEST_ORIGIN) {
    for (let attempt = 0; attempt < VALIDATION_REPEAT_COUNT; attempt += 1) {
      const corsRead = await probeScoped(scope, exchange.request.url, {
        method: "GET",
        headers: { ...exchange.request.headers, Origin: TEST_ORIGIN },
        timeoutMs: 5_000,
      });
      corsReadAttempts.push(corsRead);
      probes.push({
        label: attempt === 0 ? "credentialed CORS read probe" : "credentialed CORS read reproduction",
        result: corsRead,
        diff: computeDifferential(exchange, corsRead),
      });
    }
  }
  if (
    options.browserCorsRead &&
    browserCorsReadAttempts > 0 &&
    activeProbeAllowed &&
    baselineSucceeded &&
    hasRequestHeader(exchange.request.headers, "cookie") &&
    (capturedWildcardCredentialed || credentialedCorsSuspicious)
  ) {
    for (let attempt = 0; attempt < browserCorsReadAttempts; attempt += 1) {
      const browserRead = await options.browserCorsRead(exchange.request.url, 7_000);
      corsReadAttempts.push(browserRead);
      probes.push({
        label: attempt === 0 ? "browser credentialed CORS read proof" : "browser credentialed CORS read reproduction",
        result: browserRead,
        diff: computeDifferential(exchange, browserRead),
      });
    }
  }
  const corsValidation = buildCorsValidation(
    context,
    corsProbe,
    corsReadAttempts,
    baselineBody,
    ids,
    hasRequestHeader(exchange.request.headers, "cookie"),
    { acao, acac }
  );
  if (capturedWildcardCredentialed) {
    checks.push(
      validationAwareCorsCheck(
        "cors-wildcard-credentials",
        `${context.pathname} advertises wildcard credentialed CORS`,
        "high",
        "The captured response advertises Access-Control-Allow-Origin: * together with credentialed CORS.",
        routeEvidence(context, { accessControlAllowOrigin: acao, accessControlAllowCredentials: acac }),
        corsValidation
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
  if (credentialedCorsSuspicious) {
    checks.push(
      validationAwareCorsCheck(
        "active-cors-origin-probe",
        `Preflight probe for ${context.pathname} allowed credentialed access`,
        "high",
        "A synthetic cross-origin preflight was accepted with credential support.",
        routeEvidence(context, { status: corsProbe.status, accessControlAllowOrigin: probedAcao, accessControlAllowCredentials: probedAcac }),
        corsValidation
      )
    );
  } else if (probedAcao === TEST_ORIGIN) {
    checks.push(
      validationAwareCorsCheck(
        "active-cors-origin-probe",
        `Preflight probe for ${context.pathname} reflected an untrusted origin`,
        "medium",
        "A synthetic cross-origin preflight reflected the supplied untrusted Origin header.",
        routeEvidence(context, { status: corsProbe.status, accessControlAllowOrigin: probedAcao }),
        corsValidation
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
          "method-tampering-head",
          `Method handling: HEAD ${context.pathname} returned ${headProbe.status}`,
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
          "method-tampering-head",
          `Method handling: HEAD ${context.pathname} returned ${headProbe.status ?? "no response"}`,
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

    if (activeBaselineProbeAllowed) {
      const reflection = reflectionProbe(exchange.request.url, exchange.id);
      if (reflection.url) {
        const reflected = await probeScoped(scope, reflection.url, {
          method: "GET",
          headers: exchange.request.headers,
          timeoutMs: 5_000,
        });
        probes.push({ label: "XSS reflection marker probe", result: reflected, diff: computeDifferential(exchange, reflected) });
        const rawMarkupReflected = reflectedRawMarkup(reflected.body, reflection.token);
        const markerReflected = reflectedProbeToken(reflected.body, reflection.token);
        const browserRelevantResponse = isHtmlLikeContentType(headerValue(reflected.headers, "content-type"));
        if (rawMarkupReflected && browserRelevantResponse) {
          checks.push(
            failedCheck(
              "xss-reflection-probe",
              `XSS/reflection probe for ${context.pathname} reflected unencoded markup`,
              "medium",
              "xss",
              "A03:2021 Injection",
              "API8:2023 Security Misconfiguration",
              "An inert markup marker was reflected into a browser-rendered response without output encoding.",
              routeEvidence(context, { status: reflected.status, markerReflected, rawMarkupReflected, contentType: headerValue(reflected.headers, "content-type") }),
              buildReflectionValidation(context, reflected, rawMarkupReflected, markerReflected, browserRelevantResponse)
            )
          );
        } else {
          checks.push(
            passedCheck(
              "xss-reflection-probe",
              `XSS/reflection probe for ${context.pathname} did not prove unencoded HTML reflection`,
              markerReflected
                ? "The marker appeared in the response, but not as unencoded markup in a browser-rendered response."
                : "The inert markup marker was not reflected in the response.",
              routeEvidence(context, { status: reflected.status, markerReflected, rawMarkupReflected, contentType: headerValue(reflected.headers, "content-type") })
            )
          );
        }
      } else {
        checks.push(
          skippedCheck(
            "xss-reflection-probe",
            `XSS/reflection probe skipped for ${context.pathname}`,
            "TestMind could not construct a scoped GET URL for the reflection marker.",
            routeEvidence(context)
          )
        );
      }

      const injectionUrl = injectionProbeUrl(exchange.request.url);
      if (injectionUrl) {
        const injectionProbe = await probeScoped(scope, injectionUrl, {
          method: "GET",
          headers: exchange.request.headers,
          timeoutMs: 5_000,
        });
        probes.push({ label: "injection parser error probe", result: injectionProbe, diff: computeDifferential(exchange, injectionProbe) });
        const injectionErrored = statusIn(injectionProbe.status, 500, 599) || ERROR_DISCLOSURE_RE.test(injectionProbe.body);
        if (injectionErrored) {
          checks.push(
            failedCheck(
              "injection-error-probe",
              `Injection parser probe for ${context.pathname} returned ${injectionProbe.status ?? "error disclosure"}`,
              "medium",
              "injection",
              "A03:2021 Injection",
              "API8:2023 Security Misconfiguration",
              "A harmless parser-stress query marker caused a server error or internal error disclosure.",
              routeEvidence(context, { status: injectionProbe.status, error: injectionProbe.error }),
              buildInjectionProbeValidation(context, injectionProbe)
            )
          );
        } else {
          checks.push(
            passedCheck(
              "injection-error-probe",
              `Injection parser probe for ${context.pathname} returned ${injectionProbe.status ?? "no response"}`,
              "A harmless parser-stress query marker did not cause a server error or obvious internal error disclosure.",
              routeEvidence(context, { status: injectionProbe.status, error: injectionProbe.error })
            )
          );
        }
      } else {
        checks.push(
          skippedCheck(
            "injection-error-probe",
            `Injection parser probe skipped for ${context.pathname}`,
            "TestMind could not construct a scoped GET URL for the parser-stress marker.",
            routeEvidence(context)
          )
        );
      }
    } else {
      checks.push(
        skippedCheck(
          "xss-reflection-probe",
          `XSS/reflection probe skipped for ${context.pathname}`,
          "Live XSS/reflection probes require a successful captured GET baseline.",
          routeEvidence(context)
        )
      );
      checks.push(
        skippedCheck(
          "injection-error-probe",
          `Injection parser probe skipped for ${context.pathname}`,
          "Live injection probes require a successful captured GET baseline.",
          routeEvidence(context)
        )
      );
    }

    const idProbeFindings: Array<{ url: string; status?: number; candidate: string; value: string; sameData: boolean }> = [];
    for (const candidate of activeBaselineProbeAllowed ? idCandidates : []) {
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
            sameData: bodyLooksSameData(baselineBody, idProbe.body, ids),
          });
        }
      }
    }
    if (!activeBaselineProbeAllowed) {
      checks.push(
        skippedCheck(
          "idor-url-mutation",
          `IDOR/BOLA URL mutation skipped for ${context.pathname}`,
          "Live IDOR URL mutation probes require a successful captured GET baseline.",
          routeEvidence(context, { candidates: idCandidates.map((candidate) => candidate.paramName), idsFound: ids.length, urlIds: context.urlIds })
        )
      );
    } else if (idProbeFindings.length > 0) {
      checks.push(
        failedCheck(
          "idor-url-mutation",
          `IDOR/BOLA alternate ID probes for ${context.pathname} returned data`,
          "high",
          "broken_object_level_authorization",
          "A01:2021 Broken Access Control",
          "API1:2023 Broken Object Level Authorization",
          "Changing an ID in the captured GET URL returned a successful response with a body.",
          routeEvidence(context, { probes: idProbeFindings, probeCount: idProbeFindings.length }),
          buildIdorValidation(context, idProbeFindings)
        )
      );
    } else if (idCandidates.length > 0) {
      checks.push(
        passedCheck(
          "idor-url-mutation",
          `IDOR/BOLA alternate ID probes for ${context.pathname} did not return data`,
          "Changing detected URL IDs did not return successful data responses.",
          routeEvidence(context, { candidates: idCandidates.map((candidate) => candidate.paramName) })
        )
      );
    } else {
      checks.push(
        skippedCheck(
          "idor-url-mutation",
          `IDOR/BOLA URL mutation skipped for ${context.pathname}`,
          ids.length > 0
            ? "IDs were found in the response body, but this request has no URL ID parameter or path segment to mutate."
            : "No URL ID parameter, URL ID path segment, or response ID candidate was available for safe same-route IDOR mutation.",
          routeEvidence(context, { idsFound: ids.length, urlIds: context.urlIds })
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
      const unauthAttempts = [unauth];
      for (let attempt = 0; attempt < VALIDATION_REPEAT_COUNT; attempt += 1) {
        const repeatUnauth = await probeScoped(scope, exchange.request.url, {
          method: "GET",
          headers: authStripped.headers,
          timeoutMs: 5_000,
        });
        unauthAttempts.push(repeatUnauth);
        probes.push({
          label: attempt === 0 ? "unauthenticated replay validation" : "unauthenticated replay reproduction",
          result: repeatUnauth,
          diff: computeDifferential(exchange, repeatUnauth),
        });
      }
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
          }),
          buildUnauthenticatedAccessValidation(context, unauthAttempts, baselineBody, ids, authStripped.removed)
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
        `IDOR/BOLA derived detail skipped for ${context.pathname}`,
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
          `IDOR/BOLA derived detail ${pathnameFromUrl(url)} returned ${authDetail.status ?? "no response"}`,
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
          `IDOR/BOLA derived detail ${pathnameFromUrl(url)} was reachable, unauthenticated check skipped`,
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
          `IDOR/BOLA unauthenticated detail ${pathnameFromUrl(url)} returned ${unauthDetail.status}`,
          "A detail URL built from an ID in the list response denied access after auth/session headers were removed.",
          routeEvidence(context, { url, authStatus: authDetail.status, unauthStatus: unauthDetail.status })
        )
      );
    } else if (isSuccess(unauthDetail.status)) {
      checks.push(
        failedCheck(
          `derived-detail-auth:${url}`,
          `IDOR/BOLA unauthenticated detail ${pathnameFromUrl(url)} returned ${unauthDetail.status}`,
          bodyLooksSameData(authDetail.body, unauthDetail.body, ids) ? "high" : "medium",
          "broken_access_control",
          "A01:2021 Broken Access Control",
          "API1:2023 Broken Object Level Authorization",
          "A detail URL built from an ID in a captured response returned HTTP 2xx without auth/session headers.",
          routeEvidence(context, { url, authStatus: authDetail.status, unauthStatus: unauthDetail.status }),
          buildDerivedDetailAuthValidation(context, authDetail, unauthDetail, ids)
        )
      );
    } else {
      checks.push(
        passedCheck(
          `derived-detail-auth:${url}`,
          `IDOR/BOLA unauthenticated detail ${pathnameFromUrl(url)} returned ${unauthDetail.status ?? "no response"}`,
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
