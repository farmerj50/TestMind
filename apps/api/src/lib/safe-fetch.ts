import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

type SafeFetchPolicy = {
  allowHttp?: boolean;
  allowPrivateHosts?: boolean;
  allowedHosts?: string[];
  maxRedirects?: number;
  resolveHost?: (hostname: string) => Promise<string[]>;
};

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
};

const isPrivateIpv4Host = (hostname: string) => {
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  const m = hostname.match(/^172\.(\d{1,3})\./);
  if (m) {
    const second = Number(m[1]);
    if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
  }
  if (/^127\./.test(hostname)) return true;
  return false;
};

const isPrivateIpv6Host = (hostname: string) => {
  const normalized = hostname.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true; // fe80::/10
  }
  const v4mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped?.[1]) return isPrivateIpv4Host(v4mapped[1]);
  return false;
};

const isLocalHost = (hostname: string) => {
  if (hostname === "localhost" || hostname === "0.0.0.0") return true;
  if (isPrivateIpv4Host(hostname)) return true;
  if (isPrivateIpv6Host(hostname)) return true;
  return false;
};

const resolveHostAddresses = async (
  hostname: string,
  resolver?: (hostname: string) => Promise<string[]>
): Promise<string[]> => {
  if (isIP(hostname)) return [hostname];
  if (resolver) return resolver(hostname);
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
};

async function validateUrl(rawUrl: string, policy: SafeFetchPolicy): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid outbound URL.");
  }

  const allowHttp = policy.allowHttp ?? false;
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new Error("Outbound URL protocol is not allowed.");
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowPrivateHosts = policy.allowPrivateHosts ?? parseBoolean(process.env.TM_ALLOW_PRIVATE_OUTBOUND, false);
  if (!allowPrivateHosts && isLocalHost(hostname)) {
    throw new Error("Outbound URL host is not allowed.");
  }

  const allowedHosts = policy.allowedHosts?.map((h) => h.toLowerCase()).filter(Boolean) ?? [];
  if (allowedHosts.length > 0) {
    const ok = allowedHosts.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
    if (!ok) throw new Error(`Outbound URL host '${hostname}' is not in allowlist.`);
  }

  if (!allowPrivateHosts) {
    const resolvedAddresses = await resolveHostAddresses(hostname, policy.resolveHost);
    if (
      resolvedAddresses.some((address) => {
        const normalized = String(address ?? "").trim().toLowerCase();
        return normalized ? isLocalHost(normalized) : false;
      })
    ) {
      throw new Error("Outbound URL host resolves to a private/local address.");
    }
  }

  return parsed;
}

export async function safeFetch(
  rawUrl: string,
  init?: RequestInit,
  policy?: SafeFetchPolicy
): Promise<Response> {
  const mergedPolicy: SafeFetchPolicy = {
    allowHttp: false,
    allowPrivateHosts: false,
    maxRedirects: 5,
    ...policy,
  };
  let currentUrl = (await validateUrl(rawUrl, mergedPolicy)).toString();
  const redirects = Number.isFinite(mergedPolicy.maxRedirects)
    ? Math.max(0, Math.trunc(mergedPolicy.maxRedirects as number))
    : 5;

  for (let i = 0; i <= redirects; i++) {
    const response = await fetch(currentUrl, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) return response;
    const nextUrl = new URL(location, currentUrl).toString();
    currentUrl = (await validateUrl(nextUrl, mergedPolicy)).toString();
  }

  throw new Error("Too many redirects while fetching outbound URL.");
}
