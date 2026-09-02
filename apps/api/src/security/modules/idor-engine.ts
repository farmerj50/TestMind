/**
 * IDOR (Insecure Direct Object Reference) REST engine.
 *
 * Harvests object IDs from account A's REST API responses, then probes those same
 * IDs using account B's session to detect horizontal privilege escalation (BOLA).
 * Also probes common ID-bearing paths with predictable ID manipulation
 * (increment/decrement, UUID substitution) against a single account.
 *
 * This is the #1 finding class in fintech bug bounty programs.
 */

import { buildAuthHeaders } from "../auth-headers.js";
import type { SecurityAuthProfile } from "../types.js";
import { probeScoped, type ProbeScope } from "../http-client.js";
import { UUID_PATTERN, CUID_PATTERN } from "../http-exchange.js";

export type IdorFinding = {
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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function httpGet(
  scope: ProbeScope,
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8_000,
): Promise<{ status: number; body: string } | null> {
  const res = await probeScoped(scope, url, { method: "GET", headers, timeoutMs });
  if (res.error || res.status === undefined) return null;
  return { status: res.status, body: res.body };
}

// ── ID extraction ────────────────────────────────────────────────────────────

// Extracts IDs embedded in JSON responses. UUID_PATTERN/CUID_PATTERN are shared with
// http-exchange.ts's URL-candidate detection so the two never define the same ID shapes
// differently.
const NUMERIC_ID_PATTERN = /"(?:id|userId|accountId|transferId|transactionId|cardId|paymentId)"\s*:\s*"?(\d{4,})"?/g;

function harvestIds(body: string): { uuids: string[]; cuids: string[]; numerics: string[] } {
  const uuids = [...new Set((body.match(UUID_PATTERN) ?? []))].slice(0, 10);
  const cuids = [...new Set((body.match(CUID_PATTERN) ?? []))].slice(0, 10);
  const numerics: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(NUMERIC_ID_PATTERN.source, "g");
  while ((m = re.exec(body)) !== null && numerics.length < 10) {
    numerics.push(m[1]);
  }
  return { uuids: [...new Set(uuids)], cuids: [...new Set(cuids)], numerics: [...new Set(numerics)] };
}

// ── Probe paths that commonly expose object IDs ───────────────────────────────

const DISCOVERY_PATHS = [
  "/api/me",
  "/api/user",
  "/api/account",
  "/api/accounts",
  "/api/profile",
  "/api/v1/me",
  "/api/v1/user",
  "/api/v1/account",
  "/api/users/me",
  "/api/wallet",
  "/api/transactions",
  "/api/transfers",
  "/api/cards",
];

// Known path templates for ID probing — {id} will be substituted
const PROBE_TEMPLATES = [
  "/api/users/{id}",
  "/api/user/{id}",
  "/api/accounts/{id}",
  "/api/account/{id}",
  "/api/transactions/{id}",
  "/api/transfers/{id}",
  "/api/cards/{id}",
  "/api/v1/users/{id}",
  "/api/v1/accounts/{id}",
  "/api/v1/transactions/{id}",
];

// ── Cross-account IDOR test ───────────────────────────────────────────────────

async function testCrossAccount(
  scope: ProbeScope,
  base: string,
  idsFromA: string[],
  headersB: Record<string, string>,
  profileALabel: string,
  profileBLabel: string,
): Promise<IdorFinding[]> {
  const findings: IdorFinding[] = [];

  for (const id of idsFromA.slice(0, 15)) {
    for (const template of PROBE_TEMPLATES) {
      const url = `${base}${template.replace("{id}", id)}`;
      const res = await httpGet(scope, url, headersB);
      if (!res || res.status === 404 || res.status === 405) continue;

      if (res.status >= 200 && res.status < 300 && res.body.length > 10) {
        findings.push({
          type: "dynamic",
          severity: "high",
          title: `IDOR: ${profileBLabel} accessed object ${id} owned by ${profileALabel}`,
          description:
            `Account '${profileBLabel}' successfully retrieved a resource at ${url} using an ` +
            `object ID (${id}) that was discovered in '${profileALabel}' responses. The server ` +
            `is not enforcing object ownership — any authenticated user can read any other user's ` +
            `data by guessing or enumerating IDs.`,
          location: url,
          tool: "idor-engine",
          evidence: {
            vulnerabilityClass: "broken_object_level_authorization",
            owaspCategory: "A01:2021 Broken Access Control",
            owaspApiCategory: "API1:2023 Broken Object Level Authorization",
            ownerProfile: profileALabel,
            attackerProfile: profileBLabel,
            objectId: id,
            responseStatus: res.status,
            responsePreview: res.body.slice(0, 400),
          },
          suggestion:
            "Before returning any object, verify the authenticated caller owns or has explicit " +
            "permission to access it. Use the caller's verified user ID from the session/token, " +
            "not any ID supplied by the client.",
          status: "open",
        });
        break; // one finding per ID is enough
      }
    }
  }
  return findings;
}

// ── Predictable ID enumeration (single account) ───────────────────────────────

async function testPredictableIds(
  scope: ProbeScope,
  base: string,
  knownId: string,
  headers: Record<string, string>,
): Promise<IdorFinding[]> {
  const findings: IdorFinding[] = [];

  // For numeric IDs: try adjacent IDs (±1, ±2)
  if (/^\d+$/.test(knownId)) {
    const n = parseInt(knownId, 10);
    const candidates = [n - 2, n - 1, n + 1, n + 2].filter((v) => v > 0).map(String);

    for (const altId of candidates) {
      for (const template of PROBE_TEMPLATES.slice(0, 4)) {
        const url = `${base}${template.replace("{id}", altId)}`;
        const res = await httpGet(scope, url, headers);
        if (!res || res.status === 404 || res.status === 405) continue;

        if (res.status >= 200 && res.status < 300 && res.body.length > 10) {
          findings.push({
            type: "dynamic",
            severity: "high",
            title: `IDOR: predictable numeric ID — ${url} returned 200`,
            description:
              `By incrementing a known object ID (${knownId} → ${altId}), a different object was ` +
              `retrieved. Sequential numeric IDs make IDOR trivially exploitable — no guessing ` +
              `required, just iteration.`,
            location: url,
            tool: "idor-engine",
            evidence: {
              vulnerabilityClass: "broken_object_level_authorization",
              owaspCategory: "A01:2021 Broken Access Control",
              owaspApiCategory: "API1:2023 Broken Object Level Authorization",
              knownId,
              probeId: altId,
              responseStatus: res.status,
              responsePreview: res.body.slice(0, 300),
            },
            suggestion: "Use non-sequential, unguessable IDs (UUIDs or CUIDs) instead of sequential integers. Always verify ownership server-side regardless of ID format.",
            status: "open",
          });
          return findings; // one is enough to confirm the issue
        }
      }
    }
  }

  return findings;
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export async function runIdorScan(
  baseUrl: string,
  authProfiles: SecurityAuthProfile[],
  scope: ProbeScope,
): Promise<IdorFinding[]> {
  const findings: IdorFinding[] = [];
  const base = baseUrl.replace(/\/+$/, "");

  if (!authProfiles.length) return findings;

  const profileA = authProfiles[0];
  const headersA = buildAuthHeaders(profileA);

  // 1. Harvest IDs from account A's responses
  const allIds: { uuids: string[]; cuids: string[]; numerics: string[] } = {
    uuids: [], cuids: [], numerics: [],
  };

  for (const path of DISCOVERY_PATHS) {
    const res = await httpGet(scope, `${base}${path}`, headersA);
    if (!res || res.status >= 400) continue;
    const harvested = harvestIds(res.body);
    allIds.uuids.push(...harvested.uuids);
    allIds.cuids.push(...harvested.cuids);
    allIds.numerics.push(...harvested.numerics);
    if (allIds.uuids.length + allIds.cuids.length + allIds.numerics.length >= 15) break;
  }

  const combinedIds = [
    ...new Set([...allIds.uuids, ...allIds.cuids, ...allIds.numerics]),
  ].slice(0, 15);

  if (!combinedIds.length) {
    findings.push({
      type: "dynamic",
      severity: "info",
      title: "IDOR engine: no object IDs harvested from account A responses",
      description:
        "No UUIDs, CUIDs, or numeric IDs were extracted from the authenticated discovery paths. " +
        "The API may require specific paths not covered by the default probe list, or may use " +
        "opaque tokens rather than direct object IDs.",
      location: base,
      tool: "idor-engine",
      evidence: { pathsProbed: DISCOVERY_PATHS.length, profileA: profileA.label },
      status: "open",
    });
    return findings;
  }

  // 2. Cross-account test (requires ≥2 profiles)
  if (authProfiles.length >= 2) {
    const profileB = authProfiles[1];
    const headersB = buildAuthHeaders(profileB);
    const crossFindings = await testCrossAccount(
      scope,
      base,
      combinedIds,
      headersB,
      profileA.label ?? "Account A",
      profileB.label ?? "Account B",
    );
    findings.push(...crossFindings);

    if (!crossFindings.length) {
      findings.push({
        type: "dynamic",
        severity: "info",
        title: "IDOR cross-account check: no unauthorized access detected",
        description:
          `Account B ('${profileB.label}') could not access any of the ${combinedIds.length} object IDs ` +
          `harvested from Account A ('${profileA.label}') responses. Object-level authorization appears ` +
          `to be enforced on the tested paths.`,
        location: base,
        tool: "idor-engine",
        evidence: { idsHarvested: combinedIds.length, pathsProbed: PROBE_TEMPLATES.length },
        status: "open",
      });
    }
  } else {
    // 3. Predictable ID test (single account)
    if (allIds.numerics.length) {
      const predictableFindings = await testPredictableIds(scope, base, allIds.numerics[0], headersA);
      findings.push(...predictableFindings);
    }

    findings.push({
      type: "dynamic",
      severity: "info",
      title: `IDOR engine: only one auth profile — cross-account test skipped`,
      description:
        `Cross-account IDOR testing (the highest-value check) requires two separate authenticated ` +
        `accounts. Add a second account's session as a second auth profile and re-run. ` +
        `${combinedIds.length} object IDs were harvested from the first account and are ready to probe.`,
      location: base,
      tool: "idor-engine",
      evidence: { harvestedIds: combinedIds.slice(0, 5), totalHarvested: combinedIds.length },
      suggestion: "Add a second test account session via External Security Assessment mode → Paste cookies, then re-run the scan.",
      status: "open",
    });
  }

  return findings;
}
