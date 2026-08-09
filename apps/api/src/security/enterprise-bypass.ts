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

// ---------------------------------------------------------------------------
// Multi-mode session capture parsers
// ---------------------------------------------------------------------------

export type CaptureFormat = "raw_http" | "curl" | "cookies";

export type ParsedAuthCapture = {
  cookieString: string | null;
  rawHeaders: Record<string, string>;
  additionalHeaders: Record<string, string>;
  baseUrl: string | null;
  preferredEndpoint?: string;
  preferredMethod?: string;
  preferredBody?: string;
  preferredOperation?: string;
  warnings: string[];
};

const AUTH_HEADER_NAMES = new Set([
  "authorization",
  "x-csrf-token",
  "x-xsrf-token",
  "x-requested-with",
  "origin",
  "referer",
]);

const CANONICAL_HEADER_NAMES: Record<string, string> = {
  authorization: "Authorization",
  "x-csrf-token": "X-CSRF-Token",
  "x-xsrf-token": "X-XSRF-Token",
  "x-requested-with": "X-Requested-With",
  origin: "Origin",
  referer: "Referer",
  "content-type": "Content-Type",
  host: "Host",
  "user-agent": "User-Agent",
  accept: "Accept",
};

function canonicalizeHeaderKey(key: string): string {
  const known = CANONICAL_HEADER_NAMES[key.toLowerCase()];
  if (known) return known;
  return key
    .split("-")
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : ""))
    .join("-");
}

export function detectCaptureFormat(text: string): CaptureFormat {
  const t = text.trimStart();
  if (/^curl\s/i.test(t)) return "curl";
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\s+\S+\s+HTTP\//i.test(t))
    return "raw_http";
  return "cookies";
}

export function parseRawHttpRequest(raw: string): ParsedAuthCapture {
  const warnings: string[] = [];
  const rawHeaders: Record<string, string> = {};
  const additionalHeaders: Record<string, string> = {};
  let cookieString: string | null = null;
  let baseUrl: string | null = null;
  let preferredEndpoint: string | undefined;
  let preferredMethod: string | undefined;
  let preferredBody: string | undefined;
  let preferredOperation: string | undefined;

  // Split on first blank line → headers vs body
  const blankLineMatch = raw.match(/(\r?\n)(\r?\n)/);
  const splitIdx = blankLineMatch ? raw.indexOf(blankLineMatch[0]) + blankLineMatch[1].length : -1;
  const headerSection = splitIdx === -1 ? raw : raw.slice(0, splitIdx);
  const bodySection =
    splitIdx === -1
      ? ""
      : raw
          .slice(splitIdx + (blankLineMatch?.[2].length ?? 0))
          .trim();

  if (bodySection) preferredBody = bodySection.slice(0, 16384);

  const lines = headerSection.split(/\r?\n/);

  // First line: METHOD /path HTTP/version
  const firstLine = lines[0]?.trim() ?? "";
  const reqMatch = firstLine.match(/^(\w+)\s+(\S+)\s+HTTP\//i);
  if (reqMatch) {
    preferredMethod = reqMatch[1].toUpperCase();
    preferredEndpoint = reqMatch[2];
  }

  // Header lines
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const colonIdx = line.indexOf(": ");
    if (colonIdx === -1) {
      // Try single colon without space
      const altIdx = line.indexOf(":");
      if (altIdx === -1) continue;
      const rawKey = line.slice(0, altIdx).toLowerCase().trim();
      const value = line.slice(altIdx + 1).trim();
      processHeader(rawKey, value, {
        rawHeaders, additionalHeaders,
        onCookie: (v) => { cookieString = v; },
        onHost: (v) => { baseUrl = `https://${v}`; },
      });
      continue;
    }
    const rawKey = line.slice(0, colonIdx).toLowerCase().trim();
    const value = line.slice(colonIdx + 2).trim();
    processHeader(rawKey, value, {
      rawHeaders, additionalHeaders,
      onCookie: (v) => { cookieString = v; },
      onHost: (v) => { baseUrl = `https://${v}`; },
    });
  }

  // GraphQL operation detection
  if (preferredEndpoint && /graphql/i.test(preferredEndpoint) && preferredBody) {
    preferredOperation = extractGraphqlOperation(preferredBody);
  }

  if (!cookieString) warnings.push("No Cookie header found");
  if (!additionalHeaders["Authorization"]) warnings.push("No Authorization header found");
  if (!baseUrl) warnings.push("No Host header found — base URL unknown");

  return {
    cookieString, rawHeaders, additionalHeaders, baseUrl,
    preferredEndpoint, preferredMethod, preferredBody, preferredOperation, warnings,
  };
}

export function parseCurlCommand(curl: string): ParsedAuthCapture {
  const warnings: string[] = [];
  const rawHeaders: Record<string, string> = {};
  const additionalHeaders: Record<string, string> = {};
  let cookieString: string | null = null;
  let baseUrl: string | null = null;
  let preferredEndpoint: string | undefined;
  let preferredMethod: string | undefined;
  let preferredBody: string | undefined;
  let preferredOperation: string | undefined;

  const tokens = tokenizeCurl(curl);
  let i = 0;
  if (tokens[0]?.toLowerCase() === "curl") i++;

  // Flags that consume the next token as their argument
  const ONE_ARG_FLAGS = new Set([
    "--connect-timeout", "-m", "--max-time", "-o", "--output",
    "-w", "--write-out", "--proxy", "-x", "--cacert", "--cert",
    "--key", "-u", "--user", "--max-filesize", "-e", "--referer-str",
    "--dns-servers", "--interface", "--limit-rate",
  ]);
  // Flags that take no argument
  const NO_ARG_FLAGS = new Set([
    "-s", "--silent", "-v", "--verbose", "-k", "--insecure",
    "-L", "--location", "--compressed", "-i", "--include",
    "-I", "--head", "-G", "--get", "--http1.1", "--http2",
    "--no-keepalive", "-f", "--fail", "--fail-with-body",
  ]);

  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok === "-H" || tok === "--header") {
      const hdr = tokens[++i] ?? "";
      const colonIdx = hdr.indexOf(": ");
      const altIdx = colonIdx === -1 ? hdr.indexOf(":") : -1;
      const splitAt = colonIdx !== -1 ? colonIdx : altIdx;
      if (splitAt !== -1) {
        const rawKey = hdr.slice(0, splitAt).toLowerCase().trim();
        const value = hdr.slice(splitAt + (colonIdx !== -1 ? 2 : 1)).trim();
        if (rawKey === "cookie") {
          cookieString = cookieString ? `${cookieString}; ${value}` : value;
        } else {
          processHeader(rawKey, value, {
            rawHeaders, additionalHeaders,
            onCookie: (v) => { cookieString = cookieString ? `${cookieString}; ${v}` : v; },
            onHost: () => {},
          });
        }
      }
    } else if (tok === "-b" || tok === "--cookie") {
      const val = tokens[++i] ?? "";
      cookieString = cookieString ? `${cookieString}; ${val}` : val;
    } else if (tok === "-X" || tok === "--request") {
      preferredMethod = (tokens[++i] ?? "").toUpperCase();
    } else if (tok === "-d" || tok === "--data" || tok === "--data-raw" || tok === "--data-ascii" || tok === "--data-binary") {
      preferredBody = (tokens[++i] ?? "").slice(0, 16384);
    } else if (tok === "--url") {
      const urlStr = tokens[++i] ?? "";
      extractUrlParts(urlStr, (base, endpoint) => {
        baseUrl = base;
        preferredEndpoint = endpoint;
      });
    } else if (NO_ARG_FLAGS.has(tok)) {
      // No argument, just skip
    } else if (ONE_ARG_FLAGS.has(tok)) {
      i++; // skip argument
    } else if (!tok.startsWith("-")) {
      // Bare URL
      extractUrlParts(tok, (base, endpoint) => {
        if (!baseUrl) { baseUrl = base; preferredEndpoint = endpoint; }
      });
    }
    i++;
  }

  // Infer POST if body present and no explicit method
  if (!preferredMethod && preferredBody) preferredMethod = "POST";

  // GraphQL detection
  if (preferredEndpoint && /graphql/i.test(preferredEndpoint) && preferredBody) {
    preferredOperation = extractGraphqlOperation(preferredBody);
  }

  // Remove Cookie from rawHeaders if it snuck in
  delete rawHeaders["Cookie"];

  if (!cookieString) warnings.push("No Cookie header found");
  if (!additionalHeaders["Authorization"]) warnings.push("No Authorization header found");
  if (!baseUrl) warnings.push("No Host header found — base URL unknown");

  return {
    cookieString, rawHeaders, additionalHeaders, baseUrl,
    preferredEndpoint, preferredMethod, preferredBody, preferredOperation, warnings,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function processHeader(
  rawKey: string,
  value: string,
  callbacks: {
    rawHeaders: Record<string, string>;
    additionalHeaders: Record<string, string>;
    onCookie: (v: string) => void;
    onHost: (v: string) => void;
  }
) {
  if (rawKey === "cookie") { callbacks.onCookie(value); return; }
  if (rawKey === "host") { callbacks.onHost(value); return; }
  const canonKey = canonicalizeHeaderKey(rawKey);
  callbacks.rawHeaders[canonKey] = value;
  if (AUTH_HEADER_NAMES.has(rawKey)) {
    callbacks.additionalHeaders[canonKey] = value;
  }
}

function extractUrlParts(url: string, cb: (base: string, endpoint: string) => void) {
  try {
    const u = new URL(url);
    cb(`${u.protocol}//${u.host}`, `${u.pathname}${u.search}`);
  } catch {
    // Not a valid URL — ignore
  }
}

function extractGraphqlOperation(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.operationName === "string" && parsed.operationName) {
      return parsed.operationName;
    }
  } catch {
    // Not JSON
  }
  return undefined;
}

function tokenizeCurl(curl: string): string[] {
  // Normalize backslash-newline continuations
  const normalized = curl.replace(/\\\r?\n/g, " ");
  const tokens: string[] = [];
  let i = 0;

  while (i < normalized.length) {
    // Skip whitespace
    while (i < normalized.length && /\s/.test(normalized[i])) i++;
    if (i >= normalized.length) break;

    const ch = normalized[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let buf = "";
      while (i < normalized.length && normalized[i] !== quote) {
        if (normalized[i] === "\\" && quote === '"') {
          i++;
          buf += normalized[i] ?? "";
        } else {
          buf += normalized[i];
        }
        i++;
      }
      if (i < normalized.length) i++; // closing quote
      tokens.push(buf);
    } else {
      let start = i;
      while (i < normalized.length && !/\s/.test(normalized[i])) i++;
      tokens.push(normalized.slice(start, i));
    }
  }

  return tokens;
}
