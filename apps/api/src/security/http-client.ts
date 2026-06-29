import { request } from "undici";
import { redactText, snippet } from "./redaction.js";
import type { IntelligentSecurityScanConfig, SecurityProbeEvidence } from "./types.js";

export type ProbeOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  profile?: string;
  label?: string;
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

export async function probeScoped(
  config: Pick<IntelligentSecurityScanConfig, "allowedHosts" | "allowedPorts">,
  url: string,
  opts: ProbeOptions = {}
): Promise<ProbeResult> {
  const method = (opts.method ?? "GET").toUpperCase();
  const profile = opts.profile;

  if (!isWithinScope(url, config.allowedHosts, config.allowedPorts)) {
    return {
      method,
      url,
      profile,
      body: "",
      bodyLength: 0,
      bodySnippet: "",
      headers: {},
      error: "URL is outside allowed security scan scope.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const response = await request(url, {
      method,
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal as any,
    });
    const body = await response.body.text().catch(() => "");
    return {
      method,
      url,
      profile,
      status: response.statusCode,
      body,
      bodyLength: body.length,
      bodySnippet: snippet(body),
      headers: normalizeHeaders(response.headers),
    };
  } catch (err: any) {
    return {
      method,
      url,
      profile,
      body: "",
      bodyLength: 0,
      bodySnippet: "",
      headers: {},
      error: err?.message ?? String(err),
    };
  } finally {
    clearTimeout(timer);
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
