/**
 * Nuclei integration module.
 *
 * Nuclei (https://github.com/projectdiscovery/nuclei) is the industry-standard
 * open-source vulnerability scanner with 10,000+ community templates covering CVEs,
 * misconfigurations, exposed admin panels, subdomain takeovers, default credentials,
 * exposed secrets, and more. Integrating it here gives TestMind that entire library
 * without reimplementing it.
 *
 * This module:
 *   1. Checks if the `nuclei` binary is in PATH (skip gracefully if not installed)
 *   2. Runs Nuclei against the target URL with authenticated headers if available
 *   3. Parses Nuclei's JSON output line-by-line into TestMind findings
 *   4. Maps Nuclei severity/tags to TestMind's vulnerability classes and OWASP categories
 *
 * Installation: https://github.com/projectdiscovery/nuclei#installation
 *   go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest
 *   OR: download the binary from https://github.com/projectdiscovery/nuclei/releases
 */

import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import type { SecurityAuthProfile } from "../types.js";

const execFileAsync = promisify(execFile);

export type NucleiResult = {
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

// ── Binary detection ──────────────────────────────────────────────────────────

async function findNucleiBinary(): Promise<string | null> {
  // Common install locations beyond PATH
  const candidates = [
    "nuclei",
    "nuclei.exe",
    process.env.HOME ? `${process.env.HOME}/go/bin/nuclei` : null,
    process.env.HOME ? `${process.env.HOME}/go/bin/nuclei.exe` : null,
    "/usr/local/bin/nuclei",
    "C:/Users/gabby/go/bin/nuclei.exe",
    "C:/Users/gabby/go/bin/nuclei",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      // Try running `nuclei -version` to confirm it works
      await execFileAsync(candidate, ["-version"], { timeout: 5000 });
      return candidate;
    } catch {
      // not found or not executable — try next
    }
  }
  return null;
}

// ── Severity mapping ──────────────────────────────────────────────────────────

function mapSeverity(nucleiSeverity: string): NucleiResult["severity"] {
  switch (nucleiSeverity?.toLowerCase()) {
    case "critical": return "critical";
    case "high":     return "high";
    case "medium":   return "medium";
    case "low":      return "low";
    default:         return "info";
  }
}

// Map Nuclei template tags to OWASP/VulnClass
function mapTags(tags: string[]): { owaspCategory: string; vulnClass: string } {
  const t = tags.join(" ").toLowerCase();
  if (t.includes("sqli") || t.includes("injection") || t.includes("xss") || t.includes("ssti")) {
    return { owaspCategory: "A03:2021 Injection", vulnClass: "injection" };
  }
  if (t.includes("auth") || t.includes("default-login") || t.includes("weak-password") || t.includes("jwt")) {
    return { owaspCategory: "A07:2021 Identification and Authentication Failures", vulnClass: "broken_authentication" };
  }
  if (t.includes("idor") || t.includes("bola") || t.includes("access-control")) {
    return { owaspCategory: "A01:2021 Broken Access Control", vulnClass: "broken_object_level_authorization" };
  }
  if (t.includes("misconfig") || t.includes("exposure") || t.includes("info-disclosure") || t.includes("panel")) {
    return { owaspCategory: "A05:2021 Security Misconfiguration", vulnClass: "security_misconfiguration" };
  }
  if (t.includes("cve")) {
    return { owaspCategory: "A06:2021 Vulnerable and Outdated Components", vulnClass: "vulnerable_components" };
  }
  if (t.includes("ssrf")) {
    return { owaspCategory: "A10:2021 Server-Side Request Forgery", vulnClass: "ssrf" };
  }
  return { owaspCategory: "A05:2021 Security Misconfiguration", vulnClass: "security_misconfiguration" };
}

// ── Auth header construction ──────────────────────────────────────────────────

function buildAuthHeaderArgs(profile?: SecurityAuthProfile): string[] {
  if (!profile || profile.type === "none") return [];
  if (profile.type === "bearer" && profile.token) {
    return ["-H", `Authorization: Bearer ${profile.token}`];
  }
  if (profile.type === "cookie" && profile.cookieValue) {
    const val = profile.cookieName === "__raw__"
      ? profile.cookieValue
      : `${profile.cookieName || "session"}=${profile.cookieValue}`;
    return ["-H", `Cookie: ${val}`];
  }
  if (profile.type === "basic" && profile.username && profile.password) {
    const encoded = Buffer.from(`${profile.username}:${profile.password}`).toString("base64");
    return ["-H", `Authorization: Basic ${encoded}`];
  }
  return [];
}

// ── Output parser ─────────────────────────────────────────────────────────────

function parseNucleiOutput(stdout: string, targetUrl: string): NucleiResult[] {
  const findings: NucleiResult[] = [];
  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));

  for (const line of lines) {
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }

    const templateId: string = parsed["template-id"] ?? parsed.templateID ?? "unknown";
    const name: string = parsed.info?.name ?? templateId;
    const severity = mapSeverity(parsed.info?.severity);
    const tags: string[] = parsed.info?.tags ?? [];
    const matched: string = parsed["matched-at"] ?? parsed.url ?? targetUrl;
    const description: string = parsed.info?.description ?? parsed.description ?? "";
    const remediation: string = parsed.info?.remediation ?? "";
    const { owaspCategory, vulnClass } = mapTags(tags);

    findings.push({
      type: "dynamic",
      severity,
      title: `[Nuclei] ${name}`,
      description: description || `Nuclei template '${templateId}' matched at ${matched}.`,
      location: matched,
      tool: "nuclei",
      evidence: {
        vulnerabilityClass: vulnClass,
        owaspCategory,
        templateId,
        tags,
        matchedAt: matched,
        extractedResults: parsed["extracted-results"] ?? [],
        curl: parsed["curl-command"] ?? "",
        responsePreview: typeof parsed.response === "string" ? parsed.response.slice(0, 300) : "",
      },
      suggestion: remediation || "Refer to the Nuclei template documentation and the OWASP remediation guidance for this vulnerability class.",
      status: "open",
    });
  }

  return findings;
}

// ── Template selection ────────────────────────────────────────────────────────

// Tag-based selection — covers the highest-value categories without running every template
// (a full run takes 30+ min). This subset is fast (<3 min) and hits the most common issues.
const DEFAULT_TAGS = [
  "misconfig",
  "exposure",
  "default-login",
  "info-disclosure",
  "takeover",
  "cve",
  "xss",
  "sqli",
  "ssrf",
  "idor",
].join(",");

// ── Main entrypoint ──────────────────────────────────────────────────────────

export async function runNucleiScan(
  targetUrl: string,
  authProfiles: SecurityAuthProfile[],
  scanDepth: "baseline" | "standard" | "deep" = "standard",
): Promise<NucleiResult[]> {
  const binary = await findNucleiBinary();

  if (!binary) {
    return [
      {
        type: "dynamic",
        severity: "info",
        title: "Nuclei not installed — template scan skipped",
        description:
          "Nuclei (https://github.com/projectdiscovery/nuclei) was not found in PATH or common " +
          "install locations. Installing it enables 10,000+ community vulnerability templates " +
          "covering CVEs, misconfigurations, exposed panels, and takeovers. " +
          "Run: go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest",
        location: targetUrl,
        tool: "nuclei",
        evidence: { installed: false, installUrl: "https://github.com/projectdiscovery/nuclei#installation" },
        suggestion: "Install Nuclei and re-run the scan to enable template-based vulnerability detection.",
        status: "open",
      },
    ];
  }

  const primaryProfile = authProfiles[0];
  const authArgs = buildAuthHeaderArgs(primaryProfile);

  // Depth-based template selection
  const tags =
    scanDepth === "baseline" ? "misconfig,exposure,default-login" :
    scanDepth === "deep"     ? undefined : // all templates
    DEFAULT_TAGS;

  const args = [
    "-u", targetUrl,
    "-json",               // machine-readable output
    "-silent",             // suppress progress output
    "-no-color",
    "-timeout", "10",      // per-request timeout seconds
    "-rate-limit", "30",   // requests per second — stay polite
    "-concurrency", "10",
    ...(tags ? ["-tags", tags] : []),
    ...authArgs,
  ];

  const opts: ExecFileOptions = {
    timeout: scanDepth === "deep" ? 20 * 60 * 1000 : 8 * 60 * 1000, // 8 or 20 min
    maxBuffer: 50 * 1024 * 1024, // 50 MB output buffer
  };

  try {
    const { stdout } = await execFileAsync(binary, args, opts);
    return parseNucleiOutput(String(stdout), targetUrl);
  } catch (err: any) {
    // Nuclei exits with code 1 even when it finds results — check stdout
    if (err.stdout) return parseNucleiOutput(String(err.stdout), targetUrl);
    console.warn("[nuclei-scan] Nuclei execution error:", err?.message?.slice(0, 200));
    return [
      {
        type: "dynamic",
        severity: "info",
        title: "Nuclei scan failed",
        description: `Nuclei returned an error: ${String(err?.message ?? "unknown").slice(0, 300)}`,
        location: targetUrl,
        tool: "nuclei",
        evidence: { error: String(err?.message ?? "").slice(0, 500) },
        status: "open",
      },
    ];
  }
}
