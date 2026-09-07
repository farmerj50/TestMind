import { SECRET_KEY_PATTERN } from "./redaction.js";

// Live Security Testing v1, Ticket LST.1. This module never returns raw matched values - only
// which categories were detected and, for JSON key matches, the offending key name - so its own
// output is always safe to log or pass around without itself becoming a new leak vector. Callers
// (Ticket LST.3's circuit breaker) build any human-facing evidence excerpt separately through
// the existing redaction.ts snippet()/probeEvidence() convention, never from this module.
//
// This is deliberately NOT a general PII/health-data detector - free-text personal or health
// information isn't reliably regex-matchable, and a naive attempt would either miss real
// exposures or drown the circuit breaker in false positives. This module only covers shapes that
// ARE reliably pattern-matchable: named credential/token/secret fields, JWT-shaped strings,
// Luhn-valid credit-card-shaped digit sequences, and SSN-shaped sequences. See the frozen LST
// contract's NOT INCLUDED list - this boundary is disclosed, not a TODO to quietly forget.

export type SensitiveDataCategory = "credential" | "jwt" | "credit_card" | "ssn";

export type SensitiveDataMatch = {
  category: SensitiveDataCategory;
  /** Only present for JSON key-name matches (the "credential" category) - the offending key,
   * never the value. */
  fieldName?: string;
};

export type SensitiveDataScanResult = {
  sensitive: boolean;
  matches: SensitiveDataMatch[];
};

const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

// SSN format only (###-##-####) - a bare 9-digit run is too generic on its own (order numbers,
// phone numbers, etc.) to be a reliable signal; the dashed format is specific enough to trust.
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

// Candidate digit runs for credit-card detection, allowing space/dash separators the way cards
// are commonly displayed (e.g. "4111 1111 1111 1111" or "4111-1111-1111-1111").
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;

// The same key=value / "key": value shape redaction.ts's redactText() matches, reused here for
// DETECTION (not redaction) so non-JSON bodies (HTML, query strings, plain text) are covered too,
// not just parsed JSON objects.
const SECRET_KEY_VALUE_RE = new RegExp(`(${SECRET_KEY_PATTERN.source})\\s*[:=]\\s*["']?([^"',\\s;}]+)`, "gi");

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

function scanTextShapes(text: string, matches: SensitiveDataMatch[]) {
  if (JWT_RE.test(text)) matches.push({ category: "jwt" });
  JWT_RE.lastIndex = 0;

  if (SSN_RE.test(text)) matches.push({ category: "ssn" });
  SSN_RE.lastIndex = 0;

  let cardMatch: RegExpExecArray | null;
  while ((cardMatch = CARD_CANDIDATE_RE.exec(text)) !== null) {
    const digits = cardMatch[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      matches.push({ category: "credit_card" });
      break; // one confirmed hit is enough to flag the category
    }
  }
  CARD_CANDIDATE_RE.lastIndex = 0;

  let secretMatch: RegExpExecArray | null;
  while ((secretMatch = SECRET_KEY_VALUE_RE.exec(text)) !== null) {
    if (secretMatch[2]) matches.push({ category: "credential", fieldName: secretMatch[1] });
  }
  SECRET_KEY_VALUE_RE.lastIndex = 0;
}

function scanJsonKeys(value: unknown, matches: SensitiveDataMatch[]) {
  if (value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) scanJsonKeys(item, matches);
    return;
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key) && val != null && val !== "") {
      matches.push({ category: "credential", fieldName: key });
      continue;
    }
    scanJsonKeys(val, matches);
  }
}

/**
 * Scans a response body (raw text, and - when it happens to parse as JSON - also by key name)
 * for reliably-detectable sensitive-data shapes. Used by Ticket LST.3's circuit breaker after
 * every active probe response, and directly testable in isolation here.
 */
export function scanForSensitiveData(bodyText: string): SensitiveDataScanResult {
  const matches: SensitiveDataMatch[] = [];
  if (!bodyText) return { sensitive: false, matches };

  scanTextShapes(bodyText, matches);

  try {
    const parsed = JSON.parse(bodyText);
    scanJsonKeys(parsed, matches);
  } catch {
    // Not JSON (or not parseable) - the text-shape scan above already covers this body.
  }

  return { sensitive: matches.length > 0, matches };
}
