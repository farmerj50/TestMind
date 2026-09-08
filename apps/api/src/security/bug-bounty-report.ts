/**
 * Bug bounty report generator.
 *
 * Converts a TestMind SecurityFinding into a properly formatted submission for
 * HackerOne, BugCrowd, Intigriti, or any VDP program. Following the format that
 * triage teams actually want to read — no fluff, clear reproduction steps, a
 * CVSS score, and a concise impact statement.
 *
 * Output formats:
 *   - Markdown (for HackerOne / BugCrowd / Intigriti direct paste)
 *   - Structured JSON (for programmatic processing or custom templates)
 */

// ── CVSS v3.1 scoring ─────────────────────────────────────────────────────────

type CvssVector = {
  AV: "N" | "A" | "L" | "P";   // Attack Vector
  AC: "L" | "H";                 // Attack Complexity
  PR: "N" | "L" | "H";          // Privileges Required
  UI: "N" | "R";                 // User Interaction
  S:  "U" | "C";                 // Scope
  C:  "N" | "L" | "H";          // Confidentiality
  I:  "N" | "L" | "H";          // Integrity
  A:  "N" | "L" | "H";          // Availability
};

// Per CVSS v3.1 specification
const CVSS_WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  PR: { N: 0.85, L: 0.62, H: 0.27 }, // Scope Unchanged values
  PR_C: { N: 0.85, L: 0.68, H: 0.50 }, // Scope Changed values
  UI: { N: 0.85, R: 0.62 },
  C:  { H: 0.56, L: 0.22, N: 0 },
  I:  { H: 0.56, L: 0.22, N: 0 },
  A:  { H: 0.56, L: 0.22, N: 0 },
};

function calcCvss(v: CvssVector): { score: number; severity: string; vector: string } {
  const iss =
    1 - (1 - CVSS_WEIGHTS.C[v.C]) * (1 - CVSS_WEIGHTS.I[v.I]) * (1 - CVSS_WEIGHTS.A[v.A]);
  const pr = v.S === "C" ? CVSS_WEIGHTS.PR_C[v.PR] : CVSS_WEIGHTS.PR[v.PR];
  const exploitability =
    8.22 * CVSS_WEIGHTS.AV[v.AV] * CVSS_WEIGHTS.AC[v.AC] * pr * CVSS_WEIGHTS.UI[v.UI];

  let score: number;
  if (iss === 0) {
    score = 0;
  } else if (v.S === "U") {
    score = Math.min(6.42 * iss + exploitability, 10);
  } else {
    score = Math.min(
      7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) + exploitability,
      10
    );
  }
  const rounded = Math.round(score * 10) / 10;
  const severity =
    rounded === 0 ? "None" :
    rounded <= 3.9 ? "Low" :
    rounded <= 6.9 ? "Medium" :
    rounded <= 8.9 ? "High" : "Critical";
  const vector =
    `CVSS:3.1/AV:${v.AV}/AC:${v.AC}/PR:${v.PR}/UI:${v.UI}/S:${v.S}/C:${v.C}/I:${v.I}/A:${v.A}`;
  return { score: rounded, severity, vector };
}

// ── Vuln-class to CVSS vector mapping ────────────────────────────────────────

function cvssForVulnClass(
  vulnClass: string,
  evidence: any,
): ReturnType<typeof calcCvss> {
  switch (vulnClass) {
    case "broken_object_level_authorization":
      return calcCvss({ AV: "N", AC: "L", PR: "L", UI: "N", S: "U", C: "H", I: "N", A: "N" });
    case "broken_function_level_authorization":
      return calcCvss({ AV: "N", AC: "L", PR: "L", UI: "N", S: "U", C: "H", I: "H", A: "N" });
    case "broken_object_property_level_authorization":
      return calcCvss({ AV: "N", AC: "L", PR: "L", UI: "N", S: "U", C: "H", I: "L", A: "N" });
    case "broken_authentication":
      return calcCvss({ AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "H", I: "H", A: "N" });
    case "injection":
      return calcCvss({ AV: "N", AC: "L", PR: "N", UI: "N", S: "C", C: "H", I: "H", A: "H" });
    case "insecure_design": // race condition
      return calcCvss({ AV: "N", AC: "H", PR: "L", UI: "N", S: "U", C: "L", I: "H", A: "N" });
    case "security_misconfiguration":
      return calcCvss({ AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "L", I: "N", A: "N" });
    case "cryptographic_failure":
      return calcCvss({ AV: "N", AC: "H", PR: "N", UI: "N", S: "U", C: "H", I: "N", A: "N" });
    case "ssrf":
      return calcCvss({ AV: "N", AC: "L", PR: "N", UI: "N", S: "C", C: "H", I: "L", A: "N" });
    case "vulnerable_components":
      return calcCvss({ AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "L", I: "L", A: "N" });
    default:
      return calcCvss({ AV: "N", AC: "L", PR: "N", UI: "N", S: "U", C: "L", I: "N", A: "N" });
  }
}

// ── PoC step generator ────────────────────────────────────────────────────────
//
// Ticket TRC.4: rewritten evidence-first after the previous version was found to read
// evidence field names (evidence.ownerProfile, evidence.objectId, evidence.attackerProfile,
// evidence.parameter, evidence.payload, evidence.responseStatus, evidence.concurrentRequests,
// evidence.successCount) that don't exist on SecurityFindingEvidence's real shape - every
// vuln-class branch silently fell through to its placeholder default (OBJECT_ID, user A, INPUT)
// on every real finding. The fix: never manufacture a specific the evidence doesn't contain.
// Build the step sequence from the ACTUAL captured transactions first (requestResponse[]), add
// vuln-class explanatory text AROUND that real sequence rather than substituting fields into a
// template - the opposite construction order from the bug, and structurally harder to break the
// same way again, since there's no per-class field name to typo or invent.

// One static, evidence-independent closing sentence per class - never references a field that
// might not exist, so it can never itself become a placeholder.
function vulnClassClosingNote(vulnClass: string): string {
  switch (vulnClass) {
    case "broken_object_level_authorization":
    case "broken_object_property_level_authorization":
      return "This demonstrates that object ownership is not enforced across the request(s) above.";
    case "broken_function_level_authorization":
      return "This demonstrates that a privileged function is reachable without the required role.";
    case "broken_authentication":
      return "This demonstrates that the endpoint is reachable without a valid authentication context.";
    case "injection":
      return "This demonstrates that unsafe input reaches the endpoint's parser without adequate validation.";
    case "insecure_design":
      return "This demonstrates that concurrent or repeated requests are not guarded against a single-execution requirement.";
    case "security_misconfiguration":
      return "This demonstrates a configuration or metadata exposure that aids further attacks.";
    case "ssrf":
      return "This demonstrates that a server-side request can be redirected to an attacker-influenced target.";
    default:
      return "The sequence above reproduces the behavior captured during the automated scan.";
  }
}

function pocSteps(vulnClass: string, finding: any): string[] {
  const evidence = finding.evidence ?? {};

  // Prefer the finding's own real reproduction steps when present (populated by baseline.ts /
  // intelligent-validation.ts / anomaly-baseline.ts today) - deduplicated, blanks dropped, since
  // real scanner output can produce both.
  if (Array.isArray(evidence.reproductionSteps)) {
    const cleaned = [
      ...new Set(
        (evidence.reproductionSteps as unknown[])
          .map((s) => (typeof s === "string" ? s.trim() : ""))
          .filter((s) => s.length > 0)
      ),
    ];
    if (cleaned.length > 0) return cleaned;
  }

  // Otherwise, build from the actual captured request/response transactions, in order.
  const requestResponse: Array<{ method?: string; url?: string; status?: number; profile?: string }> = Array.isArray(
    evidence.requestResponse
  )
    ? evidence.requestResponse
    : [];

  if (requestResponse.length > 0) {
    const steps = requestResponse.map((rr, i) => {
      const method = rr.method ?? "GET";
      const url = rr.url ?? finding.location ?? "the affected endpoint";
      const profile = rr.profile ? ` as ${rr.profile}` : "";
      const outcome = rr.status !== undefined ? `observe HTTP ${rr.status}` : "observe the response";
      return `${i + 1}. Send ${method} ${url}${profile}; ${outcome}.`;
    });
    return [...steps, `${steps.length + 1}. ${vulnClassClosingNote(vulnClass)}`];
  }

  // No captured transactions at all - the most truthful step available is a generic pointer at
  // the endpoint, never a fabricated identifier or payload.
  const location = finding.location ?? "the affected endpoint";
  return [`1. Send the captured request to ${location}.`, `2. Observe the behavior described: ${finding.title ?? "see finding description"}.`];
}

// ── Impact statement generator ────────────────────────────────────────────────

function impactStatement(vulnClass: string, targetUrl: string, evidence: any): string {
  const domain = targetUrl.replace(/^https?:\/\//, "").split("/")[0];
  switch (vulnClass) {
    case "broken_object_level_authorization":
      return `An authenticated attacker can read, modify, or delete data belonging to any other user on ${domain} by substituting object IDs in API requests. In a financial application this includes account details, transaction history, card data, and personally identifiable information.`;
    case "broken_function_level_authorization":
      return `A lower-privileged user can invoke administrative or privileged functions on ${domain} that should be restricted to higher roles. This enables privilege escalation, potentially granting access to all user data, configuration changes, or financial operations.`;
    case "broken_authentication":
      return `Unauthenticated clients can access protected endpoints on ${domain}, bypassing the authentication boundary entirely. All data returned by these endpoints is exposed to any internet user.`;
    case "injection":
      return `User-supplied input reaches an unsafe execution context on ${domain}. Depending on the backend, this could enable database extraction, remote code execution, or file system access.`;
    case "insecure_design":
      return `Concurrent requests to ${domain} can bypass single-execution guarantees on state-changing operations. In a financial context this enables double-spend: the same balance deduction, transfer, or reward redemption succeeds multiple times simultaneously.`;
    case "security_misconfiguration":
      return `${domain} exposes configuration or metadata that aids further attacks — enumerating the API surface, fingerprinting technology stack, or confirming attack vectors without triggering detection.`;
    default:
      return `This vulnerability on ${domain} could allow an attacker to gain unauthorized access, extract sensitive data, or disrupt service availability.`;
  }
}

// ── Report structure ──────────────────────────────────────────────────────────

export type BugBountyReport = {
  title: string;
  severity: string;
  cvssScore: number;
  cvssVector: string;
  targetUrl: string;
  endpoint: string;
  vulnerability: string;
  description: string;
  impact: string;
  stepsToReproduce: string[];
  recommendedFix: string;
  references: string[];
  owaspCategory?: string;
  tool: string;
  generatedAt: string;
  markdown: string;
};

export function generateBugBountyReport(finding: {
  id: string;
  title: string;
  severity: string;
  description?: string | null;
  location?: string | null;
  tool?: string | null;
  evidence?: any;
  suggestion?: string | null;
}, targetUrl: string): BugBountyReport {
  const evidence = finding.evidence ?? {};
  const vulnClass: string = evidence.vulnerabilityClass ?? "security_misconfiguration";
  const cvss = cvssForVulnClass(vulnClass, evidence);
  const endpoint = finding.location ?? targetUrl;
  const steps = pocSteps(vulnClass, finding);
  const impact = impactStatement(vulnClass, targetUrl, evidence);

  // Title follows HackerOne convention: [Vulnerability Type] in [Component/Endpoint]
  const vulnTypeLabel: Record<string, string> = {
    broken_object_level_authorization:        "Broken Object Level Authorization (BOLA/IDOR)",
    broken_function_level_authorization:      "Broken Function Level Authorization",
    broken_object_property_level_authorization: "Broken Object Property Level Authorization",
    broken_authentication:                    "Broken Authentication / Missing Auth",
    injection:                                "Injection",
    insecure_design:                          "Race Condition",
    security_misconfiguration:                "Security Misconfiguration",
    cryptographic_failure:                    "Cryptographic Failure",
    ssrf:                                     "Server-Side Request Forgery (SSRF)",
    vulnerable_components:                    "Vulnerable / Outdated Component",
  };
  const vulnLabel = vulnTypeLabel[vulnClass] ?? finding.title;
  const endpointShort = endpoint.replace(/^https?:\/\/[^/]+/, "") || endpoint;
  const reportTitle = `${vulnLabel} in ${endpointShort || new URL(targetUrl).hostname}`;

  const references: string[] = [
    evidence.owaspCategory ? `OWASP ${evidence.owaspCategory}` : "",
    evidence.owaspApiCategory ? `OWASP ${evidence.owaspApiCategory}` : "",
    "https://owasp.org/www-project-top-ten/",
    "https://owasp.org/API-Security/",
  ].filter(Boolean);

  const suggestion = finding.suggestion ?? "Enforce server-side authorization checks and follow the principle of least privilege.";

  // ── Markdown report ───────────────────────────────────────────────────────

  const md = [
    `# ${reportTitle}`,
    "",
    `**Severity:** ${cvss.severity} (CVSS ${cvss.score} — \`${cvss.vector}\`)`,
    `**Target:** ${targetUrl}`,
    `**Endpoint:** \`${endpoint}\``,
    `**Tool that found it:** ${finding.tool ?? "TestMind Security Scanner"}`,
    "",
    "---",
    "",
    "## Description",
    "",
    finding.description ?? finding.title,
    "",
    "## Impact",
    "",
    impact,
    "",
    "## Steps to Reproduce",
    "",
    ...steps.map((s) => s),
    "",
    "## Recommended Fix",
    "",
    suggestion,
    "",
    "## References",
    "",
    ...references.map((r) => `- ${r}`),
    "",
    "---",
    "",
    `*Report generated by TestMind AI Security Scanner — ${new Date().toISOString()}*`,
  ].join("\n");

  return {
    title: reportTitle,
    severity: cvss.severity,
    cvssScore: cvss.score,
    cvssVector: cvss.vector,
    targetUrl,
    endpoint,
    vulnerability: vulnLabel,
    description: finding.description ?? finding.title,
    impact,
    stepsToReproduce: steps,
    recommendedFix: suggestion,
    references,
    owaspCategory: evidence.owaspCategory,
    tool: finding.tool ?? "TestMind Security Scanner",
    generatedAt: new Date().toISOString(),
    markdown: md,
  };
}
