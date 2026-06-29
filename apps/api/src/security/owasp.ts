import type { ExpectedSecurityControl, SecuritySeverity } from "./types.js";

export type VulnerabilityClass =
  | "broken_object_level_authorization"
  | "broken_authentication"
  | "broken_function_level_authorization"
  | "broken_object_property_level_authorization"
  | "injection"
  | "security_misconfiguration"
  | "cryptographic_failure"
  | "insecure_design"
  | "vulnerable_components"
  | "integrity_failure"
  | "logging_monitoring_failure"
  | "ssrf"
  | "anomalous_api_behavior";

type CatalogEntry = {
  name: string;
  owaspCategory: string;
  owaspApiCategory?: string;
  complianceRefs: string[];
  remediationSteps: string[];
  complianceSteps: string[];
};

export const OWASP_WEB_TOP_10_2021 = [
  "A01:2021 Broken Access Control",
  "A02:2021 Cryptographic Failures",
  "A03:2021 Injection",
  "A04:2021 Insecure Design",
  "A05:2021 Security Misconfiguration",
  "A06:2021 Vulnerable and Outdated Components",
  "A07:2021 Identification and Authentication Failures",
  "A08:2021 Software and Data Integrity Failures",
  "A09:2021 Security Logging and Monitoring Failures",
  "A10:2021 Server-Side Request Forgery",
] as const;

export const OWASP_API_TOP_10_2023 = [
  "API1:2023 Broken Object Level Authorization",
  "API2:2023 Broken Authentication",
  "API3:2023 Broken Object Property Level Authorization",
  "API4:2023 Unrestricted Resource Consumption",
  "API5:2023 Broken Function Level Authorization",
  "API6:2023 Unrestricted Access to Sensitive Business Flows",
  "API7:2023 Server Side Request Forgery",
  "API8:2023 Security Misconfiguration",
  "API9:2023 Improper Inventory Management",
  "API10:2023 Unsafe Consumption of APIs",
] as const;

export const VULNERABILITY_CATALOG: Record<VulnerabilityClass, CatalogEntry> = {
  broken_object_level_authorization: {
    name: "Broken Object Level Authorization",
    owaspCategory: "A01:2021 Broken Access Control",
    owaspApiCategory: "API1:2023 Broken Object Level Authorization",
    complianceRefs: ["OWASP ASVS V4 Access Control", "SOC 2 CC6", "ISO 27001 A.5.15"],
    remediationSteps: [
      "Enforce object ownership checks server-side for every object identifier accepted from the client.",
      "Use authorization decisions based on the authenticated subject and the requested object, not client-provided role or owner fields.",
      "Return 401, 403, or 404 for objects outside the caller's allowed scope.",
    ],
    complianceSteps: [
      "Document the access-control rule for the affected API route.",
      "Add a cross-account regression test using approved test accounts and object fixtures.",
      "Capture remediation evidence showing the unauthorized profile now receives a deny response.",
    ],
  },
  broken_authentication: {
    name: "Broken Authentication",
    owaspCategory: "A07:2021 Identification and Authentication Failures",
    owaspApiCategory: "API2:2023 Broken Authentication",
    complianceRefs: ["OWASP ASVS V2 Authentication", "SOC 2 CC6", "ISO 27001 A.5.17"],
    remediationSteps: [
      "Require a valid authenticated session or token before returning protected data.",
      "Reject missing, expired, malformed, and revoked credentials consistently.",
      "Centralize authentication middleware so protected routes cannot bypass it accidentally.",
    ],
    complianceSteps: [
      "Record the expected authentication requirement for the route.",
      "Add regression checks for unauthenticated, malformed, and expired-token access.",
      "Keep evidence of the deny response after remediation.",
    ],
  },
  broken_function_level_authorization: {
    name: "Broken Function Level Authorization",
    owaspCategory: "A01:2021 Broken Access Control",
    owaspApiCategory: "API5:2023 Broken Function Level Authorization",
    complianceRefs: ["OWASP ASVS V4 Access Control", "SOC 2 CC6", "ISO 27001 A.5.15"],
    remediationSteps: [
      "Enforce role and permission checks server-side on privileged functions.",
      "Deny lower-privileged users before executing business logic.",
      "Keep route-level permissions in a reviewed policy table or middleware layer.",
    ],
    complianceSteps: [
      "Document the required role or permission for the affected route.",
      "Add a lower-role regression test that expects 401, 403, or 404.",
      "Review adjacent privileged routes for the same missing control.",
    ],
  },
  broken_object_property_level_authorization: {
    name: "Broken Object Property Level Authorization",
    owaspCategory: "A01:2021 Broken Access Control",
    owaspApiCategory: "API3:2023 Broken Object Property Level Authorization",
    complianceRefs: ["OWASP ASVS V4 Access Control", "SOC 2 CC6", "ISO 27001 A.5.15"],
    remediationSteps: [
      "Filter response properties according to the caller's role and object relationship.",
      "Use explicit response DTOs or serializers instead of returning raw database objects.",
      "Add denylist or allowlist checks for sensitive fields in lower-privilege responses.",
    ],
    complianceSteps: [
      "List sensitive fields for the route and the roles allowed to view them.",
      "Add a lower-role regression test proving those fields are absent.",
      "Retain before and after evidence for audit review.",
    ],
  },
  injection: {
    name: "Injection or Unsafe Input Handling",
    owaspCategory: "A03:2021 Injection",
    owaspApiCategory: undefined,
    complianceRefs: ["OWASP ASVS V5 Validation", "SOC 2 CC7", "ISO 27001 A.8.28"],
    remediationSteps: [
      "Validate and normalize client input before it reaches query, template, or command execution paths.",
      "Use parameterized queries or framework-safe binding APIs.",
      "Return generic validation errors rather than backend exception details.",
    ],
    complianceSteps: [
      "Document input validation rules for the affected parameter or request body.",
      "Add regression tests for malformed input and generic error handling.",
      "Verify logs retain diagnostic detail while responses stay sanitized.",
    ],
  },
  security_misconfiguration: {
    name: "Security Misconfiguration",
    owaspCategory: "A05:2021 Security Misconfiguration",
    owaspApiCategory: "API8:2023 Security Misconfiguration",
    complianceRefs: ["OWASP ASVS V14 Configuration", "SOC 2 CC7", "ISO 27001 A.8.9"],
    remediationSteps: [
      "Harden the affected server, header, CORS, debug, or deployment configuration.",
      "Apply the same baseline across authenticated, unauthenticated, and error responses.",
      "Automate configuration checks in CI and deployment validation.",
    ],
    complianceSteps: [
      "Record the approved security baseline for the environment.",
      "Attach scan evidence showing the misconfiguration is corrected.",
      "Add a regression check for the baseline control.",
    ],
  },
  cryptographic_failure: {
    name: "Cryptographic Failure",
    owaspCategory: "A02:2021 Cryptographic Failures",
    complianceRefs: ["OWASP ASVS V6 Cryptography", "SOC 2 CC6", "ISO 27001 A.8.24"],
    remediationSteps: [
      "Protect sensitive data in transit and at rest with approved cryptographic controls.",
      "Avoid weak algorithms, missing TLS, and long-lived secrets.",
      "Rotate exposed or weak credentials after remediation.",
    ],
    complianceSteps: [
      "Document the cryptographic control and approved algorithm or transport requirement.",
      "Retest the affected endpoint or token after remediation.",
      "Store evidence of TLS, token, or encryption enforcement.",
    ],
  },
  insecure_design: {
    name: "Insecure Design",
    owaspCategory: "A04:2021 Insecure Design",
    complianceRefs: ["OWASP ASVS Architecture", "SOC 2 CC3", "ISO 27001 A.8.27"],
    remediationSteps: [
      "Define the intended abuse-case control for the affected workflow.",
      "Add server-side validation for the business rule rather than relying on client workflow order.",
      "Review adjacent flows that share the same design assumption.",
    ],
    complianceSteps: [
      "Add the abuse case and expected control to the project threat model.",
      "Create a regression test for the business rule.",
      "Record product/security owner sign-off for the corrected design.",
    ],
  },
  vulnerable_components: {
    name: "Vulnerable and Outdated Components",
    owaspCategory: "A06:2021 Vulnerable and Outdated Components",
    complianceRefs: ["OWASP ASVS V14 Dependency Management", "SOC 2 CC7", "ISO 27001 A.8.8"],
    remediationSteps: [
      "Upgrade the affected dependency to a fixed version.",
      "Remove unused vulnerable packages.",
      "Add dependency review to CI.",
    ],
    complianceSteps: [
      "Attach advisory evidence and the fixed package version.",
      "Retain dependency scan output after remediation.",
      "Track accepted risk for any package that cannot be updated immediately.",
    ],
  },
  integrity_failure: {
    name: "Software and Data Integrity Failure",
    owaspCategory: "A08:2021 Software and Data Integrity Failures",
    complianceRefs: ["OWASP ASVS V10 Integrity", "SOC 2 CC8", "ISO 27001 A.8.32"],
    remediationSteps: [
      "Verify integrity for updates, build artifacts, webhooks, and critical data transitions.",
      "Sign or validate trusted inputs where applicable.",
      "Review CI/CD controls for tamper resistance.",
    ],
    complianceSteps: [
      "Document the integrity control for the affected path.",
      "Add verification evidence to release or deployment records.",
      "Create regression checks for unsigned or untrusted data acceptance.",
    ],
  },
  logging_monitoring_failure: {
    name: "Security Logging and Monitoring Failure",
    owaspCategory: "A09:2021 Security Logging and Monitoring Failures",
    complianceRefs: ["OWASP ASVS V7 Logging", "SOC 2 CC7", "ISO 27001 A.8.15"],
    remediationSteps: [
      "Log security-relevant authentication, authorization, validation, and error events.",
      "Avoid logging secrets or sensitive payloads.",
      "Create alerting for repeated denied access or suspicious workflow anomalies.",
    ],
    complianceSteps: [
      "Document expected audit events for the route or workflow.",
      "Capture test evidence that the event is recorded.",
      "Verify monitoring or alert routing for high-risk events.",
    ],
  },
  ssrf: {
    name: "Server-Side Request Forgery",
    owaspCategory: "A10:2021 Server-Side Request Forgery",
    owaspApiCategory: "API7:2023 Server Side Request Forgery",
    complianceRefs: ["OWASP ASVS V5 Validation", "SOC 2 CC6", "ISO 27001 A.8.20"],
    remediationSteps: [
      "Constrain outbound URL fetches to explicit allowlists.",
      "Block loopback, link-local, metadata, and private network destinations unless explicitly required.",
      "Validate redirects with the same outbound policy as the original request.",
    ],
    complianceSteps: [
      "Document the outbound destination allowlist.",
      "Add regression tests for blocked internal destinations and redirects.",
      "Retain evidence of policy enforcement.",
    ],
  },
  anomalous_api_behavior: {
    name: "Anomalous API Security Behavior",
    owaspCategory: "A04:2021 Insecure Design",
    owaspApiCategory: "API6:2023 Unrestricted Access to Sensitive Business Flows",
    complianceRefs: ["OWASP ASVS Architecture", "SOC 2 CC7", "ISO 27001 A.8.16"],
    remediationSteps: [
      "Review the affected behavior against the API's declared security contract.",
      "Normalize error handling, status codes, redirects, and response schemas across equivalent authorization states.",
      "Add regression coverage for the anomalous behavior once the intended control is confirmed.",
    ],
    complianceSteps: [
      "Document whether the observed behavior is intended or a policy defect.",
      "Attach request and response evidence for the review.",
      "Create a regression test for the approved behavior.",
    ],
  },
};

export function metadataForVulnerability(vulnerabilityClass: VulnerabilityClass): CatalogEntry {
  return VULNERABILITY_CATALOG[vulnerabilityClass];
}

export function confidenceLabel(score: number): "low" | "medium" | "high" {
  if (score >= 85) return "high";
  if (score >= 65) return "medium";
  return "low";
}

export function severityForControl(control: ExpectedSecurityControl | string): SecuritySeverity {
  if (control === "object_owner_required" || control === "role_admin_required") return "high";
  if (control === "auth_required" || control === "no_sensitive_fields") return "high";
  if (control === "input_validation") return "medium";
  return "medium";
}
