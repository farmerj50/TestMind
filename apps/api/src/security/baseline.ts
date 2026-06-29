import { createHash } from "node:crypto";
import { confidenceLabel, metadataForVulnerability, type VulnerabilityClass } from "./owasp.js";
import type {
  AuthMatrixProbe,
  AuthMatrixResult,
  RouteBaselineSnapshot,
  SecurityAgentFinding,
  SecurityBaselineDriftSummary,
  SecurityBaselineFingerprint,
  SecurityBaselineStore,
  SecurityBehaviorBaseline,
  SecurityFindingEvidence,
  SecurityProbeEvidence,
  SecuritySeverity,
} from "./types.js";

export const SECURITY_BASELINE_PROVIDER = "security_behavior_baseline";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function statusClass(status?: number) {
  if (typeof status !== "number") return "error";
  return `${Math.floor(status / 100)}xx`;
}

function bodyLengthBucket(length?: number) {
  const value = length ?? 0;
  if (value === 0) return "0";
  if (value <= 100) return "1-100";
  if (value <= 1_000) return "101-1k";
  if (value <= 10_000) return "1k-10k";
  if (value <= 100_000) return "10k-100k";
  return "100k+";
}

function observedAccess(evidence: SecurityProbeEvidence) {
  const status = evidence.status;
  const bodyLength = evidence.bodyLength ?? 0;
  return typeof status === "number" && status >= 200 && status < 400 && (bodyLength > 40 || status === 204);
}

function locationHost(evidence: SecurityProbeEvidence) {
  const location = evidence.headers?.location;
  if (!location) return undefined;
  try {
    return new URL(location, evidence.url).host;
  } catch {
    return undefined;
  }
}

export function securityBaselineScopeKey(environment: string | undefined, baseUrl: string) {
  let origin = baseUrl;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    origin = baseUrl.replace(/\/+$/, "");
  }
  return `${environment || "qa"}|${origin}`;
}

export function emptySecurityBaselineStore(): SecurityBaselineStore {
  return { version: 1, baselines: {} };
}

export function parseSecurityBaselineStore(value: unknown): SecurityBaselineStore {
  if (!value || typeof value !== "object") return emptySecurityBaselineStore();
  const maybe = value as Partial<SecurityBaselineStore>;
  if (maybe.version !== 1 || !maybe.baselines || typeof maybe.baselines !== "object") {
    return emptySecurityBaselineStore();
  }
  return { version: 1, baselines: maybe.baselines };
}

export function getSecurityBehaviorBaseline(
  store: SecurityBaselineStore,
  scopeKey: string
): SecurityBehaviorBaseline | null {
  return store.baselines[scopeKey] ?? null;
}

export function upsertSecurityBehaviorBaseline(
  store: SecurityBaselineStore,
  baseline: SecurityBehaviorBaseline
): SecurityBaselineStore {
  return {
    version: 1,
    baselines: {
      ...store.baselines,
      [baseline.scopeKey]: baseline,
    },
  };
}

function routeSchemaKey(route: string, method: string) {
  return `${method.toUpperCase()} ${route}`;
}

function buildSchemaMap(snapshots: RouteBaselineSnapshot[] = []) {
  const map = new Map<string, string[]>();
  for (const snapshot of snapshots) {
    const keys = Array.from(new Set(snapshot.schemaKeys ?? [])).sort().slice(0, 80);
    map.set(routeSchemaKey(snapshot.contract.route, snapshot.contract.method), keys);
  }
  return map;
}

function fingerprintProbe(
  matrix: AuthMatrixResult,
  probe: AuthMatrixProbe,
  schemaKeys: string[]
): SecurityBaselineFingerprint {
  const snippet = probe.evidence.bodySnippet || "";
  return {
    key: `${matrix.method.toUpperCase()} ${matrix.route} ${probe.label}`,
    route: matrix.route,
    method: matrix.method.toUpperCase(),
    probeLabel: probe.label,
    expected: probe.expected,
    profile: probe.profile,
    objectId: probe.objectId,
    status: probe.evidence.status,
    statusClass: statusClass(probe.evidence.status),
    observedAccess: observedAccess(probe.evidence),
    bodyLength: probe.evidence.bodyLength,
    bodyLengthBucket: bodyLengthBucket(probe.evidence.bodyLength),
    locationHost: locationHost(probe.evidence),
    schemaKeys,
    schemaKeysHash: schemaKeys.length ? sha256(schemaKeys.join("|")) : undefined,
    bodySnippetHash: snippet ? sha256(snippet) : undefined,
    signals: probe.signals,
  };
}

export function buildSecurityBehaviorBaseline(input: {
  projectId: string;
  sourceScanId: string;
  baseUrl: string;
  environment?: string;
  authMatrix: AuthMatrixResult[];
  snapshots?: RouteBaselineSnapshot[];
  createdAt?: string;
}): SecurityBehaviorBaseline {
  const schemaByRoute = buildSchemaMap(input.snapshots);
  const fingerprints = input.authMatrix.flatMap((matrix) => {
    const schemaKeys = schemaByRoute.get(routeSchemaKey(matrix.route, matrix.method)) ?? [];
    return matrix.probes.map((probe) => fingerprintProbe(matrix, probe, schemaKeys));
  });

  return {
    version: 1,
    projectId: input.projectId,
    sourceScanId: input.sourceScanId,
    scopeKey: securityBaselineScopeKey(input.environment, input.baseUrl),
    baseUrl: input.baseUrl,
    environment: input.environment || "qa",
    createdAt: input.createdAt ?? new Date().toISOString(),
    fingerprints,
  };
}

function vulnerabilityForProbe(probeLabel: SecurityBaselineFingerprint["probeLabel"]): VulnerabilityClass {
  if (probeLabel === "unauthenticated") return "broken_authentication";
  if (probeLabel === "other_on_owner_object" || probeLabel === "owner_on_other_object") {
    return "broken_object_level_authorization";
  }
  if (probeLabel === "low_privilege" || probeLabel === "admin") {
    return "broken_function_level_authorization";
  }
  return "anomalous_api_behavior";
}

function evidenceFromFingerprint(label: string, fingerprint: SecurityBaselineFingerprint): SecurityProbeEvidence {
  return {
    label,
    method: fingerprint.method,
    url: `${fingerprint.method} ${fingerprint.route}`,
    profile: fingerprint.profile,
    status: fingerprint.status,
    bodyLength: fingerprint.bodyLength,
    headers: fingerprint.locationHost ? { location: fingerprint.locationHost } : undefined,
  };
}

function makeDriftFinding(input: {
  previous: SecurityBaselineFingerprint;
  current: SecurityBaselineFingerprint;
  severity: SecuritySeverity;
  signals: string[];
}): SecurityAgentFinding {
  const vulnerabilityClass = vulnerabilityForProbe(input.current.probeLabel);
  const meta = metadataForVulnerability(vulnerabilityClass);
  const evidence: SecurityFindingEvidence = {
    name: "Security Behavior Drift",
    vulnerabilityClass,
    owaspCategory: meta.owaspCategory,
    owaspApiCategory: meta.owaspApiCategory ?? null,
    complianceRefs: meta.complianceRefs,
    testedControl: "security_behavior_baseline",
    expectedBehavior: `Approved baseline for ${input.current.method} ${input.current.route} / ${input.current.probeLabel} should remain stable.`,
    observedBehavior: `Security behavior drifted from ${input.previous.statusClass} access=${input.previous.observedAccess} to ${input.current.statusClass} access=${input.current.observedAccess}.`,
    confidence: {
      score: input.signals.includes("previously_denied_now_allowed") ? 91 : 72,
      label: confidenceLabel(input.signals.includes("previously_denied_now_allowed") ? 91 : 72),
      rationale: "The current scan was compared against an explicitly approved security behavior baseline.",
    },
    requestResponse: [
      evidenceFromFingerprint("Approved baseline fingerprint", input.previous),
      evidenceFromFingerprint("Current scan fingerprint", input.current),
    ],
    anomalySignals: input.signals,
    reproductionSteps: [
      `1. Replay ${input.current.method} ${input.current.route} for probe ${input.current.probeLabel}.`,
      `2. Compare the current response status/access outcome to the approved baseline fingerprint.`,
    ],
    remediationSteps: [
      "Review the route authorization policy change that caused the drift.",
      ...meta.remediationSteps,
    ],
    complianceSteps: [
      "Record whether this drift was approved or a regression.",
      "If approved, approve the current scan as the new security baseline.",
      ...meta.complianceSteps,
    ],
  };

  return {
    type: "dynamic",
    severity: input.severity,
    title: "Security Behavior Drift",
    description: evidence.observedBehavior,
    location: `${input.current.method} ${input.current.route}`,
    tool: "security-baseline-drift",
    evidence,
    suggestion: evidence.remediationSteps[0],
    status: "open",
  };
}

export function compareSecurityBehaviorBaseline(
  approved: SecurityBehaviorBaseline | null,
  current: SecurityBehaviorBaseline
): { findings: SecurityAgentFinding[]; summary: SecurityBaselineDriftSummary } {
  if (!approved) {
    return {
      findings: [],
      summary: {
        baselinePresent: false,
        scopeKey: current.scopeKey,
        currentFingerprints: current.fingerprints.length,
        baselineFingerprints: 0,
        driftFindings: 0,
        deniedToAllowed: 0,
        allowedToDenied: 0,
        statusClassChanges: 0,
        schemaChanges: 0,
        newProbes: current.fingerprints.length,
        missingProbes: 0,
      },
    };
  }

  const previousByKey = new Map(approved.fingerprints.map((fingerprint) => [fingerprint.key, fingerprint]));
  const currentByKey = new Map(current.fingerprints.map((fingerprint) => [fingerprint.key, fingerprint]));
  const findings: SecurityAgentFinding[] = [];
  let deniedToAllowed = 0;
  let allowedToDenied = 0;
  let statusClassChanges = 0;
  let schemaChanges = 0;
  let newProbes = 0;
  let missingProbes = 0;

  for (const currentFingerprint of current.fingerprints) {
    const previous = previousByKey.get(currentFingerprint.key);
    if (!previous) {
      newProbes += 1;
      continue;
    }

    const signals: string[] = [];
    if (!previous.observedAccess && currentFingerprint.observedAccess) {
      deniedToAllowed += 1;
      signals.push("previously_denied_now_allowed");
    }
    if (previous.observedAccess && !currentFingerprint.observedAccess) {
      allowedToDenied += 1;
      signals.push("previously_allowed_now_denied");
    }
    if (previous.statusClass !== currentFingerprint.statusClass) {
      statusClassChanges += 1;
      signals.push(`status_class_changed:${previous.statusClass}->${currentFingerprint.statusClass}`);
    }
    if (
      previous.schemaKeysHash &&
      currentFingerprint.schemaKeysHash &&
      previous.schemaKeysHash !== currentFingerprint.schemaKeysHash
    ) {
      schemaChanges += 1;
      signals.push("schema_keys_changed");
    }

    const highRiskAccessDrift =
      signals.includes("previously_denied_now_allowed") && currentFingerprint.expected === "deny";
    if (highRiskAccessDrift) {
      findings.push(
        makeDriftFinding({
          previous,
          current: currentFingerprint,
          severity: "high",
          signals,
        })
      );
    }
  }

  for (const previous of approved.fingerprints) {
    if (!currentByKey.has(previous.key)) missingProbes += 1;
  }

  return {
    findings,
    summary: {
      baselinePresent: true,
      scopeKey: current.scopeKey,
      approvedAt: approved.approvedAt,
      sourceScanId: approved.sourceScanId,
      currentFingerprints: current.fingerprints.length,
      baselineFingerprints: approved.fingerprints.length,
      driftFindings: findings.length,
      deniedToAllowed,
      allowedToDenied,
      statusClassChanges,
      schemaChanges,
      newProbes,
      missingProbes,
    },
  };
}
