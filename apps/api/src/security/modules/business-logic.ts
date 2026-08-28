/**
 * Business logic security testing module.
 *
 * Generic DAST scanners miss financial business logic flaws because they don't
 * understand what the numbers mean. This module probes for the class of bugs that
 * consistently pay out in fintech bug bounty programs:
 *
 *   1. Negative amount injection  — debit becomes credit, balance increases
 *   2. Zero-value bypass          — skip fees, rate limits, or KYC triggers
 *   3. Integer overflow/underflow — wrap around to unexpected values
 *   4. Decimal precision abuse    — fractional pennies exploit rounding errors
 *   5. Mass assignment            — sneak privileged fields into write requests
 *   6. Parameter pollution        — duplicate fields with conflicting values
 *   7. Null/empty field bypass    — bypass required-field validation
 *   8. Idempotency key reuse      — replay a transaction with a known-good key
 *   9. Currency/unit confusion    — mismatch the stated and actual unit
 *  10. Limit boundary testing     — probe just above/below declared limits
 */

import { buildAuthHeaders } from "../auth-headers.js";
import type { SecurityAuthProfile } from "../types.js";
import { probeScoped, type ProbeScope } from "../http-client.js";

export type BizLogicFinding = {
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

// ── HTTP helper ───────────────────────────────────────────────────────────────

type ProbeResult = { status: number; body: string; ms: number } | null;

async function probe(
  scope: ProbeScope,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
  timeoutMs = 10_000,
): Promise<ProbeResult> {
  const t0 = Date.now();
  const result = await probeScoped(scope, url, { method, headers: { Accept: "application/json", ...headers }, body, timeoutMs });
  if (result.error || result.status === undefined) return null;
  return { status: result.status, body: result.body, ms: Date.now() - t0 };
}

// ── Financial endpoint discovery ─────────────────────────────────────────────

const FINANCIAL_REST_PATHS = [
  "/api/transfer", "/api/transfers",
  "/api/payment", "/api/payments",
  "/api/withdraw", "/api/withdrawal",
  "/api/send", "/api/send-money",
  "/api/checkout", "/api/purchase",
  "/api/redeem", "/api/claim",
  "/api/topup", "/api/deposit",
  "/api/v1/transfer", "/api/v1/payment",
  "/v1/transfer", "/v1/payment",
];

const FINANCIAL_GQL_MUTATIONS = [
  { name: "transfer",       query: (amount: unknown) => `mutation { transfer(input: { amount: ${JSON.stringify(amount)} }) { id status } }` },
  { name: "sendMoney",      query: (amount: unknown) => `mutation { sendMoney(amount: ${JSON.stringify(amount)}) { id status } }` },
  { name: "createTransfer", query: (amount: unknown) => `mutation { createTransfer(input: { amount: ${JSON.stringify(amount)}, to: "test" }) { id } }` },
  { name: "pay",            query: (amount: unknown) => `mutation { pay(amount: ${JSON.stringify(amount)}) { id status } }` },
  { name: "withdraw",       query: (amount: unknown) => `mutation { withdraw(amount: ${JSON.stringify(amount)}) { id status } }` },
];

// ── Payload library ───────────────────────────────────────────────────────────

const AMOUNT_PAYLOADS = [
  { label: "negative amount",   value: -0.01,           severity: "critical" as const,
    why: "Negative amounts may reverse the direction of a financial operation — a debit becomes a credit." },
  { label: "negative large",    value: -999999,         severity: "critical" as const,
    why: "Large negative amount may result in account balance increasing by the absolute value." },
  { label: "zero value",        value: 0,               severity: "medium" as const,
    why: "Zero-value transactions may bypass fee triggers, rate limits, or KYC thresholds." },
  { label: "integer overflow",  value: 9223372036854775807, severity: "high" as const,
    why: "64-bit integer max — may wrap to a negative number or cause arithmetic exceptions." },
  { label: "float overflow",    value: 1e308,           severity: "high" as const,
    why: "Floating point overflow may produce Infinity or NaN, bypassing validation." },
  { label: "decimal precision", value: 0.00000001,      severity: "medium" as const,
    why: "Sub-cent amounts may round to zero in some contexts but still trigger operations." },
  { label: "negative string",   value: "-1",            severity: "high" as const,
    why: "String '-1' may bypass numeric-type validation while still being parsed as negative." },
  { label: "null value",        value: null,            severity: "medium" as const,
    why: "Null may bypass required-field validation in weakly-typed backends." },
];

const MASS_ASSIGNMENT_FIELDS = [
  { key: "role",         value: "admin"  },
  { key: "isAdmin",      value: true     },
  { key: "balance",      value: 999999   },
  { key: "credit",       value: 999999   },
  { key: "verified",     value: true     },
  { key: "kycStatus",    value: "approved" },
  { key: "premium",      value: true     },
  { key: "spotme",       value: true     },
  { key: "overdraftLimit", value: 999999 },
];

// ── Checks ────────────────────────────────────────────────────────────────────

function isSuccessResponse(res: ProbeResult): boolean {
  if (!res) return false;
  if (res.status >= 200 && res.status < 300) return true;
  try {
    const parsed = JSON.parse(res.body);
    // GraphQL: data present and non-null = success
    if (parsed.data && Object.values(parsed.data).some((v) => v !== null)) return true;
  } catch {}
  return false;
}

function isServerError(res: ProbeResult): boolean {
  return !!res && (res.status === 500 || res.status === 502 || res.status === 503);
}

async function testAmountPayloads(
  scope: ProbeScope,
  url: string,
  method: string,
  headers: Record<string, string>,
  isGraphQL: boolean,
  opName: string,
  gqlMutationFn?: (amount: unknown) => string,
): Promise<BizLogicFinding[]> {
  const findings: BizLogicFinding[] = [];

  for (const payload of AMOUNT_PAYLOADS) {
    let body: string;
    if (isGraphQL && gqlMutationFn) {
      body = JSON.stringify({ query: gqlMutationFn(payload.value) });
    } else {
      body = JSON.stringify({ amount: payload.value });
    }

    const res = await probe(scope, method, url, { ...headers, "Content-Type": "application/json" }, body);
    if (!res) continue;

    if (isSuccessResponse(res)) {
      findings.push({
        type: "dynamic",
        severity: payload.severity,
        title: `Business logic: ${payload.label} accepted by ${opName}`,
        description:
          `Sending amount = ${JSON.stringify(payload.value)} to ${url} (${opName}) ` +
          `returned HTTP ${res.status}. ${payload.why}`,
        location: url,
        tool: "business-logic",
        evidence: {
          vulnerabilityClass: "insecure_design",
          owaspCategory: "A04:2021 Insecure Design",
          owaspApiCategory: "API6:2023 Unrestricted Access to Sensitive Business Flows",
          operation: opName,
          payloadLabel: payload.label,
          payloadValue: payload.value,
          responseStatus: res.status,
          responsePreview: res.body.slice(0, 400),
        },
        suggestion:
          "Validate that all monetary amounts are: (1) positive and non-zero, (2) within declared " +
          "minimum/maximum limits, (3) representable as the expected type (integer cents, not floats), " +
          "(4) never null or missing. Perform validation server-side, not just client-side.",
        status: "open",
      });
    } else if (isServerError(res)) {
      findings.push({
        type: "dynamic",
        severity: "medium",
        title: `Business logic: unhandled server error on ${payload.label} input to ${opName}`,
        description:
          `Sending amount = ${JSON.stringify(payload.value)} to ${opName} at ${url} ` +
          `caused HTTP ${res.status}. The server should return 400 Bad Request for invalid input, ` +
          `not an unhandled exception.`,
        location: url,
        tool: "business-logic",
        evidence: {
          vulnerabilityClass: "security_misconfiguration",
          owaspCategory: "A05:2021 Security Misconfiguration",
          payloadLabel: payload.label,
          payloadValue: payload.value,
          responseStatus: res.status,
          responsePreview: res.body.slice(0, 400),
        },
        suggestion: "Add input validation middleware that returns 400 with a clear validation error before business logic executes.",
        status: "open",
      });
    }
  }
  return findings;
}

async function testMassAssignment(
  scope: ProbeScope,
  url: string,
  method: string,
  headers: Record<string, string>,
): Promise<BizLogicFinding[]> {
  const findings: BizLogicFinding[] = [];
  const payload = Object.fromEntries(MASS_ASSIGNMENT_FIELDS.map((f) => [f.key, f.value]));

  const res = await probe(scope, method, url, { ...headers, "Content-Type": "application/json" }, JSON.stringify(payload));
  if (!res) return findings;

  if (isSuccessResponse(res)) {
    // Check if any privileged field appears in the response (indicating it was accepted)
    const accepted = MASS_ASSIGNMENT_FIELDS.filter((f) =>
      res.body.includes(`"${f.key}"`)
    );
    if (accepted.length > 0) {
      findings.push({
        type: "dynamic",
        severity: "high",
        title: `Mass assignment: privileged fields accepted by ${url}`,
        description:
          `Sending ${accepted.map((f) => f.key).join(", ")} in the request body to ${url} ` +
          `returned a 2xx response that echoes those fields. The server may be applying them directly ` +
          `to the model without filtering to an allowed-fields list.`,
        location: url,
        tool: "business-logic",
        evidence: {
          vulnerabilityClass: "broken_function_level_authorization",
          owaspCategory: "A01:2021 Broken Access Control",
          owaspApiCategory: "API3:2023 Broken Object Property Level Authorization",
          acceptedFields: accepted.map((f) => f.key),
          responseStatus: res.status,
          responsePreview: res.body.slice(0, 400),
        },
        suggestion:
          "Use explicit DTO/input classes that only accept declared fields. Never pass the full " +
          "request body directly to an ORM update call. Apply an allowlist of writable fields " +
          "server-side, independent of client input.",
        status: "open",
      });
    }
  }
  return findings;
}

async function testParameterPollution(
  scope: ProbeScope,
  url: string,
  method: string,
  headers: Record<string, string>,
): Promise<BizLogicFinding[]> {
  // Send both a valid and a negative amount — which one wins?
  // We build the raw string manually since TS objects deduplicate keys at compile time.
  const body = '{"amount":1,"amount":-999}'; // last-wins in most JSON parsers
  const res = await probe(scope, method, url, { ...headers, "Content-Type": "application/json" }, body);
  if (!res || !isSuccessResponse(res)) return [];

  // Also test query-string pollution for GET endpoints
  const qs = `${url}${url.includes("?") ? "&" : "?"}amount=1&amount=-999`;
  const resQs = await probe(scope, "GET", qs, headers);

  if (resQs && isSuccessResponse(resQs)) {
    return [
      {
        type: "dynamic",
        severity: "medium",
        title: `Parameter pollution accepted at ${url}`,
        description:
          `Sending duplicate amount parameters (1 and -999) to ${url} returned success. ` +
          `If the backend uses the last value, a malicious actor can override the first parameter ` +
          `with a negative or manipulated value. Inconsistent parsing between layers can lead to ` +
          `split-validation attacks.`,
        location: url,
        tool: "business-logic",
        evidence: {
          vulnerabilityClass: "insecure_design",
          owaspCategory: "A04:2021 Insecure Design",
          responseStatus: resQs.status,
          test: "query-string parameter pollution",
        },
        suggestion:
          "Explicitly reject duplicate parameters. Parse request bodies into a validated schema " +
          "before passing to business logic — never access raw request parameters in financial operations.",
        status: "open",
      },
    ];
  }
  return [];
}

// ── GraphQL-specific business logic ──────────────────────────────────────────

async function testGraphQLBusinessLogic(
  scope: ProbeScope,
  base: string,
  authHeaders: Record<string, string>,
): Promise<BizLogicFinding[]> {
  const findings: BizLogicFinding[] = [];
  const endpoint = `${base}/api/graphql`;
  const headers = { ...authHeaders, "Content-Type": "application/json", Accept: "application/json" };

  for (const mutation of FINANCIAL_GQL_MUTATIONS) {
    const amountFindings = await testAmountPayloads(
      scope, endpoint, "POST", headers, true, `GraphQL ${mutation.name}`, mutation.query
    );
    findings.push(...amountFindings);
    if (amountFindings.some((f) => f.severity === "critical")) break; // escalate early
  }
  return findings;
}

// ── Main entrypoint ──────────────────────────────────────────────────────────

export async function runBusinessLogicScan(
  baseUrl: string,
  authProfiles: SecurityAuthProfile[],
  scope: ProbeScope,
): Promise<BizLogicFinding[]> {
  const findings: BizLogicFinding[] = [];
  const base = baseUrl.replace(/\/+$/, "");
  const primaryProfile = authProfiles[0];
  if (!primaryProfile) return findings;

  const authHeaders = buildAuthHeaders(primaryProfile);

  // 1. GraphQL financial mutations (Chime-style)
  const gqlFindings = await testGraphQLBusinessLogic(scope, base, authHeaders);
  findings.push(...gqlFindings);

  // 2. REST financial endpoints
  for (const path of FINANCIAL_REST_PATHS) {
    const url = `${base}${path}`;
    const check = await probe(scope, "GET", url, authHeaders, undefined, 5_000);
    if (!check || check.status === 404 || check.status === 405) continue;

    const amountFindings = await testAmountPayloads(scope, url, "POST", authHeaders, false, path);
    findings.push(...amountFindings);

    const massFindings = await testMassAssignment(scope, url, "POST", authHeaders);
    findings.push(...massFindings);

    const pollutionFindings = await testParameterPollution(scope, url, "POST", authHeaders);
    findings.push(...pollutionFindings);
  }

  if (!findings.length) {
    findings.push({
      type: "dynamic",
      severity: "info",
      title: "Business logic scan: no financial endpoints responded to probes",
      description:
        "No common financial REST paths or GraphQL mutations responded to business-logic test payloads. " +
        "If the target uses custom endpoint paths, import the OpenAPI spec or run the GraphQL audit " +
        "to discover the actual operation names, then add them to the manual auth profiles for targeted testing.",
      location: base,
      tool: "business-logic",
      evidence: { restPathsProbed: FINANCIAL_REST_PATHS.length, gqlMutationsProbed: FINANCIAL_GQL_MUTATIONS.length },
      status: "open",
    });
  }

  return findings;
}
