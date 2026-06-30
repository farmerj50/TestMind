import { probeScoped } from "./http-client.js";

// Client side of the "test-only auth bypass" contract a target app can implement for
// Enterprise mode security scanning. The target app owns enforcing its own guard rails
// (NODE_ENV !== production, TESTMIND_AUTH_BYPASS_ENABLED=true, shared-secret check,
// IP/CI/staging allowlist) — this module is just the caller.
//
// Contract:
//   POST {baseUrl}/testmind/auth/session
//   Headers: X-TestMind-Shared-Secret: <shared secret>
//   Body:    { "role": "admin" | "user" | ... }
//   200:     { "role": "...", "sessionCookie": "name=value; name2=value2", "expiresAt": "<ISO8601>" }
//   401/403: shared secret missing/invalid, or bypass not enabled on this environment
//   404:     bypass endpoint not implemented on the target app

const BYPASS_PATH = "/testmind/auth/session";

export type BypassResult = {
  role: string;
  sessionCookie: string;
  expiresAt: string | null;
};

export async function callAuthBypassEndpoint(opts: {
  baseUrl: string;
  sharedSecret: string;
  role?: string;
}): Promise<BypassResult> {
  const base = new URL(opts.baseUrl);
  const allowedHosts = [base.hostname];
  const allowedPorts = [base.port ? Number(base.port) : base.protocol === "https:" ? 443 : 80];
  const endpoint = new URL(BYPASS_PATH, opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`).toString();

  const result = await probeScoped(
    { allowedHosts, allowedPorts },
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TestMind-Shared-Secret": opts.sharedSecret },
      body: JSON.stringify({ role: opts.role ?? "admin" }),
      timeoutMs: 10_000,
      profile: "enterprise-auth-bypass",
    }
  );

  if (result.error) throw new Error(`Bypass endpoint request failed: ${result.error}`);
  if (result.status === 404) throw new Error("Target app has no /testmind/auth/session bypass endpoint configured.");
  if (result.status === 401 || result.status === 403) {
    throw new Error("Bypass endpoint rejected the shared secret. Check TESTMIND_SHARED_SECRET / TESTMIND_AUTH_BYPASS_ENABLED on the target app.");
  }
  if (!result.status || result.status < 200 || result.status >= 300) {
    throw new Error(`Bypass endpoint returned unexpected status ${result.status ?? "(none)"}.`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new Error("Bypass endpoint did not return valid JSON.");
  }
  if (!parsed?.sessionCookie || typeof parsed.sessionCookie !== "string") {
    throw new Error("Bypass endpoint response is missing sessionCookie.");
  }
  return {
    role: typeof parsed.role === "string" ? parsed.role : opts.role ?? "admin",
    sessionCookie: parsed.sessionCookie,
    expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
  };
}

export function buildStorageStateFromCookieString(cookieStr: string, baseUrl: string) {
  const url = new URL(baseUrl);
  const cookies = cookieStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      if (idx === -1) return null;
      return {
        name: pair.slice(0, idx).trim(),
        value: pair.slice(idx + 1).trim(),
        domain: url.hostname,
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: url.protocol === "https:",
        sameSite: "Lax" as const,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
  return { cookies, origins: [] as any[] };
}
