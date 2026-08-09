/**
 * JavaScript bundle endpoint extractor.
 *
 * Modern SPAs (React, Vue, Angular) bundle all API routes into their JavaScript.
 * Generic scanners only probe known/guessed paths — this module finds the ACTUAL
 * API surface by fetching the target's HTML, locating all JS bundle URLs, then
 * extracting endpoint patterns from the bundle content.
 *
 * Technique: regex-based extraction of URL-like strings from minified JS, similar
 * to tools like LinkFinder, JSParser, and Burp Suite's JS parser. Feeds discovered
 * endpoints back into the IDOR engine and surfaces them as scan findings.
 *
 * Particularly effective on Chime/fintech SPAs where the entire API surface
 * lives in a single webpack bundle.
 */

import { request } from "undici";
import { buildAuthHeaders } from "../auth-headers.js";
import type { SecurityAuthProfile } from "../types.js";

export type JsEndpointFinding = {
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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 15_000): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await request(url, { method: "GET", headers, signal: ctrl.signal as any });
    if (res.statusCode >= 400) return null;
    return await res.body.text().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── JS URL discovery from HTML ────────────────────────────────────────────────

const JS_SRC_PATTERN = /(?:src|href)=["']([^"']*\.(?:js|mjs|chunk\.js)[^"']*)["']/gi;
const INLINE_SCRIPT_PATTERN = /<script[^>]*>([\s\S]*?)<\/script>/gi;

function extractJsUrls(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const urls = new Set<string>();

  let m: RegExpExecArray | null;
  const srcRe = new RegExp(JS_SRC_PATTERN.source, "gi");
  while ((m = srcRe.exec(html)) !== null) {
    const raw = m[1];
    try {
      const resolved = new URL(raw, base.origin).href;
      if (resolved.includes(base.hostname) || resolved.startsWith("/")) {
        urls.add(resolved);
      }
    } catch {}
  }
  return [...urls].slice(0, 20); // cap at 20 JS files
}

// ── Endpoint pattern extraction ───────────────────────────────────────────────

// Patterns that match API endpoint strings in minified JS
const ENDPOINT_PATTERNS = [
  // String literals containing path segments: "/api/v1/users"
  /["'`](\/(?:api|v\d|graphql|gql|rest|service|internal|backend|app)\/[a-zA-Z0-9/_\-{}:.?&=]+)["'`]/g,
  // Template literals: `/api/users/${id}`
  /["'`](\/[a-zA-Z][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9_\-{}:.]+){1,8})["'`]/g,
  // fetch/axios/request calls
  /(?:fetch|axios\.(?:get|post|put|patch|delete)|request)\s*\(\s*["'`](\/[a-zA-Z][^"'`\s]{5,100})["'`]/g,
];

// Known false-positive patterns to filter out
const SKIP_PATTERNS = [
  /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|css|map|html|txt)$/i,
  /^\/\//,
  /localhost/i,
  /node_modules/i,
  /__webpack/i,
  /\$\{/,  // template literal with variable — not a real literal path
];

function extractEndpoints(jsContent: string): string[] {
  const found = new Set<string>();

  for (const pattern of ENDPOINT_PATTERNS) {
    const re = new RegExp(pattern.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(jsContent)) !== null && found.size < 500) {
      const path = m[1];
      if (path.length < 4 || path.length > 150) continue;
      if (SKIP_PATTERNS.some((skip) => skip.test(path))) continue;
      // Must start with / and contain at least one more path segment
      if (!path.startsWith("/") || path.split("/").length < 2) continue;
      found.add(path);
    }
  }

  return [...found].sort();
}

// ── Sensitive endpoint classifier ─────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  { pattern: /\/admin\//i, label: "admin panel", severity: "high" as const },
  { pattern: /\/internal\//i, label: "internal API", severity: "high" as const },
  { pattern: /\/debug\//i, label: "debug endpoint", severity: "high" as const },
  { pattern: /\/(user|account|profile)\//i, label: "user/account data", severity: "medium" as const },
  { pattern: /\/(transfer|payment|withdraw|send)\//i, label: "financial operation", severity: "high" as const },
  { pattern: /\/(token|auth|session|login|oauth)\//i, label: "authentication", severity: "medium" as const },
  { pattern: /\/(config|settings|env|secret)\//i, label: "configuration", severity: "high" as const },
  { pattern: /\/(upload|import|export|download)\//i, label: "file operation", severity: "medium" as const },
  { pattern: /\/(graphql|gql)\b/i, label: "GraphQL endpoint", severity: "low" as const },
];

type ClassifiedEndpoint = {
  path: string;
  label: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
};

function classifyEndpoint(path: string): ClassifiedEndpoint {
  for (const { pattern, label, severity } of SENSITIVE_PATTERNS) {
    if (pattern.test(path)) return { path, label, severity };
  }
  return { path, label: "API endpoint", severity: "info" };
}

// ── Auth helper ───────────────────────────────────────────────────────────────

// ── Main entrypoint ──────────────────────────────────────────────────────────

export type JsExtractionResult = {
  findings: JsEndpointFinding[];
  discoveredEndpoints: string[]; // raw paths — fed into IDOR engine
};

export async function runJsEndpointExtraction(
  baseUrl: string,
  authProfiles: SecurityAuthProfile[],
): Promise<JsExtractionResult> {
  const findings: JsEndpointFinding[] = [];
  const base = baseUrl.replace(/\/+$/, "");
  const primaryProfile = authProfiles[0];
  const authHeaders = buildAuthHeaders(primaryProfile);

  // 1. Fetch the HTML entry point
  const html = await fetchText(base, authHeaders, 20_000) ??
               await fetchText(`${base}/`, authHeaders, 20_000);

  if (!html) {
    findings.push({
      type: "dynamic",
      severity: "info",
      title: "JS endpoint extraction: target HTML not reachable",
      description: `Could not fetch the HTML entry point at ${base}. JS bundle analysis skipped.`,
      location: base,
      tool: "js-endpoint-extractor",
      evidence: {},
      status: "open",
    });
    return { findings, discoveredEndpoints: [] };
  }

  // 2. Find all JS bundle URLs
  const jsUrls = extractJsUrls(html, base);

  if (!jsUrls.length) {
    findings.push({
      type: "dynamic",
      severity: "info",
      title: "JS endpoint extraction: no JavaScript bundles found in HTML",
      description: "No <script src> tags pointing to JS bundles were found in the entry page HTML. The target may use server-side rendering or dynamically load scripts.",
      location: base,
      tool: "js-endpoint-extractor",
      evidence: { htmlLength: html.length },
      status: "open",
    });
    return { findings, discoveredEndpoints: [] };
  }

  // 3. Fetch JS bundles and extract endpoints
  const allEndpoints = new Set<string>();
  let bundlesFetched = 0;

  for (const jsUrl of jsUrls.slice(0, 10)) {
    const content = await fetchText(jsUrl, {}, 30_000);
    if (!content) continue;
    bundlesFetched++;
    const extracted = extractEndpoints(content);
    extracted.forEach((e) => allEndpoints.add(e));
  }

  const endpointList = [...allEndpoints].sort();

  findings.push({
    type: "dynamic",
    severity: "info",
    title: `JS endpoint extraction: ${endpointList.length} API routes discovered from ${bundlesFetched} bundles`,
    description:
      `Analyzed ${bundlesFetched} JavaScript bundle(s) from ${base} and found ` +
      `${endpointList.length} unique API endpoint patterns. These are being fed into the ` +
      `IDOR engine for cross-account testing. Sensitive endpoints are flagged below.`,
    location: base,
    tool: "js-endpoint-extractor",
    evidence: {
      bundlesAnalyzed: bundlesFetched,
      totalEndpoints: endpointList.length,
      jsFiles: jsUrls.slice(0, 5),
      sampleEndpoints: endpointList.slice(0, 15),
    },
    status: "open",
  });

  // 4. Classify and flag sensitive endpoints
  const classified = endpointList.map(classifyEndpoint);
  const sensitive = classified.filter((c) => c.severity !== "info");

  for (const ep of sensitive.slice(0, 25)) {
    findings.push({
      type: "dynamic",
      severity: ep.severity,
      title: `Discovered ${ep.label}: ${ep.path}`,
      description:
        `The JavaScript bundle references a ${ep.label} endpoint at '${ep.path}'. ` +
        `This endpoint was not discoverable through standard URL guessing — it was found ` +
        `by parsing the application's own JavaScript source. Verify whether this endpoint ` +
        `enforces proper authentication and authorization checks.`,
      location: `${base}${ep.path}`,
      tool: "js-endpoint-extractor",
      evidence: {
        vulnerabilityClass: ep.severity === "high" ? "broken_function_level_authorization" : "security_misconfiguration",
        owaspCategory: ep.severity === "high" ? "A01:2021 Broken Access Control" : "A05:2021 Security Misconfiguration",
        discoveredFrom: "javascript-bundle-analysis",
        path: ep.path,
        label: ep.label,
      },
      suggestion:
        `Ensure ${ep.path} enforces authentication and authorization server-side, ` +
        `independent of whether the path is referenced in the client-side code. ` +
        `Security through obscurity (hiding routes in JS) is not access control.`,
      status: "open",
    });
  }

  return { findings, discoveredEndpoints: endpointList };
}
