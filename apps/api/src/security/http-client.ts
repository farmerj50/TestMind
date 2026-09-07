import { request } from "undici";
import { redactText, snippet } from "./redaction.js";
import type { IntelligentSecurityScanConfig, SecurityProbeEvidence } from "./types.js";

// Canonical scope-config shape, so every module that needs "what hosts/ports may this
// scan touch" imports the same type instead of each defining its own equivalent.
export type ProbeScope = Pick<IntelligentSecurityScanConfig, "allowedHosts" | "allowedPorts">;

export type ProbeOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  profile?: string;
  label?: string;
  maxRedirects?: number;
  // Set to false to get the raw 3xx response back without following it at all (e.g. the
  // open-redirect probe, which needs to inspect the Location header itself). Defaults to
  // true: follow up to maxRedirects hops, re-validating scope on each one.
  followRedirects?: boolean;
};

export type ProbeResult = {
  method: string;
  url: string;
  profile?: string;
  status?: number;
  body: string;
  bodyLength: number;
  bodySnippet: string;
  headers: Record<string, string>;
  error?: string;
};

export function portForUrl(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

export function isWithinScope(rawUrl: string, allowedHosts: string[], allowedPorts: number[]) {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    const hosts = allowedHosts.map((host) => host.toLowerCase()).filter(Boolean);
    const hostOk =
      hosts.length === 0 ||
      hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    const portOk = allowedPorts.length === 0 || allowedPorts.includes(portForUrl(url));
    return hostOk && portOk;
  } catch {
    return false;
  }
}

export function toAbsoluteUrl(baseUrl: string, route: string): string {
  return new URL(route, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

export function withQueryParam(rawUrl: string, key: string, value: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set(key, value);
  return url.toString();
}

export function materializeRoute(baseUrl: string, route: string, objectId?: string): string {
  let resolvedRoute = route.trim() || "/";
  if (objectId) {
    if (/[:{]id[}]/i.test(resolvedRoute)) {
      resolvedRoute = resolvedRoute.replace(/:id|\{id\}/i, encodeURIComponent(objectId));
    } else if (/\{objectId\}/i.test(resolvedRoute)) {
      resolvedRoute = resolvedRoute.replace(/\{objectId\}/i, encodeURIComponent(objectId));
    } else if (!resolvedRoute.includes(objectId)) {
      resolvedRoute = `${resolvedRoute.replace(/\/$/, "")}/${encodeURIComponent(objectId)}`;
    }
  }
  return toAbsoluteUrl(baseUrl, resolvedRoute);
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) out[key.toLowerCase()] = redactText(value.join("; "));
    else if (typeof value === "string") out[key.toLowerCase()] = redactText(value);
  }
  return out;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function emptyResult(method: string, url: string, profile: string | undefined, error: string): ProbeResult {
  return { method, url, profile, body: "", bodyLength: 0, bodySnippet: "", headers: {}, error };
}

// HTTP/2 pseudo-headers (":authority", ":method", ":path", ":scheme") show up in headers
// captured via Chrome DevTools Protocol (real browser traffic exposes HTTP/2 framing details
// CDP surfaces directly) but are not valid HTTP/1.1 header field names. undici's request()
// throws "invalid header key" and aborts the ENTIRE outbound call if even one is present -
// silently failing every probe that replays real captured headers (every active probe except
// the CORS preflight, which builds its own headers from scratch rather than reusing captured
// ones). Filtered out once, here, at the actual outbound-request boundary, so every caller of
// probeScoped (live-security-tests.ts, experiment.ts, enterprise-bypass.ts) is protected
// uniformly instead of each needing its own header-sanitizing discipline - this is the real
// security/correctness boundary, not caller discipline, matching this file's own redirect-scope
// re-validation below.
const VALID_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function sanitizeOutboundHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (VALID_HEADER_NAME_RE.test(key)) out[key] = value;
  }
  return out;
}

// Follows redirects manually (undici's bare request() does not auto-follow), re-validating
// isWithinScope on every hop before it's requested — not just the initial URL. Without this,
// an in-scope target that 302s to an out-of-scope/internal address would have let the
// redirect target be requested unchecked. Mirrors safe-fetch.ts's safeFetch loop shape.
export async function probeScoped(
  config: ProbeScope,
  url: string,
  opts: ProbeOptions = {}
): Promise<ProbeResult> {
  const method = (opts.method ?? "GET").toUpperCase();
  const profile = opts.profile;
  const followRedirects = opts.followRedirects ?? true;
  const maxRedirects = Number.isFinite(opts.maxRedirects) ? Math.max(0, Math.trunc(opts.maxRedirects as number)) : 5;
  const headers = sanitizeOutboundHeaders(opts.headers);

  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    if (!isWithinScope(currentUrl, config.allowedHosts, config.allowedPorts)) {
      return emptyResult(method, currentUrl, profile, "URL is outside allowed security scan scope.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(currentUrl, {
        method,
        headers,
        body: opts.body,
        signal: controller.signal as any,
      });
    } catch (err: any) {
      clearTimeout(timer);
      return emptyResult(method, currentUrl, profile, err?.message ?? String(err));
    }
    clearTimeout(timer);

    if (REDIRECT_STATUSES.has(response.statusCode) && followRedirects) {
      const location = response.headers.location;
      const locationStr = Array.isArray(location) ? location[0] : location;
      await response.body.text().catch(() => ""); // drain before following
      if (locationStr) {
        if (hop >= maxRedirects) {
          return emptyResult(method, currentUrl, profile, "Too many redirects while probing scoped URL.");
        }
        try {
          currentUrl = new URL(locationStr, currentUrl).toString();
          continue; // re-validate scope for the redirect target at the top of the loop
        } catch {
          return emptyResult(method, currentUrl, profile, "Redirect target is not a valid URL.");
        }
      }
    }

    const body = await response.body.text().catch(() => "");
    return {
      method,
      url: currentUrl,
      profile,
      status: response.statusCode,
      body,
      bodyLength: body.length,
      bodySnippet: snippet(body),
      headers: normalizeHeaders(response.headers),
    };
  }
}

export function probeEvidence(label: string, result: ProbeResult): SecurityProbeEvidence {
  return {
    label,
    method: result.method,
    url: result.url,
    profile: result.profile,
    status: result.status,
    bodyLength: result.bodyLength,
    bodySnippet: result.bodySnippet,
    headers: {
      "content-type": result.headers["content-type"] ?? "",
      location: result.headers.location ?? "",
    },
    error: result.error,
  };
}

export function isSuccessStatus(status: number | undefined): boolean {
  return typeof status === "number" && status >= 200 && status < 300;
}

export function isDeniedStatus(status: number | undefined, expected = [401, 403, 404]): boolean {
  return typeof status === "number" && expected.includes(status);
}

export function hasServerError(result: ProbeResult): boolean {
  return typeof result.status === "number" && result.status >= 500;
}

export function hasErrorDisclosure(body: string): boolean {
  const normalized = body.toLowerCase();
  return [
    "stack trace",
    "traceback",
    "sql syntax",
    "pg_query",
    "mysql",
    "ora-",
    "at node:",
    "exception",
    "unhandled rejection",
  ].some((marker) => normalized.includes(marker));
}
