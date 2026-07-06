export type SecuritySeverity = "info" | "low" | "medium" | "high" | "critical";

export type SecurityFindingType = "recon" | "static_analysis" | "dependency" | "dynamic";

export type SecurityScanDepth = "baseline" | "standard" | "deep";

export type SecurityEnvironment = "dev" | "qa" | "stage" | "prod";

export type AuthProfileType = "none" | "bearer" | "cookie" | "basic";

export type SecurityAuthProfile = {
  label: string;
  role?: string;
  type: AuthProfileType;
  token?: string;
  tokenSecretKey?: string;
  cookieName?: string;
  cookieValue?: string;
  cookieValueSecretKey?: string;
  username?: string;
  password?: string;
  passwordSecretKey?: string;
  // Mid-scan re-auth: session ID allows looking up provider config to refresh expired tokens
  sessionId?: string;
};

export type ExpectedSecurityControl =
  | "auth_required"
  | "object_owner_required"
  | "role_admin_required"
  | "no_sensitive_fields"
  | "strict_cors"
  | "secure_cookies"
  | "no_error_disclosure"
  | "input_validation";

export type ApiSecurityFixture = {
  name?: string;
  route: string;
  method?: string;
  ownerProfile?: string;
  otherProfile?: string;
  adminProfile?: string;
  lowPrivilegeProfile?: string;
  ownerObjectId?: string;
  otherObjectId?: string;
  expectedDenyStatuses?: number[];
  expectedControls?: ExpectedSecurityControl[];
  forbiddenFields?: string[];
};

export type RouteInventorySource = "fixture" | "base" | "html" | "form" | "openapi" | "script" | "heuristic";

export type RouteInventoryItem = {
  route: string;
  method: string;
  source: RouteInventorySource;
  url: string;
};

export type RouteSecurityContract = {
  route: string;
  method: string;
  source: RouteInventorySource;
  expectedControls: ExpectedSecurityControl[];
  expectedDenyStatuses: number[];
  forbiddenFields: string[];
  ownerProfile?: string;
  otherProfile?: string;
  adminProfile?: string;
  lowPrivilegeProfile?: string;
  ownerObjectId?: string;
  otherObjectId?: string;
  confidence: "declared" | "heuristic";
};

export type AuthMatrixExpectation = "allow" | "deny" | "observe";

export type AuthMatrixProbe = {
  label:
    | "unauthenticated"
    | "owner"
    | "other"
    | "other_on_owner_object"
    | "owner_on_other_object"
    | "low_privilege"
    | "admin";
  expected: AuthMatrixExpectation;
  passed: boolean | null;
  profile?: string;
  objectId?: string;
  evidence: SecurityProbeEvidence;
  signals: string[];
};

export type AuthMatrixResult = {
  route: string;
  method: string;
  source: RouteSecurityContract["source"];
  controls: ExpectedSecurityControl[];
  confidence: RouteSecurityContract["confidence"];
  probes: AuthMatrixProbe[];
  objectSwap: boolean;
  passCount: number;
  failCount: number;
  inconclusiveCount: number;
};

export type SecurityBaselineFingerprint = {
  key: string;
  route: string;
  method: string;
  probeLabel: AuthMatrixProbe["label"];
  expected: AuthMatrixExpectation;
  profile?: string;
  objectId?: string;
  status?: number;
  statusClass: string;
  observedAccess: boolean;
  bodyLength?: number;
  bodyLengthBucket: string;
  locationHost?: string;
  schemaKeys?: string[];
  schemaKeysHash?: string;
  bodySnippetHash?: string;
  signals: string[];
};

export type SecurityBehaviorBaseline = {
  version: 1;
  projectId: string;
  sourceScanId: string;
  scopeKey: string;
  baseUrl: string;
  environment: string;
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
  fingerprints: SecurityBaselineFingerprint[];
};

export type SecurityBaselineStore = {
  version: 1;
  baselines: Record<string, SecurityBehaviorBaseline>;
};

export type SecurityBaselineDriftSummary = {
  baselinePresent: boolean;
  scopeKey: string;
  approvedAt?: string;
  sourceScanId?: string;
  currentFingerprints: number;
  baselineFingerprints: number;
  driftFindings: number;
  deniedToAllowed: number;
  allowedToDenied: number;
  statusClassChanges: number;
  schemaChanges: number;
  newProbes: number;
  missingProbes: number;
};

export type RouteBaselineSnapshot = {
  contract: RouteSecurityContract;
  unauthenticated?: SecurityProbeEvidence;
  owner?: SecurityProbeEvidence;
  other?: SecurityProbeEvidence;
  otherOnOwner?: SecurityProbeEvidence;
  ownerOnOther?: SecurityProbeEvidence;
  lowerPrivilege?: SecurityProbeEvidence;
  admin?: SecurityProbeEvidence;
  benignMutation?: SecurityProbeEvidence;
  malformedMutation?: SecurityProbeEvidence;
  schemaKeys?: string[];
  authMatrix?: AuthMatrixResult;
  anomalySignals: string[];
};

export type IntelligentSecurityScanConfig = {
  jobId: string;
  projectId: string;
  baseUrl: string;
  allowedHosts: string[];
  allowedPorts: number[];
  maxDurationMinutes: number;
  enableActive: boolean;
  environment?: SecurityEnvironment | string;
  scanDepth?: SecurityScanDepth;
  safeMode?: boolean;
  authProfiles?: SecurityAuthProfile[];
  apiFixtures?: ApiSecurityFixture[];
  expectedControls?: ExpectedSecurityControl[];
  owaspCategories?: string[];
  complianceFrameworks?: string[];
};

export type SecurityTestSetup = {
  authProfiles: SecurityAuthProfile[];
  apiFixtures: ApiSecurityFixture[];
  expectedControls: ExpectedSecurityControl[];
  owaspCategories: string[];
  complianceFrameworks: string[];
};

export type SecurityProbeEvidence = {
  label: string;
  method: string;
  url: string;
  profile?: string;
  status?: number;
  bodyLength?: number;
  bodySnippet?: string;
  headers?: Record<string, string>;
  error?: string;
};

export type SecurityFindingEvidence = {
  name: string;
  vulnerabilityClass: string;
  owaspCategory: string;
  owaspApiCategory?: string | null;
  complianceRefs: string[];
  testedControl: ExpectedSecurityControl | string;
  expectedBehavior: string;
  observedBehavior: string;
  confidence: {
    score: number;
    label: "low" | "medium" | "high";
    rationale: string;
  };
  requestResponse: SecurityProbeEvidence[];
  anomalySignals?: string[];
  reproductionSteps: string[];
  remediationSteps: string[];
  complianceSteps: string[];
};

export type SecurityAgentFinding = {
  type: SecurityFindingType;
  severity: SecuritySeverity;
  title: string;
  description?: string;
  location?: string;
  tool?: string;
  evidence?: SecurityFindingEvidence | Record<string, unknown>;
  suggestion?: string;
  status?: string;
};
