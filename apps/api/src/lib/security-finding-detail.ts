type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";
type FindingType = "recon" | "static_analysis" | "dependency" | "dynamic";

export type SecurityFindingLike = {
  title: string;
  severity: FindingSeverity;
  type: FindingType;
  description?: string | null;
  location?: string | null;
  tool?: string | null;
  evidence?: unknown;
  suggestion?: string | null;
};

export type SecurityFindingDetail = {
  title: string;
  severity: FindingSeverity;
  summary: string;
  affectedAsset: string;
  whyItMatters: string;
  confidence: {
    score: number;
    label: "low" | "medium" | "high";
    rationale: string;
  };
  evidence: string[];
  safeVerificationSteps: string[];
  recommendedFix: string[];
  defensiveNote: string;
  cve: string | null;
};

type FindingCategory =
  | "dependency"
  | "headers"
  | "cookies"
  | "cors"
  | "clickjacking"
  | "directory_listing"
  | "sensitive_path"
  | "service_exposure"
  | "http_methods"
  | "https"
  | "error_disclosure"
  | "version_disclosure"
  | "open_redirect"
  | "xss"
  | "sql_error"
  | "path_traversal"
  | "generic";

function normalizeText(...values: Array<string | null | undefined>): string {
  return values.filter(Boolean).join(" ").toLowerCase();
}

function classifyFinding(finding: SecurityFindingLike): FindingCategory {
  const text = normalizeText(finding.title, finding.description, finding.tool);
  if (finding.type === "dependency") return "dependency";
  if (/missing security header|frame protection headers/.test(text)) return "headers";
  if (/cookies missing secure\/httponly/.test(text)) return "cookies";
  if (/cors misconfiguration|allow-origin/.test(text)) return "cors";
  if (/clickjacking/.test(text)) return "clickjacking";
  if (/directory listing/.test(text)) return "directory_listing";
  if (/sensitive path exposed/.test(text)) return "sensitive_path";
  if (/trace\/track|http methods exposed|allow header/.test(text)) return "http_methods";
  if (/non-https base url/.test(text)) return "https";
  if (/error disclosure|stack trace/.test(text)) return "error_disclosure";
  if (/banner disclosed|technology stack disclosed|version disclosed|proxy chain disclosed/.test(text)) {
    return "version_disclosure";
  }
  if (/service exposed on plaintext port|service identified|port \d+ open/.test(text)) {
    return "service_exposure";
  }
  if (/open redirect/.test(text)) return "open_redirect";
  if (/xss/.test(text)) return "xss";
  if (/sql/.test(text)) return "sql_error";
  if (/traversal/.test(text)) return "path_traversal";
  return "generic";
}

function confidenceForFinding(
  finding: SecurityFindingLike,
  category: FindingCategory
): SecurityFindingDetail["confidence"] {
  let score = 72;
  let rationale = "Detected by deterministic scan logic with a directly observable signal.";

  if (finding.type === "dependency") {
    score = 95;
    rationale = "Dependency findings are based on advisory-backed package metadata.";
  } else if (category === "headers" || category === "cookies" || category === "sensitive_path") {
    score = 92;
    rationale = "The issue is confirmed directly from the HTTP response seen by the scanner.";
  } else if (category === "directory_listing" || category === "http_methods") {
    score = 88;
    rationale = "The response advertised the risky behavior explicitly.";
  } else if (
    category === "open_redirect" ||
    category === "xss" ||
    category === "sql_error" ||
    category === "path_traversal"
  ) {
    score = 78;
    rationale = "The finding came from a bounded active check and should be re-verified in a safe test environment.";
  } else if (category === "service_exposure" || category === "version_disclosure") {
    score = 84;
    rationale = "The signal is observable, but operational context determines the real-world risk.";
  }

  if (finding.severity === "critical") score = Math.max(score, 90);
  if (finding.severity === "info") score = Math.min(score, 80);

  return {
    score,
    label: score >= 85 ? "high" : score >= 70 ? "medium" : "low",
    rationale,
  };
}

function evidenceLines(finding: SecurityFindingLike): string[] {
  const evidence: string[] = [];
  if (finding.location) evidence.push(`Affected asset: ${finding.location}`);
  if (finding.tool) evidence.push(`Detected by: ${finding.tool}`);
  if (finding.description) evidence.push(`Scanner note: ${finding.description}`);

  if (finding.evidence && typeof finding.evidence === "object" && !Array.isArray(finding.evidence)) {
    for (const [key, value] of Object.entries(finding.evidence as Record<string, unknown>).slice(0, 4)) {
      if (value == null) continue;
      evidence.push(`${key}: ${String(value).slice(0, 180)}`);
    }
  }

  return evidence.length > 0 ? evidence : ["Observed by the scanner during the recorded security job."];
}

function buildSummary(finding: SecurityFindingLike, category: FindingCategory): string {
  const asset = finding.location || "the scanned asset";
  switch (category) {
    case "dependency":
      return `A dependency issue was reported for ${asset}. The package inventory should be reviewed and patched.`;
    case "headers":
      return `Security response hardening appears incomplete on ${asset}.`;
    case "cookies":
      return `Cookie protection flags are missing or incomplete on ${asset}.`;
    case "cors":
      return `Cross-origin access controls appear too permissive on ${asset}.`;
    case "clickjacking":
      return `The application may be frameable because clickjacking protections were not confirmed on ${asset}.`;
    case "directory_listing":
      return `A directory-style index appears exposed on ${asset}.`;
    case "sensitive_path":
      return `A sensitive route returned a successful response on ${asset}.`;
    case "service_exposure":
      return `A network service was exposed on ${asset} and should be validated against expected attack surface.`;
    case "http_methods":
      return `The server advertised HTTP methods that should be reviewed on ${asset}.`;
    case "https":
      return `The target is reachable over HTTP rather than HTTPS.`;
    case "error_disclosure":
      return `The server appears to reveal internal error details on ${asset}.`;
    case "version_disclosure":
      return `Technology or version information is exposed in responses from ${asset}.`;
    case "open_redirect":
      return `Redirect handling on ${asset} may allow untrusted destinations.`;
    case "xss":
      return `User-controlled data may be reflected without safe output handling on ${asset}.`;
    case "sql_error":
      return `Input handling on ${asset} may leak database error behavior.`;
    case "path_traversal":
      return `Path handling on ${asset} may not safely constrain user-supplied file references.`;
    default:
      return finding.description || `The scanner reported a security finding affecting ${asset}.`;
  }
}

function buildWhyItMatters(category: FindingCategory): string {
  switch (category) {
    case "dependency":
      return "Known vulnerable components can expose reachable attack paths even when your application code is otherwise correct.";
    case "headers":
      return "Missing browser-facing security headers weakens baseline protection against common client-side abuse patterns.";
    case "cookies":
      return "Cookies without Secure or HttpOnly are easier to expose through transport or client-side script access.";
    case "cors":
      return "Overly broad cross-origin access can let untrusted origins read sensitive application responses.";
    case "clickjacking":
      return "If pages can be framed by other origins, users may be tricked into clicking hidden or disguised controls.";
    case "directory_listing":
      return "Browsable indexes can leak internal file names, backups, and implementation details.";
    case "sensitive_path":
      return "Sensitive endpoints often expose internal state, credentials, metrics, or administration surfaces.";
    case "service_exposure":
      return "Unexpected network services expand the reachable attack surface and often bypass normal application controls.";
    case "http_methods":
      return "Unnecessary methods can enable unsafe state changes or legacy protocol abuse.";
    case "https":
      return "Without HTTPS, traffic and session data can be intercepted or modified in transit.";
    case "error_disclosure":
      return "Detailed error output can reveal framework, query, path, or stack information that helps attackers map the system.";
    case "version_disclosure":
      return "Version leakage helps adversaries align public advisories and exploit research to your stack.";
    case "open_redirect":
      return "Open redirects can be chained into phishing, token leakage, or trust-boundary bypasses.";
    case "xss":
      return "Unsafe output handling can let attacker-controlled input execute in a victim's browser context.";
    case "sql_error":
      return "Database error leakage signals weak query handling and can disclose schema or backend details.";
    case "path_traversal":
      return "Unsafe file path handling can expose files outside the intended application boundary.";
    default:
      return "The issue should be reviewed because it may weaken application hardening or expose unnecessary attack surface.";
  }
}

function safeVerificationSteps(
  finding: SecurityFindingLike,
  category: FindingCategory
): string[] {
  const asset = finding.location || "the affected asset";
  switch (category) {
    case "dependency":
      return [
        "Review the package name and version in the project lockfile or manifest.",
        "Confirm the advisory in the package manager or vendor advisory feed.",
        "Retest after upgrading to verify the vulnerable version is no longer resolved.",
      ];
    case "headers":
      return [
        `Fetch ${asset} with a HEAD or GET request and inspect the response headers.`,
        "Confirm the expected hardening header is present on the final application response.",
        "Repeat the check on authenticated and unauthenticated routes if they are served differently.",
      ];
    case "cookies":
      return [
        `Inspect Set-Cookie headers returned by ${asset}.`,
        "Verify session-bearing cookies include Secure and HttpOnly, and SameSite where appropriate.",
        "Retest login and session refresh flows after remediation.",
      ];
    case "cors":
      return [
        `Send a request to ${asset} with a non-trusted Origin header from a controlled test client.`,
        "Confirm the response does not reflect arbitrary origins and that credentials are not enabled for untrusted sites.",
        "Verify the policy against the exact list of approved front-end origins.",
      ];
    case "clickjacking":
      return [
        `Inspect ${asset} for X-Frame-Options or a CSP frame-ancestors directive.`,
        "Validate the framing policy on the final rendered response, not only an upstream redirect.",
        "Retest after remediation to confirm the page cannot be embedded by untrusted origins.",
      ];
    case "directory_listing":
      return [
        `Open ${asset} in a browser or fetch it with a simple GET request.`,
        "Confirm the response no longer renders an index-style listing of files or directories.",
        "Verify the backing directory does not contain web-accessible backup or archive files.",
      ];
    case "sensitive_path":
      return [
        `Request ${asset} from a normal unauthenticated client in a non-production environment.`,
        "Confirm the endpoint now returns an authorization error or is removed entirely.",
        "Review whether the route should exist publicly at all or only behind internal controls.",
      ];
    case "service_exposure":
      return [
        "Confirm the service and port are intentionally exposed for this environment.",
        "Review the owning process, bind address, and any network policy around the exposed service.",
        "After restricting exposure, rerun the scoped scan to confirm the service is no longer reachable.",
      ];
    case "http_methods":
      return [
        `Issue an OPTIONS request to ${asset} and inspect the Allow or Public headers.`,
        "Confirm only the methods required by the application contract are advertised.",
        "Retest after server or gateway changes to ensure unsafe methods are no longer exposed.",
      ];
    case "https":
      return [
        "Verify the public entrypoint redirects HTTP to HTTPS and that TLS is enabled end to end.",
        "Check HSTS behavior after HTTPS is in place.",
        "Confirm internal links, callbacks, and generated URLs prefer HTTPS consistently.",
      ];
    case "error_disclosure":
      return [
        `Trigger a benign invalid request to ${asset} in a test environment.`,
        "Confirm the response returns a generic error page without stack traces or internal identifiers.",
        "Review logs to ensure detailed diagnostics remain server-side only.",
      ];
    case "version_disclosure":
      return [
        `Inspect the response headers for ${asset}.`,
        "Confirm product, framework, and version banners are removed or normalized where possible.",
        "Verify any remaining header is operationally necessary before leaving it exposed.",
      ];
    case "open_redirect":
      return [
        "Review the redirect parameter handling in a test environment using only approved internal destinations.",
        "Confirm the application allows only known-safe redirect targets or relative paths.",
        "Retest with both valid and invalid destinations after remediation.",
      ];
    case "xss":
      return [
        "Use a harmless marker string in the affected input path and inspect how it is rendered back.",
        "Confirm the marker is encoded or rejected rather than interpreted as active content.",
        "Retest the exact render path after fixing output encoding or template handling.",
      ];
    case "sql_error":
      return [
        "Review the request path that triggered the database-style error behavior in a test environment.",
        "Confirm invalid input is handled with generic validation errors rather than backend exception output.",
        "Inspect query construction to ensure parameterized access is used consistently.",
      ];
    case "path_traversal":
      return [
        "Review file path normalization and allowlisting logic in the affected route.",
        "Confirm out-of-scope path inputs are rejected before filesystem access occurs.",
        "Retest with invalid relative path input in a safe environment after remediation.",
      ];
    default:
      return [
        "Review the affected route, asset, or package in a test environment.",
        "Confirm the scanner signal is reproducible using a benign request or configuration check.",
        "Retest after remediation to verify the finding no longer appears.",
      ];
  }
}

function recommendedFixes(
  finding: SecurityFindingLike,
  category: FindingCategory
): string[] {
  switch (category) {
    case "dependency":
      return [
        "Upgrade the affected package to a fixed version.",
        "If no fix exists, pin to a safer version or apply the vendor mitigation guidance.",
        "Add dependency review or audit checks to CI so regressions are caught earlier.",
      ];
    case "headers":
      return [
        "Set the missing security headers at the application or edge layer.",
        "Standardize header policy across redirects, static assets, and app routes.",
        "Add an automated regression check for the required headers.",
      ];
    case "cookies":
      return [
        "Mark session-bearing cookies as Secure and HttpOnly.",
        "Set SameSite explicitly based on the application flow.",
        "Avoid storing sensitive data directly in client-readable cookies.",
      ];
    case "cors":
      return [
        "Replace wildcard or reflected origins with a strict allowlist.",
        "Do not enable credentialed cross-origin access for untrusted origins.",
        "Apply the same policy at both the app and any reverse proxy layer.",
      ];
    case "clickjacking":
      return [
        "Set X-Frame-Options or CSP frame-ancestors based on your embedding requirements.",
        "Apply the policy consistently on all user-facing pages.",
        "Document any approved embedding exceptions explicitly.",
      ];
    case "directory_listing":
      return [
        "Disable auto-index or directory listing at the web server or hosting layer.",
        "Remove backup, archive, and internal files from web-accessible directories.",
        "Serve only the specific assets the application needs to expose.",
      ];
    case "sensitive_path":
      return [
        "Move the endpoint behind authentication, internal networking, or remove it from public exposure.",
        "Return 404 or 403 for sensitive internal routes.",
        "Review deployment artifacts to ensure secrets and admin assets are not published.",
      ];
    case "service_exposure":
      return [
        "Close unused ports and bind internal services to private interfaces only.",
        "Prefer encrypted protocols over plaintext equivalents.",
        "Restrict any required exposed service with network policy and authentication controls.",
      ];
    case "http_methods":
      return [
        "Disable unsupported or legacy methods at the app server, framework, or reverse proxy.",
        "Expose only the methods required by the route contract.",
        "Add a regression check for method allowlists on sensitive routes.",
      ];
    case "https":
      return [
        "Redirect all HTTP traffic to HTTPS.",
        "Enable TLS consistently across the entrypoint and downstream services.",
        "Add HSTS after confirming HTTPS is stable for all supported hosts.",
      ];
    case "error_disclosure":
      return [
        "Return generic client-facing error messages.",
        "Keep stack traces and detailed diagnostics in server-side logs only.",
        "Review exception handling middleware and production debug settings.",
      ];
    case "version_disclosure":
      return [
        "Remove or normalize framework and version disclosure headers where feasible.",
        "Avoid leaking unnecessary product details in error pages or banners.",
        "Track remaining disclosures as operational exceptions if they cannot be removed.",
      ];
    case "open_redirect":
      return [
        "Allow only relative redirects or an explicit allowlist of trusted destinations.",
        "Normalize and validate redirect targets before issuing a redirect.",
        "Log and monitor rejected redirect attempts for abuse visibility.",
      ];
    case "xss":
      return [
        "Apply context-appropriate output encoding where user input is rendered.",
        "Validate and constrain user-controlled input before storage or reflection.",
        "Backstop client rendering with a strict Content Security Policy where possible.",
      ];
    case "sql_error":
      return [
        "Use parameterized queries or ORM parameter binding consistently.",
        "Return generic validation errors instead of raw backend exceptions.",
        "Review logging so database details are not exposed to clients.",
      ];
    case "path_traversal":
      return [
        "Resolve and normalize user-supplied paths before access.",
        "Constrain file operations to an allowlisted base directory.",
        "Reject traversal tokens and unexpected file targets early.",
      ];
    default:
      return [
        finding.suggestion || "Review the affected control and harden it based on the scanner evidence.",
        "Add a focused regression check so the same issue is caught automatically next time.",
        "Document the accepted behavior and ownership for future reviews.",
      ];
  }
}

function extractCve(finding: SecurityFindingLike): string | null {
  const text = `${finding.title} ${finding.description || ""}`;
  const match = text.match(/\bCVE-\d{4}-\d{4,7}\b/i);
  return match ? match[0].toUpperCase() : null;
}

export function buildSecurityFindingDetail(finding: SecurityFindingLike): SecurityFindingDetail {
  const category = classifyFinding(finding);
  return {
    title: finding.title,
    severity: finding.severity,
    summary: buildSummary(finding, category),
    affectedAsset: finding.location || "Project or application surface",
    whyItMatters: buildWhyItMatters(category),
    confidence: confidenceForFinding(finding, category),
    evidence: evidenceLines(finding),
    safeVerificationSteps: safeVerificationSteps(finding, category),
    recommendedFix: recommendedFixes(finding, category),
    defensiveNote:
      "This guidance stays in defensive mode: verify with benign requests, review evidence, and remediate without attempting exploitation.",
    cve: extractCve(finding),
  };
}

export function buildSecurityRegressionTest(finding: SecurityFindingLike): string {
  const category = classifyFinding(finding);
  const titleLiteral = JSON.stringify(`security regression: ${finding.title}`);
  const locationLiteral = JSON.stringify(finding.location || "/");
  const headerName =
    finding.title.match(/missing security header:\s*([a-z0-9-]+)/i)?.[1]?.toLowerCase() || "";

  if (category === "headers" && headerName) {
    return `test(${titleLiteral}, async ({ request }) => {
  const response = await request.get(${locationLiteral});
  expect(response.headers()[${JSON.stringify(headerName)}]).toBeTruthy();
});`;
  }

  if (category === "cookies") {
    return `test(${titleLiteral}, async ({ request }) => {
  const response = await request.get(${locationLiteral});
  const cookies = response.headersArray().filter((header) => header.name.toLowerCase() === "set-cookie");
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) {
    expect(cookie.value).toMatch(/HttpOnly/i);
    expect(cookie.value).toMatch(/Secure/i);
  }
});`;
  }

  if (category === "clickjacking") {
    return `test(${titleLiteral}, async ({ request }) => {
  const response = await request.get(${locationLiteral});
  const headers = response.headers();
  expect(headers["x-frame-options"] || headers["content-security-policy"]).toBeTruthy();
});`;
  }

  if (category === "cors") {
    return `test(${titleLiteral}, async ({ request }) => {
  const response = await request.get(${locationLiteral}, {
    headers: { Origin: "https://untrusted.example.test" },
  });
  const acao = response.headers()["access-control-allow-origin"];
  expect(acao === "*" || acao === "https://untrusted.example.test").toBeFalsy();
});`;
  }

  if (category === "directory_listing") {
    return `test(${titleLiteral}, async ({ request }) => {
  const response = await request.get(${locationLiteral});
  const body = await response.text();
  expect(body.toLowerCase()).not.toContain("index of");
});`;
  }

  if (category === "sensitive_path") {
    return `test(${titleLiteral}, async ({ request }) => {
  const response = await request.get(${locationLiteral});
  expect([401, 403, 404]).toContain(response.status());
});`;
  }

  if (category === "http_methods") {
    return `test(${titleLiteral}, async ({ request }) => {
  const response = await request.fetch(${locationLiteral}, { method: "OPTIONS" });
  const allow = response.headers()["allow"] || "";
  expect(allow.toUpperCase()).not.toContain("TRACE");
  expect(allow.toUpperCase()).not.toContain("TRACK");
});`;
  }

  if (category === "https") {
    return `test(${titleLiteral}, async () => {
  expect(${locationLiteral}.startsWith("https://")).toBeTruthy();
});`;
  }

  return `test(${titleLiteral}, async ({ request, page }) => {
  await page.goto(${locationLiteral});
  const response = await request.get(${locationLiteral});
  expect(response.ok()).toBeTruthy();
  // TODO: Add a focused assertion proving the vulnerable behavior no longer occurs.
});`;
}
