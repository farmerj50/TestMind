// Types and ID-detection shared between the Live Security Testing session
// (live-security-session.ts) and the existing IDOR engine (modules/idor-engine.ts).
//
// idor-engine.ts's harvestIds() extracts IDs embedded in JSON *response bodies* (a
// different operation — scanning free text for occurrences) using global, unanchored
// patterns. detectResourceIdCandidates() below checks whether a single *URL path segment
// or query value* looks like a resource id (an anchored, single-value check). Both are
// built from the same ID-shape definitions so the two never drift apart, even though the
// functions themselves can't be literally merged — they operate on different inputs.

export type SecurityHttpExchange = {
  id: string;
  sessionId: string;
  timestamp: number;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    postData?: string;
  };
  response?: {
    status: number;
    headers: Record<string, string>;
    body?: string;
    durationMs: number;
  };
  // Set when a forwarded input event preceded this request within the session's
  // correlation window — see live-security-session.ts.
  correlatedActionId?: string;
};

export type ResourceIdCandidate = {
  location: "path" | "query";
  paramName: string;
  value: string;
};

// Same ID shapes idor-engine.ts's UUID_PATTERN/CUID_PATTERN match, expressed as global,
// unanchored patterns for scanning free text (response bodies). Exported so idor-engine.ts
// imports these instead of defining its own copies.
export const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export const CUID_PATTERN = /\bc[a-z0-9]{24,}\b/g;

// Anchored single-value versions of the same shapes, for checking one URL segment/query
// value at a time (as opposed to scanning a larger body of text for all occurrences).
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUID_SHAPE = /^c[a-z0-9]{24,}$/i;
const NUMERIC_ID_SHAPE = /^\d{2,}$/;

export function looksLikeResourceId(value: string): boolean {
  return UUID_SHAPE.test(value) || CUID_SHAPE.test(value) || NUMERIC_ID_SHAPE.test(value);
}

// Scans a captured request URL's path segments and query parameters for values that look
// like resource identifiers — the candidates a "Test this ID" mutation experiment can
// target. Never inspects headers or body (those aren't exposed as mutable candidates).
export function detectResourceIdCandidates(url: string): ResourceIdCandidate[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  const candidates: ResourceIdCandidate[] = [];

  const segments = parsed.pathname.split("/").filter(Boolean);
  segments.forEach((segment, index) => {
    if (looksLikeResourceId(segment)) {
      candidates.push({ location: "path", paramName: `segment${index}`, value: segment });
    }
  });

  for (const [key, value] of parsed.searchParams.entries()) {
    if (looksLikeResourceId(value)) {
      candidates.push({ location: "query", paramName: key, value });
    }
  }

  return candidates;
}

// Applies exactly one candidate mutation to a URL, leaving everything else unchanged.
// Used by experiment.ts to build the mutated request from a server-validated candidate.
export function applyResourceIdMutation(url: string, candidate: ResourceIdCandidate, newValue: string): string {
  const parsed = new URL(url);
  if (candidate.location === "query") {
    parsed.searchParams.set(candidate.paramName, newValue);
    return parsed.toString();
  }
  const index = Number(candidate.paramName.replace("segment", ""));
  const segments = parsed.pathname.split("/");
  let seen = -1;
  for (let i = 0; i < segments.length; i++) {
    if (!segments[i]) continue;
    seen++;
    if (seen === index) {
      segments[i] = newValue;
      break;
    }
  }
  parsed.pathname = segments.join("/");
  return parsed.toString();
}

// Live Security Testing v1, Ticket LST.4. Body-level counterpart to detectResourceIdCandidates/
// applyResourceIdMutation above - needed because an IDOR/BOLA hypothesis on a PUT/PATCH/POST
// endpoint often carries the resource id in a JSON body field, not the URL, and preserving the
// real method (Ticket LST.4's whole point) is worthless if the id being tested is still only
// ever mutated in the URL. `path` is a structural array (not a string) so re-applying the
// mutation never has to re-parse a path expression - it just walks the same keys it found.
export type BodyResourceIdCandidate = {
  location: "body";
  /** Human-readable dotted path, for display/evidence only - e.g. "order.id" or "items[0].id". */
  paramName: string;
  /** The real navigation key used by applyResourceIdMutationInBody. */
  path: Array<string | number>;
  value: string;
};

const MAX_BODY_ID_CANDIDATES = 8;
const MAX_BODY_WALK_DEPTH = 6;

function isIdShapedKey(key: string): boolean {
  return /(^id$|id$|_id$|uuid|guid)$/i.test(key);
}

/**
 * Scans a captured request's JSON body for fields that look like resource identifiers, the
 * same way detectResourceIdCandidates scans a URL. Returns [] for a missing or non-JSON body -
 * never guesses at a shape it can't parse.
 */
export function detectResourceIdCandidatesInBody(bodyText: string | undefined): BodyResourceIdCandidate[] {
  if (!bodyText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return [];
  }

  const candidates: BodyResourceIdCandidate[] = [];
  const visit = (value: unknown, path: Array<string | number>, label: string, depth: number) => {
    if (candidates.length >= MAX_BODY_ID_CANDIDATES || depth > MAX_BODY_WALK_DEPTH) return;
    if (Array.isArray(value)) {
      value.slice(0, 10).forEach((item, index) => visit(item, [...path, index], `${label}[${index}]`, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (candidates.length >= MAX_BODY_ID_CANDIDATES) return;
      const childPath = [...path, key];
      const childLabel = label ? `${label}.${key}` : key;
      if ((typeof child === "string" || typeof child === "number") && isIdShapedKey(key)) {
        const stringValue = String(child);
        if (looksLikeResourceId(stringValue)) {
          candidates.push({ location: "body", paramName: childLabel, path: childPath, value: stringValue });
          continue;
        }
      }
      visit(child, childPath, childLabel, depth + 1);
    }
  };

  visit(parsed, [], "", 0);
  return candidates;
}

/**
 * Applies exactly one body candidate mutation, leaving everything else in the body unchanged.
 * Returns the original bodyText unmodified if the candidate's path is no longer valid against
 * it (defensive - this function is never the source of truth for whether a candidate applies,
 * detectResourceIdCandidatesInBody is) rather than throwing mid-probe-construction.
 */
export function applyResourceIdMutationInBody(bodyText: string, candidate: BodyResourceIdCandidate, newValue: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }

  let cursor: any = parsed;
  for (let i = 0; i < candidate.path.length - 1; i++) {
    const key = candidate.path[i];
    if (cursor == null || typeof cursor !== "object") return bodyText;
    cursor = cursor[key as keyof typeof cursor];
  }
  const lastKey = candidate.path[candidate.path.length - 1];
  if (cursor == null || typeof cursor !== "object" || !(lastKey in cursor)) return bodyText;
  cursor[lastKey] = newValue;

  return JSON.stringify(parsed);
}
