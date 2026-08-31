export const LEGACY_OPEN_SOURCE_TOOL_IDS = ["semgrep", "dependency-audit", "nuclei"] as const;

export const DEFAULT_OPEN_SOURCE_TOOL_IDS = [
  "semgrep",
  "dependency-audit",
  "nuclei",
  "zap-baseline",
] as const;

export const OPEN_SOURCE_SECURITY_TOOLS = [
  {
    id: "semgrep",
    name: "Semgrep",
    category: "code",
    risk: "low",
    requiresSource: true,
    description: "Static application security testing for first-party code.",
  },
  {
    id: "dependency-audit",
    name: "Dependency audit",
    category: "code",
    risk: "low",
    requiresSource: true,
    description: "Package manager SCA using npm or pnpm audit output.",
  },
  {
    id: "nuclei",
    name: "Nuclei",
    category: "dast",
    risk: "medium",
    requiresSource: false,
    description: "ProjectDiscovery template scan for CVEs, exposures, takeovers, and misconfigurations.",
  },
  {
    id: "zap-baseline",
    name: "OWASP ZAP baseline",
    category: "dast",
    risk: "low",
    requiresSource: false,
    description: "Passive OWASP ZAP spider and baseline alert scan.",
  },
  {
    id: "zap-full",
    name: "OWASP ZAP full active",
    category: "dast",
    risk: "high",
    requiresSource: false,
    requiresDeepApproval: true,
    description: "Full OWASP ZAP active scan. Runs only for approved deep active scans.",
  },
] as const;

export type OpenSourceSecurityToolId = (typeof OPEN_SOURCE_SECURITY_TOOLS)[number]["id"];

const OPEN_SOURCE_TOOL_ID_SET = new Set<string>(OPEN_SOURCE_SECURITY_TOOLS.map((tool) => tool.id));

function isKnownOpenSourceToolId(value: string): value is OpenSourceSecurityToolId {
  return OPEN_SOURCE_TOOL_ID_SET.has(value);
}

export function normalizeOpenSourceToolIds(
  ids: string[] | undefined | null,
  fallback: readonly OpenSourceSecurityToolId[] = LEGACY_OPEN_SOURCE_TOOL_IDS
): OpenSourceSecurityToolId[] {
  if (ids == null) return [...fallback];
  const selected: OpenSourceSecurityToolId[] = [];
  const seen = new Set<string>();
  for (const rawId of ids) {
    const id = rawId.trim();
    if (!isKnownOpenSourceToolId(id) || seen.has(id)) continue;
    selected.push(id);
    seen.add(id);
  }
  return selected;
}

export function isOpenSourceToolSelected(
  ids: string[] | undefined | null,
  id: OpenSourceSecurityToolId,
  fallback: readonly OpenSourceSecurityToolId[] = LEGACY_OPEN_SOURCE_TOOL_IDS
) {
  return normalizeOpenSourceToolIds(ids, fallback).includes(id);
}

