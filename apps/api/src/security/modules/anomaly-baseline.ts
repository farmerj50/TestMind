import {
  confidenceLabel,
  metadataForVulnerability,
  type VulnerabilityClass,
} from "../owasp.js";
import {
  hasErrorDisclosure,
  hasServerError,
  isDeniedStatus,
  isSuccessStatus,
  materializeRoute,
  probeEvidence,
  probeScoped,
  withQueryParam,
  type ProbeResult,
} from "../http-client.js";
import type {
  AuthMatrixProbe,
  AuthMatrixResult,
  ExpectedSecurityControl,
  IntelligentSecurityScanConfig,
  RouteBaselineSnapshot,
  RouteSecurityContract,
  SecurityAgentFinding,
  SecurityAuthProfile,
  SecurityFindingEvidence,
  SecuritySeverity,
} from "../types.js";

function buildAuthHeaders(profile?: SecurityAuthProfile): Record<string, string> {
  if (!profile || profile.type === "none") return {};
  if (profile.type === "bearer" && profile.token) return { Authorization: `Bearer ${profile.token}` };
  if (profile.type === "cookie" && profile.cookieValue) {
    if (profile.cookieName === "__raw__") return { Cookie: profile.cookieValue };
    return { Cookie: `${profile.cookieName || "session"}=${profile.cookieValue}` };
  }
  if (profile.type === "basic" && profile.username && profile.password) {
    return {
      Authorization: `Basic ${Buffer.from(`${profile.username}:${profile.password}`).toString("base64")}`,
    };
  }
  return {};
}

function profileFor(
  profiles: SecurityAuthProfile[],
  label?: string,
  role?: string,
  exclude?: SecurityAuthProfile
) {
  if (label) {
    const exact = profiles.find((profile) => profile.label === label);
    if (exact) return exact;
  }
  if (role) {
    const byRole = profiles.find(
      (profile) => profile !== exclude && profile.role?.toLowerCase() === role.toLowerCase()
    );
    if (byRole) return byRole;
  }
  return profiles.find((profile) => profile !== exclude && profile.type !== "none");
}

function isProbeable(contract: RouteSecurityContract): boolean {
  return !/\/:\w+|\{[^}]+\}/.test(contract.route) || !!contract.ownerObjectId;
}

function targetUrl(config: IntelligentSecurityScanConfig, contract: RouteSecurityContract): string | null {
  if (!isProbeable(contract)) return null;
  const url = materializeRoute(config.baseUrl, contract.route, contract.ownerObjectId);
  return /\/:\w+|\{[^}]+\}/.test(url) ? null : url;
}

function objectUrl(
  config: IntelligentSecurityScanConfig,
  contract: RouteSecurityContract,
  objectId?: string
): string | null {
  const url = materializeRoute(config.baseUrl, contract.route, objectId);
  return /\/:\w+|\{[^}]+\}/.test(url) ? null : url;
}

function hasMeaningfulBody(result: ProbeResult): boolean {
  return result.bodyLength > 40 || /^[\s]*[{[]/.test(result.body);
}

function isMatrixAllowed(result: ProbeResult): boolean {
  return isSuccessStatus(result.status) && (hasMeaningfulBody(result) || result.status === 204);
}

function differenceRatio(a: ProbeResult, b: ProbeResult): number {
  const larger = Math.max(a.bodyLength, b.bodyLength, 1);
  const smaller = Math.min(a.bodyLength, b.bodyLength);
  return (larger - smaller) / larger;
}

function jsonKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => jsonKeys(item, prefix));
  const keys: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key;
    keys.push(next);
    keys.push(...jsonKeys(nested, next));
  }
  return keys;
}

function parseJsonKeys(body: string): string[] {
  try {
    return jsonKeys(JSON.parse(body));
  } catch {
    return [];
  }
}

function exposedForbiddenFields(body: string, fields: string[]): string[] {
  if (!body || !fields.length) return [];
  const keys = parseJsonKeys(body).map((key) => key.toLowerCase());
  const lowerBody = body.toLowerCase();
  return fields.filter((field) => {
    const lowerField = field.toLowerCase();
    return (
      keys.some((key) => key === lowerField || key.endsWith(`.${lowerField}`)) ||
      lowerBody.includes(`"${lowerField}"`)
    );
  });
}

function evidenceConfidence(contract: RouteSecurityContract, declared: number, heuristic: number) {
  const score = contract.confidence === "declared" ? declared : heuristic;
  return {
    score,
    label: confidenceLabel(score),
    rationale:
      contract.confidence === "declared"
        ? "The anomaly violates a user-declared security contract."
        : "The anomaly violates a conservative route contract inferred from route shape and behavior.",
  };
}

function probeExpectationPassed(
  result: ProbeResult,
  expected: AuthMatrixProbe["expected"],
  expectedDenyStatuses: number[]
): boolean | null {
  if (result.error) return null;
  if (expected === "observe") return true;
  if (expected === "deny") {
    return isDeniedStatus(result.status, expectedDenyStatuses) || !isMatrixAllowed(result);
  }
  return isMatrixAllowed(result);
}

function matrixProbe(input: {
  label: AuthMatrixProbe["label"];
  expected: AuthMatrixProbe["expected"];
  result?: ProbeResult;
  profile?: string;
  objectId?: string;
  expectedDenyStatuses: number[];
}): AuthMatrixProbe | null {
  if (!input.result) return null;
  const passed = probeExpectationPassed(input.result, input.expected, input.expectedDenyStatuses);
  const signals: string[] = [];
  if (passed === false) {
    signals.push(
      input.expected === "deny"
        ? `${input.label}_unexpectedly_allowed`
        : `${input.label}_unexpectedly_denied`
    );
  }
  if (input.expected === "deny" && isMatrixAllowed(input.result)) {
    signals.push(`${input.label}_success_status:${input.result.status ?? "unknown"}`);
  }

  return {
    label: input.label,
    expected: input.expected,
    passed,
    profile: input.profile,
    objectId: input.objectId,
    evidence: probeEvidence(input.label, input.result),
    signals,
  };
}

function buildAuthMatrix(
  contract: RouteSecurityContract,
  raw: {
    unauthenticated: ProbeResult;
    owner?: ProbeResult;
    other?: ProbeResult;
    otherOnOwner?: ProbeResult;
    ownerOnOther?: ProbeResult;
    lowerPrivilege?: ProbeResult;
    admin?: ProbeResult;
  },
  profiles: {
    owner?: SecurityAuthProfile;
    other?: SecurityAuthProfile;
    low?: SecurityAuthProfile;
    admin?: SecurityAuthProfile;
  }
): AuthMatrixResult {
  const authRequired = contract.expectedControls.includes("auth_required");
  const objectOwnerRequired = contract.expectedControls.includes("object_owner_required");
  const adminRequired = contract.expectedControls.includes("role_admin_required");
  const probes = [
    matrixProbe({
      label: "unauthenticated",
      expected: authRequired ? "deny" : "observe",
      result: raw.unauthenticated,
      expectedDenyStatuses: contract.expectedDenyStatuses,
    }),
    matrixProbe({
      label: "owner",
      expected: profiles.owner ? "allow" : "observe",
      result: raw.owner,
      profile: profiles.owner?.label,
      objectId: contract.ownerObjectId,
      expectedDenyStatuses: contract.expectedDenyStatuses,
    }),
    matrixProbe({
      label: "other",
      expected: "allow",
      result: raw.other,
      profile: profiles.other?.label,
      objectId: contract.otherObjectId,
      expectedDenyStatuses: contract.expectedDenyStatuses,
    }),
    matrixProbe({
      label: "other_on_owner_object",
      expected: objectOwnerRequired ? "deny" : "observe",
      result: raw.otherOnOwner,
      profile: profiles.other?.label,
      objectId: contract.ownerObjectId,
      expectedDenyStatuses: contract.expectedDenyStatuses,
    }),
    matrixProbe({
      label: "owner_on_other_object",
      expected: objectOwnerRequired ? "deny" : "observe",
      result: raw.ownerOnOther,
      profile: profiles.owner?.label,
      objectId: contract.otherObjectId,
      expectedDenyStatuses: contract.expectedDenyStatuses,
    }),
    matrixProbe({
      label: "low_privilege",
      expected: adminRequired || objectOwnerRequired ? "deny" : "observe",
      result: raw.lowerPrivilege,
      profile: profiles.low?.label,
      objectId: contract.ownerObjectId,
      expectedDenyStatuses: contract.expectedDenyStatuses,
    }),
    matrixProbe({
      label: "admin",
      expected: adminRequired ? "allow" : "observe",
      result: raw.admin,
      profile: profiles.admin?.label,
      objectId: contract.ownerObjectId,
      expectedDenyStatuses: contract.expectedDenyStatuses,
    }),
  ].filter((probe): probe is AuthMatrixProbe => !!probe);

  return {
    route: contract.route,
    method: contract.method,
    source: contract.source,
    controls: contract.expectedControls,
    confidence: contract.confidence,
    probes,
    objectSwap: Boolean(contract.ownerObjectId && contract.otherObjectId),
    passCount: probes.filter((probe) => probe.passed === true).length,
    failCount: probes.filter((probe) => probe.passed === false).length,
    inconclusiveCount: probes.filter((probe) => probe.passed === null).length,
  };
}

function makeFinding(input: {
  contract: RouteSecurityContract;
  vulnerabilityClass: VulnerabilityClass;
  severity: SecuritySeverity;
  testedControl: ExpectedSecurityControl | string;
  expectedBehavior: string;
  observedBehavior: string;
  location: string;
  evidence: Array<{ label: string; result: ProbeResult }>;
  confidence: { score: number; label: "low" | "medium" | "high"; rationale: string };
  anomalySignals: string[];
}): SecurityAgentFinding {
  const meta = metadataForVulnerability(input.vulnerabilityClass);
  const evidence: SecurityFindingEvidence = {
    name: meta.name,
    vulnerabilityClass: input.vulnerabilityClass,
    owaspCategory: meta.owaspCategory,
    owaspApiCategory: meta.owaspApiCategory ?? null,
    complianceRefs: meta.complianceRefs,
    testedControl: input.testedControl,
    expectedBehavior: input.expectedBehavior,
    observedBehavior: input.observedBehavior,
    confidence: input.confidence,
    requestResponse: input.evidence.map((entry) => probeEvidence(entry.label, entry.result)),
    anomalySignals: [
      ...input.anomalySignals,
      `contract_source:${input.contract.source}`,
      `contract_confidence:${input.contract.confidence}`,
    ],
    reproductionSteps: input.evidence.map((entry, index) => {
      const profile = entry.result.profile ? ` as ${entry.result.profile}` : "";
      return `${index + 1}. Send ${entry.result.method} ${entry.result.url}${profile}; observe status ${entry.result.status ?? "error"} and response size ${entry.result.bodyLength} bytes.`;
    }),
    remediationSteps: meta.remediationSteps,
    complianceSteps: meta.complianceSteps,
  };

  return {
    type: "dynamic",
    severity: input.severity,
    title: meta.name,
    description: input.observedBehavior,
    location: input.location,
    tool: "anomaly-baseline-agent",
    evidence,
    suggestion: meta.remediationSteps[0],
    status: "open",
  };
}

async function collectSnapshot(
  config: IntelligentSecurityScanConfig,
  contract: RouteSecurityContract,
  url: string,
  ownerProfile?: SecurityAuthProfile,
  otherProfile?: SecurityAuthProfile,
  lower?: SecurityAuthProfile,
  adminProfile?: SecurityAuthProfile
): Promise<{
  snapshot: RouteBaselineSnapshot;
  raw: {
    unauthenticated: ProbeResult;
    owner?: ProbeResult;
    other?: ProbeResult;
    otherOnOwner?: ProbeResult;
    ownerOnOther?: ProbeResult;
    lowerPrivilege?: ProbeResult;
    admin?: ProbeResult;
    benignMutation?: ProbeResult;
    malformedMutation?: ProbeResult;
  };
}> {
  const otherUrl = contract.otherObjectId ? objectUrl(config, contract, contract.otherObjectId) : null;
  const unauthenticated = await probeScoped(config, url, {
    method: contract.method,
    profile: "Unauthenticated",
  });
  const ownerResult = ownerProfile
    ? await probeScoped(config, url, {
        method: contract.method,
        headers: buildAuthHeaders(ownerProfile),
        profile: ownerProfile.label,
      })
    : undefined;
  const other =
    otherProfile && otherUrl
      ? await probeScoped(config, otherUrl, {
          method: contract.method,
          headers: buildAuthHeaders(otherProfile),
          profile: otherProfile.label,
        })
      : undefined;
  const otherOnOwner = otherProfile
    ? await probeScoped(config, url, {
        method: contract.method,
        headers: buildAuthHeaders(otherProfile),
        profile: otherProfile.label,
      })
    : undefined;
  const ownerOnOther =
    ownerProfile && otherUrl
      ? await probeScoped(config, otherUrl, {
          method: contract.method,
          headers: buildAuthHeaders(ownerProfile),
          profile: ownerProfile.label,
        })
      : undefined;
  const lowerPrivilege = lower
    ? lower === otherProfile && otherOnOwner
      ? otherOnOwner
      : await probeScoped(config, url, {
          method: contract.method,
          headers: buildAuthHeaders(lower),
          profile: lower.label,
        })
    : undefined;
  const admin = adminProfile
    ? await probeScoped(config, url, {
        method: contract.method,
        headers: buildAuthHeaders(adminProfile),
        profile: adminProfile.label,
      })
    : undefined;
  const benignMutation =
    contract.method === "GET"
      ? await probeScoped(config, withQueryParam(url, "__tm_probe", "baseline-marker"), {
          method: "GET",
          headers: buildAuthHeaders(ownerProfile),
          profile: ownerProfile?.label,
        })
      : undefined;
  const malformedMutation =
    contract.method === "GET"
      ? await probeScoped(config, withQueryParam(url, "__tm_probe", "'"), {
          method: "GET",
          headers: buildAuthHeaders(ownerProfile),
          profile: ownerProfile?.label,
        })
      : undefined;

  const responseForSchema = ownerResult ?? lowerPrivilege ?? unauthenticated;
  const authMatrix = buildAuthMatrix(
    contract,
    {
      unauthenticated,
      owner: ownerResult,
      other,
      otherOnOwner,
      ownerOnOther,
      lowerPrivilege,
      admin,
    },
    {
      owner: ownerProfile,
      other: otherProfile,
      low: lower,
      admin: adminProfile,
    }
  );
  const matrixSignals = authMatrix.probes.flatMap((probe) => probe.signals);
  return {
    snapshot: {
      contract,
      unauthenticated: probeEvidence("Unauthenticated", unauthenticated),
      owner: ownerResult ? probeEvidence("Owner baseline", ownerResult) : undefined,
      other: other ? probeEvidence("Other owned-object baseline", other) : undefined,
      otherOnOwner: otherOnOwner ? probeEvidence("Other profile on owner object", otherOnOwner) : undefined,
      ownerOnOther: ownerOnOther ? probeEvidence("Owner profile on other object", ownerOnOther) : undefined,
      lowerPrivilege: lowerPrivilege ? probeEvidence("Lower-privilege baseline", lowerPrivilege) : undefined,
      admin: admin ? probeEvidence("Admin baseline", admin) : undefined,
      benignMutation: benignMutation ? probeEvidence("Benign mutation", benignMutation) : undefined,
      malformedMutation: malformedMutation ? probeEvidence("Malformed mutation", malformedMutation) : undefined,
      schemaKeys: parseJsonKeys(responseForSchema.body).slice(0, 60),
      authMatrix,
      anomalySignals: matrixSignals,
    },
    raw: {
      unauthenticated,
      owner: ownerResult,
      other,
      otherOnOwner,
      ownerOnOther,
      lowerPrivilege,
      admin,
      benignMutation,
      malformedMutation,
    },
  };
}

export async function runAnomalyBaseline(
  config: IntelligentSecurityScanConfig,
  contracts: RouteSecurityContract[]
): Promise<{
  findings: SecurityAgentFinding[];
  snapshots: RouteBaselineSnapshot[];
  authMatrix: AuthMatrixResult[];
}> {
  const findings: SecurityAgentFinding[] = [];
  const snapshots: RouteBaselineSnapshot[] = [];
  const authMatrix: AuthMatrixResult[] = [];
  const profiles = config.authProfiles ?? [];
  const maxContracts = config.scanDepth === "deep" ? 80 : config.scanDepth === "baseline" ? 10 : 35;

  for (const contract of contracts.slice(0, maxContracts)) {
    const url = targetUrl(config, contract);
    if (!url) continue;

    const owner = profileFor(profiles, contract.ownerProfile, "user");
    const other = profileFor(profiles, contract.otherProfile, "user", owner);
    const lower =
      profileFor(profiles, contract.lowPrivilegeProfile, "viewer", owner) ??
      other;
    const admin = profileFor(profiles, contract.adminProfile, "admin");
    const { snapshot, raw } = await collectSnapshot(config, contract, url, owner, other, lower, admin);
    snapshots.push(snapshot);
    if (snapshot.authMatrix) authMatrix.push(snapshot.authMatrix);

    if (contract.expectedControls.includes("auth_required")) {
      const baseline = raw.owner;
      const unauth = raw.unauthenticated;
      const shouldFlag =
        isSuccessStatus(unauth.status) &&
        hasMeaningfulBody(unauth) &&
        (!baseline || isSuccessStatus(baseline.status));
      if (shouldFlag && !isDeniedStatus(unauth.status, contract.expectedDenyStatuses)) {
        const sameBody = baseline ? baseline.body === unauth.body && baseline.bodyLength > 0 : false;
        findings.push(
          makeFinding({
            contract,
            vulnerabilityClass: "broken_authentication",
            severity: contract.confidence === "declared" || sameBody ? "high" : "medium",
            testedControl: "auth_required",
            expectedBehavior: `${contract.method} ${contract.route} should require authentication.`,
            observedBehavior: `Unauthenticated request returned HTTP ${unauth.status} with ${unauth.bodyLength} bytes.`,
            location: url,
            evidence: [
              ...(baseline ? [{ label: "Authenticated baseline", result: baseline }] : []),
              { label: "Unauthenticated request", result: unauth },
            ],
            confidence: sameBody
              ? evidenceConfidence(contract, 94, 78)
              : evidenceConfidence(contract, 84, 68),
            anomalySignals: [
              "unauthenticated_success",
              ...(sameBody ? ["unauthenticated_matches_authenticated_body"] : []),
            ],
          })
        );
      }
    }

    if (contract.expectedControls.includes("object_owner_required")) {
      const ownerBaseline = raw.owner;
      const otherOwnBaseline = raw.other;
      const crossAccountProbes: Array<{
        label: string;
        result?: ProbeResult;
        actor?: string;
        objectId?: string;
        ownerLabel?: string;
      }> = [
        {
          label: "Other profile on owner object",
          result: raw.otherOnOwner,
          actor: other?.label,
          objectId: contract.ownerObjectId,
          ownerLabel: owner?.label,
        },
        {
          label: "Owner profile on other object",
          result: raw.ownerOnOther,
          actor: owner?.label,
          objectId: contract.otherObjectId,
          ownerLabel: other?.label,
        },
      ];

      for (const probe of crossAccountProbes) {
        if (!probe.result) continue;
        if (
          isMatrixAllowed(probe.result) &&
          !isDeniedStatus(probe.result.status, contract.expectedDenyStatuses)
        ) {
          const matchedOwnerBody =
            ownerBaseline && probe.result.body === ownerBaseline.body && ownerBaseline.bodyLength > 0;
          const hasOtherBaseline =
            otherOwnBaseline && isSuccessStatus(otherOwnBaseline.status) && hasMeaningfulBody(otherOwnBaseline);
          findings.push(
            makeFinding({
              contract,
              vulnerabilityClass: "broken_object_level_authorization",
              severity: contract.confidence === "declared" || matchedOwnerBody ? "high" : "medium",
              testedControl: "object_owner_required",
              expectedBehavior: `${contract.method} ${contract.route} should deny cross-account object access.`,
              observedBehavior: `${probe.actor ?? "Cross-account profile"} received HTTP ${probe.result.status} with ${probe.result.bodyLength} bytes for object ${probe.objectId ?? "unknown"} owned by ${probe.ownerLabel ?? "another profile"}.`,
              location: probe.result.url,
              evidence: [
                ...(ownerBaseline ? [{ label: "Owner object baseline", result: ownerBaseline }] : []),
                ...(otherOwnBaseline ? [{ label: "Other owned-object baseline", result: otherOwnBaseline }] : []),
                { label: probe.label, result: probe.result },
              ],
              confidence: matchedOwnerBody
                ? evidenceConfidence(contract, 96, 84)
                : hasOtherBaseline
                  ? evidenceConfidence(contract, 90, 76)
                  : evidenceConfidence(contract, 84, 68),
              anomalySignals: [
                "object_swap_success",
                ...(matchedOwnerBody ? ["cross_account_response_matches_owner_body"] : []),
                ...(hasOtherBaseline ? ["other_owned_object_baseline_confirmed"] : []),
              ],
            })
          );
        }
      }
    }

    if (contract.expectedControls.includes("role_admin_required") && raw.lowerPrivilege) {
      const lowerResult = raw.lowerPrivilege;
      if (isSuccessStatus(lowerResult.status) && hasMeaningfulBody(lowerResult)) {
        findings.push(
          makeFinding({
            contract,
            vulnerabilityClass: "broken_function_level_authorization",
            severity: contract.confidence === "declared" ? "high" : "medium",
            testedControl: "role_admin_required",
            expectedBehavior: `${contract.method} ${contract.route} should deny lower-privilege profiles.`,
            observedBehavior: `${lowerResult.profile ?? "Lower-privilege profile"} received HTTP ${lowerResult.status} with ${lowerResult.bodyLength} bytes.`,
            location: url,
            evidence: [{ label: "Lower-privilege request", result: lowerResult }],
            confidence: evidenceConfidence(contract, 88, 70),
            anomalySignals: ["lower_privilege_success_on_privileged_route"],
          })
        );
      }
    }

    const lowerOrUnauth = raw.lowerPrivilege ?? raw.unauthenticated;
    if (contract.expectedControls.includes("no_sensitive_fields") || contract.forbiddenFields.length) {
      if (isSuccessStatus(lowerOrUnauth.status)) {
        const exposed = exposedForbiddenFields(lowerOrUnauth.body, contract.forbiddenFields);
        if (exposed.length) {
          findings.push(
            makeFinding({
              contract,
              vulnerabilityClass: "broken_object_property_level_authorization",
              severity: contract.confidence === "declared" ? "high" : "medium",
              testedControl: "no_sensitive_fields",
              expectedBehavior: `${contract.method} ${contract.route} should not expose sensitive fields to lower-trust profiles.`,
              observedBehavior: `Response exposed sensitive field(s): ${exposed.join(", ")}.`,
              location: url,
              evidence: [{ label: "Lower-trust response", result: lowerOrUnauth }],
              confidence: evidenceConfidence(contract, 90, 72),
              anomalySignals: exposed.map((field) => `forbidden_field:${field}`),
            })
          );
        }
      }
    }

    if (contract.expectedControls.includes("input_validation") && raw.malformedMutation) {
      const baseline = raw.owner ?? raw.unauthenticated;
      const malformed = raw.malformedMutation;
      const benign = raw.benignMutation;
      const signals: string[] = [];
      if (!hasServerError(baseline) && hasServerError(malformed)) signals.push("malformed_input_caused_5xx");
      if (hasErrorDisclosure(malformed.body)) signals.push("malformed_input_disclosed_backend_error");
      if (benign && isSuccessStatus(baseline.status) && isSuccessStatus(benign.status) && differenceRatio(baseline, benign) > 0.85) {
        signals.push("benign_marker_response_size_anomaly");
      }
      if (signals.length) {
        const isInjectionLike = signals.some((signal) => signal.includes("backend_error"));
        findings.push(
          makeFinding({
            contract,
            vulnerabilityClass: isInjectionLike ? "injection" : "anomalous_api_behavior",
            severity: isInjectionLike ? "high" : "medium",
            testedControl: "input_validation",
            expectedBehavior: `${contract.method} ${contract.route} should handle benign and malformed input with stable, generic responses.`,
            observedBehavior: `Input mutation produced anomaly signal(s): ${signals.join(", ")}.`,
            location: url,
            evidence: [
              { label: "Baseline request", result: baseline },
              ...(benign ? [{ label: "Benign mutation", result: benign }] : []),
              { label: "Malformed mutation", result: malformed },
            ],
            confidence: evidenceConfidence(contract, 84, 66),
            anomalySignals: signals,
          })
        );
      }
    }
  }

  return { findings, snapshots, authMatrix };
}
