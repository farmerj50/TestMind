import { createHmac } from "node:crypto";
import { safeFetch } from "../lib/safe-fetch.js";

// Real OAuth/IdP provider integrations for Enterprise mode: authenticate a test account
// directly against the provider's own token endpoint (Resource Owner Password Grant style),
// returning a bearer token to use for the scan — no browser automation, no bypass endpoint
// required on the target app. Each provider is its own small function; callers branch on
// SecurityAuthSession.provider.

export type ProviderAuthResult = { token: string; expiresIn?: number };

export async function authenticateAuth0(opts: {
  domain: string;
  clientId: string;
  clientSecret?: string;
  audience?: string;
  username: string;
  password: string;
}): Promise<ProviderAuthResult> {
  const domain = opts.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const url = `https://${domain}/oauth/token`;
  const res = await safeFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "password",
        username: opts.username,
        password: opts.password,
        client_id: opts.clientId,
        ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
        ...(opts.audience ? { audience: opts.audience } : {}),
        scope: "openid profile email",
      }),
    },
    { allowedHosts: [domain] }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Auth0 token request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Auth0 response was not valid JSON.");
  }
  if (!parsed.access_token || typeof parsed.access_token !== "string") {
    throw new Error("Auth0 response is missing access_token.");
  }
  return { token: parsed.access_token, expiresIn: typeof parsed.expires_in === "number" ? parsed.expires_in : undefined };
}

export async function authenticateFirebase(opts: {
  apiKey: string;
  email: string;
  password: string;
}): Promise<ProviderAuthResult> {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(opts.apiKey)}`;
  const res = await safeFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: opts.email, password: opts.password, returnSecureToken: true }),
    },
    { allowedHosts: ["identitytoolkit.googleapis.com"] }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Firebase auth request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Firebase response was not valid JSON.");
  }
  if (!parsed.idToken || typeof parsed.idToken !== "string") {
    throw new Error("Firebase response is missing idToken.");
  }
  return { token: parsed.idToken, expiresIn: parsed.expiresIn ? Number(parsed.expiresIn) : undefined };
}

export async function authenticateCognito(opts: {
  region: string;
  clientId: string;
  clientSecret?: string;
  username: string;
  password: string;
}): Promise<ProviderAuthResult> {
  const host = `cognito-idp.${opts.region}.amazonaws.com`;
  const authParameters: Record<string, string> = {
    USERNAME: opts.username,
    PASSWORD: opts.password,
  };
  if (opts.clientSecret) {
    // SECRET_HASH = Base64(HMAC-SHA256(clientSecret, username + clientId)) — required when the
    // Cognito app client is configured with a client secret.
    authParameters.SECRET_HASH = createHmac("sha256", opts.clientSecret)
      .update(opts.username + opts.clientId)
      .digest("base64");
  }
  const res = await safeFetch(
    `https://${host}/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: opts.clientId,
        AuthParameters: authParameters,
      }),
    },
    { allowedHosts: [host] }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Cognito InitiateAuth failed (${res.status}): ${text.slice(0, 300)}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Cognito response was not valid JSON.");
  }
  if (parsed.ChallengeName) {
    throw new Error(
      `Cognito requires an additional challenge (${parsed.ChallengeName}) — provider-authenticate only supports direct USER_PASSWORD_AUTH. Use a test account without MFA/forced-password-change.`
    );
  }
  const idToken = parsed.AuthenticationResult?.IdToken;
  if (!idToken || typeof idToken !== "string") {
    throw new Error("Cognito response is missing AuthenticationResult.IdToken.");
  }
  return {
    token: idToken,
    expiresIn: typeof parsed.AuthenticationResult?.ExpiresIn === "number" ? parsed.AuthenticationResult.ExpiresIn : undefined,
  };
}

function extractSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function mergeCookieJar(jar: Map<string, string>, setCookies: string[]) {
  for (const sc of setCookies) {
    const pair = sc.split(";")[0] ?? "";
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// Clerk's sign-in flow is not a single password-grant call like the other providers — it's a
// stateful, cookie-tracked, multi-step exchange against Clerk's "Frontend API" (the same one
// clerk-js uses): create a sign-in attempt, submit the password as its first factor, then mint
// a session token. This mirrors documented Clerk Frontend API behavior, but Clerk doesn't treat
// this as a stable public contract the way Auth0/Firebase/Cognito do — if Clerk changes response
// shapes, this will need updating. Only single-factor (password, no MFA) test accounts work here.
export async function authenticateClerk(opts: {
  frontendApiUrl: string;
  identifier: string;
  password: string;
  origin?: string;
}): Promise<ProviderAuthResult> {
  const base = opts.frontendApiUrl.replace(/\/+$/, "");
  const host = new URL(base).hostname;
  const jar = new Map<string, string>();
  const baseHeaders: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (opts.origin) baseHeaders.Origin = opts.origin;

  let res = await safeFetch(
    `${base}/v1/client/sign_ins`,
    {
      method: "POST",
      headers: baseHeaders,
      body: new URLSearchParams({ identifier: opts.identifier }).toString(),
    },
    { allowedHosts: [host] }
  );
  mergeCookieJar(jar, extractSetCookies(res));
  let text = await res.text();
  if (!res.ok) throw new Error(`Clerk sign-in creation failed (${res.status}): ${text.slice(0, 300)}`);
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Clerk sign-in response was not valid JSON.");
  }
  const signInId = parsed?.response?.id;
  if (!signInId || typeof signInId !== "string") {
    throw new Error("Clerk sign-in response is missing response.id.");
  }

  res = await safeFetch(
    `${base}/v1/client/sign_ins/${signInId}/attempt_first_factor`,
    {
      method: "POST",
      headers: { ...baseHeaders, Cookie: cookieHeader(jar) },
      body: new URLSearchParams({ strategy: "password", password: opts.password }).toString(),
    },
    { allowedHosts: [host] }
  );
  mergeCookieJar(jar, extractSetCookies(res));
  text = await res.text();
  if (!res.ok) throw new Error(`Clerk password verification failed (${res.status}): ${text.slice(0, 300)}`);
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Clerk attempt_first_factor response was not valid JSON.");
  }
  const status = parsed?.response?.status;
  const sessionId = parsed?.response?.created_session_id;
  if (status !== "complete" || !sessionId || typeof sessionId !== "string") {
    throw new Error(
      `Clerk sign-in did not complete (status="${status ?? "unknown"}"). The test account may require a second factor, which provider-authenticate does not support.`
    );
  }

  res = await safeFetch(
    `${base}/v1/client/sessions/${sessionId}/tokens`,
    {
      method: "POST",
      headers: { ...baseHeaders, Cookie: cookieHeader(jar) },
    },
    { allowedHosts: [host] }
  );
  text = await res.text();
  if (!res.ok) throw new Error(`Clerk session token request failed (${res.status}): ${text.slice(0, 300)}`);
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Clerk session token response was not valid JSON.");
  }
  const jwt = parsed?.jwt;
  if (!jwt || typeof jwt !== "string") {
    throw new Error("Clerk session token response is missing jwt.");
  }
  return { token: jwt };
}
