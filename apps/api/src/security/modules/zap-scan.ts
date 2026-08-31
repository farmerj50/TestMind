import { execFile, type ExecFileOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isWithinScope, type ProbeScope } from "../http-client.js";
import type { SecurityAgentFinding, SecurityAuthProfile, SecuritySeverity } from "../types.js";

const execFileAsync = promisify(execFile);

export type ZapScanMode = "baseline" | "full";

type ZapRunner = {
  kind: "local" | "docker";
  command: string;
  args: string[];
  reportPath: string;
};

function modeLabel(mode: ZapScanMode) {
  return mode === "full" ? "full active" : "baseline";
}

function zapScriptForMode(mode: ZapScanMode) {
  return mode === "full" ? "zap-full-scan.py" : "zap-baseline.py";
}

async function canRun(command: string, args: string[], opts: ExecFileOptions = {}) {
  try {
    await execFileAsync(command, args, { timeout: 5_000, ...opts });
    return true;
  } catch {
    return false;
  }
}

async function findLocalZapScript(mode: ZapScanMode): Promise<string | null> {
  const envBin = mode === "full" ? process.env.ZAP_FULL_BIN : process.env.ZAP_BASELINE_BIN;
  const candidates = [
    envBin,
    zapScriptForMode(mode),
    process.platform === "win32" ? `${zapScriptForMode(mode)}.bat` : null,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (await canRun(candidate, ["-h"])) return candidate;
  }
  return null;
}

async function findDockerBinary(): Promise<string | null> {
  const docker = process.env.DOCKER_BIN || "docker";
  return (await canRun(docker, ["--version"])) ? docker : null;
}

async function resolveZapRunner(mode: ZapScanMode, targetUrl: string, tmpDir: string): Promise<ZapRunner | null> {
  const script = zapScriptForMode(mode);
  const spiderMinutes = mode === "full" ? "2" : "1";
  const localScript = await findLocalZapScript(mode);
  if (localScript) {
    const reportPath = path.join(tmpDir, "zap-report.json");
    return {
      kind: "local",
      command: localScript,
      args: ["-t", targetUrl, "-J", reportPath, "-m", spiderMinutes, "-I"],
      reportPath,
    };
  }

  const docker = await findDockerBinary();
  if (!docker) return null;

  return {
    kind: "docker",
    command: docker,
    args: [
      "run",
      "--rm",
      "-v",
      `${tmpDir}:/zap/wrk:rw`,
      "ghcr.io/zaproxy/zaproxy:stable",
      script,
      "-t",
      targetUrl,
      "-J",
      "zap-report.json",
      "-m",
      spiderMinutes,
      "-I",
    ],
    reportPath: path.join(tmpDir, "zap-report.json"),
  };
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function stripHtml(value: unknown) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function mapZapSeverity(alert: any): SecuritySeverity {
  const riskCode = Number(alert?.riskcode ?? alert?.riskCode);
  if (riskCode >= 3) return "high";
  if (riskCode === 2) return "medium";
  if (riskCode === 1) return "low";

  const risk = String(alert?.riskdesc ?? alert?.risk ?? "").toLowerCase();
  if (risk.includes("high")) return "high";
  if (risk.includes("medium")) return "medium";
  if (risk.includes("low")) return "low";
  return "info";
}

function mapZapCategory(alert: any): { vulnerabilityClass: string; owaspCategory: string; owaspApiCategory: string } {
  const text = [
    alert?.alert,
    alert?.name,
    alert?.riskdesc,
    alert?.desc,
    alert?.solution,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/\b(sql|xss|injection|template injection|command injection|ldap injection)\b/.test(text)) {
    return {
      vulnerabilityClass: "injection",
      owaspCategory: "A03:2021 Injection",
      owaspApiCategory: "API8:2023 Security Misconfiguration",
    };
  }
  if (/\b(auth|credential|password|session|cookie|csrf|jwt)\b/.test(text)) {
    return {
      vulnerabilityClass: "broken_authentication",
      owaspCategory: "A07:2021 Identification and Authentication Failures",
      owaspApiCategory: "API2:2023 Broken Authentication",
    };
  }
  if (/\b(access control|authorization|idor|bola|permission|privilege)\b/.test(text)) {
    return {
      vulnerabilityClass: "broken_object_level_authorization",
      owaspCategory: "A01:2021 Broken Access Control",
      owaspApiCategory: "API1:2023 Broken Object Level Authorization",
    };
  }
  if (/\b(cve|outdated|vulnerable|dependency|component|library)\b/.test(text)) {
    return {
      vulnerabilityClass: "vulnerable_components",
      owaspCategory: "A06:2021 Vulnerable and Outdated Components",
      owaspApiCategory: "API8:2023 Security Misconfiguration",
    };
  }
  if (/\b(ssrf|server-side request forgery)\b/.test(text)) {
    return {
      vulnerabilityClass: "ssrf",
      owaspCategory: "A10:2021 Server-Side Request Forgery",
      owaspApiCategory: "API7:2023 Server Side Request Forgery",
    };
  }
  return {
    vulnerabilityClass: "security_misconfiguration",
    owaspCategory: "A05:2021 Security Misconfiguration",
    owaspApiCategory: "API8:2023 Security Misconfiguration",
  };
}

function sortFindings(findings: SecurityAgentFinding[]) {
  const weight: Record<SecuritySeverity, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };
  return findings.sort((a, b) => weight[b.severity] - weight[a.severity]);
}

export function parseZapJsonReport(
  rawReport: unknown,
  targetUrl: string,
  mode: ZapScanMode
): SecurityAgentFinding[] {
  const report = rawReport as any;
  const findings: SecurityAgentFinding[] = [];
  for (const site of asArray(report?.site)) {
    for (const alert of asArray(site?.alerts)) {
      const title = String(alert?.alert ?? alert?.name ?? "ZAP alert").trim();
      const instances = asArray(alert?.instances).map((instance: any) => ({
        uri: instance?.uri,
        method: instance?.method,
        param: instance?.param,
        evidence: stripHtml(instance?.evidence).slice(0, 500),
        attack: stripHtml(instance?.attack).slice(0, 200),
      }));
      const firstInstance = instances.find((instance) => instance.uri) ?? instances[0];
      const category = mapZapCategory(alert);
      findings.push({
        type: "dynamic",
        severity: mapZapSeverity(alert),
        title: `[OWASP ZAP ${modeLabel(mode)}] ${title}`,
        description:
          stripHtml(alert?.desc).slice(0, 900) ||
          `OWASP ZAP ${modeLabel(mode)} reported ${title} for the target.`,
        location: String(firstInstance?.uri ?? site?.["@name"] ?? site?.name ?? targetUrl),
        tool: "owasp-zap",
        evidence: {
          ...category,
          scannerMode: mode,
          pluginId: alert?.pluginid ?? alert?.pluginId,
          alertRef: alert?.alertRef,
          risk: alert?.riskdesc ?? alert?.risk,
          confidence: alert?.confidence,
          cweId: alert?.cweid,
          wascId: alert?.wascid,
          instances: instances.slice(0, 5),
          totalInstances: instances.length,
        },
        suggestion:
          stripHtml(alert?.solution).slice(0, 700) ||
          "Review this OWASP ZAP alert and apply the matching OWASP remediation guidance.",
        status: "open",
      });
    }
  }
  return sortFindings(findings).slice(0, 75);
}

function zapUnavailableFinding(targetUrl: string, mode: ZapScanMode): SecurityAgentFinding {
  return {
    type: "dynamic",
    severity: "info",
    title: `OWASP ZAP ${modeLabel(mode)} scan skipped`,
    description:
      "TestMind selected OWASP ZAP for this scan, but neither the ZAP packaged scan script nor Docker was available to run it. Install Docker or set ZAP_BASELINE_BIN/ZAP_FULL_BIN.",
    location: targetUrl,
    tool: "owasp-zap",
    evidence: {
      vulnerabilityClass: "scan_coverage",
      owaspCategory: "A05:2021 Security Misconfiguration",
      owaspApiCategory: "API9:2023 Improper Inventory Management",
      scannerMode: mode,
      installed: false,
    },
    suggestion: "Install Docker or the OWASP ZAP packaged scan scripts, then re-run the scan.",
    status: "needs_setup",
  };
}

export async function runZapScan(
  targetUrl: string,
  authProfiles: SecurityAuthProfile[],
  scanDepth: "baseline" | "standard" | "deep" = "standard",
  scope: ProbeScope = { allowedHosts: [], allowedPorts: [] },
  mode: ZapScanMode = "baseline",
): Promise<SecurityAgentFinding[]> {
  if (!isWithinScope(targetUrl, scope.allowedHosts ?? [], scope.allowedPorts ?? [])) {
    return [
      {
        type: "dynamic",
        severity: "info",
        title: `OWASP ZAP ${modeLabel(mode)} scan skipped outside scope`,
        description: "The target URL is outside the allowed security scan host/port scope.",
        location: targetUrl,
        tool: "owasp-zap",
        evidence: {
          vulnerabilityClass: "scan_coverage",
          owaspCategory: "A05:2021 Security Misconfiguration",
          owaspApiCategory: "API9:2023 Improper Inventory Management",
          scannerMode: mode,
          allowedHosts: scope.allowedHosts,
          allowedPorts: scope.allowedPorts,
        },
        status: "needs_setup",
      },
    ];
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "testmind-zap-"));
  try {
    const runner = await resolveZapRunner(mode, targetUrl, tmpDir);
    if (!runner) return [zapUnavailableFinding(targetUrl, mode)];

    let commandError: any = null;
    try {
      await execFileAsync(runner.command, runner.args, {
        timeout: mode === "full" || scanDepth === "deep" ? 20 * 60 * 1000 : 8 * 60 * 1000,
        maxBuffer: 40 * 1024 * 1024,
      });
    } catch (err: any) {
      commandError = err;
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(await fs.readFile(runner.reportPath, "utf8"));
    } catch {
      parsed = null;
    }

    if (parsed) {
      const findings = parseZapJsonReport(parsed, targetUrl, mode);
      if (findings.length > 0) return findings;
      if (!commandError) {
        return [
          {
            type: "dynamic",
            severity: "info",
            title: `OWASP ZAP ${modeLabel(mode)} completed with no alerts`,
            description: `OWASP ZAP ${modeLabel(mode)} produced a JSON report with no reportable alerts.`,
            location: targetUrl,
            tool: "owasp-zap",
            evidence: {
              vulnerabilityClass: "scan_coverage",
              owaspCategory: "A05:2021 Security Misconfiguration",
              owaspApiCategory: "API9:2023 Improper Inventory Management",
              scannerMode: mode,
              runner: runner.kind,
              authenticatedProfilesAvailable: authProfiles.length,
            },
            status: "closed",
          },
        ];
      }
    }

    return [
      {
        type: "dynamic",
        severity: "info",
        title: `OWASP ZAP ${modeLabel(mode)} scan did not complete`,
        description:
          commandError?.message ??
          "OWASP ZAP did not produce a readable JSON report. Check Docker networking and target reachability.",
        location: targetUrl,
        tool: "owasp-zap",
        evidence: {
          vulnerabilityClass: "scan_coverage",
          owaspCategory: "A05:2021 Security Misconfiguration",
          owaspApiCategory: "API9:2023 Improper Inventory Management",
          scannerMode: mode,
          runner: runner.kind,
          exitCode: commandError?.code,
          stderr: String(commandError?.stderr ?? "").slice(0, 1000),
        },
        suggestion: "Verify Docker can reach the target URL and re-run the scan.",
        status: "needs_setup",
      },
    ];
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

