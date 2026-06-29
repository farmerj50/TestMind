import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { ensureClient } from "../agent/openai.js";
import { prisma } from "../prisma.js";

const MODEL = process.env.AGENT_MODEL || "gpt-4o";
type Sev = "info" | "low" | "medium" | "high";

// ── Auth config ───────────────────────────────────────────────────────────────

type AuthConfig = {
  type: "none" | "bearer" | "cookie" | "basic";
  token?: string;
  cookieName?: string;
  cookieValue?: string;
  username?: string;
  password?: string;
  testObjectId?: string; // own resource ID for IDOR baseline
};

function buildAuthHeaders(auth: AuthConfig): Record<string, string> {
  if (auth.type === "bearer" && auth.token)
    return { Authorization: `Bearer ${auth.token}` };
  if (auth.type === "cookie" && auth.cookieValue)
    return { Cookie: `${auth.cookieName || "session"}=${auth.cookieValue}` };
  if (auth.type === "basic" && auth.username && auth.password)
    return { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` };
  return {};
}

// ── Types ─────────────────────────────────────────────────────────────────────

type HeaderFinding  = { header: string; value: string | null; issue: string; severity: Sev };
type PathFinding    = { path: string; status: number; issue: string; severity: Sev };
type CorsFinding    = { requestOrigin: string; allowOrigin: string | null; allowCredentials: string | null; issue: string; severity: Sev };
type CookieFinding  = { cookie: string; issue: string; severity: Sev };
type AccessFinding  = { url: string; unauthStatus: number; authStatus: number | null; issue: string; severity: Sev };
type IdorFinding    = { originalUrl: string; testUrl: string; originalId: string; testId: string; originalStatus: number; testStatus: number; issue: string; severity: Sev };
type JwtFinding     = { issue: string; severity: Sev };

type JwtAnalysis = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  findings: JwtFinding[];
  expiresAt: string | null;
  algorithm: string | null;
};

type ProbeResults = {
  targetUrl: string;
  finalUrl: string;
  responseStatus: number;
  serverInfo: Record<string, string>;
  rawHeaders: Record<string, string>;
  headerFindings: HeaderFinding[];
  corsFindings: CorsFinding[];
  pathFindings: PathFinding[];
  cookieFindings: CookieFinding[];
  accessFindings: AccessFinding[];
  idorFindings: IdorFinding[];
  jwtAnalysis: JwtAnalysis | null;
};

// ── Security header checks ────────────────────────────────────────────────────

function checkSecurityHeaders(headers: Record<string, string>): HeaderFinding[] {
  const findings: HeaderFinding[] = [];
  const h = (name: string) => headers[name.toLowerCase()] ?? null;
  const csp = h("content-security-policy");

  if (!h("strict-transport-security"))
    findings.push({ header: "Strict-Transport-Security", value: null, issue: "Missing HSTS — connections can be downgraded to HTTP", severity: "medium" });
  else if (!h("strict-transport-security")!.includes("includeSubDomains"))
    findings.push({ header: "Strict-Transport-Security", value: h("strict-transport-security"), issue: "HSTS does not include subdomains", severity: "low" });

  if (!csp)
    findings.push({ header: "Content-Security-Policy", value: null, issue: "Missing CSP — no XSS mitigation policy", severity: "high" });
  else {
    if (csp.includes("unsafe-inline")) findings.push({ header: "Content-Security-Policy", value: csp, issue: "CSP allows unsafe-inline — XSS protection weakened", severity: "medium" });
    if (csp.includes("unsafe-eval"))  findings.push({ header: "Content-Security-Policy", value: csp, issue: "CSP allows unsafe-eval — XSS protection weakened", severity: "medium" });
    if (csp.includes("*"))            findings.push({ header: "Content-Security-Policy", value: csp, issue: "CSP contains wildcard source — overly permissive", severity: "low" });
  }

  if (!h("x-frame-options") && !csp?.includes("frame-ancestors"))
    findings.push({ header: "X-Frame-Options", value: null, issue: "No clickjacking protection (X-Frame-Options or CSP frame-ancestors)", severity: "medium" });
  if (!h("x-content-type-options"))
    findings.push({ header: "X-Content-Type-Options", value: null, issue: "Missing X-Content-Type-Options — MIME sniffing possible", severity: "low" });
  if (!h("referrer-policy"))
    findings.push({ header: "Referrer-Policy", value: null, issue: "Missing Referrer-Policy — sensitive URL data may leak", severity: "low" });

  const server = h("server");
  if (server) findings.push({ header: "Server", value: server, issue: `Server version disclosed: ${server}`, severity: "info" });
  const xpb = h("x-powered-by");
  if (xpb)   findings.push({ header: "X-Powered-By", value: xpb, issue: `Technology stack disclosed: ${xpb}`, severity: "info" });

  return findings;
}

// ── CORS probe ────────────────────────────────────────────────────────────────

async function probeCors(targetUrl: string, authHeaders: Record<string, string>): Promise<CorsFinding[]> {
  const findings: CorsFinding[] = [];
  for (const origin of ["https://evil.com", "null", "https://attacker.example.com"]) {
    try {
      const res = await fetch(targetUrl, {
        headers: { ...authHeaders, Origin: origin },
        signal: AbortSignal.timeout(8000),
      });
      const ao = res.headers.get("access-control-allow-origin");
      const ac = res.headers.get("access-control-allow-credentials");
      if (!ao) continue;
      if (ao === "*")
        findings.push({ requestOrigin: origin, allowOrigin: ao, allowCredentials: ac, issue: "CORS wildcard — any origin can read responses", severity: "medium" });
      else if (ao === origin) {
        const sev: Sev = ac === "true" ? "high" : "medium";
        findings.push({ requestOrigin: origin, allowOrigin: ao, allowCredentials: ac, issue: ac === "true"
          ? "CORS reflects attacker origin AND allows credentials — cross-origin authenticated requests possible"
          : `CORS reflects arbitrary origin: ${origin}`, severity: sev });
      } else if (ao === "null")
        findings.push({ requestOrigin: origin, allowOrigin: ao, allowCredentials: ac, issue: "CORS allows null origin — sandbox iframe attacks possible", severity: "medium" });
    } catch { /* skip */ }
  }
  return findings;
}

// ── Sensitive path probe ──────────────────────────────────────────────────────

const SENSITIVE_PATHS: { path: string; issue: string; severity: Sev }[] = [
  { path: "/.git/config",            issue: "Git repo exposed — source code downloadable",                         severity: "high"   },
  { path: "/.env",                   issue: ".env exposed — may contain API keys and DB credentials",              severity: "high"   },
  { path: "/.env.local",             issue: ".env.local exposed",                                                  severity: "high"   },
  { path: "/wp-config.php",          issue: "WordPress config exposed",                                            severity: "high"   },
  { path: "/config.php",             issue: "PHP config file accessible",                                          severity: "high"   },
  { path: "/backup.sql",             issue: "Database backup accessible",                                          severity: "high"   },
  { path: "/backup.zip",             issue: "Site backup archive accessible",                                      severity: "high"   },
  { path: "/phpinfo.php",            issue: "phpinfo() exposed — full server config visible",                      severity: "high"   },
  { path: "/server-status",          issue: "Apache server-status exposed — reveals internal request log",         severity: "medium" },
  { path: "/api/swagger.json",       issue: "Swagger spec exposed — full API surface visible",                     severity: "medium" },
  { path: "/api/openapi.json",       issue: "OpenAPI spec exposed",                                               severity: "medium" },
  { path: "/swagger-ui.html",        issue: "Swagger UI exposed",                                                  severity: "medium" },
  { path: "/.DS_Store",              issue: ".DS_Store exposed — directory tree reconstructable",                  severity: "low"    },
  { path: "/robots.txt",             issue: "robots.txt found — disallowed paths may reveal hidden structure",     severity: "info"   },
  { path: "/sitemap.xml",            issue: "Sitemap found — full route map available",                            severity: "info"   },
  { path: "/api/health",             issue: "Health endpoint exposed — may disclose versions/dependencies",        severity: "info"   },
  { path: "/api/version",            issue: "Version endpoint exposed",                                            severity: "info"   },
  { path: "/.well-known/security.txt", issue: "security.txt present — review contacts/policies",                  severity: "info"   },
];

async function probeSensitivePaths(targetUrl: string, authHeaders: Record<string, string>): Promise<PathFinding[]> {
  const origin = new URL(targetUrl).origin;
  const findings: PathFinding[] = [];
  await Promise.all(SENSITIVE_PATHS.map(async ({ path, issue, severity }) => {
    try {
      const res = await fetch(`${origin}${path}`, { headers: authHeaders, redirect: "follow", signal: AbortSignal.timeout(8000) });
      if (res.status === 200 || res.status === 206)
        findings.push({ path: `${origin}${path}`, status: res.status, issue, severity });
      else if ((res.status === 401 || res.status === 403) && severity === "high")
        findings.push({ path: `${origin}${path}`, status: res.status, issue: `${issue} (exists but auth-protected)`, severity: "low" });
    } catch { /* skip */ }
  }));
  return findings;
}

// ── Cookie security check ─────────────────────────────────────────────────────

async function checkCookieSecurity(targetUrl: string, authHeaders: Record<string, string>): Promise<CookieFinding[]> {
  const findings: CookieFinding[] = [];
  try {
    const res = await fetch(targetUrl, { headers: authHeaders, redirect: "follow", signal: AbortSignal.timeout(10000) });
    const rawCookies: string[] = (res.headers as any).getSetCookie?.() ?? [];
    // fallback for runtimes without getSetCookie
    if (rawCookies.length === 0) {
      const single = res.headers.get("set-cookie");
      if (single) rawCookies.push(...single.split(/,(?=[^;]+=[^;]+)/));
    }
    for (const cookie of rawCookies) {
      const name = cookie.split("=")[0].trim();
      const lc   = cookie.toLowerCase();
      if (!lc.includes("httponly"))         findings.push({ cookie: name, issue: "Missing HttpOnly — cookie readable via JavaScript (XSS theft)", severity: "medium" });
      if (!lc.includes("secure"))           findings.push({ cookie: name, issue: "Missing Secure flag — cookie transmitted over plain HTTP", severity: "medium" });
      if (!lc.includes("samesite"))         findings.push({ cookie: name, issue: "Missing SameSite — vulnerable to CSRF attacks", severity: "medium" });
      else if (lc.includes("samesite=none"))findings.push({ cookie: name, issue: "SameSite=None — cookie sent on all cross-site requests", severity: "low" });
      if (lc.includes("samesite=lax") && lc.includes("secure") && !lc.includes("httponly"))
        findings.push({ cookie: name, issue: "SameSite=Lax without HttpOnly — CSRF mitigated but XSS theft still possible", severity: "low" });
    }
  } catch { /* skip */ }
  return findings;
}

// ── Broken access control ─────────────────────────────────────────────────────

const AUTH_REQUIRED_PATHS = [
  "/api/me", "/api/profile", "/api/account", "/api/user", "/api/users",
  "/api/admin", "/api/settings", "/api/dashboard", "/api/billing",
  "/api/orders", "/api/transactions", "/api/payments", "/api/keys",
  "/dashboard", "/admin", "/settings", "/account", "/profile",
];

async function checkBrokenAccess(targetUrl: string, authHeaders: Record<string, string>): Promise<AccessFinding[]> {
  const findings: AccessFinding[] = [];
  const origin = new URL(targetUrl).origin;
  const hasAuth = Object.keys(authHeaders).length > 0;

  // Test target URL: check if it's accessible without auth when auth is configured
  if (hasAuth) {
    try {
      const [unauth, authed] = await Promise.all([
        fetch(targetUrl, { redirect: "follow", signal: AbortSignal.timeout(8000) }),
        fetch(targetUrl, { headers: authHeaders, redirect: "follow", signal: AbortSignal.timeout(8000) }),
      ]);
      if (unauth.status === 200 && authed.status === 200) {
        const [unauthBody, authBody] = await Promise.all([unauth.text(), authed.text()]);
        if (unauthBody === authBody)
          findings.push({ url: targetUrl, unauthStatus: 200, authStatus: 200, issue: "Target returns identical 200 with and without credentials — endpoint does not enforce authentication", severity: "high" });
        else
          findings.push({ url: targetUrl, unauthStatus: 200, authStatus: 200, issue: "Target returns 200 without auth but response differs — partial auth enforcement, review carefully", severity: "medium" });
      }
    } catch { /* skip */ }
  }

  // Test common sensitive paths without auth
  await Promise.all(AUTH_REQUIRED_PATHS.map(async (path) => {
    const url = `${origin}${path}`;
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(6000) });
      if (res.status === 200) {
        // Confirm the endpoint also works with auth (exists) before flagging
        const sev: Sev = hasAuth ? "high" : "medium";
        findings.push({ url, unauthStatus: 200, authStatus: null, issue: `${path} returns 200 without credentials — broken access control`, severity: sev });
      }
    } catch { /* skip */ }
  }));

  return findings;
}

// ── IDOR probe ────────────────────────────────────────────────────────────────

async function checkIdor(targetUrl: string, authHeaders: Record<string, string>, testObjectId?: string): Promise<IdorFinding[]> {
  const findings: IdorFinding[] = [];
  if (Object.keys(authHeaders).length === 0) return findings; // IDOR only meaningful with auth

  const url = new URL(targetUrl);
  const segments = url.pathname.split("/");

  // Collect candidate numeric ID positions
  const idPositions: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (/^\d{1,10}$/.test(segments[i]) && parseInt(segments[i]) > 0) idPositions.push(i);
    if (testObjectId && segments[i] === testObjectId) idPositions.push(i);
  }
  if (idPositions.length === 0) return findings;

  // Fetch baseline — the authorized resource
  let baselineBody: string;
  let baselineStatus: number;
  try {
    const base = await fetch(targetUrl, { headers: authHeaders, redirect: "follow", signal: AbortSignal.timeout(10000) });
    baselineStatus = base.status;
    baselineBody = await base.text();
  } catch { return findings; }

  if (baselineStatus !== 200) return findings; // no baseline to compare against

  for (const pos of idPositions) {
    const originalId = segments[pos];
    const numId = parseInt(originalId);
    const candidates = isNaN(numId)
      ? ["1", "2", "100"]
      : [String(numId + 1), String(numId - 1), String(numId + 100), "1"].filter(id => id !== originalId && parseInt(id) > 0);

    for (const candidateId of candidates) {
      const testSegments = [...segments];
      testSegments[pos] = candidateId;
      const testUrl = `${url.origin}${testSegments.join("/")}${url.search}`;
      try {
        const res = await fetch(testUrl, { headers: authHeaders, redirect: "follow", signal: AbortSignal.timeout(8000) });
        if (res.status === 200) {
          const body = await res.text();
          if (body !== baselineBody && body.length > 50) {
            findings.push({
              originalUrl: targetUrl,
              testUrl,
              originalId,
              testId: candidateId,
              originalStatus: baselineStatus,
              testStatus: res.status,
              issue: `ID ${candidateId} returns a different 200 response — possible IDOR: server returned a different object without verifying ownership`,
              severity: "high",
            });
          }
        }
      } catch { /* skip */ }
    }
  }
  return findings;
}

// ── JWT analysis ──────────────────────────────────────────────────────────────

function analyzeJwt(token: string): JwtAnalysis | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header  = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf-8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as Record<string, unknown>;
    const findings: JwtFinding[] = [];

    const alg = String(header.alg ?? "");
    if (alg === "none" || alg === "")
      findings.push({ issue: "JWT uses 'none' algorithm — signature verification bypassed", severity: "high" });
    else if (alg.startsWith("HS"))
      findings.push({ issue: `JWT uses symmetric ${alg} — if secret is weak or leaked, tokens can be forged`, severity: "medium" });

    const exp = typeof payload.exp === "number" ? payload.exp : null;
    let expiresAt: string | null = null;
    if (!exp) {
      findings.push({ issue: "JWT has no exp claim — tokens never expire", severity: "high" });
    } else {
      expiresAt = new Date(exp * 1000).toISOString();
      const daysLeft = (exp * 1000 - Date.now()) / 86_400_000;
      if (daysLeft < 0)
        findings.push({ issue: "JWT is already expired — server may not be validating expiry", severity: "high" });
      else if (daysLeft > 30)
        findings.push({ issue: `JWT expires in ${Math.round(daysLeft)} days — excessively long-lived token`, severity: "medium" });
    }

    if (!payload.iat)
      findings.push({ issue: "JWT has no iat (issued-at) claim — replay detection harder", severity: "low" });

    // Sensitive data in payload
    const sensitiveKeys = ["password", "secret", "key", "ssn", "card", "cvv", "pin"];
    for (const key of sensitiveKeys) {
      if (Object.keys(payload).some(k => k.toLowerCase().includes(key)))
        findings.push({ issue: `JWT payload contains sensitive field name: "${key}" — verify this is not stored insecurely client-side`, severity: "medium" });
    }

    // Role claims
    if (payload.role || payload.roles || payload.admin || payload.is_admin || payload.scope)
      findings.push({ issue: "JWT carries role/scope claims — verify server re-validates these on every request, not just on the client", severity: "low" });

    // Sanitize payload (mask long strings)
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      sanitized[k] = typeof v === "string" && v.length > 80 ? v.slice(0, 60) + "…[truncated]" : v;
    }

    return { header, payload: sanitized, findings, expiresAt, algorithm: alg || null };
  } catch {
    return null;
  }
}

// ── Main probe orchestrator ───────────────────────────────────────────────────

async function probeTarget(targetUrl: string, auth: AuthConfig): Promise<ProbeResults> {
  const authHeaders = buildAuthHeaders(auth);

  const mainRes = await fetch(targetUrl, {
    headers: { "User-Agent": "TestMind-ResearchAgent/1.0", ...authHeaders },
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });

  const rawHeaders: Record<string, string> = {};
  mainRes.headers.forEach((v, k) => { rawHeaders[k] = v; });

  const serverInfo: Record<string, string> = {};
  for (const h of ["server", "x-powered-by", "via", "x-cache", "cf-ray"]) {
    const v = mainRes.headers.get(h);
    if (v) serverInfo[h] = v;
  }

  // JWT analysis from bearer token
  const jwtAnalysis = auth.type === "bearer" && auth.token ? analyzeJwt(auth.token) : null;

  const [headerFindings, corsFindings, pathFindings, cookieFindings, accessFindings, idorFindings] = await Promise.all([
    Promise.resolve(checkSecurityHeaders(rawHeaders)),
    probeCors(targetUrl, authHeaders),
    probeSensitivePaths(targetUrl, authHeaders),
    checkCookieSecurity(targetUrl, authHeaders),
    checkBrokenAccess(targetUrl, authHeaders),
    checkIdor(targetUrl, authHeaders, auth.testObjectId),
  ]);

  return {
    targetUrl,
    finalUrl: mainRes.url,
    responseStatus: mainRes.status,
    serverInfo,
    rawHeaders,
    headerFindings,
    corsFindings,
    pathFindings,
    cookieFindings,
    accessFindings,
    idorFindings,
    jwtAnalysis,
  };
}

// ── Route ─────────────────────────────────────────────────────────────────────

export default async function researchAgentRoutes(app: FastifyInstance) {
  app.post("/research-agent/analyze", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { programName, programRules, targetUrl, featureOrFlow, notes, auth } = (req.body ?? {}) as {
      programName?: string;
      programRules?: string;
      targetUrl?: string;
      featureOrFlow?: string;
      notes?: string;
      auth?: AuthConfig;
    };

    if (!programName || !programRules || !targetUrl || !featureOrFlow)
      return reply.code(400).send({ error: "programName, programRules, targetUrl, and featureOrFlow are required" });

    let probe: ProbeResults;
    try {
      probe = await probeTarget(targetUrl, auth ?? { type: "none" });
    } catch (err: any) {
      return reply.code(502).send({ error: `Could not reach target: ${err?.message}` });
    }

    const totalFindings =
      probe.headerFindings.length + probe.corsFindings.length + probe.pathFindings.length +
      probe.cookieFindings.length + probe.accessFindings.length + probe.idorFindings.length +
      (probe.jwtAnalysis?.findings.length ?? 0);

    const openai = ensureClient();

    const prompt = `You are a rules-bound security research assistant. You have REAL passive and authenticated scan results from an automated probe. Interpret these findings against the program scope and produce a prioritized, actionable report.

Rules:
- Base every risk area on an ACTUAL finding from the probe data — do not fabricate issues.
- Do NOT suggest destructive payloads, brute force, credential attacks against real users, or mass scanning.
- The researcher uses approved test accounts only.

Return ONLY valid JSON:
{
  "scopeStatus": "in_scope | out_of_scope | unclear",
  "summary": string,
  "riskAreas": [
    {
      "area": string,
      "actualFinding": string,
      "whyItMatters": string,
      "severity": "info | low | medium | high",
      "reportability": "low | medium | high",
      "manualVerificationSteps": [
        {
          "step": number,
          "action": string,
          "expectedResult": string,
          "tool": "Browser DevTools | curl | Burp Suite | browser address bar | JWT.io | Postman"
        }
      ]
    }
  ],
  "reportDraft": {
    "title": string,
    "impact": string,
    "stepsToReproduce": string[],
    "evidenceNeeded": string[]
  }
}

For manualVerificationSteps: 2-5 concrete steps a researcher can follow RIGHT NOW to confirm exploitability. Each step needs exact actions (open DevTools → Network tab → inspect header X), and what a vulnerable vs safe response looks like.

=== PROGRAM ===
Name: ${programName}
Rules:
${programRules}

=== TARGET ===
URL: ${targetUrl}
Final URL (after redirects): ${probe.finalUrl}
HTTP Status: ${probe.responseStatus}
Auth type used: ${auth?.type ?? "none"}
Feature / Flow: ${featureOrFlow}
Notes: ${notes || "None"}
Total probe findings: ${totalFindings}

=== SERVER INFO ===
${JSON.stringify(probe.serverInfo, null, 2)}

=== SECURITY HEADERS (${probe.headerFindings.length} issues) ===
${JSON.stringify(probe.headerFindings, null, 2)}

=== CORS (${probe.corsFindings.length} issues) ===
${JSON.stringify(probe.corsFindings, null, 2)}

=== COOKIE SECURITY (${probe.cookieFindings.length} issues) ===
${JSON.stringify(probe.cookieFindings, null, 2)}

=== BROKEN ACCESS CONTROL (${probe.accessFindings.length} issues) ===
${JSON.stringify(probe.accessFindings, null, 2)}

=== IDOR (${probe.idorFindings.length} issues) ===
${JSON.stringify(probe.idorFindings, null, 2)}

=== JWT ANALYSIS ===
${probe.jwtAnalysis ? JSON.stringify(probe.jwtAnalysis, null, 2) : "No JWT token provided"}

=== SENSITIVE PATHS (${probe.pathFindings.length} found) ===
${JSON.stringify(probe.pathFindings, null, 2)}`;

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a responsible security research assistant. Only analyze observed findings. Return only valid JSON." },
        { role: "user", content: prompt },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? "{}";
    let result: unknown;
    try {
      result = JSON.parse(raw);
    } catch {
      return reply.code(502).send({ error: "LLM returned invalid JSON" });
    }

    return reply.send({ ...(result as object), probe });
  });

  // ── Saved programs CRUD ──────────────────────────────────────────────────────

  app.get("/research-agent/programs", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const programs = await prisma.researchProgram.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, targetUrl: true, featureOrFlow: true, programRules: true, notes: true, createdAt: true, updatedAt: true },
    });
    return reply.send({ programs });
  });

  app.post("/research-agent/programs", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { name, programRules, targetUrl, featureOrFlow, notes } = (req.body ?? {}) as {
      name?: string; programRules?: string; targetUrl?: string; featureOrFlow?: string; notes?: string;
    };
    if (!name || !programRules || !targetUrl || !featureOrFlow)
      return reply.code(400).send({ error: "name, programRules, targetUrl, and featureOrFlow are required" });

    const program = await prisma.researchProgram.create({
      data: { userId, name, programRules, targetUrl, featureOrFlow, notes },
    });
    return reply.code(201).send({ program });
  });

  app.delete("/research-agent/programs/:id", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const { id } = req.params as { id: string };
    const existing = await prisma.researchProgram.findUnique({ where: { id }, select: { userId: true } });
    if (!existing) return reply.code(404).send({ error: "Program not found" });
    if (existing.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

    await prisma.researchProgram.delete({ where: { id } });
    return reply.send({ ok: true });
  });
}
