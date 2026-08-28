/**
 * Subdomain enumeration module.
 *
 * The majority of high-severity bug bounty findings live on subdomains that security
 * teams forgot about: staging environments left public, admin panels, internal APIs,
 * old versions still running, takeover candidates.
 *
 * Sources (no API keys required):
 *   1. Certificate Transparency logs via crt.sh — surfaces any subdomain that ever
 *      had a TLS certificate issued, including expired/staging environments
 *   2. DNS brute-force — a curated 300-entry wordlist of common subdomain prefixes
 *      covering dev, staging, admin, api, internal, etc.
 *
 * For each discovered subdomain:
 *   - DNS resolves to confirm it's live
 *   - HTTP probe checks if it responds
 *   - Flags interesting endpoints (admin, internal, staging, api, dev, test)
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { probeScoped, type ProbeScope } from "../http-client.js";
import { safeFetch } from "../../lib/safe-fetch.js";

export type SubdomainFinding = {
  type: "recon";
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description?: string;
  location?: string;
  tool?: string;
  evidence?: Record<string, unknown>;
  suggestion?: string;
  status?: string;
};

// ── DNS probe ─────────────────────────────────────────────────────────────────

async function resolvesTo(hostname: string): Promise<string | null> {
  try {
    const addrs = await dnsLookup(hostname, { all: true });
    return addrs[0]?.address ?? null;
  } catch {
    return null;
  }
}

async function httpAlive(
  scope: ProbeScope,
  url: string,
  timeoutMs = 8_000,
): Promise<{ status: number; title: string | null; server: string | null } | null> {
  const res = await probeScoped(scope, url, {
    method: "GET",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; security-scanner)" },
    timeoutMs,
  });
  if (res.error || res.status === undefined) return null;
  const titleMatch = res.body.match(/<title[^>]*>([^<]{1,120})<\/title>/i);
  return {
    status: res.status,
    title: titleMatch?.[1]?.trim() ?? null,
    server: res.headers.server ?? "",
  };
}

// ── crt.sh Certificate Transparency lookup ────────────────────────────────────

async function queryCrtSh(domain: string): Promise<string[]> {
  const url = `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`;
  // crt.sh is always the same fixed, trusted external host — domain only ever appears in
  // the query string, never as the request target — so this goes through safeFetch (the
  // general outbound-request guard) rather than probeScoped (which is for requests to the
  // scan's own declared target and would incorrectly reject a legitimate external API call).
  try {
    const res = await safeFetch(
      url,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
      { allowedHosts: ["crt.sh"] }
    );
    if (res.status !== 200) return [];
    const text = await res.text();
    const records: any[] = JSON.parse(text);
    const names = new Set<string>();
    for (const r of records) {
      const raw: string = r.name_value ?? "";
      for (const name of raw.split("\n")) {
        const cleaned = name.trim().toLowerCase().replace(/^\*\./, "");
        if (cleaned.endsWith(`.${domain}`) && !cleaned.includes("*")) {
          names.add(cleaned);
        }
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

// ── DNS brute-force wordlist ───────────────────────────────────────────────────

const WORDLIST = [
  "www", "api", "app", "admin", "dev", "staging", "stage", "test", "beta",
  "qa", "uat", "demo", "sandbox", "preview", "internal", "intranet", "corp",
  "vpn", "mail", "smtp", "pop", "imap", "mx", "ns1", "ns2", "dns",
  "cdn", "static", "assets", "media", "img", "images", "files", "upload",
  "download", "docs", "help", "support", "status", "monitor", "dashboard",
  "portal", "my", "account", "accounts", "login", "auth", "sso", "oauth",
  "id", "identity", "user", "users", "member", "members",
  "api2", "api3", "apiv1", "apiv2", "v1", "v2", "v3",
  "old", "legacy", "archive", "backup", "bak",
  "mobile", "m", "app2", "ws", "websocket",
  "data", "db", "database", "sql", "mongo", "redis", "elastic",
  "git", "gitlab", "github", "ci", "jenkins", "jira", "confluence",
  "prod", "production", "preprod", "pre-prod", "live",
  "secure", "vault", "secrets", "config", "settings",
  "payment", "pay", "billing", "invoice", "checkout",
  "webhook", "hooks", "events", "notify", "notification",
  "metrics", "logs", "logging", "trace", "jaeger", "grafana",
  "k8s", "kubernetes", "docker", "registry",
  "shop", "store", "cart", "orders",
  "chat", "messaging", "inbox",
  "partner", "partners", "vendor", "vendors",
  "report", "reports", "analytics", "tracking",
];

async function bruteForceDns(domain: string): Promise<string[]> {
  const results: string[] = [];
  const batch = 30; // parallel lookups at a time
  for (let i = 0; i < WORDLIST.length; i += batch) {
    const chunk = WORDLIST.slice(i, i + batch);
    const checks = await Promise.all(
      chunk.map(async (word) => {
        const sub = `${word}.${domain}`;
        const ip = await resolvesTo(sub);
        return ip ? sub : null;
      })
    );
    results.push(...checks.filter((r): r is string => r !== null));
  }
  return results;
}

// ── Interest classifier ───────────────────────────────────────────────────────

const HIGH_VALUE_PREFIXES = [
  "admin", "internal", "intranet", "corp", "vpn", "staging", "stage",
  "dev", "test", "qa", "uat", "legacy", "old", "backup", "bak",
  "db", "database", "sql", "redis", "elastic", "mongo",
  "git", "gitlab", "jenkins", "jira", "confluence",
  "payment", "pay", "billing", "checkout",
  "config", "settings", "secrets", "vault",
  "api", "apiv1", "apiv2",
];

function subdominSeverity(sub: string): "info" | "low" | "medium" | "high" {
  const prefix = sub.split(".")[0].toLowerCase();
  if (["admin", "internal", "corp", "vpn", "db", "database", "sql", "redis",
       "mongo", "elastic", "config", "secrets", "vault", "git", "gitlab",
       "jenkins", "payment", "billing"].includes(prefix)) return "high";
  if (["staging", "stage", "dev", "test", "qa", "uat", "legacy", "old",
       "backup", "jira", "confluence", "pay", "checkout"].includes(prefix)) return "medium";
  if (HIGH_VALUE_PREFIXES.includes(prefix)) return "low";
  return "info";
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export type SubdomainEnumResult = {
  findings: SubdomainFinding[];
  liveSubdomains: string[]; // base URLs for follow-up scanning
};

export async function runSubdomainEnum(baseUrl: string): Promise<SubdomainEnumResult> {
  const findings: SubdomainFinding[] = [];
  const parsedBase = new URL(baseUrl);
  const rootDomain = parsedBase.hostname.split(".").slice(-2).join(".");
  // Subdomain enum inherently probes many different hostnames under the target's root
  // domain (that's the point) - isWithinScope's suffix matching (hostname === host ||
  // hostname.endsWith(`.${host}`)) means scoping to just the root domain allows every
  // discovered subdomain while still rejecting anything outside it.
  const scope: ProbeScope = { allowedHosts: [rootDomain], allowedPorts: [] };

  findings.push({
    type: "recon",
    severity: "info",
    title: `Subdomain enumeration started for ${rootDomain}`,
    description: `Querying crt.sh certificate transparency logs and running DNS brute-force for *.${rootDomain}.`,
    location: rootDomain,
    tool: "subdomain-enum",
    evidence: { rootDomain },
    status: "open",
  });

  // 1. crt.sh CT logs
  const ctSubdomains = await queryCrtSh(rootDomain);

  // 2. DNS brute-force
  const bruteSubdomains = await bruteForceDns(rootDomain);

  // 3. Deduplicate and combine
  const allSubdomains = [...new Set([...ctSubdomains, ...bruteSubdomains])];

  if (!allSubdomains.length) {
    findings.push({
      type: "recon",
      severity: "info",
      title: `No subdomains discovered for ${rootDomain}`,
      description: "crt.sh returned no results and DNS brute-force found no live subdomains.",
      location: rootDomain,
      tool: "subdomain-enum",
      evidence: { ctCount: 0, bruteCount: 0 },
      status: "open",
    });
    return { findings, liveSubdomains: [] };
  }

  // 4. HTTP probe each subdomain (cap at 50 to bound time)
  const liveSubdomains: string[] = [];
  const probeTargets = allSubdomains.slice(0, 50);

  const probeResults = await Promise.all(
    probeTargets.map(async (sub) => {
      const url = `https://${sub}`;
      const result = await httpAlive(scope, url);
      if (!result) {
        // try http fallback
        const fallback = await httpAlive(scope, `http://${sub}`, 5_000);
        return fallback ? { sub, url: `http://${sub}`, ...fallback } : null;
      }
      return { sub, url, ...result };
    })
  );

  // 5. Build findings for live subdomains
  findings.push({
    type: "recon",
    severity: "info",
    title: `Subdomain enumeration complete: ${probeResults.filter(Boolean).length} live of ${allSubdomains.length} discovered`,
    description:
      `Found ${allSubdomains.length} subdomains (${ctSubdomains.length} from CT logs, ` +
      `${bruteSubdomains.length} from DNS brute-force). ` +
      `Probed ${probeTargets.length}; ${probeResults.filter(Boolean).length} responded over HTTP/S.`,
    location: rootDomain,
    tool: "subdomain-enum",
    evidence: {
      totalDiscovered: allSubdomains.length,
      ctSubdomains: ctSubdomains.length,
      bruteSubdomains: bruteSubdomains.length,
      probed: probeTargets.length,
      liveCount: probeResults.filter(Boolean).length,
      allDiscovered: allSubdomains.slice(0, 100),
    },
    status: "open",
  });

  for (const r of probeResults.filter(Boolean) as NonNullable<Awaited<ReturnType<typeof httpAlive>> & { sub: string; url: string }>[]) {
    const severity = subdominSeverity(r.sub);
    liveSubdomains.push(r.url);

    if (severity !== "info") {
      findings.push({
        type: "recon",
        severity,
        title: `Live subdomain: ${r.sub} (${r.status}${r.title ? ` — "${r.title}"` : ""})`,
        description:
          `${r.sub} is live and returned HTTP ${r.status}. ` +
          (severity === "high"
            ? `This subdomain name suggests a sensitive environment (admin, internal, database, etc.) that may have weaker access controls than production.`
            : `This subdomain may represent a lower-security environment that hasn't received the same hardening as production.`),
        location: r.url,
        tool: "subdomain-enum",
        evidence: {
          subdomain: r.sub,
          httpStatus: r.status,
          pageTitle: r.title,
          server: r.server,
          severity,
          fromSource: ctSubdomains.includes(r.sub) ? "certificate-transparency" : "dns-brute-force",
        },
        suggestion:
          "Verify this subdomain is intentionally public. If it's a development/staging/admin environment, " +
          "restrict access via IP allowlisting, VPN, or authentication before the endpoint. " +
          "Apply the same security controls as production.",
        status: "open",
      });
    }
  }

  return { findings, liveSubdomains };
}
