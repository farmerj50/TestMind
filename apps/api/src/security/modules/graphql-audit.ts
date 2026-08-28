/**
 * GraphQL-aware security audit module.
 *
 * Covers the attack surface that generic HTTP scanners miss on GraphQL APIs:
 *   1. Endpoint detection   — finds the actual /graphql (or /api/graphql etc.) path
 *   2. Introspection        — maps the schema; introspection enabled is itself a finding
 *   3. Auth enforcement     — tests every discovered operation unauthenticated
 *   4. Cross-account IDOR   — with ≥2 auth profiles, replays account-A object IDs under
 *                             account-B's session (BOLA/IDOR)
 *   5. Query batching       — tests whether batched arrays bypass rate-limiting
 *   6. Sensitive field leak — checks whether lower-privilege sessions receive fields
 *                             that should be ownership-gated
 */

import { buildAuthHeaders } from "../auth-headers.js";
import type { SecurityScanPayload } from "../../runner/queue.js";
import type { SecurityAuthProfile } from "../types.js";
import { probeScoped, type ProbeScope } from "../http-client.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type GqlFinding = {
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

type ProbeResult = { status: number; body: string; headers: Record<string, string | string[] | undefined> } | null;

// ── Low-level helpers ────────────────────────────────────────────────────────

async function gqlProbe(
  scope: ProbeScope,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 10_000,
): Promise<ProbeResult> {
  const res = await probeScoped(scope, url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", ...headers },
    body: JSON.stringify(body),
    timeoutMs,
  });
  if (res.error || res.status === undefined) return null;
  return { status: res.status, body: res.body, headers: res.headers };
}

function parseGqlResponse(raw: string): { data?: any; errors?: any[]; extensions?: any } | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && ("data" in parsed || "errors" in parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function isGqlResponse(raw: string): boolean {
  return parseGqlResponse(raw) !== null;
}

// ── 1. Endpoint detection ────────────────────────────────────────────────────

const GQL_PATHS = [
  "/api/graphql",
  "/graphql",
  "/gql",
  "/v1/graphql",
  "/v2/graphql",
  "/query",
  "/api/query",
];

const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      subscriptionType { name }
      types {
        name
        kind
        fields(includeDeprecated: true) {
          name
          args { name type { name kind ofType { name kind } } }
          type { name kind ofType { name kind } }
        }
      }
    }
  }
`.trim();

export async function detectGraphQLEndpoint(
  scope: ProbeScope,
  baseUrl: string,
  authHeaders: Record<string, string> = {},
): Promise<string | null> {
  const base = baseUrl.replace(/\/+$/, "");
  for (const p of GQL_PATHS) {
    const url = `${base}${p}`;
    const res = await gqlProbe(scope, url, { query: "{ __typename }" }, authHeaders, 6000);
    if (res && isGqlResponse(res.body)) return url;
  }
  return null;
}

// ── 2. Introspection ─────────────────────────────────────────────────────────

type GqlType = {
  name: string;
  kind: string;
  fields?: Array<{ name: string; args: Array<{ name: string }>; type: any }>;
};

type GqlSchema = {
  queryType?: { name: string } | null;
  mutationType?: { name: string } | null;
  subscriptionType?: { name: string } | null;
  types?: GqlType[];
};

export async function fetchIntrospection(
  scope: ProbeScope,
  endpoint: string,
  authHeaders: Record<string, string>,
): Promise<{ schema: GqlSchema | null; enabled: boolean }> {
  const res = await gqlProbe(scope, endpoint, { query: INTROSPECTION_QUERY }, authHeaders);
  if (!res) return { schema: null, enabled: false };
  const parsed = parseGqlResponse(res.body);
  if (!parsed) return { schema: null, enabled: false };
  if (parsed.data?.__schema) return { schema: parsed.data.__schema as GqlSchema, enabled: true };
  // introspection disabled — errors present but it IS a GraphQL endpoint
  if (parsed.errors) return { schema: null, enabled: false };
  return { schema: null, enabled: false };
}

function extractOperations(schema: GqlSchema): Array<{ name: string; kind: "query" | "mutation" }> {
  const ops: Array<{ name: string; kind: "query" | "mutation" }> = [];
  const queryTypeName = schema.queryType?.name ?? "Query";
  const mutationTypeName = schema.mutationType?.name ?? "Mutation";
  for (const t of schema.types ?? []) {
    if (t.name?.startsWith("__")) continue;
    if (t.name === queryTypeName && t.fields) {
      ops.push(...t.fields.map((f) => ({ name: f.name, kind: "query" as const })));
    }
    if (t.name === mutationTypeName && t.fields) {
      ops.push(...t.fields.map((f) => ({ name: f.name, kind: "mutation" as const })));
    }
  }
  return ops;
}

// ── 3. Auth enforcement probes ───────────────────────────────────────────────

// Common operations on financial/account apps — used when introspection is disabled.
const COMMON_FINANCIAL_QUERIES = [
  { name: "me", kind: "query" as const, query: "query { me { id email } }" },
  { name: "viewer", kind: "query" as const, query: "query { viewer { id email } }" },
  { name: "currentUser", kind: "query" as const, query: "query { currentUser { id email } }" },
  { name: "accounts", kind: "query" as const, query: "query { accounts { id balance } }" },
  { name: "bankAccount", kind: "query" as const, query: "query { bankAccount { id balance accountNumber } }" },
  { name: "transactions", kind: "query" as const, query: "query { transactions { id amount } }" },
  { name: "cards", kind: "query" as const, query: "query { cards { id last4 } }" },
];

async function testUnauthenticatedAccess(
  scope: ProbeScope,
  endpoint: string,
  operations: Array<{ name: string; kind: "query" | "mutation" }>,
  schema: GqlSchema | null,
): Promise<GqlFinding[]> {
  const findings: GqlFinding[] = [];

  const toTest = schema
    ? operations.slice(0, 30).map((op) => ({
        name: op.name,
        kind: op.kind,
        query: op.kind === "query" ? `query { ${op.name} }` : `mutation { ${op.name} }`,
      }))
    : COMMON_FINANCIAL_QUERIES;

  for (const op of toTest) {
    const res = await gqlProbe(scope, endpoint, { query: op.query }, {}); // no auth headers
    if (!res) continue;
    const parsed = parseGqlResponse(res.body);
    if (!parsed) continue;
    // Data returned without auth = auth enforcement missing
    if (parsed.data && parsed.data[op.name] !== null && parsed.data[op.name] !== undefined) {
      findings.push({
        type: "dynamic",
        severity: op.kind === "mutation" ? "critical" : "high",
        title: `GraphQL ${op.kind} '${op.name}' accessible without authentication`,
        description:
          `The GraphQL ${op.kind} '${op.name}' returned data for an unauthenticated request. ` +
          `All operations that return user/account data must require a valid session.`,
        location: `${endpoint} → ${op.name}`,
        tool: "graphql-audit",
        evidence: {
          vulnerabilityClass: "broken_authentication",
          owaspCategory: "A07:2021 Identification and Authentication Failures",
          owaspApiCategory: "API2:2023 Broken Authentication",
          operation: op.name,
          kind: op.kind,
          responseStatus: res.status,
          responsePreview: res.body.slice(0, 500),
        },
        suggestion: `Enforce session/token authentication on the '${op.name}' ${op.kind} resolver before executing any logic.`,
        status: "open",
      });
    }
  }
  return findings;
}

// ── 4. Cross-account IDOR (BOLA) ─────────────────────────────────────────────

// IDs look like: UUIDs, cuid, numeric strings, base64 opaque IDs
const ID_PATTERN = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c[a-z0-9]{24,}|[0-9]{6,18})\b/g;

function extractIds(body: string): string[] {
  const matches = body.match(ID_PATTERN) ?? [];
  return [...new Set(matches)].slice(0, 20);
}

// Queries to try with harvested IDs — try passing them as common argument names
const ID_PROBE_TEMPLATES = (id: string) => [
  `query { account(id: "${id}") { id balance accountNumber } }`,
  `query { transaction(id: "${id}") { id amount description } }`,
  `query { user(id: "${id}") { id email firstName lastName } }`,
  `query { card(id: "${id}") { id last4 cardNumber } }`,
  `query { transfer(id: "${id}") { id amount status } }`,
];

async function testCrossAccountBOLA(
  scope: ProbeScope,
  endpoint: string,
  profileA: SecurityAuthProfile,
  profileB: SecurityAuthProfile,
): Promise<GqlFinding[]> {
  const findings: GqlFinding[] = [];

  // Step 1: harvest IDs from profile A's responses
  const harvestQueries = COMMON_FINANCIAL_QUERIES;
  const harvestedIds: string[] = [];
  for (const op of harvestQueries) {
    const res = await gqlProbe(scope, endpoint, { query: op.query }, buildAuthHeaders(profileA));
    if (res?.body) harvestedIds.push(...extractIds(res.body));
    if (harvestedIds.length >= 10) break;
  }

  if (!harvestedIds.length) return findings;

  // Step 2: probe those IDs using profile B's session
  const headersB = buildAuthHeaders(profileB);
  for (const id of harvestedIds.slice(0, 10)) {
    for (const queryStr of ID_PROBE_TEMPLATES(id)) {
      const opName = queryStr.match(/query \{ (\w+)/)?.[1] ?? "unknown";
      const res = await gqlProbe(scope, endpoint, { query: queryStr }, headersB, 8000);
      if (!res) continue;
      const parsed = parseGqlResponse(res.body);
      if (!parsed?.data) continue;
      const returnedData = parsed.data[opName];
      if (!returnedData) continue;
      // Profile B received data for an object ID belonging to profile A
      findings.push({
        type: "dynamic",
        severity: "high",
        title: `GraphQL BOLA: account '${profileB.role ?? profileB.label}' accessed object owned by '${profileA.role ?? profileA.label}'`,
        description:
          `The GraphQL query '${opName}' returned data for object ID '${id}' when requested by ` +
          `'${profileB.role ?? profileB.label}', even though that ID was discovered in ` +
          `'${profileA.role ?? profileA.label}' responses. Server-side object ownership is not enforced.`,
        location: `${endpoint} → ${opName}(id: "${id}")`,
        tool: "graphql-audit",
        evidence: {
          vulnerabilityClass: "broken_object_level_authorization",
          owaspCategory: "A01:2021 Broken Access Control",
          owaspApiCategory: "API1:2023 Broken Object Level Authorization",
          ownerProfile: profileA.label,
          attackerProfile: profileB.label,
          objectId: id,
          operation: opName,
          responsePreview: res.body.slice(0, 500),
        },
        suggestion:
          "Before returning any object, verify that the authenticated user owns or has explicit permission to access it. Never rely solely on the caller supplying a valid-format ID.",
        status: "open",
      });
      break; // one finding per ID is enough; avoid noise
    }
  }
  return findings;
}

// ── 5. Query batching ────────────────────────────────────────────────────────

async function testQueryBatching(
  scope: ProbeScope,
  endpoint: string,
  authHeaders: Record<string, string>,
): Promise<GqlFinding[]> {
  // Send an array of 5 identical introspection probes — if all succeed, batching is on.
  const batch = Array.from({ length: 5 }, () => ({ query: "{ __typename }" }));
  const res = await gqlProbe(scope, endpoint, batch, authHeaders, 12_000);
  if (!res) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(res.body); } catch { return []; }
  if (!Array.isArray(parsed) || parsed.length < 3) return [];
  const allData = parsed.every((r: any) => r?.data?.__typename);
  if (!allData) return [];
  return [
    {
      type: "dynamic",
      severity: "medium",
      title: "GraphQL query batching enabled",
      description:
        "The GraphQL endpoint accepts batched arrays of operations in a single HTTP request. " +
        "Attackers can use this to send hundreds of queries per request, effectively bypassing " +
        "per-request rate limits and amplifying enumeration/brute-force attacks.",
      location: endpoint,
      tool: "graphql-audit",
      evidence: {
        vulnerabilityClass: "security_misconfiguration",
        owaspCategory: "A05:2021 Security Misconfiguration",
        owaspApiCategory: "API8:2023 Security Misconfiguration",
        batchSize: 5,
        allSucceeded: true,
      },
      suggestion:
        "Disable query batching unless explicitly required. If needed, enforce a low maximum batch size (≤ 5) and apply the same rate limits to batched requests as to individual ones.",
      status: "open",
    },
  ];
}

// ── 6. Sensitive field leak ──────────────────────────────────────────────────

const SENSITIVE_FIELD_PATTERNS = [
  /\b(accountNumber|account_number|routingNumber|routing_number)\b/i,
  /\b(ssn|socialSecurityNumber|taxId|tax_id)\b/i,
  /\b(cardNumber|card_number|cvv|cvv2|pan)\b/i,
  /\b(password|passwordHash|password_hash|hashedPassword)\b/i,
  /\b(secretKey|secret_key|apiKey|api_key|accessToken|access_token)\b/i,
];

async function testSensitiveFieldLeak(
  scope: ProbeScope,
  endpoint: string,
  authHeaders: Record<string, string>,
): Promise<GqlFinding[]> {
  // Probe common "me/user" operations and check for sensitive fields in the response.
  const findings: GqlFinding[] = [];
  for (const op of COMMON_FINANCIAL_QUERIES.slice(0, 3)) {
    const res = await gqlProbe(scope, endpoint, { query: op.query }, authHeaders, 8000);
    if (!res?.body) continue;
    for (const pattern of SENSITIVE_FIELD_PATTERNS) {
      if (pattern.test(res.body)) {
        findings.push({
          type: "dynamic",
          severity: "high",
          title: `Sensitive field exposed in GraphQL response: ${pattern.source.replace(/\\b|\\/g, "")}`,
          description:
            `The GraphQL operation '${op.name}' returns response data containing a field that matches ` +
            `a sensitive pattern (${pattern.source}). Verify this field requires explicit authorization ` +
            `and is not returned to profiles that shouldn't see it.`,
          location: `${endpoint} → ${op.name}`,
          tool: "graphql-audit",
          evidence: {
            vulnerabilityClass: "broken_object_property_level_authorization",
            owaspCategory: "A01:2021 Broken Access Control",
            owaspApiCategory: "API3:2023 Broken Object Property Level Authorization",
            operation: op.name,
            matchedPattern: pattern.source,
            responsePreview: res.body.slice(0, 400),
          },
          suggestion:
            "Use an explicit field allowlist in the resolver return type. Never return raw DB models; use response DTOs that only expose fields the caller is authorized to see.",
          status: "open",
        });
        break;
      }
    }
  }
  return findings;
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export async function runGraphQLAudit(
  payload: SecurityScanPayload & { authProfiles?: SecurityAuthProfile[] },
): Promise<GqlFinding[]> {
  const findings: GqlFinding[] = [];
  const authProfiles: SecurityAuthProfile[] = payload.authProfiles ?? [];
  const primaryProfile = authProfiles[0];
  const authHeaders = buildAuthHeaders(primaryProfile);
  const scope: ProbeScope = { allowedHosts: payload.allowedHosts ?? [], allowedPorts: payload.allowedPorts ?? [] };

  // 1. Detect endpoint
  const endpoint = await detectGraphQLEndpoint(scope, payload.baseUrl, authHeaders);
  if (!endpoint) {
    // No GraphQL endpoint found — not a finding, just nothing to audit
    return [];
  }

  findings.push({
    type: "dynamic",
    severity: "info",
    title: "GraphQL endpoint detected",
    description: `A GraphQL endpoint was found at ${endpoint}. GraphQL-specific checks are now running.`,
    location: endpoint,
    tool: "graphql-audit",
    evidence: { endpoint },
    status: "open",
  });

  // 2. Introspection
  const { schema, enabled: introspectionEnabled } = await fetchIntrospection(scope, endpoint, authHeaders);
  if (introspectionEnabled && schema) {
    findings.push({
      type: "dynamic",
      severity: "low",
      title: "GraphQL introspection enabled in production",
      description:
        "The GraphQL introspection query succeeded, exposing the full schema — all types, queries, " +
        "mutations, and their argument signatures. This accelerates attacker enumeration significantly.",
      location: endpoint,
      tool: "graphql-audit",
      evidence: {
        vulnerabilityClass: "security_misconfiguration",
        owaspCategory: "A05:2021 Security Misconfiguration",
        owaspApiCategory: "API8:2023 Security Misconfiguration",
        queryCount: schema.types?.filter((t) => t.name === (schema.queryType?.name ?? "Query"))[0]?.fields?.length ?? 0,
        mutationCount: schema.types?.filter((t) => t.name === (schema.mutationType?.name ?? "Mutation"))[0]?.fields?.length ?? 0,
      },
      suggestion: "Disable introspection in production. Most GraphQL frameworks support a single config flag for this.",
      status: "open",
    });
  }

  const operations = schema ? extractOperations(schema) : [];

  // 3. Auth enforcement
  const authFindings = await testUnauthenticatedAccess(scope, endpoint, operations, schema);
  findings.push(...authFindings);

  // 4. Sensitive field leak (primary profile)
  if (primaryProfile) {
    const leakFindings = await testSensitiveFieldLeak(scope, endpoint, authHeaders);
    findings.push(...leakFindings);
  }

  // 5. Query batching
  const batchFindings = await testQueryBatching(scope, endpoint, authHeaders);
  findings.push(...batchFindings);

  // 6. Cross-account BOLA (requires ≥2 auth profiles)
  if (authProfiles.length >= 2) {
    const profileA = authProfiles[0];
    const profileB = authProfiles[1];
    const bolaFindings = await testCrossAccountBOLA(scope, endpoint, profileA, profileB);
    findings.push(...bolaFindings);
  } else if (primaryProfile) {
    // Single profile — note that cross-account testing is not possible yet
    findings.push({
      type: "dynamic",
      severity: "info",
      title: "GraphQL cross-account BOLA testing skipped — only one auth profile",
      description:
        "Cross-account BOLA/IDOR testing (the highest-value check on financial APIs) requires " +
        "at least two separate authenticated accounts. Add a second account's session to the " +
        "'Auth profiles' section and re-run to enable this check.",
      location: endpoint,
      tool: "graphql-audit",
      evidence: { profilesConfigured: authProfiles.length },
      suggestion: "Create a second test account, capture its session, and add it as a second auth profile.",
      status: "open",
    });
  }

  return findings;
}
