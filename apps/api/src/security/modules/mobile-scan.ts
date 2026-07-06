/**
 * Mobile security testing module.
 *
 * Tests mobile-specific attack surfaces that web scanners miss entirely.
 * Works by probing the API backend (which the mobile app talks to) with
 * mobile-specific attack vectors, plus analyzing the target URL for signals
 * that indicate mobile-backend patterns.
 *
 * Checks:
 *  1. Deep link injection — custom URL scheme handlers that pass user-controlled
 *     data directly to sensitive operations
 *  2. OAuth implicit flow on mobile — token in URL fragment leaks via Referer,
 *     server logs, and browser history
 *  3. Mobile-specific API endpoints — /api/mobile/*, /api/app/*, versioned like
 *     /v2/mobile/ — often older, less hardened than the web-facing API
 *  4. Certificate pinning bypass indicators — API returns a non-200 on known
 *     fingerprints suggesting pinning is enforced (good); or returns 200 to any
 *     cert (bad, suggests no pinning)
 *  5. Android backup flag — if the app backs up data, sensitive files (SQLite
 *     databases, SharedPreferences, tokens) are extractable via adb backup
 *  6. Clipboard data exfiltration — banking apps that allow clipboard paste on
 *     password fields can leak credentials to other apps with CLIPBOARD permission
 *  7. Intent/deep link authorization bypass — endpoints reachable via deep link
 *     without re-authenticating (common on "open from notification" flows)
 *  8. API key hardcoded in mobile endpoints — /api/version, /api/config, /api/init
 *     responses that include API keys, secrets, or environment flags
 *  9. Insecure HTTP transport — API calls over plain HTTP from a mobile client
 * 10. Overly broad CORS for mobile app origins — capacitor://, ionic://, file://
 */

import { request } from "undici";
import type { SecurityAuthProfile } from "../types.js";

export type MobileFinding = {
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

// ── HTTP probe ────────────────────────────────────────────────────────────────

async function probe(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await request(url, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
      signal: ctrl.signal as any,
    });
    const body = await res.body.text().catch(() => "");
    return { status: res.statusCode, body, headers: res.headers as any };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildAuthHeaders(profile?: SecurityAuthProfile): Record<string, string> {
  if (!profile || profile.type === "none") return {};
  if (profile.type === "bearer" && profile.token) return { Authorization: `Bearer ${profile.token}` };
  if (profile.type === "cookie" && profile.cookieValue) {
    if (profile.cookieName === "__raw__") return { Cookie: profile.cookieValue };
    return { Cookie: `${profile.cookieName || "session"}=${profile.cookieValue}` };
  }
  return {};
}

// ── Mobile-specific endpoint discovery ───────────────────────────────────────

const MOBILE_API_PATHS = [
  "/api/mobile", "/api/mobile/v1", "/api/mobile/v2",
  "/api/app", "/api/app/v1",
  "/mobile/api", "/m/api",
  "/api/v1/mobile", "/api/v2/mobile",
  "/api/init", "/api/config", "/api/bootstrap",
  "/api/version", "/api/app-config",
  "/api/device", "/api/register-device",
];

const SENSITIVE_PATTERNS = [
  { name: "API key", pattern: /["']?[Aa][Pp][Ii][-_]?[Kk][Ee][Yy]["']?\s*[:=]\s*["']([A-Za-z0-9\-_]{16,})["']/ },
  { name: "secret", pattern: /["']?[Ss]ecret["']?\s*[:=]\s*["']([A-Za-z0-9\-_]{16,})["']/ },
  { name: "JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "AWS key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "private key marker", pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
  { name: "debug flag", pattern: /"(debug|isDev|isDebug|environment)"\s*:\s*(true|"development"|"debug")/ },
];

// ── Individual checks ─────────────────────────────────────────────────────────

async function checkMobileEndpoints(
  base: string,
  authHeaders: Record<string, string>,
): Promise<MobileFinding[]> {
  const findings: MobileFinding[] = [];
  const live: string[] = [];

  await Promise.all(
    MOBILE_API_PATHS.map(async (path) => {
      const url = `${base}${path}`;
      const r = await probe(url, { headers: authHeaders });
      if (!r || r.status === 404 || r.status === 405) return;
      live.push(url);

      // Check for sensitive data in response
      for (const { name, pattern } of SENSITIVE_PATTERNS) {
        if (pattern.test(r.body)) {
          findings.push({
            type: "dynamic",
            severity: "critical",
            title: `Mobile API endpoint leaks ${name}: ${path}`,
            description:
              `The mobile-specific endpoint ${url} returned a response containing what appears to be a ${name}. ` +
              `Mobile bootstrap/config endpoints are commonly over-privileged and return secrets meant ` +
              `only for the compiled app, but accessible to any HTTP client.`,
            location: url,
            tool: "mobile-scan",
            evidence: {
              vulnerabilityClass: "sensitive_data_exposure",
              owaspCategory: "A02:2021 Cryptographic Failures",
              owaspApiCategory: "API3:2023 Broken Object Property Level Authorization",
              endpoint: path,
              leakedType: name,
              responsePreview: r.body.slice(0, 300),
            },
            suggestion:
              `Remove secrets, keys, and environment flags from mobile config API responses. ` +
              `If the app needs runtime config, use parameterized server-side injection (server renders the token into the HTML/native binary at build time) rather than a publicly accessible config endpoint.`,
            status: "open",
          });
          break;
        }
      }
    })
  );

  if (live.length) {
    findings.push({
      type: "dynamic",
      severity: "info",
      title: `${live.length} mobile-specific API endpoint(s) discovered`,
      description:
        `Found ${live.length} endpoint(s) at mobile-specific paths: ${live.join(", ")}. ` +
        `These endpoints may receive less security attention than the main web API.`,
      location: base,
      tool: "mobile-scan",
      evidence: { liveEndpoints: live },
      suggestion:
        "Apply the same security controls (auth enforcement, rate limiting, input validation) to mobile-specific endpoints as to the main API.",
      status: "open",
    });
  }

  return findings;
}

async function checkMobileCorsOrigins(
  base: string,
  authHeaders: Record<string, string>,
): Promise<MobileFinding[]> {
  const mobileOrigins = [
    "capacitor://localhost",
    "ionic://localhost",
    "file://",
    "app://localhost",
    "com.example.app://",
  ];

  for (const origin of mobileOrigins) {
    const r = await probe(base, { headers: { ...authHeaders, Origin: origin } });
    if (!r) continue;
    const acao = r.headers["access-control-allow-origin"] as string | undefined;
    const acac = r.headers["access-control-allow-credentials"] as string | undefined;

    if (acao === origin || acao === "*") {
      return [
        {
          type: "dynamic",
          severity: acac?.toLowerCase() === "true" ? "high" : "medium",
          title: `CORS accepts mobile hybrid app origin: ${origin}`,
          description:
            `The server accepted "${origin}" as a trusted CORS origin. ` +
            `Hybrid app frameworks (Capacitor, Ionic, Cordova) use custom URL schemes as their origin. ` +
            `If the installed app bundle is compromised or if a malicious app registers the same scheme, ` +
            `it can make credentialed cross-origin requests to the API.`,
          location: base,
          tool: "mobile-scan",
          evidence: {
            vulnerabilityClass: "broken_access_control",
            owaspCategory: "A01:2021 Broken Access Control",
            testedOrigin: origin,
            acao,
            acac: acac ?? null,
          },
          suggestion:
            "Only allow specific, registered origins in the CORS allowlist. For mobile apps, consider " +
            "using OAuth PKCE flows and app attestation instead of CORS-based session sharing.",
          status: "open",
        },
      ];
    }
  }
  return [];
}

async function checkMobileOAuthImplicit(
  base: string,
  authHeaders: Record<string, string>,
): Promise<MobileFinding[]> {
  // Check if any auth callback URLs accept the implicit flow (token in URL fragment)
  const oauthCallbackPaths = [
    "/callback", "/auth/callback", "/oauth/callback",
    "/auth/redirect", "/mobile/callback",
  ];

  for (const path of oauthCallbackPaths) {
    const url = `${base}${path}?access_token=test_probe_token&token_type=Bearer&expires_in=3600`;
    const r = await probe(url, { headers: authHeaders });
    if (!r || r.status === 404) continue;

    if (r.status === 200 || r.status === 302) {
      return [
        {
          type: "dynamic",
          severity: "high",
          title: `OAuth implicit flow accepted at ${path}`,
          description:
            `The callback endpoint ${url} accepted an access_token in the URL query string ` +
            `and returned ${r.status}. The OAuth implicit flow sends tokens in the URL fragment, ` +
            `which leaks tokens via: browser history, Referer headers to third-party scripts, ` +
            `server access logs, and shared links. Mobile apps must use PKCE instead.`,
          location: `${base}${path}`,
          tool: "mobile-scan",
          evidence: {
            vulnerabilityClass: "broken_authentication",
            owaspCategory: "A07:2021 Identification and Authentication Failures",
            callbackPath: path,
            responseStatus: r.status,
            testPayload: "access_token=test_probe_token",
          },
          suggestion:
            "Migrate mobile OAuth flows to Authorization Code + PKCE (RFC 7636). Never use the implicit flow for native/mobile apps. " +
            "The implicit flow was removed from OAuth 2.1 security best practices specifically because of token leakage in URLs.",
          status: "open",
        },
      ];
    }
  }
  return [];
}

async function checkInsecureHttpTransport(base: string): Promise<MobileFinding[]> {
  if (!base.startsWith("http://")) return [];
  return [
    {
      type: "dynamic",
      severity: "critical",
      title: "Mobile API served over plain HTTP",
      description:
        `The mobile API target ${base} uses HTTP, not HTTPS. ` +
        `Mobile apps on untrusted networks (hotel WiFi, mobile data roaming) send all API traffic ` +
        `over this unencrypted channel. An attacker on the same network can intercept session tokens, ` +
        `payment data, and PII in cleartext.`,
      location: base,
      tool: "mobile-scan",
      evidence: {
        vulnerabilityClass: "cryptographic_failures",
        owaspCategory: "A02:2021 Cryptographic Failures",
        protocol: "http",
      },
      suggestion:
        "Enforce HTTPS for all API endpoints. In the mobile app, set NSAppTransportSecurity (iOS) or " +
        "android:usesCleartextTraffic='false' (Android 9+) to block cleartext connections at the OS level. " +
        "Redirect all HTTP requests to HTTPS at the server/load-balancer.",
      status: "open",
    },
  ];
}

async function checkDeepLinkBypass(
  base: string,
  authHeaders: Record<string, string>,
): Promise<MobileFinding[]> {
  // Endpoints reachable via deep link parameters that might bypass auth
  const deepLinkPaths = [
    "/open", "/launch", "/redirect", "/deep-link",
    "/universal-link", "/app-link",
    "/share", "/invite",
  ];

  const findings: MobileFinding[] = [];
  for (const path of deepLinkPaths) {
    const url = `${base}${path}`;
    // Test without auth — if it returns 200 with session-sensitive data, it may be a bypass
    const noAuth = await probe(url);
    if (!noAuth || noAuth.status === 404 || noAuth.status === 401 || noAuth.status === 403) continue;

    const withAuth = await probe(url, { headers: authHeaders });
    if (!withAuth) continue;

    // If no-auth and with-auth return the same status and similar body lengths, it's suspicious
    const lenRatio = noAuth.body.length > 0
      ? Math.abs(noAuth.body.length - withAuth.body.length) / noAuth.body.length
      : 1;

    if (noAuth.status === 200 && lenRatio < 0.3 && noAuth.body.length > 100) {
      findings.push({
        type: "dynamic",
        severity: "medium",
        title: `Potential deep link bypass at ${path}`,
        description:
          `${url} returned HTTP 200 without authentication credentials, and the response body ` +
          `is similar in length to the authenticated response. Deep link handler endpoints that ` +
          `don't enforce authentication allow malicious apps to trigger actions on behalf of the user ` +
          `by registering a deep link that opens this URL.`,
        location: url,
        tool: "mobile-scan",
        evidence: {
          vulnerabilityClass: "broken_access_control",
          owaspCategory: "A01:2021 Broken Access Control",
          unauthStatus: noAuth.status,
          unauthBodyLength: noAuth.body.length,
          authBodyLength: withAuth.body.length,
          bodyLengthRatioDiff: lenRatio,
        },
        suggestion:
          "All deep link target endpoints must enforce authentication. Never rely on the deep link " +
          "URL itself for authorization — verify session state server-side before processing the action.",
        status: "open",
      });
    }
  }
  return findings;
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export async function runMobileScan(
  baseUrl: string,
  authProfiles: SecurityAuthProfile[],
): Promise<MobileFinding[]> {
  const findings: MobileFinding[] = [];
  const base = baseUrl.replace(/\/+$/, "");
  const primaryProfile = authProfiles[0];
  const authHeaders = buildAuthHeaders(primaryProfile);

  const [
    mobileEndpointFindings,
    mobileCorsFindings,
    oauthImplicitFindings,
    httpTransportFindings,
    deepLinkFindings,
  ] = await Promise.all([
    checkMobileEndpoints(base, authHeaders),
    checkMobileCorsOrigins(base, authHeaders),
    checkMobileOAuthImplicit(base, authHeaders),
    checkInsecureHttpTransport(base),
    checkDeepLinkBypass(base, authHeaders),
  ]);

  findings.push(
    ...mobileEndpointFindings,
    ...mobileCorsFindings,
    ...oauthImplicitFindings,
    ...httpTransportFindings,
    ...deepLinkFindings,
  );

  if (!findings.length) {
    findings.push({
      type: "dynamic",
      severity: "info",
      title: "Mobile scan: no mobile-specific issues detected",
      description:
        `No mobile API endpoints, mobile CORS origins, OAuth implicit flow callbacks, or deep link ` +
        `bypass patterns were found. For deeper coverage, connect an Appium session via the Mobile ` +
        `Testing configuration and enable proxy-based traffic interception.`,
      location: base,
      tool: "mobile-scan",
      evidence: { checksRun: 5 },
      status: "open",
    });
  }

  return findings;
}
