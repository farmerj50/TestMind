type FindingShape = {
  type: "recon" | "static_analysis" | "dependency" | "dynamic";
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description?: string;
  location?: string;
  tool?: string;
};

const PLAINTEXT_SERVICE_PORTS: Record<number, { service: string; severity: FindingShape["severity"] }> = {
  21: { service: "FTP", severity: "medium" },
  23: { service: "Telnet", severity: "high" },
  25: { service: "SMTP", severity: "low" },
  110: { service: "POP3", severity: "medium" },
  143: { service: "IMAP", severity: "medium" },
};

export function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join("; ");
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function extractVersionDisclosureFindings(input: {
  headers: Record<string, string | string[] | undefined>;
  location: string;
  tool: string;
}): FindingShape[] {
  const findings: FindingShape[] = [];
  const candidates = [
    { header: "server", title: "Server banner disclosed" },
    { header: "x-powered-by", title: "Technology stack disclosed" },
    { header: "x-aspnet-version", title: "ASP.NET version disclosed" },
    { header: "x-runtime", title: "Framework runtime disclosed" },
    { header: "via", title: "Proxy chain disclosed" },
  ] as const;

  for (const candidate of candidates) {
    const raw = normalizeHeaderValue(input.headers[candidate.header]);
    if (!raw) continue;
    findings.push({
      type: "dynamic",
      severity: /\d/.test(raw) ? "low" : "info",
      title: candidate.title,
      description: `${candidate.header}: ${raw.slice(0, 160)}`,
      location: input.location,
      tool: input.tool,
    });
  }
  return findings;
}

export function detectDirectoryListing(input: {
  body: string;
  location: string;
  tool: string;
}): FindingShape[] {
  const body = input.body || "";
  if (!/(<title>\s*index of\b|<h1>\s*index of\b|directory listing for\b)/i.test(body)) {
    return [];
  }
  return [
    {
      type: "dynamic",
      severity: "medium",
      title: "Directory listing exposed",
      description: "The response appears to expose a browsable directory index.",
      location: input.location,
      tool: input.tool,
    },
  ];
}

export function parseAllowedMethods(raw?: string | null): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean)
    )
  );
}

export function extractHttpMethodFindings(input: {
  allowHeader?: string | null;
  location: string;
  tool: string;
}): FindingShape[] {
  const methods = parseAllowedMethods(input.allowHeader);
  if (!methods.length) return [];
  const findings: FindingShape[] = [];

  if (methods.includes("TRACE") || methods.includes("TRACK")) {
    findings.push({
      type: "dynamic",
      severity: "medium",
      title: "TRACE/TRACK method enabled",
      description: `Allow header advertises: ${methods.join(", ")}`,
      location: input.location,
      tool: input.tool,
    });
  }

  const risky = methods.filter((method) =>
    ["PUT", "DELETE", "PATCH", "CONNECT", "PROPFIND"].includes(method)
  );
  if (risky.length) {
    findings.push({
      type: "dynamic",
      severity: "low",
      title: "Potentially risky HTTP methods exposed",
      description: `Allow header advertises: ${risky.join(", ")}`,
      location: input.location,
      tool: input.tool,
    });
  }

  return findings;
}

export function fingerprintServiceFromBanner(
  banner: string | null | undefined,
  port?: number
): { service: string; details: string } | null {
  const raw = (banner || "").trim();
  if (!raw) {
    const fallback = port ? PLAINTEXT_SERVICE_PORTS[port]?.service : undefined;
    return fallback ? { service: fallback, details: `port ${port}` } : null;
  }

  if (/^SSH-\d+\.\d+/i.test(raw)) return { service: "SSH", details: raw.slice(0, 160) };
  if (/^220[ -].*ftp/i.test(raw)) return { service: "FTP", details: raw.slice(0, 160) };
  if (/^220[ -].*(smtp|esmtp)/i.test(raw)) return { service: "SMTP", details: raw.slice(0, 160) };
  if (/^\+OK/i.test(raw)) return { service: "POP3", details: raw.slice(0, 160) };
  if (/^\* OK/i.test(raw)) return { service: "IMAP", details: raw.slice(0, 160) };
  if (/^HTTP\/\d+\.\d+/i.test(raw)) return { service: "HTTP", details: raw.slice(0, 160) };

  const fallback = port ? PLAINTEXT_SERVICE_PORTS[port]?.service : undefined;
  return fallback ? { service: fallback, details: raw.slice(0, 160) } : null;
}

export function extractServiceExposureFindings(input: {
  host: string;
  port: number;
  banner?: string | null;
  tool: string;
}): FindingShape[] {
  const findings: FindingShape[] = [];
  const fingerprint = fingerprintServiceFromBanner(input.banner, input.port);
  const location = `${input.host}:${input.port}`;

  if (fingerprint) {
    findings.push({
      type: "recon",
      severity: "info",
      title: `Service identified: ${fingerprint.service}`,
      description: fingerprint.details,
      location,
      tool: input.tool,
    });
  }

  const plaintext = PLAINTEXT_SERVICE_PORTS[input.port];
  if (plaintext) {
    findings.push({
      type: "dynamic",
      severity: plaintext.severity,
      title: `${plaintext.service} service exposed on plaintext port`,
      description: `Open ${plaintext.service} service detected on ${location}. Prefer encrypted equivalents or restrict exposure.`,
      location,
      tool: input.tool,
    });
  }

  return findings;
}
