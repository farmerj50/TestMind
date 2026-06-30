import {
  confidenceLabel,
  metadataForVulnerability,
  severityForControl,
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
  ApiSecurityFixture,
  ExpectedSecurityControl,
  IntelligentSecurityScanConfig,
  SecurityAgentFinding,
  SecurityAuthProfile,
  SecurityFindingEvidence,
  SecuritySeverity,
} from "../types.js";

function buildAuthHeaders(profile?: SecurityAuthProfile): Record<string, string> {
  if (!profile || profile.type === "none") return {};
  if (profile.type === "bearer" && profile.token) {
    return { Authorization: `Bearer ${profile.token}` };
  }
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

function controlsForFixture(
  config: IntelligentSecurityScanConfig,
  fixture: ApiSecurityFixture
): ExpectedSecurityControl[] {
  const merged = [...(config.expectedControls ?? []), ...(fixture.expectedControls ?? [])];
  return Array.from(new Set(merged));
}

function profileMap(profiles: SecurityAuthProfile[] = []) {
  return new Map(profiles.map((profile) => [profile.label, profile]));
}

function findProfile(
  profiles: SecurityAuthProfile[] = [],
  preferred?: string,
  role?: string,
  exclude?: SecurityAuthProfile
) {
  if (preferred) {
    const found = profiles.find((profile) => profile.label === preferred);
    if (found) return found;
  }
  if (role) {
    const found = profiles.find(
      (profile) =>
        profile !== exclude &&
        profile.role?.trim().toLowerCase() === role.trim().toLowerCase()
    );
    if (found) return found;
  }
  return profiles.find((profile) => profile !== exclude && profile.type !== "none");
}

function hasMeaningfulBody(result: ProbeResult): boolean {
  return result.bodyLength > 40 || /[{[]/.test(result.body.trim());
}

function bodyDifferenceRatio(a: ProbeResult, b: ProbeResult): number {
  const larger = Math.max(a.bodyLength, b.bodyLength, 1);
  const smaller = Math.min(a.bodyLength, b.bodyLength);
  return (larger - smaller) / larger;
}

function confidence(score: number, rationale: string) {
  return { score, label: confidenceLabel(score), rationale };
}

function makeFinding(input: {
  vulnerabilityClass: VulnerabilityClass;
  severity?: SecuritySeverity;
  testedControl: ExpectedSecurityControl | string;
  expectedBehavior: string;
  observedBehavior: string;
  location: string;
  evidence: Array<{ label: string; result: ProbeResult }>;
  confidenceScore: number;
  confidenceRationale: string;
  anomalySignals?: string[];
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
    confidence: confidence(input.confidenceScore, input.confidenceRationale),
    requestResponse: input.evidence.map((entry) => probeEvidence(entry.label, entry.result)),
    anomalySignals: input.anomalySignals,
    reproductionSteps: input.evidence.map((entry, index) => {
      const result = entry.result;
      const profile = result.profile ? ` as ${result.profile}` : "";
      return `${index + 1}. Send ${result.method} ${result.url}${profile}; observe status ${result.status ?? "error"}.`;
    }),
    remediationSteps: meta.remediationSteps,
    complianceSteps: meta.complianceSteps,
  };

  return {
    type: "dynamic",
    severity: input.severity ?? severityForControl(input.testedControl),
    title: meta.name,
    description: input.observedBehavior,
    location: input.location,
    tool: "intelligent-security-agent",
    evidence,
    suggestion: meta.remediationSteps[0],
    status: "open",
  };
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

function exposedFields(body: string, forbiddenFields: string[] = []): string[] {
  if (!forbiddenFields.length || !body.trim()) return [];
  const normalizedBody = body.toLowerCase();
  let keys: string[] = [];
  try {
    keys = jsonKeys(JSON.parse(body)).map((key) => key.toLowerCase());
  } catch {
    keys = [];
  }

  return forbiddenFields.filter((field) => {
    const normalizedField = field.toLowerCase();
    return (
      keys.some((key) => key === normalizedField || key.endsWith(`.${normalizedField}`)) ||
      normalizedBody.includes(`"${normalizedField}"`) ||
      normalizedBody.includes(`'${normalizedField}'`)
    );
  });
}

async function checkAuthRequired(
  config: IntelligentSecurityScanConfig,
  fixture: ApiSecurityFixture,
  ownerProfile: SecurityAuthProfile
): Promise<SecurityAgentFinding[]> {
  const url = materializeRoute(config.baseUrl, fixture.route, fixture.ownerObjectId);
  const expectedDenyStatuses = fixture.expectedDenyStatuses ?? [401, 403, 404];
  const authed = await probeScoped(config, url, {
    method: fixture.method ?? "GET",
    headers: buildAuthHeaders(ownerProfile),
    profile: ownerProfile.label,
  });
  const unauth = await probeScoped(config, url, { method: fixture.method ?? "GET", profile: "Unauthenticated" });

  if (!isSuccessStatus(authed.status) || isDeniedStatus(unauth.status, expectedDenyStatuses)) {
    return [];
  }

  if (isSuccessStatus(unauth.status) && hasMeaningfulBody(unauth)) {
    const sameBody = authed.body === unauth.body && authed.bodyLength > 0;
    return [
      makeFinding({
        vulnerabilityClass: "broken_authentication",
        testedControl: "auth_required",
        expectedBehavior: `Unauthenticated callers should receive ${expectedDenyStatuses.join(", ")} for ${url}.`,
        observedBehavior: `Unauthenticated request returned HTTP ${unauth.status} with ${unauth.bodyLength} bytes from a protected route.`,
        location: url,
        evidence: [
          { label: "Authorized baseline", result: authed },
          { label: "Unauthenticated comparison", result: unauth },
        ],
        confidenceScore: sameBody ? 94 : 82,
        confidenceRationale: sameBody
          ? "The unauthenticated response matched the authorized baseline."
          : "The unauthenticated response succeeded and returned a meaningful body.",
      }),
    ];
  }

  return [];
}

async function checkObjectAuthorization(
  config: IntelligentSecurityScanConfig,
  fixture: ApiSecurityFixture,
  ownerProfile: SecurityAuthProfile,
  otherProfile?: SecurityAuthProfile
): Promise<SecurityAgentFinding[]> {
  if (!otherProfile || !fixture.ownerObjectId) return [];
  const url = materializeRoute(config.baseUrl, fixture.route, fixture.ownerObjectId);
  const otherOwnedUrl = fixture.otherObjectId
    ? materializeRoute(config.baseUrl, fixture.route, fixture.otherObjectId)
    : null;
  const expectedDenyStatuses = fixture.expectedDenyStatuses ?? [401, 403, 404];
  const owner = await probeScoped(config, url, {
    method: fixture.method ?? "GET",
    headers: buildAuthHeaders(ownerProfile),
    profile: ownerProfile.label,
  });
  const otherOwned = otherOwnedUrl
    ? await probeScoped(config, otherOwnedUrl, {
        method: fixture.method ?? "GET",
        headers: buildAuthHeaders(otherProfile),
        profile: otherProfile.label,
      })
    : undefined;
  const other = await probeScoped(config, url, {
    method: fixture.method ?? "GET",
    headers: buildAuthHeaders(otherProfile),
    profile: otherProfile.label,
  });

  if (!isSuccessStatus(owner.status) || isDeniedStatus(other.status, expectedDenyStatuses)) return [];

  if (isSuccessStatus(other.status) && hasMeaningfulBody(other)) {
    const sameBody = owner.body === other.body && owner.bodyLength > 0;
    const otherHasValidBaseline = otherOwned ? isSuccessStatus(otherOwned.status) && hasMeaningfulBody(otherOwned) : false;
    return [
      makeFinding({
        vulnerabilityClass: "broken_object_level_authorization",
        testedControl: "object_owner_required",
        expectedBehavior: `${otherProfile.label} should not access object ${fixture.ownerObjectId} owned by ${ownerProfile.label}.`,
        observedBehavior: `${otherProfile.label} received HTTP ${other.status} with ${other.bodyLength} bytes for ${ownerProfile.label}'s object.`,
        location: url,
        evidence: [
          { label: "Owner baseline", result: owner },
          ...(otherOwned ? [{ label: "Other account valid-object baseline", result: otherOwned }] : []),
          { label: "Cross-account object request", result: other },
        ],
        confidenceScore: sameBody ? 96 : otherHasValidBaseline ? 90 : 86,
        confidenceRationale: sameBody
          ? "The other profile received the same object response as the owner."
          : otherHasValidBaseline
            ? "The other profile could access its own fixture object and also received a successful response for the owner's object."
            : "The other profile received a successful meaningful response for an object it should not own.",
        anomalySignals: [
          "cross_account_object_success",
          ...(otherHasValidBaseline ? ["other_profile_valid_object_baseline_confirmed"] : []),
        ],
      }),
    ];
  }

  return [];
}

async function checkObjectMutation(
  config: IntelligentSecurityScanConfig,
  fixture: ApiSecurityFixture,
  ownerProfile: SecurityAuthProfile
): Promise<SecurityAgentFinding[]> {
  if (!fixture.ownerObjectId || !fixture.otherObjectId) return [];
  const ownerUrl = materializeRoute(config.baseUrl, fixture.route, fixture.ownerObjectId);
  const otherUrl = materializeRoute(config.baseUrl, fixture.route, fixture.otherObjectId);
  const expectedDenyStatuses = fixture.expectedDenyStatuses ?? [401, 403, 404];
  const baseline = await probeScoped(config, ownerUrl, {
    method: fixture.method ?? "GET",
    headers: buildAuthHeaders(ownerProfile),
    profile: ownerProfile.label,
  });
  const mutated = await probeScoped(config, otherUrl, {
    method: fixture.method ?? "GET",
    headers: buildAuthHeaders(ownerProfile),
    profile: ownerProfile.label,
  });

  if (!isSuccessStatus(baseline.status) || isDeniedStatus(mutated.status, expectedDenyStatuses)) return [];

  if (isSuccessStatus(mutated.status) && hasMeaningfulBody(mutated) && baseline.body !== mutated.body) {
    return [
      makeFinding({
        vulnerabilityClass: "broken_object_level_authorization",
        testedControl: "object_owner_required",
        expectedBehavior: `${ownerProfile.label} should not access object ${fixture.otherObjectId} unless it is assigned to that profile.`,
        observedBehavior: `Changing object ID from ${fixture.ownerObjectId} to ${fixture.otherObjectId} returned HTTP ${mutated.status} with a different response.`,
        location: otherUrl,
        evidence: [
          { label: "Owned object baseline", result: baseline },
          { label: "Mutated object request", result: mutated },
        ],
        confidenceScore: 84,
        confidenceRationale:
          "An approved object-id fixture returned a different successful response under the same account.",
      }),
    ];
  }

  return [];
}

async function checkFunctionAuthorization(
  config: IntelligentSecurityScanConfig,
  fixture: ApiSecurityFixture,
  lowProfile?: SecurityAuthProfile
): Promise<SecurityAgentFinding[]> {
  if (!lowProfile) return [];
  const url = materializeRoute(config.baseUrl, fixture.route, fixture.ownerObjectId);
  const expectedDenyStatuses = fixture.expectedDenyStatuses ?? [401, 403, 404];
  const low = await probeScoped(config, url, {
    method: fixture.method ?? "GET",
    headers: buildAuthHeaders(lowProfile),
    profile: lowProfile.label,
  });

  if (isDeniedStatus(low.status, expectedDenyStatuses) || !isSuccessStatus(low.status)) return [];

  return [
    makeFinding({
      vulnerabilityClass: "broken_function_level_authorization",
      testedControl: "role_admin_required",
      expectedBehavior: `${lowProfile.label} should be denied from privileged function ${url}.`,
      observedBehavior: `${lowProfile.label} received HTTP ${low.status} for a route declared as privileged.`,
      location: url,
      evidence: [{ label: "Lower-privilege function request", result: low }],
      confidenceScore: hasMeaningfulBody(low) ? 88 : 72,
      confidenceRationale:
        "A lower-privilege profile received a successful response for a route configured as role-protected.",
    }),
  ];
}

async function checkSensitiveFields(
  config: IntelligentSecurityScanConfig,
  fixture: ApiSecurityFixture,
  lowerProfile?: SecurityAuthProfile
): Promise<SecurityAgentFinding[]> {
  if (!lowerProfile || !fixture.forbiddenFields?.length) return [];
  const url = materializeRoute(config.baseUrl, fixture.route, fixture.ownerObjectId);
  const response = await probeScoped(config, url, {
    method: fixture.method ?? "GET",
    headers: buildAuthHeaders(lowerProfile),
    profile: lowerProfile.label,
  });
  if (!isSuccessStatus(response.status)) return [];
  const fields = exposedFields(response.body, fixture.forbiddenFields);
  if (!fields.length) return [];

  return [
    makeFinding({
      vulnerabilityClass: "broken_object_property_level_authorization",
      testedControl: "no_sensitive_fields",
      expectedBehavior: `${lowerProfile.label} response should not include fields: ${fixture.forbiddenFields.join(", ")}.`,
      observedBehavior: `Response exposed sensitive field(s): ${fields.join(", ")}.`,
      location: url,
      evidence: [{ label: "Lower-privilege response", result: response }],
      confidenceScore: 90,
      confidenceRationale: "Configured forbidden fields were observed in a successful lower-privilege response.",
      anomalySignals: fields.map((field) => `forbidden_field:${field}`),
    }),
  ];
}

async function checkInputAnomalies(
  config: IntelligentSecurityScanConfig,
  fixture: ApiSecurityFixture,
  profile?: SecurityAuthProfile
): Promise<SecurityAgentFinding[]> {
  if ((fixture.method ?? "GET").toUpperCase() !== "GET") return [];
  const url = materializeRoute(config.baseUrl, fixture.route, fixture.ownerObjectId);
  const headers = buildAuthHeaders(profile);
  const baseline = await probeScoped(config, url, {
    method: "GET",
    headers,
    profile: profile?.label,
  });
  const benign = await probeScoped(config, withQueryParam(url, "__tm_probe", "testmind-marker"), {
    method: "GET",
    headers,
    profile: profile?.label,
  });
  const malformed = await probeScoped(config, withQueryParam(url, "__tm_probe", "'"), {
    method: "GET",
    headers,
    profile: profile?.label,
  });

  const signals: string[] = [];
  if (!hasServerError(baseline) && hasServerError(malformed)) signals.push("malformed_input_caused_5xx");
  if (hasErrorDisclosure(malformed.body)) signals.push("malformed_input_disclosed_backend_error");
  if (
    isSuccessStatus(baseline.status) &&
    isSuccessStatus(benign.status) &&
    bodyDifferenceRatio(baseline, benign) > 0.85
  ) {
    signals.push("benign_marker_response_size_anomaly");
  }

  if (!signals.length) return [];

  return [
    makeFinding({
      vulnerabilityClass: signals.some((signal) => signal.includes("backend_error")) ? "injection" : "anomalous_api_behavior",
      severity: signals.some((signal) => signal.includes("backend_error")) ? "high" : "medium",
      testedControl: "input_validation",
      expectedBehavior: "Benign and malformed test parameters should be rejected or handled with stable, generic responses.",
      observedBehavior: `Input mutation produced anomaly signal(s): ${signals.join(", ")}.`,
      location: url,
      evidence: [
        { label: "Baseline request", result: baseline },
        { label: "Benign marker request", result: benign },
        { label: "Malformed marker request", result: malformed },
      ],
      confidenceScore: signals.some((signal) => signal.includes("backend_error")) ? 84 : 68,
      confidenceRationale:
        "The finding is based on controlled non-destructive input mutation and response anomaly comparison.",
      anomalySignals: signals,
    }),
  ];
}

function dedupe(findings: SecurityAgentFinding[]) {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.title}:${finding.location}:${finding.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function runIntelligentValidation(
  config: IntelligentSecurityScanConfig
): Promise<SecurityAgentFinding[]> {
  const fixtures = (config.apiFixtures ?? []).filter((fixture) => fixture.route?.trim());
  const profiles = config.authProfiles ?? [];
  if (!fixtures.length) return [];

  const profilesByLabel = profileMap(profiles);
  const findings: SecurityAgentFinding[] = [];

  for (const fixture of fixtures) {
    const controls = controlsForFixture(config, fixture);
    const ownerProfile =
      (fixture.ownerProfile ? profilesByLabel.get(fixture.ownerProfile) : undefined) ??
      findProfile(profiles, undefined, "user");
    const otherProfile =
      (fixture.otherProfile ? profilesByLabel.get(fixture.otherProfile) : undefined) ??
      findProfile(profiles, undefined, "user", ownerProfile);
    const lowProfile =
      (fixture.lowPrivilegeProfile ? profilesByLabel.get(fixture.lowPrivilegeProfile) : undefined) ??
      otherProfile ??
      findProfile(profiles, undefined, "viewer", ownerProfile);

    if (ownerProfile && (controls.length === 0 || controls.includes("auth_required"))) {
      findings.push(...(await checkAuthRequired(config, fixture, ownerProfile)));
    }

    if (ownerProfile && (controls.length === 0 || controls.includes("object_owner_required"))) {
      findings.push(...(await checkObjectAuthorization(config, fixture, ownerProfile, otherProfile)));
      findings.push(...(await checkObjectMutation(config, fixture, ownerProfile)));
    }

    if (controls.includes("role_admin_required")) {
      findings.push(...(await checkFunctionAuthorization(config, fixture, lowProfile)));
    }

    if (controls.includes("no_sensitive_fields") || fixture.forbiddenFields?.length) {
      findings.push(...(await checkSensitiveFields(config, fixture, lowProfile)));
    }

    if ((config.scanDepth ?? "standard") !== "baseline") {
      findings.push(...(await checkInputAnomalies(config, fixture, ownerProfile)));
    }
  }

  return dedupe(findings);
}
