// Exported (Live Security Testing v1, Ticket LST.1) so sensitive-data.ts's key-name detection
// reuses this exact pattern rather than maintaining a second, driftable copy.
export const SECRET_KEY_PATTERN =
  /(authorization|bearer|token|cookie|password|secret|api[-_]?key|session|jwt|credential)/i;

const JWT_SHAPE_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const SSN_SHAPE_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// Redacts value-shaped sensitive data (JWTs, Luhn-valid card numbers, SSNs) in addition to the
// key-named-secret redaction below. Conceptually mirrors security/sensitive-data.ts's DETECTION
// patterns (that module can't import these back from here - it already imports
// SECRET_KEY_PATTERN from this file, and this file must stay dependency-free of it to avoid a
// cycle) - keep the two in sync if either changes. Added for Live Security Testing v1's
// sensitive-data circuit breaker (Ticket LST.3): its evidence is built through this same
// snippet()/redactText() convention every other check in this codebase already uses, so a
// stop-triggering response's raw card/SSN/JWT value must never survive into stored evidence.
export function redactText(value: string): string {
  let out = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/]+=*/gi, "Basic [REDACTED]")
    .replace(
      /(token|password|secret|api[-_]?key|session|jwt|cookie)\s*[:=]\s*["']?[^"',\s;}]+/gi,
      "$1=[REDACTED]"
    )
    .replace(/([A-Za-z0-9_%-]+)=([^;\s]{12,})/g, "$1=[REDACTED]")
    .replace(JWT_SHAPE_RE, "[REDACTED-JWT]")
    .replace(SSN_SHAPE_RE, "[REDACTED-SSN]");

  out = out.replace(CARD_CANDIDATE_RE, (match) => (luhnValid(match.replace(/[ -]/g, "")) ? "[REDACTED-CARD]" : match));

  return out;
}

export function redactJson<T>(input: T): T {
  if (input == null) return input;
  if (typeof input === "string") return redactText(input) as T;
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map((item) => redactJson(item)) as T;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = value ? "[REDACTED]" : value;
      continue;
    }
    out[key] = redactJson(value);
  }
  return out as T;
}

export function snippet(value: string, maxLength = 220): string {
  const compact = redactText(value).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength)}...[truncated]`;
}

export function redactAuthProfileForStorage(profile: Record<string, unknown>) {
  const copy = { ...profile };
  delete copy.token;
  delete copy.cookieValue;
  delete copy.password;
  return redactJson(copy);
}
