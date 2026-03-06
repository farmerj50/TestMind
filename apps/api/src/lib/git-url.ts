const DEFAULT_ALLOWED_GIT_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];

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
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }
  const v4mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped?.[1]) return isPrivateIpv4Host(v4mapped[1]);
  return false;
};

const isLoopbackOrLocalHost = (hostname: string) =>
  hostname === "localhost" || hostname === "0.0.0.0" || isPrivateIpv4Host(hostname) || isPrivateIpv6Host(hostname);

const getAllowedHosts = () => {
  const envHosts = (process.env.TM_GIT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const merged = [...DEFAULT_ALLOWED_GIT_HOSTS, ...envHosts];
  return Array.from(new Set(merged));
};

const hostMatchesAllowlist = (hostname: string, allowedHosts: string[]) =>
  allowedHosts.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));

export type RepoUrlValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

export function validateAndNormalizeRepoUrl(raw: string): RepoUrlValidation {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "Repository URL cannot be empty." };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "Repository URL must be a valid absolute URL." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "Repository URL must use https://." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Repository URL must not include embedded credentials." };
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowPrivateHosts = parseBoolean(process.env.TM_ALLOW_PRIVATE_GIT_HOSTS, false);
  if (!allowPrivateHosts && isLoopbackOrLocalHost(hostname)) {
    return { ok: false, reason: "Repository URL host is not allowed." };
  }

  const allowedHosts = getAllowedHosts();
  if (!hostMatchesAllowlist(hostname, allowedHosts)) {
    return {
      ok: false,
      reason: `Repository host '${hostname}' is not allowed. Configure TM_GIT_ALLOWED_HOSTS for enterprise hosts.`,
    };
  }

  if (!parsed.pathname || parsed.pathname === "/") {
    return { ok: false, reason: "Repository URL must include owner/repository path." };
  }

  parsed.hash = "";
  parsed.search = "";
  const normalized = parsed.toString().replace(/\/+$/, "");
  return { ok: true, normalized };
}
