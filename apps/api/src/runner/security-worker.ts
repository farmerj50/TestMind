import "dotenv/config";
import { Worker, Job } from "bullmq";
import { prisma } from "../prisma";
import { redis } from "./redis";
import type { SecurityScanPayload } from "./queue";
import { request } from "undici";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";

type FindingInput = {
  type: "recon" | "static_analysis" | "dependency" | "dynamic";
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description?: string;
  location?: string;
  tool?: string;
};

const DEFAULT_HEADERS = [
  { name: "content-security-policy", severity: "high" },
  { name: "strict-transport-security", severity: "high" },
  { name: "x-frame-options", severity: "medium" },
  { name: "x-content-type-options", severity: "medium" },
  { name: "referrer-policy", severity: "low" },
] as const;

async function updateJob(
  jobId: string,
  data: Partial<{
    status: any;
    phase: string | null;
    summary: any;
    error: string | null;
    finishedAt: Date | null;
  }>
) {
  await prisma.securityScanJob.update({
    where: { id: jobId },
    data,
  });
}

async function addFindings(jobId: string, findings: FindingInput[]) {
  for (const f of findings) {
    await prisma.securityFinding.create({
      data: {
        scanId: jobId,
        type: f.type as any,
        severity: f.severity as any,
        title: f.title,
        description: f.description,
        location: f.location,
        tool: f.tool,
        evidence: {},
      },
    });
  }
}

function withinScope(urlStr: string, allowedHosts: string[], allowedPorts: number[]) {
  try {
    const u = new URL(urlStr);
    const hostOk = allowedHosts.length === 0 || allowedHosts.includes(u.hostname);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    const portOk = allowedPorts.length === 0 || allowedPorts.includes(port);
    return hostOk && portOk;
  } catch {
    return false;
  }
}

async function runRecon(job: SecurityScanPayload): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  if (!withinScope(job.baseUrl, job.allowedHosts, job.allowedPorts)) {
    findings.push({
      type: "recon",
      severity: "info",
      title: "Base URL out of scope",
      description: `Skipped recon; ${job.baseUrl} not in allowed hosts/ports.`,
      location: job.baseUrl,
      tool: "scope-check",
    });
    return findings;
  }
  try {
    const res = await request(job.baseUrl, { method: "GET", maxRedirections: 3 });
    findings.push({
      type: "recon",
      severity: "info",
      title: `Reachable (${res.statusCode})`,
      description: `Fetched ${job.baseUrl}`,
      location: job.baseUrl,
      tool: "undici",
    });
    const headers = res.headers;
    for (const h of DEFAULT_HEADERS) {
      if (!headers[h.name]) {
        findings.push({
          type: "dynamic",
          severity: h.severity as any,
          title: `Missing security header: ${h.name}`,
          description: `Header ${h.name} not present on response`,
          location: job.baseUrl,
          tool: "header-check",
        });
      }
    }
    // Cookie flags
    const setCookie = headers["set-cookie"];
    if (Array.isArray(setCookie)) {
      const insecureCookies = setCookie.filter(
        (c) => !/httponly/i.test(c) || !/secure/i.test(c)
      );
      if (insecureCookies.length > 0) {
        findings.push({
          type: "dynamic",
          severity: "medium",
          title: "Cookies missing Secure/HttpOnly",
          description: insecureCookies.slice(0, 3).join("; "),
          location: job.baseUrl,
          tool: "cookie-check",
        });
      }
    }

    // Simple crawl (same host, shallow)
    try {
      const body = await res.body.text();
      const hrefs = Array.from(body.matchAll(/href\s*=\s*["']([^"']+)["']/gi))
        .map((m) => m[1])
        .filter((h) => h.startsWith("/"));
      const unique = Array.from(new Set(hrefs)).slice(0, 10);
      if (unique.length > 0) {
        findings.push({
          type: "recon",
          severity: "info",
          title: "Endpoints discovered",
          description: `Found ${unique.length} path(s): ${unique.join(", ")}`,
          location: job.baseUrl,
          tool: "playwright-spider",
        });
      }
    } catch {
      // ignore crawl errors
    }
  } catch (err: any) {
    findings.push({
      type: "recon",
      severity: "medium",
      title: "Failed to reach base URL",
      description: err?.message ?? String(err),
      location: job.baseUrl,
      tool: "undici",
    });
  }

  // Port probe within allowed hosts/ports
  for (const host of job.allowedHosts) {
    for (const port of job.allowedPorts) {
      const isAllowed = withinScope(`http://${host}:${port}`, job.allowedHosts, job.allowedPorts);
      if (!isAllowed) continue;
      const status = await new Promise<"open" | "closed" | "timeout">((resolve) => {
        const socket = new net.Socket();
        const timer = setTimeout(() => {
          socket.destroy();
          resolve("timeout");
        }, 800);
        socket.once("error", () => {
          clearTimeout(timer);
          resolve("closed");
        });
        socket.connect(port, host, () => {
          clearTimeout(timer);
          socket.destroy();
          resolve("open");
        });
      });
      findings.push({
        type: "recon",
        severity: status === "open" ? "info" : "low",
        title: `Port ${port} ${status}`,
        description: `Host ${host}:${port} reported ${status}`,
        location: `${host}:${port}`,
        tool: "port-probe",
      });
    }
  }

  return findings;
}

async function runStatic(job: SecurityScanPayload): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const repoRoot = path.resolve(process.cwd());
  const pkgJson = path.join(repoRoot, "package.json");
  const exists = fs.existsSync(pkgJson);

  // Try semgrep if available
  const semgrepBin = process.env.SEMGREP_BIN || "semgrep";
  if (exists) {
    try {
      const result = await new Promise<{ stdout: string }>((resolve, reject) => {
        execFile(
          semgrepBin,
          ["--config", "p/security-audit", "--json", "--quiet"],
          { cwd: repoRoot, maxBuffer: 5 * 1024 * 1024 },
          (err, stdout) => {
            // Semgrep exits with code 1 when findings are present; treat that as success
            if (err && (err as any).code !== 1) return reject(err);
            resolve({ stdout: stdout || "{}" });
          }
        );
      });
      let parsed: any = {};
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = {};
      }
      const semgrepFindings = Array.isArray(parsed?.results) ? parsed.results : [];
      if (semgrepFindings.length === 0) {
        findings.push({
          type: "static_analysis",
          severity: "info",
          title: "Semgrep found no issues",
          description: "Semgrep scan completed with no findings.",
          location: repoRoot,
          tool: "semgrep",
        });
      } else {
        for (const f of semgrepFindings.slice(0, 50)) {
          findings.push({
            type: "static_analysis",
            severity: "medium",
            title: f?.check_id || "Semgrep finding",
            description: f?.extra?.message,
            location: `${f?.path}:${f?.start?.line ?? ""}`,
            tool: "semgrep",
          });
        }
      }
      return findings;
    } catch (err: any) {
      findings.push({
        type: "static_analysis",
        severity: "info",
        title: "Semgrep not available",
        description: err?.code === "ENOENT" ? "Semgrep binary not found." : err?.message,
        location: repoRoot,
        tool: "semgrep",
      });
    }
  } else {
    findings.push({
      type: "static_analysis",
      severity: "info",
      title: "No package.json found",
      description: "Skipping SAST; cannot find repository files in worker context.",
      location: repoRoot,
      tool: "sast",
    });
  }

  return findings;
}

async function runDeps(job: SecurityScanPayload): Promise<FindingInput[]> {
  const findings: FindingInput[] = [];
  const repoRoot = path.resolve(process.cwd());
  const lockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
  const searchRoots = [repoRoot, path.resolve(repoRoot, ".."), path.resolve(repoRoot, "..", "..")];

  let lockfilePath: string | null = null;
  for (const root of searchRoots) {
    const found = lockfiles.find((f) => fs.existsSync(path.join(root, f)));
    if (found) {
      lockfilePath = path.join(root, found);
      break;
    }
  }

  if (!lockfilePath) {
    findings.push({
      type: "dependency",
      severity: "low",
      title: "No lockfile found",
      description: "Add a lockfile to enable dependency scanning.",
      location: repoRoot,
      tool: "sca",
    });
    return findings;
  }

  try {
    const lockName = path.basename(lockfilePath).toLowerCase();
    if (lockName === "pnpm-lock.yaml") {
      findings.push({
        type: "dependency",
        severity: "info",
        title: "pnpm lockfile detected",
        description: "pnpm lockfile found. Integrate pnpm audit or provide a package-lock.json for npm audit.",
        location: lockfilePath,
        tool: "sca",
      });
      return findings;
    }

    const npmBin = process.env.NPM_BIN || (process.platform === "win32" ? "npm.cmd" : "npm");

    const audit = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        npmBin,
        ["audit", "--json", "--production"],
        {
          cwd: path.dirname(lockfilePath),
          maxBuffer: 5 * 1024 * 1024,
          shell: process.platform === "win32",
        },
        (err, stdout) => {
          // npm audit exits non-zero when vulns found; ignore code
          if (err && (err as any).code !== 1) return reject(err);
          resolve({ stdout: stdout || "{}" });
        }
      );
    });
    const parsed = JSON.parse(audit.stdout);
    const advisories = parsed?.vulnerabilities || {};
    const entries = Object.entries(advisories);
    if (entries.length === 0) {
      findings.push({
        type: "dependency",
        severity: "info",
        title: "No dependency vulnerabilities found",
        description: "npm audit reported no issues.",
        location: lockfilePath,
        tool: "npm-audit",
      });
    } else {
      for (const [name, vuln] of entries.slice(0, 50)) {
        findings.push({
          type: "dependency",
          severity: (vuln as any)?.severity || "medium",
          title: `Vulnerability: ${name}`,
          description: `Affected: ${name}. ${ (vuln as any)?.via ? JSON.stringify((vuln as any)?.via).slice(0,200) : "" }`,
          location: lockfilePath,
          tool: "npm-audit",
        });
      }
    }
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      findings.push({
        type: "dependency",
        severity: "info",
        title: "npm not available",
        description: `Failed to run npm audit. Ensure npm is on PATH or set NPM_BIN.`,
        location: lockfilePath,
        tool: "npm-audit",
      });
      return findings;
    }
    findings.push({
      type: "dependency",
      severity: "info",
      title: "Audit failed",
      description: err?.message ?? String(err),
      location: lockfilePath,
      tool: "npm-audit",
    });
  }

  return findings;
}

async function runDynamic(job: SecurityScanPayload): Promise<FindingInput[]> {
  // For now reuse header checks as baseline dynamic output
  return [];
}

export const securityWorker = new Worker(
  "security-scan",
  async (job: Job<SecurityScanPayload>) => {
    const payload = job.data;
    await updateJob(payload.jobId, { status: "running", phase: "recon" });

    const allFindings: FindingInput[] = [];

    // Recon
    allFindings.push(...(await runRecon(payload)));
    await updateJob(payload.jobId, { phase: "static_analysis" });

    // SAST
    allFindings.push(...(await runStatic(payload)));
    await updateJob(payload.jobId, { phase: "dependency" });

    // SCA
    allFindings.push(...(await runDeps(payload)));
    await updateJob(payload.jobId, { phase: "dynamic" });

    // Dynamic (baseline)
    allFindings.push(...(await runDynamic(payload)));

    await addFindings(payload.jobId, allFindings);

    await updateJob(payload.jobId, {
      status: "completed",
      phase: null,
      finishedAt: new Date(),
      summary: {
        counts: allFindings.reduce<Record<string, number>>((acc, f) => {
          acc[f.severity] = (acc[f.severity] || 0) + 1;
          return acc;
        }, {}),
      },
    });
  },
  { connection: redis }
);

securityWorker.on("failed", async (job, err) => {
  if (job?.data?.jobId) {
    await updateJob(job.data.jobId, {
      status: "failed",
      error: err?.message ?? String(err),
      finishedAt: new Date(),
    });
  }
});

securityWorker.on("completed", async (job) => {
  if (job?.data?.jobId) {
    await updateJob(job.data.jobId, { phase: null, finishedAt: new Date() });
  }
});
