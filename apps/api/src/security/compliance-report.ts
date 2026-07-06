/**
 * Compliance report generator.
 *
 * Maps scan findings to regulatory and industry security frameworks and produces
 * a structured report document suitable for sharing with a security team, compliance
 * officer, or bug bounty program as evidence of methodology and coverage.
 *
 * Supported frameworks:
 *   - OWASP Top 10 2021
 *   - OWASP API Security Top 10 2023
 *   - PCI-DSS v4.0 (relevant controls for API/web)
 *   - SOC 2 Type II (CC6-class controls)
 */

// ── Framework control definitions ─────────────────────────────────────────────

type ControlStatus = "pass" | "fail" | "partial" | "not_tested";

type Control = {
  id: string;
  name: string;
  description: string;
  owaspCategories: string[]; // which OWASP categories map to this control
  vulnClasses: string[];     // which VulnerabilityClass keys map to this control
  tools: string[];           // which scan tools cover this control
};

type ControlResult = Control & {
  status: ControlStatus;
  findingCount: number;
  findingTitles: string[];
  testedBy: string[];
};

type FrameworkResult = {
  name: string;
  version: string;
  controls: ControlResult[];
  passCount: number;
  failCount: number;
  partialCount: number;
  notTestedCount: number;
  overallStatus: ControlStatus;
  coveragePercent: number;
};

// ── OWASP Top 10 2021 controls ────────────────────────────────────────────────

const OWASP_WEB_CONTROLS: Control[] = [
  {
    id: "A01:2021", name: "Broken Access Control",
    description: "Restrictions on what authenticated users are allowed to do are not properly enforced.",
    owaspCategories: ["A01:2021 Broken Access Control"],
    vulnClasses: ["broken_object_level_authorization", "broken_function_level_authorization", "broken_object_property_level_authorization"],
    tools: ["idor-engine", "graphql-audit", "openapi-scan", "intelligent-validation"],
  },
  {
    id: "A02:2021", name: "Cryptographic Failures",
    description: "Failures related to cryptography which often lead to sensitive data exposure.",
    owaspCategories: ["A02:2021 Cryptographic Failures"],
    vulnClasses: ["cryptographic_failure"],
    tools: ["jwt-analyzer", "anomaly-baseline"],
  },
  {
    id: "A03:2021", name: "Injection",
    description: "User-supplied data is not validated, filtered, or sanitized by the application.",
    owaspCategories: ["A03:2021 Injection"],
    vulnClasses: ["injection"],
    tools: ["openapi-scan", "intelligent-validation"],
  },
  {
    id: "A04:2021", name: "Insecure Design",
    description: "Missing or ineffective control design, including race conditions and business logic flaws.",
    owaspCategories: ["A04:2021 Insecure Design"],
    vulnClasses: ["insecure_design"],
    tools: ["race-condition"],
  },
  {
    id: "A05:2021", name: "Security Misconfiguration",
    description: "Insecure default configurations, open cloud storage, verbose error messages, unnecessary features.",
    owaspCategories: ["A05:2021 Security Misconfiguration"],
    vulnClasses: ["security_misconfiguration"],
    tools: ["openapi-scan", "graphql-audit", "recon"],
  },
  {
    id: "A07:2021", name: "Identification and Authentication Failures",
    description: "Weaknesses in authentication, session management, and credential handling.",
    owaspCategories: ["A07:2021 Identification and Authentication Failures"],
    vulnClasses: ["broken_authentication"],
    tools: ["jwt-analyzer", "openapi-scan", "graphql-audit"],
  },
  {
    id: "A09:2021", name: "Security Logging and Monitoring Failures",
    description: "Insufficient logging, monitoring, and response to security events.",
    owaspCategories: ["A09:2021 Security Logging and Monitoring Failures"],
    vulnClasses: ["logging_monitoring_failure"],
    tools: ["anomaly-baseline"],
  },
];

// ── OWASP API Security Top 10 2023 controls ───────────────────────────────────

const OWASP_API_CONTROLS: Control[] = [
  {
    id: "API1:2023", name: "Broken Object Level Authorization",
    description: "APIs tend to expose endpoints that handle object identifiers, creating a wide attack surface.",
    owaspCategories: ["API1:2023 Broken Object Level Authorization"],
    vulnClasses: ["broken_object_level_authorization"],
    tools: ["idor-engine", "graphql-audit", "intelligent-validation"],
  },
  {
    id: "API2:2023", name: "Broken Authentication",
    description: "Authentication mechanisms are often implemented incorrectly.",
    owaspCategories: ["API2:2023 Broken Authentication"],
    vulnClasses: ["broken_authentication"],
    tools: ["jwt-analyzer", "openapi-scan", "graphql-audit"],
  },
  {
    id: "API3:2023", name: "Broken Object Property Level Authorization",
    description: "Lack of or improper authorization validation for properties exposed by APIs.",
    owaspCategories: ["API3:2023 Broken Object Property Level Authorization"],
    vulnClasses: ["broken_object_property_level_authorization"],
    tools: ["intelligent-validation", "graphql-audit"],
  },
  {
    id: "API5:2023", name: "Broken Function Level Authorization",
    description: "Complex access control policies with different hierarchies and roles.",
    owaspCategories: ["API5:2023 Broken Function Level Authorization"],
    vulnClasses: ["broken_function_level_authorization"],
    tools: ["openapi-scan", "graphql-audit", "intelligent-validation"],
  },
  {
    id: "API6:2023", name: "Unrestricted Access to Sensitive Business Flows",
    description: "APIs that expose business flows without considering the impact of excessive use.",
    owaspCategories: ["API6:2023 Unrestricted Access to Sensitive Business Flows"],
    vulnClasses: ["insecure_design"],
    tools: ["race-condition"],
  },
  {
    id: "API8:2023", name: "Security Misconfiguration",
    description: "Misconfigured servers, services, network, or cloud components.",
    owaspCategories: ["API8:2023 Security Misconfiguration"],
    vulnClasses: ["security_misconfiguration"],
    tools: ["graphql-audit", "openapi-scan"],
  },
];

// ── PCI-DSS v4.0 controls (API/web-relevant subset) ──────────────────────────

const PCI_CONTROLS: Control[] = [
  {
    id: "PCI 6.2", name: "Bespoke and custom software are developed securely",
    description: "All security vulnerabilities are identified and addressed in bespoke and custom software.",
    owaspCategories: ["A03:2021 Injection", "A01:2021 Broken Access Control"],
    vulnClasses: ["injection", "broken_object_level_authorization"],
    tools: ["openapi-scan", "idor-engine"],
  },
  {
    id: "PCI 6.3", name: "Security vulnerabilities are identified and addressed",
    description: "New security vulnerabilities are identified using industry-recognized sources.",
    owaspCategories: ["A05:2021 Security Misconfiguration"],
    vulnClasses: ["security_misconfiguration", "vulnerable_components"],
    tools: ["recon", "openapi-scan"],
  },
  {
    id: "PCI 6.4", name: "Public-facing web applications are protected against attacks",
    description: "Web applications are reviewed for vulnerabilities and protected by WAF or code review.",
    owaspCategories: ["A01:2021 Broken Access Control", "A03:2021 Injection"],
    vulnClasses: ["broken_object_level_authorization", "injection"],
    tools: ["openapi-scan", "idor-engine", "intelligent-validation"],
  },
  {
    id: "PCI 8.2", name: "User identification and authentication are managed",
    description: "All user IDs and authentication are managed throughout their lifecycle.",
    owaspCategories: ["A07:2021 Identification and Authentication Failures"],
    vulnClasses: ["broken_authentication"],
    tools: ["jwt-analyzer", "openapi-scan"],
  },
  {
    id: "PCI 8.6", name: "Use of application and system accounts is managed",
    description: "Accounts used by applications have the minimum access necessary.",
    owaspCategories: ["A01:2021 Broken Access Control", "API5:2023 Broken Function Level Authorization"],
    vulnClasses: ["broken_function_level_authorization"],
    tools: ["intelligent-validation", "openapi-scan"],
  },
];

// ── SOC 2 CC6 controls (logical access) ──────────────────────────────────────

const SOC2_CONTROLS: Control[] = [
  {
    id: "CC6.1", name: "Logical access security measures",
    description: "The entity implements logical access security software, infrastructure, and architectures to protect against threats.",
    owaspCategories: ["A07:2021 Identification and Authentication Failures", "A01:2021 Broken Access Control"],
    vulnClasses: ["broken_authentication", "broken_object_level_authorization"],
    tools: ["jwt-analyzer", "openapi-scan", "idor-engine"],
  },
  {
    id: "CC6.3", name: "Role-based access and least privilege",
    description: "The entity implements need-to-know principles for access to information assets.",
    owaspCategories: ["A01:2021 Broken Access Control", "API5:2023 Broken Function Level Authorization"],
    vulnClasses: ["broken_function_level_authorization", "broken_object_property_level_authorization"],
    tools: ["intelligent-validation", "graphql-audit"],
  },
  {
    id: "CC6.6", name: "Security measures against threats from outside system boundaries",
    description: "The entity implements controls to prevent and detect unauthorized access from outside.",
    owaspCategories: ["A04:2021 Insecure Design", "A05:2021 Security Misconfiguration"],
    vulnClasses: ["insecure_design", "security_misconfiguration"],
    tools: ["race-condition", "recon", "openapi-scan"],
  },
  {
    id: "CC6.8", name: "Prevention and detection of malicious software",
    description: "The entity implements controls to prevent or detect malicious software.",
    owaspCategories: ["A03:2021 Injection"],
    vulnClasses: ["injection"],
    tools: ["openapi-scan"],
  },
];

// ── Report builder ────────────────────────────────────────────────────────────

type RawFinding = {
  id: string;
  title: string;
  severity: string;
  type: string;
  location?: string | null;
  tool?: string | null;
  evidence?: any;
  status?: string | null;
};

function resolveControlStatus(control: Control, findings: RawFinding[]): ControlResult {
  const toolsRun = [...new Set(findings.map((f) => f.tool ?? "").filter(Boolean))];
  const controlFindings = findings.filter((f) => {
    const vulnClass = f.evidence?.vulnerabilityClass;
    const owaspCat = f.evidence?.owaspCategory ?? "";
    const owaspApiCat = f.evidence?.owaspApiCategory ?? "";
    return (
      (vulnClass && control.vulnClasses.includes(vulnClass)) ||
      control.owaspCategories.some((c) => String(owaspCat).includes(c.split(" ")[0]) || String(owaspApiCat).includes(c.split(" ")[0]))
    );
  });

  const testedBy = control.tools.filter((t) => toolsRun.includes(t));
  const isTested = testedBy.length > 0;

  const failFindings = controlFindings.filter((f) =>
    ["critical", "high", "medium"].includes(f.severity ?? "")
  );

  let status: ControlStatus;
  if (!isTested) {
    status = "not_tested";
  } else if (failFindings.length > 0) {
    status = "fail";
  } else if (controlFindings.length > 0) {
    status = "partial"; // findings exist but are info/low only
  } else {
    status = "pass";
  }

  return {
    ...control,
    status,
    findingCount: failFindings.length,
    findingTitles: failFindings.slice(0, 5).map((f) => f.title),
    testedBy,
  };
}

function buildFrameworkResult(
  name: string,
  version: string,
  controls: Control[],
  findings: RawFinding[],
): FrameworkResult {
  const results = controls.map((c) => resolveControlStatus(c, findings));
  const passCount = results.filter((r) => r.status === "pass").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  const partialCount = results.filter((r) => r.status === "partial").length;
  const notTestedCount = results.filter((r) => r.status === "not_tested").length;
  const testedCount = controls.length - notTestedCount;
  const coveragePercent = testedCount > 0 ? Math.round((testedCount / controls.length) * 100) : 0;

  const overallStatus: ControlStatus =
    failCount > 0 ? "fail" :
    notTestedCount === controls.length ? "not_tested" :
    partialCount > 0 ? "partial" : "pass";

  return { name, version, controls: results, passCount, failCount, partialCount, notTestedCount, overallStatus, coveragePercent };
}

export type ComplianceReport = {
  generatedAt: string;
  scanId: string;
  targetUrl: string;
  scanPhases: string[];
  summary: {
    totalFindings: number;
    bySeverity: Record<string, number>;
    byVulnClass: Record<string, number>;
    toolsCoverage: string[];
  };
  frameworks: {
    owaspTop10: FrameworkResult;
    owaspApiTop10: FrameworkResult;
    pciDss: FrameworkResult;
    soc2: FrameworkResult;
  };
  topFindings: RawFinding[];
  methodology: string;
};

export function buildComplianceReport(
  scanId: string,
  targetUrl: string,
  findings: RawFinding[],
  scanConfig?: { phases?: string[]; authProfileCount?: number; apiSpecTitle?: string },
): ComplianceReport {
  const bySeverity: Record<string, number> = {};
  const byVulnClass: Record<string, number> = {};
  const toolsRun = new Set<string>();

  for (const f of findings) {
    bySeverity[f.severity ?? "info"] = (bySeverity[f.severity ?? "info"] ?? 0) + 1;
    if (f.evidence?.vulnerabilityClass) {
      const vc = String(f.evidence.vulnerabilityClass);
      byVulnClass[vc] = (byVulnClass[vc] ?? 0) + 1;
    }
    if (f.tool) toolsRun.add(f.tool);
  }

  const topFindings = findings
    .filter((f) => ["critical", "high", "medium"].includes(f.severity ?? ""))
    .sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2 };
      return (order[a.severity as keyof typeof order] ?? 3) - (order[b.severity as keyof typeof order] ?? 3);
    })
    .slice(0, 20);

  const authNote = scanConfig?.authProfileCount
    ? `${scanConfig.authProfileCount} authenticated role(s) tested`
    : "unauthenticated scan only";
  const specNote = scanConfig?.apiSpecTitle ? ` against OpenAPI spec '${scanConfig.apiSpecTitle}'` : "";

  return {
    generatedAt: new Date().toISOString(),
    scanId,
    targetUrl,
    scanPhases: scanConfig?.phases ?? [],
    summary: {
      totalFindings: findings.length,
      bySeverity,
      byVulnClass,
      toolsCoverage: [...toolsRun],
    },
    frameworks: {
      owaspTop10: buildFrameworkResult("OWASP Top 10", "2021", OWASP_WEB_CONTROLS, findings),
      owaspApiTop10: buildFrameworkResult("OWASP API Security Top 10", "2023", OWASP_API_CONTROLS, findings),
      pciDss: buildFrameworkResult("PCI-DSS", "v4.0", PCI_CONTROLS, findings),
      soc2: buildFrameworkResult("SOC 2", "Type II (CC6)", SOC2_CONTROLS, findings),
    },
    topFindings,
    methodology: [
      `Automated security scan of ${targetUrl} using TestMind AI Security Scanner.`,
      `Scan phases executed: ${(scanConfig?.phases ?? []).join(", ") || "recon, dynamic, intelligent_validation"}.`,
      `Authentication coverage: ${authNote}${specNote}.`,
      `Checks performed: port reconnaissance, static analysis, dependency scanning, dynamic probing, ` +
      `GraphQL schema audit, JWT token analysis, IDOR object enumeration, race condition testing, ` +
      `and auth profile cross-account BOLA detection.`,
      `Findings are mapped to OWASP Top 10 2021, OWASP API Security Top 10 2023, PCI-DSS v4.0, ` +
      `and SOC 2 Type II (CC6) frameworks.`,
    ].join(" "),
  };
}

// ── HTML report renderer ──────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#b91c1c",
  high:     "#c2410c",
  medium:   "#b45309",
  low:      "#15803d",
  info:     "#1d4ed8",
};

const STATUS_COLOR: Record<string, string> = {
  pass:       "#15803d",
  fail:       "#b91c1c",
  partial:    "#b45309",
  not_tested: "#6b7280",
};

const STATUS_LABEL: Record<string, string> = {
  pass:       "Pass",
  fail:       "Fail",
  partial:    "Partial",
  not_tested: "Not tested",
};

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function severityBadge(sev: string): string {
  const color = SEVERITY_COLOR[sev] ?? "#6b7280";
  return `<span style="background:${color};color:#fff;border-radius:3px;padding:1px 6px;font-size:11px;font-weight:600;text-transform:uppercase">${esc(sev)}</span>`;
}

function statusBadge(status: string): string {
  const color = STATUS_COLOR[status] ?? "#6b7280";
  const label = STATUS_LABEL[status] ?? status;
  return `<span style="background:${color};color:#fff;border-radius:3px;padding:1px 8px;font-size:11px;font-weight:600">${esc(label)}</span>`;
}

function frameworkTable(fw: FrameworkResult): string {
  const rows = fw.controls.map((c) => `
    <tr>
      <td style="padding:8px 12px;font-family:monospace;font-size:12px;white-space:nowrap">${esc(c.id)}</td>
      <td style="padding:8px 12px;font-size:13px">${esc(c.name)}</td>
      <td style="padding:8px 12px;text-align:center">${statusBadge(c.status)}</td>
      <td style="padding:8px 12px;font-size:12px;color:#374151">
        ${c.findingTitles.length ? c.findingTitles.map((t) => `<div>· ${esc(t)}</div>`).join("") : "<span style='color:#9ca3af'>None</span>"}
      </td>
    </tr>`).join("");

  const statusColor = STATUS_COLOR[fw.overallStatus] ?? "#6b7280";
  return `
  <div style="margin-bottom:28px">
    <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:8px">
      <h3 style="margin:0;font-size:16px;font-weight:700;color:#111827">${esc(fw.name)} <span style="font-weight:400;color:#6b7280;font-size:13px">${esc(fw.version)}</span></h3>
      <span style="color:${statusColor};font-weight:600;font-size:13px">${STATUS_LABEL[fw.overallStatus] ?? fw.overallStatus}</span>
      <span style="color:#6b7280;font-size:12px">${fw.coveragePercent}% coverage · ${fw.passCount} pass · ${fw.failCount} fail · ${fw.partialCount} partial · ${fw.notTestedCount} not tested</span>
    </div>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
      <thead>
        <tr style="background:#f9fafb">
          <th style="padding:8px 12px;text-align:left;font-size:12px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb">Control</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb">Name</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb">Status</th>
          <th style="padding:8px 12px;text-align:left;font-size:12px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb">Findings</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

export function buildHtmlReport(report: ComplianceReport): string {
  const date = new Date(report.generatedAt).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  const severityCounts = report.summary.bySeverity;
  const summaryBadges = ["critical", "high", "medium", "low", "info"]
    .filter((s) => (severityCounts[s] ?? 0) > 0)
    .map((s) => `<span style="margin-right:8px">${severityBadge(s)} <strong>${severityCounts[s]}</strong></span>`)
    .join("");

  const overallStatuses = [
    report.frameworks.owaspTop10.overallStatus,
    report.frameworks.owaspApiTop10.overallStatus,
    report.frameworks.pciDss.overallStatus,
    report.frameworks.soc2.overallStatus,
  ];
  const hasFail = overallStatuses.includes("fail");
  const overallColor = hasFail ? "#b91c1c" : "#15803d";
  const overallLabel = hasFail ? "Issues Found" : "No Critical Issues";

  const findingRows = report.topFindings.slice(0, 30).map((f) => `
    <tr>
      <td style="padding:8px 12px">${severityBadge(f.severity ?? "info")}</td>
      <td style="padding:8px 12px;font-size:13px;font-weight:500;color:#111827">${esc(f.title)}</td>
      <td style="padding:8px 12px;font-size:12px;color:#374151;font-family:monospace">${esc(f.location ?? "")}</td>
      <td style="padding:8px 12px;font-size:12px;color:#6b7280">${esc(f.tool ?? "")}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Security Compliance Report — ${esc(report.targetUrl)}</title>
  <style>
    @page { margin: 20mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; background: #fff; margin: 0; padding: 0; }
    .page { max-width: 960px; margin: 0 auto; padding: 40px 32px; }
    .cover { border-bottom: 3px solid #111827; padding-bottom: 32px; margin-bottom: 32px; }
    .cover-title { font-size: 28px; font-weight: 800; margin: 0 0 4px; }
    .cover-sub  { font-size: 15px; color: #6b7280; margin: 0; }
    .cover-meta { margin-top: 16px; font-size: 13px; color: #374151; }
    .cover-meta span { margin-right: 20px; }
    .overall { display: inline-flex; align-items: center; gap: 8px; background: #f3f4f6; border-radius: 8px; padding: 8px 16px; margin-top: 12px; }
    h2 { font-size: 18px; font-weight: 700; color: #111827; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; margin-top: 36px; }
    .summary-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; margin-bottom: 24px; }
    .fw-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; }
    .fw-card-name { font-size: 12px; color: #6b7280; font-weight: 500; }
    .fw-card-status { font-size: 15px; font-weight: 700; margin-top: 4px; }
    .fw-card-counts { font-size: 11px; color: #9ca3af; margin-top: 2px; }
    .section { page-break-before: always; }
    table tr:nth-child(even) { background: #f9fafb; }
    .methodology { background: #f9fafb; border-left: 4px solid #1d4ed8; padding: 12px 16px; border-radius: 0 6px 6px 0; font-size: 13px; color: #374151; line-height: 1.6; }
    .footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 11px; color: #9ca3af; display: flex; justify-content: space-between; }
    @media print {
      .section { page-break-before: always; }
      a { text-decoration: none; color: inherit; }
    }
  </style>
</head>
<body>
<div class="page">

  <!-- Cover -->
  <div class="cover">
    <p class="cover-title">Security Compliance Report</p>
    <p class="cover-sub">Automated security validation — TestMind AI Security Scanner</p>
    <div class="cover-meta">
      <span><strong>Target:</strong> ${esc(report.targetUrl)}</span>
      <span><strong>Generated:</strong> ${date}</span>
      <span><strong>Scan ID:</strong> <code>${esc(report.scanId)}</code></span>
    </div>
    <div class="overall">
      <span style="font-size:13px;font-weight:600;color:${overallColor}">${esc(overallLabel)}</span>
      <span style="font-size:12px;color:#6b7280">${report.summary.totalFindings} total findings</span>
    </div>
  </div>

  <!-- Executive summary -->
  <h2>Executive Summary</h2>
  <div style="margin-bottom:16px">${summaryBadges || "<span style='color:#15803d;font-weight:600'>No significant findings</span>"}</div>
  <div class="summary-grid">
    ${[
      { fw: report.frameworks.owaspTop10, label: "OWASP Top 10" },
      { fw: report.frameworks.owaspApiTop10, label: "OWASP API Top 10" },
      { fw: report.frameworks.pciDss, label: "PCI-DSS v4.0" },
      { fw: report.frameworks.soc2, label: "SOC 2 Type II" },
    ].map(({ fw, label }) => `
      <div class="fw-card">
        <div class="fw-card-name">${esc(label)}</div>
        <div class="fw-card-status" style="color:${STATUS_COLOR[fw.overallStatus] ?? "#6b7280"}">${STATUS_LABEL[fw.overallStatus] ?? fw.overallStatus}</div>
        <div class="fw-card-counts">${fw.coveragePercent}% tested · ${fw.failCount} fail · ${fw.passCount} pass</div>
      </div>`).join("")}
  </div>

  <!-- Methodology -->
  <h2>Methodology</h2>
  <div class="methodology">${esc(report.methodology)}</div>
  <div style="margin-top:10px;font-size:12px;color:#6b7280">
    Tools: ${report.summary.toolsCoverage.join(", ") || "standard scan modules"}
  </div>

  <!-- Compliance frameworks -->
  <div class="section">
    <h2>Compliance Framework Detail</h2>
    ${frameworkTable(report.frameworks.owaspTop10)}
    ${frameworkTable(report.frameworks.owaspApiTop10)}
    ${frameworkTable(report.frameworks.pciDss)}
    ${frameworkTable(report.frameworks.soc2)}
  </div>

  <!-- Top findings -->
  <div class="section">
    <h2>Top Findings (${Math.min(report.topFindings.length, 30)} of ${report.topFindings.length})</h2>
    ${report.topFindings.length === 0
      ? "<p style='color:#15803d;font-weight:600'>No critical, high, or medium findings.</p>"
      : `<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden">
          <thead>
            <tr style="background:#f9fafb">
              <th style="padding:8px 12px;text-align:left;font-size:12px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb;white-space:nowrap">Severity</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb">Title</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb">Location</th>
              <th style="padding:8px 12px;text-align:left;font-size:12px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb">Tool</th>
            </tr>
          </thead>
          <tbody>${findingRows}</tbody>
        </table>`}
  </div>

  <div class="footer">
    <span>TestMind AI Security Scanner</span>
    <span>Scan ID: ${esc(report.scanId)}</span>
    <span>${date}</span>
  </div>

</div>
</body>
</html>`;
}
