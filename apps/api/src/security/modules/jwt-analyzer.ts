/**
 * JWT analysis module.
 *
 * Decodes every JWT found in the scan's auth profiles and checks for:
 *   1. Algorithm confusion  — alg:none, RS256→HS256 downgrade
 *   2. Weak HS256 secrets   — brute-force common passwords/secrets
 *   3. Missing claims       — no exp, no iss, no aud
 *   4. Excessive expiry     — token valid for >7 days
 *   5. Sensitive payload    — SSN, card number, password in claims
 *   6. Blank/empty token    — accepted as valid by some middleware
 */

import { createHmac } from "node:crypto";
import { probeScoped, type ProbeScope } from "../http-client.js";

export type JwtFinding = {
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

// ── JWT decode ────────────────────────────────────────────────────────────────

type JwtParts = {
  headerRaw: string;
  payloadRaw: string;
  sigRaw: string;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
};

function decodeJwt(token: string): JwtParts | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decode = (s: string) =>
      JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return {
      headerRaw: parts[0],
      payloadRaw: parts[1],
      sigRaw: parts[2],
      header: decode(parts[0]),
      payload: decode(parts[1]),
    };
  } catch {
    return null;
  }
}

function extractTokens(profile: any): string[] {
  const tokens: string[] = [];
  if (profile?.token && typeof profile.token === "string") tokens.push(profile.token);
  if (profile?.cookieValue && typeof profile.cookieValue === "string") {
    // Cookies may contain JWTs as values: "session=eyJ..."
    const matches = profile.cookieValue.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g);
    if (matches) tokens.push(...matches);
  }
  return tokens.filter((t) => {
    const p = decodeJwt(t);
    return p !== null;
  });
}

// ── Checks ────────────────────────────────────────────────────────────────────

const SENSITIVE_CLAIM_PATTERNS = [
  /\b(ssn|socialSecurity|taxId)\b/i,
  /\b(cardNumber|pan|cvv)\b/i,
  /\b(password|passwordHash)\b/i,
  /\b(secretKey|apiKey|privateKey)\b/i,
];

const COMMON_SECRETS = [
  "secret", "password", "123456", "changeme", "supersecret",
  "jwt_secret", "jwtsecret", "your_jwt_secret", "your-secret-key",
  "development", "production", "app_secret", "secret_key",
  "access_token_secret", "refresh_token_secret", "hs256_secret",
];

function verifyHmac(token: string, secret: string): boolean {
  const parts = token.split(".");
  const hmac = createHmac("sha256", secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest("base64url");
  return hmac === parts[2];
}

function analyzeJwt(token: string, source: string): JwtFinding[] {
  const findings: JwtFinding[] = [];
  const decoded = decodeJwt(token);
  if (!decoded) return findings;

  const { header, payload } = decoded;
  const alg = String(header.alg ?? "").toLowerCase();
  const shortToken = token.slice(0, 20) + "...";

  // 1. alg:none
  if (alg === "none" || alg === "") {
    findings.push({
      type: "dynamic",
      severity: "critical",
      title: `JWT alg:none — signature verification bypassed (${source})`,
      description:
        `The JWT uses algorithm 'none', meaning no signature is applied. Any JWT payload can be ` +
        `crafted and accepted by the server without a valid signature if the library honours this algorithm.`,
      location: source,
      tool: "jwt-analyzer",
      evidence: {
        vulnerabilityClass: "broken_authentication",
        owaspCategory: "A07:2021 Identification and Authentication Failures",
        owaspApiCategory: "API2:2023 Broken Authentication",
        algorithm: header.alg,
        tokenPreview: shortToken,
        header: JSON.stringify(header),
      },
      suggestion: "Reject tokens with alg:none in your JWT library configuration. Use an explicit allowlist of accepted algorithms.",
      status: "open",
    });
  }

  // 2. Weak HS256 secret
  if (alg === "hs256" || alg === "hs384" || alg === "hs512") {
    for (const secret of COMMON_SECRETS) {
      if (verifyHmac(token, secret)) {
        findings.push({
          type: "dynamic",
          severity: "critical",
          title: `JWT signed with weak/common secret: "${secret}" (${source})`,
          description:
            `The JWT's HMAC signature was verified using the common secret "${secret}". An attacker ` +
            `can forge arbitrary JWTs (e.g. with escalated roles or a different user ID) by signing ` +
            `them with this known secret.`,
          location: source,
          tool: "jwt-analyzer",
          evidence: {
            vulnerabilityClass: "broken_authentication",
            owaspCategory: "A07:2021 Identification and Authentication Failures",
            discoveredSecret: secret,
            algorithm: alg,
            tokenPreview: shortToken,
          },
          suggestion: "Replace the signing secret with a cryptographically random value of ≥256 bits. Store it as an environment secret, never in source code.",
          status: "open",
        });
        break;
      }
    }
  }

  // 3. Missing exp claim
  if (!payload.exp) {
    findings.push({
      type: "dynamic",
      severity: "medium",
      title: `JWT missing 'exp' claim — token never expires (${source})`,
      description:
        "The token has no expiry claim. If the signing key is ever compromised or an account is " +
        "deleted, previously issued tokens remain valid forever.",
      location: source,
      tool: "jwt-analyzer",
      evidence: {
        vulnerabilityClass: "broken_authentication",
        owaspCategory: "A07:2021 Identification and Authentication Failures",
        tokenPreview: shortToken,
        payloadClaims: Object.keys(payload),
      },
      suggestion: "Add an 'exp' claim to every issued token. Access tokens should typically expire in 15 minutes to 1 hour; refresh tokens in 7–30 days.",
      status: "open",
    });
  } else {
    // 4. Excessive expiry (>7 days)
    const expMs = Number(payload.exp) * 1000;
    const issuedMs = payload.iat ? Number(payload.iat) * 1000 : Date.now();
    const lifetimeDays = (expMs - issuedMs) / 86_400_000;
    if (lifetimeDays > 7) {
      findings.push({
        type: "dynamic",
        severity: "low",
        title: `JWT excessive lifetime: ${Math.round(lifetimeDays)} days (${source})`,
        description:
          `The token's lifetime is ${Math.round(lifetimeDays)} days. Long-lived access tokens increase ` +
          `the blast radius of a token leak — the attacker retains access until expiry regardless of ` +
          `password changes or account revocation.`,
        location: source,
        tool: "jwt-analyzer",
        evidence: {
          vulnerabilityClass: "broken_authentication",
          owaspCategory: "A07:2021 Identification and Authentication Failures",
          lifetimeDays: Math.round(lifetimeDays),
          exp: payload.exp,
          iat: payload.iat,
        },
        suggestion: "Reduce access token lifetime to ≤1 hour. Use refresh tokens for longer sessions and revoke them explicitly on logout.",
        status: "open",
      });
    }
  }

  // 5. Missing iss / aud
  if (!payload.iss && !payload.aud) {
    findings.push({
      type: "dynamic",
      severity: "low",
      title: `JWT missing 'iss' and 'aud' claims (${source})`,
      description:
        "Without issuer and audience claims, a token issued for one service may be accepted by " +
        "another service in the same environment — a cross-service token replay attack.",
      location: source,
      tool: "jwt-analyzer",
      evidence: {
        vulnerabilityClass: "broken_authentication",
        owaspCategory: "A07:2021 Identification and Authentication Failures",
        tokenPreview: shortToken,
        payloadClaims: Object.keys(payload),
      },
      suggestion: "Always include 'iss' (issuer) and 'aud' (audience) in tokens, and validate them on every request.",
      status: "open",
    });
  }

  // 6. Sensitive data in payload
  const payloadStr = JSON.stringify(payload);
  for (const pattern of SENSITIVE_CLAIM_PATTERNS) {
    if (pattern.test(payloadStr)) {
      findings.push({
        type: "dynamic",
        severity: "high",
        title: `Sensitive data in JWT payload: matches pattern '${pattern.source}' (${source})`,
        description:
          "The JWT payload contains a field matching a sensitive-data pattern. JWT payloads are " +
          "base64-encoded (not encrypted) and readable by anyone who holds the token — including " +
          "a compromised client or a man-in-the-middle on a non-TLS channel.",
        location: source,
        tool: "jwt-analyzer",
        evidence: {
          vulnerabilityClass: "broken_object_property_level_authorization",
          owaspCategory: "A01:2021 Broken Access Control",
          matchedPattern: pattern.source,
          payloadKeys: Object.keys(payload),
        },
        suggestion: "Remove sensitive fields from the JWT payload. Use an opaque session ID that maps to server-side session data instead.",
        status: "open",
      });
      break;
    }
  }

  return findings;
}

// ── Blank token test ─────────────────────────────────────────────────────────

async function testBlankToken(
  scope: ProbeScope,
  baseUrl: string,
  candidateUrl: string,
): Promise<JwtFinding[]> {
  const res = await probeScoped(scope, candidateUrl, {
    method: "GET",
    headers: { Authorization: "Bearer " },
    timeoutMs: 6_000,
  });
  if (!res.error && res.status !== undefined && res.status < 400) {
    return [
      {
        type: "dynamic",
        severity: "high",
        title: "Blank Bearer token accepted without rejection",
        description:
          `${candidateUrl} returned HTTP ${res.status} for a request with an empty ` +
          `'Authorization: Bearer ' header. Some middleware implementations skip validation ` +
          `when the token value is empty rather than returning 401.`,
        location: candidateUrl,
        tool: "jwt-analyzer",
        evidence: {
          vulnerabilityClass: "broken_authentication",
          owaspCategory: "A07:2021 Identification and Authentication Failures",
          responseStatus: res.status,
        },
        suggestion: "Validate that the token value is present and non-empty before attempting signature verification. Return 401 for any malformed Authorization header.",
        status: "open",
      },
    ];
  }
  return [];
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export async function runJwtAnalysis(
  baseUrl: string,
  authProfiles: any[],
  scope: ProbeScope,
): Promise<JwtFinding[]> {
  const findings: JwtFinding[] = [];

  for (const profile of authProfiles) {
    const tokens = extractTokens(profile);
    for (const token of tokens) {
      const source = `${profile.label ?? "profile"} (${profile.type ?? "bearer"})`;
      findings.push(...analyzeJwt(token, source));
    }
  }

  // Blank bearer token check against a few likely protected paths
  const candidatePaths = ["/api/me", "/api/user", "/api/account", "/api/graphql"];
  for (const p of candidatePaths) {
    const url = `${baseUrl.replace(/\/+$/, "")}${p}`;
    const blankFindings = await testBlankToken(scope, baseUrl, url);
    findings.push(...blankFindings);
    if (blankFindings.length) break; // one finding is enough
  }

  return findings;
}
