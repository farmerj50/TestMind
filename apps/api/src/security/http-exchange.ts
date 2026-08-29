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
