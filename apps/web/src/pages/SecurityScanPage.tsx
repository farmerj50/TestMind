import { useEffect, useMemo, useRef, useState } from "react";
import { useApi, apiUrl } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Building2, Bug, Code2, KeyRound, Plus, RefreshCw, Save, ShieldCheck, Trash2 } from "lucide-react";

type Project = { id: string; name: string };
type ProjectSecret = { id: string; name: string; key: string; createdAt: string; updatedAt: string };
type AuthProfileConfig = {
  label: string;
  role?: string;
  type: "none" | "bearer" | "cookie" | "basic";
  tokenSecretKey?: string;
  cookieName?: string;
  cookieValueSecretKey?: string;
  username?: string;
  passwordSecretKey?: string;
};
type ApiFixtureConfig = {
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
  expectedControls?: string[];
  forbiddenFields?: string[];
};
type ApiFixtureSuggestion = ApiFixtureConfig & {
  source?: string;
  confidence?: string;
  rationale?: string;
  objectIdRequired?: boolean;
};
type SecurityTestSetup = {
  authProfiles: AuthProfileConfig[];
  apiFixtures: ApiFixtureConfig[];
  expectedControls: string[];
  owaspCategories?: string[];
  complianceFrameworks?: string[];
};
type SecurityJob = {
  id: string;
  projectId: string;
  status: "queued" | "running" | "completed" | "failed";
  phase?: string | null;
  summary?: any;
  config?: {
    authProfiles?: Array<{ label: string; role?: string | null; type?: string }>;
  } | null;
  createdAt: string;
  updatedAt: string;
  findings?: SecurityFinding[];
  error?: string | null;
};

type OperatorJobRef = {
  id: string;
  status: string;
};

type AuthMode = "enterprise" | "bug_bounty";

type SecurityAuthSession = {
  id: string;
  projectId: string;
  mode: AuthMode;
  provider?: string | null;
  baseUrl?: string | null;
  loginUrl?: string | null;
  scopeAcknowledged: boolean;
  role?: string | null;
  expiresAt?: string | null;
  status: "pending" | "mfa_required" | "authenticated" | "captured" | "expired" | "failed";
  error?: string | null;
  createdAt: string;
  updatedAt: string;
};

type ApiSpecRecord = {
  id: string;
  title: string;
  version?: string | null;
  sourceUrl?: string | null;
  endpointCount: number;
  createdAt: string;
};

type SecurityFinding = {
  id: string;
  type: string;
  severity: string;
  title: string;
  description?: string | null;
  location?: string | null;
  tool?: string | null;
  evidence?: any;
};

type SecurityFindingDetail = {
  title: string;
  severity: string;
  vulnerabilityClass?: string | null;
  owaspCategory?: string | null;
  owaspApiCategory?: string | null;
  complianceRefs?: string[];
  expectedBehavior?: string | null;
  observedBehavior?: string | null;
  summary: string;
  affectedAsset: string;
  whyItMatters: string;
  confidence: {
    score: number;
    label: string;
    rationale: string;
  };
  evidence: string[];
  safeVerificationSteps: string[];
  recommendedFix: string[];
  complianceSteps?: string[];
  defensiveNote: string;
  cve?: string | null;
};

const DEFAULT_EXPECTED_CONTROLS =
  "auth_required,object_owner_required,no_sensitive_fields,input_validation";
const SECURITY_CONTROLS = [
  "auth_required",
  "object_owner_required",
  "role_admin_required",
  "no_sensitive_fields",
  "strict_cors",
  "secure_cookies",
  "no_error_disclosure",
  "input_validation",
] as const;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const OWASP_WEB_TOP_10 = [
  { value: "A01:2021", label: "A01 — Broken Access Control" },
  { value: "A02:2021", label: "A02 — Cryptographic Failures" },
  { value: "A03:2021", label: "A03 — Injection" },
  { value: "A04:2021", label: "A04 — Insecure Design" },
  { value: "A05:2021", label: "A05 — Security Misconfiguration" },
  { value: "A06:2021", label: "A06 — Vulnerable and Outdated Components" },
  { value: "A07:2021", label: "A07 — Identification and Authentication Failures" },
  { value: "A08:2021", label: "A08 — Software and Data Integrity Failures" },
  { value: "A09:2021", label: "A09 — Security Logging and Monitoring Failures" },
  { value: "A10:2021", label: "A10 — Server-Side Request Forgery" },
] as const;

const OWASP_API_TOP_10 = [
  { value: "API1:2023", label: "API1 — Broken Object Level Authorization" },
  { value: "API2:2023", label: "API2 — Broken Authentication" },
  { value: "API3:2023", label: "API3 — Broken Object Property Level Authorization" },
  { value: "API4:2023", label: "API4 — Unrestricted Resource Consumption" },
  { value: "API5:2023", label: "API5 — Broken Function Level Authorization" },
  { value: "API6:2023", label: "API6 — Unrestricted Access to Sensitive Business Flows" },
  { value: "API7:2023", label: "API7 — Server Side Request Forgery" },
  { value: "API8:2023", label: "API8 — Security Misconfiguration" },
  { value: "API9:2023", label: "API9 — Improper Inventory Management" },
  { value: "API10:2023", label: "API10 — Unsafe Consumption of APIs" },
] as const;

const ALL_WEB_CATEGORIES = OWASP_WEB_TOP_10.map((c) => c.value);
const ALL_API_CATEGORIES = OWASP_API_TOP_10.map((c) => c.value);

// The access-control vulnerability classes that genuinely depend on having more than one
// authenticated role available — BOLA/IDOR, role escalation, admin-route testing, and session
// boundary testing only mean something once a scan actually has multiple captured/configured
// auth contexts to compare. Labels/categories mirror apps/api/src/security/owasp.ts's
// VULNERABILITY_CATALOG for these same four classes.
const ACCESS_CONTROL_MATRIX_ROWS = [
  {
    vulnerabilityClass: "broken_object_level_authorization",
    label: "Object-level authorization (BOLA/IDOR)",
    owaspCategory: "A01:2021 Broken Access Control",
    owaspApiCategory: "API1:2023 Broken Object Level Authorization",
  },
  {
    vulnerabilityClass: "broken_object_property_level_authorization",
    label: "Object property exposure (ownership/field-level)",
    owaspCategory: "A01:2021 Broken Access Control",
    owaspApiCategory: "API3:2023 Broken Object Property Level Authorization",
  },
  {
    vulnerabilityClass: "broken_function_level_authorization",
    label: "Function-level authorization (role escalation / admin routes)",
    owaspCategory: "A01:2021 Broken Access Control",
    owaspApiCategory: "API5:2023 Broken Function Level Authorization",
  },
  {
    vulnerabilityClass: "broken_authentication",
    label: "Authentication / session boundary",
    owaspCategory: "A07:2021 Identification and Authentication Failures",
    owaspApiCategory: "API2:2023 Broken Authentication",
  },
] as const;

const SCAN_INTENTS = [
  {
    value: "recon",
    label: "Recon",
    categories: ["A05:2021", "A06:2021", "A09:2021", "API8:2023", "API9:2023"],
  },
  {
    value: "auth",
    label: "Auth",
    categories: ["A01:2021", "A07:2021", "API2:2023", "API5:2023"],
  },
  {
    value: "api",
    label: "API",
    categories: [...ALL_API_CATEGORIES],
  },
  {
    value: "input",
    label: "Input",
    categories: ["A03:2021", "API8:2023"],
  },
  {
    value: "business_logic",
    label: "Business Logic",
    categories: ["A04:2021", "API6:2023"],
  },
  {
    value: "full",
    label: "Full",
    categories: [...ALL_WEB_CATEGORIES, ...ALL_API_CATEGORIES],
  },
] as const;

const BB_STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for login",
  mfa_required: "MFA required",
  authenticated: "Authenticated",
  captured: "Session captured",
  expired: "Session expired",
  failed: "Re-authentication required",
};

const RISK_MODES = [
  {
    value: "safe",
    label: "Safe",
    description: "Non-destructive authorized validation only.",
    safeMode: true,
    enableActive: false,
  },
  {
    value: "active",
    label: "Active",
    description: "Bounded active probes (input mutation, redirect checks) within authorized scope.",
    safeMode: true,
    enableActive: true,
  },
  {
    value: "deep",
    label: "Deep (requires approval)",
    description: "Deep scan depth with active probing and reduced safe-mode guardrails. Always routes through Operator approval.",
    safeMode: false,
    enableActive: true,
  },
] as const;

function prettyJson(value: unknown) {
  return value && Array.isArray(value) && value.length ? JSON.stringify(value, null, 2) : "";
}

function splitList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseStatusList(value?: string) {
  const values = splitList(value ?? "")
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item));
  return values.length ? values : undefined;
}

function parseStringList(value?: string) {
  const values = splitList(value ?? "");
  return values.length ? values : undefined;
}

function apiFixtureKey(fixture: Pick<ApiFixtureConfig, "route" | "method">) {
  return `${(fixture.method || "GET").toUpperCase()} ${fixture.route.trim()}`;
}

function normalizeAuthProfile(profile: AuthProfileConfig): AuthProfileConfig {
  const type = profile.type || "none";
  const normalized: AuthProfileConfig = {
    label: profile.label.trim(),
    type,
  };
  if (profile.role?.trim()) normalized.role = profile.role.trim();
  if (type === "bearer" && profile.tokenSecretKey?.trim()) {
    normalized.tokenSecretKey = profile.tokenSecretKey.trim();
  }
  if (type === "cookie") {
    normalized.cookieName = profile.cookieName?.trim() || "session";
    if (profile.cookieValueSecretKey?.trim()) {
      normalized.cookieValueSecretKey = profile.cookieValueSecretKey.trim();
    }
  }
  if (type === "basic") {
    if (profile.username?.trim()) normalized.username = profile.username.trim();
    if (profile.passwordSecretKey?.trim()) {
      normalized.passwordSecretKey = profile.passwordSecretKey.trim();
    }
  }
  return normalized;
}

function normalizeApiFixture(fixture: ApiFixtureConfig): ApiFixtureConfig {
  const normalized: ApiFixtureConfig = {
    route: fixture.route.trim(),
    method: (fixture.method || "GET").toUpperCase(),
  };
  if (fixture.name?.trim()) normalized.name = fixture.name.trim();
  if (fixture.ownerProfile?.trim()) normalized.ownerProfile = fixture.ownerProfile.trim();
  if (fixture.otherProfile?.trim()) normalized.otherProfile = fixture.otherProfile.trim();
  if (fixture.adminProfile?.trim()) normalized.adminProfile = fixture.adminProfile.trim();
  if (fixture.lowPrivilegeProfile?.trim()) {
    normalized.lowPrivilegeProfile = fixture.lowPrivilegeProfile.trim();
  }
  if (fixture.ownerObjectId?.trim()) normalized.ownerObjectId = fixture.ownerObjectId.trim();
  if (fixture.otherObjectId?.trim()) normalized.otherObjectId = fixture.otherObjectId.trim();
  if (fixture.expectedDenyStatuses?.length) {
    normalized.expectedDenyStatuses = fixture.expectedDenyStatuses;
  }
  if (fixture.expectedControls?.length) {
    normalized.expectedControls = fixture.expectedControls;
  }
  if (fixture.forbiddenFields?.length) {
    normalized.forbiddenFields = fixture.forbiddenFields;
  }
  return normalized;
}

// Keep only the newest job per page/baseUrl so duplicate scans don't pile up in the UI.
function uniqByPage(jobs: SecurityJob[]) {
  const byKey = new Map<string, SecurityJob>();
  for (const job of jobs) {
    const key =
      job.summary?.url ||
      job.summary?.baseUrl ||
      job.summary?.page ||
      (job as any)?.baseUrl ||
      "unknown";
    const existing = byKey.get(key);
    if (!existing || new Date(job.createdAt) > new Date(existing.createdAt)) {
      byKey.set(key, job);
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export default function SecurityScanPage() {
  const { apiFetch } = useApi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [authMode, setAuthMode] = useState<AuthMode>("enterprise");
  const [bbLoginUrl, setBbLoginUrl] = useState("");
  const [bbScopeAck, setBbScopeAck] = useState(false);
  const [bbAllowInteractiveChallengeHandling, setBbAllowInteractiveChallengeHandling] = useState(false);
  const [bbProxyUrl, setBbProxyUrl] = useState("");
  const [bbInputMode, setBbInputMode] = useState<"live" | "paste">("live");
  const [bbPastedCookies, setBbPastedCookies] = useState("");
  const [bbPasteImporting, setBbPasteImporting] = useState(false);
  const [bbStarting, setBbStarting] = useState(false);
  const [bbSession, setBbSession] = useState<SecurityAuthSession | null>(null);
  const bbPollRef = useRef<number | null>(null);
  const [entMethod, setEntMethod] = useState<"bypass" | "auth0" | "firebase" | "cognito" | "clerk">("bypass");
  const [entBypassSecretKey, setEntBypassSecretKey] = useState("");
  const [entRole, setEntRole] = useState("admin");
  const [entStarting, setEntStarting] = useState(false);
  const [entSession, setEntSession] = useState<SecurityAuthSession | null>(null);
  const [auth0Domain, setAuth0Domain] = useState("");
  const [auth0ClientId, setAuth0ClientId] = useState("");
  const [auth0Audience, setAuth0Audience] = useState("");
  const [auth0Username, setAuth0Username] = useState("");
  const [auth0PasswordSecretKey, setAuth0PasswordSecretKey] = useState("");
  const [auth0ClientSecretKey, setAuth0ClientSecretKey] = useState("");
  const [fbApiKey, setFbApiKey] = useState("");
  const [fbEmail, setFbEmail] = useState("");
  const [fbPasswordSecretKey, setFbPasswordSecretKey] = useState("");
  const [cogRegion, setCogRegion] = useState("");
  const [cogClientId, setCogClientId] = useState("");
  const [cogUsername, setCogUsername] = useState("");
  const [cogPasswordSecretKey, setCogPasswordSecretKey] = useState("");
  const [cogClientSecretKey, setCogClientSecretKey] = useState("");
  const [clerkFrontendApiUrl, setClerkFrontendApiUrl] = useState("");
  const [clerkOrigin, setClerkOrigin] = useState("");
  const [clerkIdentifier, setClerkIdentifier] = useState("");
  const [clerkPasswordSecretKey, setClerkPasswordSecretKey] = useState("");
  const [authSessions, setAuthSessions] = useState<SecurityAuthSession[]>([]);
  const [selectedAuthSessionId, setSelectedAuthSessionId] = useState("");
  const [apiSpecs, setApiSpecs] = useState<ApiSpecRecord[]>([]);
  const [selectedApiSpecId, setSelectedApiSpecId] = useState("");
  const [apiSpecImportUrl, setApiSpecImportUrl] = useState("");
  const [apiSpecImporting, setApiSpecImporting] = useState(false);
  const [liveViewOpen, setLiveViewOpen] = useState(false);
  const [liveViewConnecting, setLiveViewConnecting] = useState(false);
  const liveWsRef = useRef<WebSocket | null>(null);
  const liveImgRef = useRef<HTMLImageElement | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [allowedHosts, setAllowedHosts] = useState("");
  const [allowedPorts, setAllowedPorts] = useState("80,443");
  const [maxDuration, setMaxDuration] = useState(10);
  const [enableActive, setEnableActive] = useState(false);
  const [environment, setEnvironment] = useState<"dev" | "qa" | "stage" | "prod">("qa");
  const [scanDepth, setScanDepth] = useState<"baseline" | "standard" | "deep">("standard");
  const [safeMode, setSafeMode] = useState(true);
  const [riskMode, setRiskMode] = useState<(typeof RISK_MODES)[number]["value"]>("safe");
  const [scanIntent, setScanIntent] = useState<(typeof SCAN_INTENTS)[number]["value"]>("full");
  const [owaspCategories, setOwaspCategories] = useState<string[]>([]);
  const [complianceFrameworks] = useState<string[]>(["OWASP ASVS", "SOC 2", "ISO 27001"]);
  const [expectedControls, setExpectedControls] = useState(DEFAULT_EXPECTED_CONTROLS);
  const [authProfiles, setAuthProfiles] = useState<AuthProfileConfig[]>([]);
  const [apiFixtures, setApiFixtures] = useState<ApiFixtureConfig[]>([]);
  const [authProfilesJson, setAuthProfilesJson] = useState("");
  const [apiFixturesJson, setApiFixturesJson] = useState("");
  const [showSetupJson, setShowSetupJson] = useState(false);
  const [useSavedSetup, setUseSavedSetup] = useState(true);
  const [setupDirty, setSetupDirty] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupSaving, setSetupSaving] = useState(false);
  const [contractSuggestions, setContractSuggestions] = useState<ApiFixtureSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionInventory, setSuggestionInventory] = useState<{
    routes: number;
    sources: Record<string, number>;
  } | null>(null);
  const [secrets, setSecrets] = useState<ProjectSecret[]>([]);
  const [job, setJob] = useState<SecurityJob | null>(null);
  const [recent, setRecent] = useState<SecurityJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [operatorRequest, setOperatorRequest] = useState<OperatorJobRef | null>(null);
  const pollRef = useRef<number | null>(null);
  const pollFailures = useRef<number>(0);
  const [selectedFinding, setSelectedFinding] = useState<SecurityFinding | null>(null);
  const [findingExplain, setFindingExplain] = useState<SecurityFindingDetail | null>(null);
  const [findingTest, setFindingTest] = useState<string>("");
  const [findingLoading, setFindingLoading] = useState<{ explain?: boolean; test?: boolean }>({});
  const [baselineApproving, setBaselineApproving] = useState(false);
  const needsOperatorApproval = environment === "prod" || scanDepth === "deep" || enableActive || safeMode === false;
  const stopPolling = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    let mounted = true;
    apiFetch<{ projects: Project[] }>("/projects")
      .then((res) => {
        if (!mounted) return;
        setProjects(res.projects || []);
        if (res.projects?.length && !projectId) {
          setProjectId(res.projects[0].id);
        }
      })
      .catch((err: any) => {
        if (!mounted) return;
        setError(err?.message ?? "Failed to load projects");
      });
    return () => {
      mounted = false;
      stopPolling();
      stopBbPolling();
      closeLiveView();
    };
  }, [apiFetch]);

  // load recent scans when project changes
  useEffect(() => {
    if (!projectId) return;
    apiFetch<{ jobs: SecurityJob[] }>(`/security/scans?projectId=${projectId}`)
      .then((res) => setRecent(uniqByPage(res.jobs || [])))
      .catch(() => {});
  }, [apiFetch, projectId]);

  const loadAuthSessions = (pid: string) => {
    apiFetch<{ sessions: SecurityAuthSession[] }>(`/security/auth-sessions?projectId=${pid}`)
      .then((res) => setAuthSessions(res.sessions || []))
      .catch(() => {});
  };

  useEffect(() => {
    if (!projectId) return;
    loadAuthSessions(projectId);
    loadApiSpecs(projectId);
  }, [apiFetch, projectId]);

  const usableAuthSessions = authSessions.filter((s) => s.status === "authenticated" || s.status === "captured");

  const loadApiSpecs = (pid: string) => {
    apiFetch<{ specs: ApiSpecRecord[] }>(`/security/api-specs?projectId=${pid}`)
      .then((res) => setApiSpecs(res.specs || []))
      .catch(() => {});
  };

  const importApiSpec = async () => {
    if (!projectId) { setError("Pick a project first."); return; }
    if (!apiSpecImportUrl.trim()) { setError("Enter a spec URL to import."); return; }
    setError(null);
    setApiSpecImporting(true);
    try {
      await apiFetch("/security/api-specs/import", {
        method: "POST",
        body: JSON.stringify({ projectId, specUrl: apiSpecImportUrl.trim() }),
      });
      setApiSpecImportUrl("");
      loadApiSpecs(projectId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to import spec");
    } finally {
      setApiSpecImporting(false);
    }
  };

  useEffect(() => {
    if (!projectId) return;
    setSetupLoading(true);
    Promise.all([
      apiFetch<{ setup: SecurityTestSetup }>(`/projects/${projectId}/security-setup`),
      apiFetch<{ secrets: ProjectSecret[] }>(`/projects/${projectId}/secrets`),
    ])
      .then(([setupRes, secretsRes]) => {
        const setup = setupRes.setup || {
          authProfiles: [],
          apiFixtures: [],
          expectedControls: [],
        };
        setAuthProfiles(setup.authProfiles || []);
        setApiFixtures(setup.apiFixtures || []);
        setAuthProfilesJson(prettyJson(setup.authProfiles || []));
        setApiFixturesJson(prettyJson(setup.apiFixtures || []));
        setExpectedControls(
          setup.expectedControls?.length
            ? setup.expectedControls.join(",")
            : DEFAULT_EXPECTED_CONTROLS
        );
        setOwaspCategories(setup.owaspCategories || []);
        setSecrets(secretsRes.secrets || []);
        setContractSuggestions([]);
        setSuggestionInventory(null);
        setSetupDirty(false);
      })
      .catch((err: any) => {
        setError(err?.message ?? "Failed to load security test setup");
      })
      .finally(() => setSetupLoading(false));
  }, [apiFetch, projectId]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId]
  );
  const profileLabels = useMemo(
    () =>
      Array.from(
        new Set(authProfiles.map((profile) => profile.label.trim()).filter(Boolean))
      ),
    [authProfiles]
  );
  const configuredFixtureKeys = useMemo(
    () => new Set(apiFixtures.map(apiFixtureKey)),
    [apiFixtures]
  );

  // Coverage is inferred, not directly recorded: SecurityFinding only ever represents a
  // confirmed vulnerability (status is always "open" — there's no "passed" record). So
  // "covered" here means "this role had a configured session and no vulnerability of this
  // class was found for it" — a reasonable proxy, not a guarantee the check ran exhaustively.
  const accessControlMatrix = useMemo(() => {
    const profiles = job?.config?.authProfiles ?? [];
    if (!profiles.length) return null;
    const roleForLabel = new Map<string, string>();
    const roles: string[] = [];
    for (const p of profiles) {
      const role = (p.role && p.role.trim()) || p.label.trim();
      if (!role) continue;
      roleForLabel.set(p.label.trim(), role);
      if (!roles.includes(role)) roles.push(role);
    }
    if (!roles.length) return null;

    const cells = new Map<string, Map<string, "vulnerable" | "covered">>();
    for (const row of ACCESS_CONTROL_MATRIX_ROWS) {
      const roleStatus = new Map<string, "vulnerable" | "covered">();
      for (const role of roles) roleStatus.set(role, "covered");
      cells.set(row.vulnerabilityClass, roleStatus);
    }

    for (const finding of job?.findings ?? []) {
      const vulnerabilityClass = (finding.evidence as any)?.vulnerabilityClass;
      const roleStatus = vulnerabilityClass ? cells.get(vulnerabilityClass) : undefined;
      if (!roleStatus) continue;
      const touchedLabels: string[] = ((finding.evidence as any)?.requestResponse ?? [])
        .map((rr: any) => rr?.profile)
        .filter(Boolean);
      for (const label of touchedLabels) {
        const role = roleForLabel.get(String(label).trim()) ?? String(label).trim();
        if (roleStatus.has(role)) roleStatus.set(role, "vulnerable");
      }
    }

    return {
      roles,
      rows: ACCESS_CONTROL_MATRIX_ROWS.map((row) => ({ ...row, cells: cells.get(row.vulnerabilityClass)! })),
    };
  }, [job]);

  const pollJob = (jobId: string) => {
    stopPolling();
    pollRef.current = window.setInterval(() => {
      apiFetch<{ job: SecurityJob }>(`/security/scans/${jobId}`)
        .then((res) => {
          setJob(res.job);
          pollFailures.current = 0;
          if (res.job.status === "completed" || res.job.status === "failed") {
            stopPolling();
            // Refresh the Recent scans list so it shows the final status rather than
            // the stale "running" entry that was cached when the project was loaded.
            if (projectId) {
              apiFetch<{ jobs: SecurityJob[] }>(`/security/scans?projectId=${projectId}`)
                .then((r) => setRecent(uniqByPage(r.jobs || [])))
                .catch(() => {});
            }
          }
        })
        .catch(() => {
          pollFailures.current += 1;
          if (pollFailures.current >= 5) {
            stopPolling();
          }
        });
    }, 1500);
  };

  const stopBbPolling = () => {
    if (bbPollRef.current) {
      window.clearInterval(bbPollRef.current);
      bbPollRef.current = null;
    }
  };

  const pollBbSession = (sessionId: string) => {
    stopBbPolling();
    bbPollRef.current = window.setInterval(() => {
      apiFetch<{ session: SecurityAuthSession }>(`/security/auth-sessions/${sessionId}/status`)
        .then((res) => {
          setBbSession(res.session);
          if (["authenticated", "captured", "expired", "failed"].includes(res.session.status)) {
            stopBbPolling();
            if (projectId) loadAuthSessions(projectId);
          }
        })
        .catch(() => stopBbPolling());
    }, 2000);
  };

  const startBugBountySession = async () => {
    if (!projectId) {
      setError("Pick a project first.");
      return;
    }
    // In paste mode the user never navigates anywhere — use baseUrl as the loginUrl so the
    // session record is created without requiring a separate login URL field.
    const effectiveLoginUrl = bbInputMode === "paste" ? baseUrl.trim() : bbLoginUrl.trim();
    if (!baseUrl.trim() || !effectiveLoginUrl) {
      setError(
        bbInputMode === "paste"
          ? "Target base URL is required."
          : "Target URL and login URL are required for Bug Bounty mode."
      );
      return;
    }
    if (!bbScopeAck) {
      setError("Confirm program scope/rules before starting a Bug Bounty session.");
      return;
    }
    setError(null);
    setBbStarting(true);
    try {
      const res = await apiFetch<{ session: SecurityAuthSession }>("/security/auth-sessions/start", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          mode: "bug_bounty",
          baseUrl: baseUrl.trim(),
          loginUrl: effectiveLoginUrl,
          scopeAcknowledged: bbScopeAck,
        }),
      });
      setBbSession(res.session);
      pollBbSession(res.session.id);
    } catch (err: any) {
      setError(err?.message ?? "Failed to start Bug Bounty session");
    } finally {
      setBbStarting(false);
    }
  };

  const importPastedCookies = async () => {
    if (!bbSession) return;
    if (!bbPastedCookies.trim()) {
      setError("Paste your session cookies first.");
      return;
    }
    setError(null);
    setBbPasteImporting(true);
    try {
      const res = await apiFetch<{ session: SecurityAuthSession }>(
        `/security/auth-sessions/${bbSession.id}/import-cookies`,
        {
          method: "POST",
          body: JSON.stringify({ cookies: bbPastedCookies.trim(), baseUrl: baseUrl.trim() || undefined }),
        }
      );
      setBbSession(res.session);
      setBbPastedCookies("");
      if (projectId) loadAuthSessions(projectId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to import cookies");
    } finally {
      setBbPasteImporting(false);
    }
  };

  const refreshBugBountySession = async () => {
    if (!bbSession) return;
    setError(null);
    try {
      const res = await apiFetch<{ session: SecurityAuthSession }>(
        `/security/auth-sessions/${bbSession.id}/refresh`,
        { method: "POST" }
      );
      setBbSession(res.session);
      pollBbSession(res.session.id);
    } catch (err: any) {
      setError(err?.message ?? "Failed to refresh Bug Bounty session");
    }
  };

  const refreshEnterpriseSession = async () => {
    if (!entSession) return;
    setError(null);
    try {
      const res = await apiFetch<{ session: SecurityAuthSession }>(
        `/security/auth-sessions/${entSession.id}/refresh`,
        { method: "POST" }
      );
      setEntSession(res.session);
      if (projectId) loadAuthSessions(projectId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to refresh session");
    }
  };

  const LIVE_VIEWPORT = { width: 1280, height: 800 };

  function closeLiveView() {
    if (liveWsRef.current) {
      try {
        liveWsRef.current.close();
      } catch {}
      liveWsRef.current = null;
    }
    setLiveViewOpen(false);
    setLiveViewConnecting(false);
  }

  async function openLiveView() {
    if (!bbSession) return;
    setError(null);
    setLiveViewConnecting(true);
    try {
      const res = await apiFetch<{ ticket: string }>(`/security/auth-sessions/${bbSession.id}/stream-ticket`, {
        method: "POST",
        body: JSON.stringify({
          allowInteractiveChallengeHandling: bbAllowInteractiveChallengeHandling,
          ...(bbProxyUrl.trim() ? { proxyUrl: bbProxyUrl.trim() } : {}),
        }),
      });
      const httpBase = apiUrl(`/security/auth-sessions/${bbSession.id}/stream`);
      const wsUrl = `${httpBase.replace(/^http/, "ws")}?ticket=${encodeURIComponent(res.ticket)}`;
      const ws = new WebSocket(wsUrl);
      liveWsRef.current = ws;
      ws.onopen = () => {
        setLiveViewOpen(true);
        setLiveViewConnecting(false);
      };
      ws.onmessage = (evt) => {
        let msg: any;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        if (msg.type === "frame" && liveImgRef.current) {
          liveImgRef.current.src = `data:image/jpeg;base64,${msg.data}`;
        } else if (msg.type === "status") {
          setBbSession((prev) => (prev ? { ...prev, status: msg.status, error: msg.error ?? null } : prev));
          if (msg.status === "captured") {
            closeLiveView();
          }
        }
      };
      ws.onerror = () => {
        setError("Live session view disconnected.");
        closeLiveView();
      };
      ws.onclose = () => {
        if (liveWsRef.current === ws) liveWsRef.current = null;
        setLiveViewOpen(false);
        setLiveViewConnecting(false);
      };
    } catch (err: any) {
      setError(err?.message ?? "Failed to open live session view");
      setLiveViewConnecting(false);
    }
  }

  function sendLiveInput(payload: Record<string, unknown>) {
    const ws = liveWsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function liveCoords(e: { clientX: number; clientY: number; currentTarget: HTMLElement }) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * LIVE_VIEWPORT.width;
    const y = ((e.clientY - rect.top) / rect.height) * LIVE_VIEWPORT.height;
    return { x, y };
  }

  function captureLiveSession() {
    sendLiveInput({ type: "capture" });
  }

  async function startEnterpriseBypass() {
    if (!projectId) {
      setError("Pick a project first.");
      return;
    }
    if (!baseUrl.trim()) {
      setError("Base URL is required for the bypass endpoint.");
      return;
    }
    if (!entBypassSecretKey) {
      setError("Select a project secret holding the shared bypass secret.");
      return;
    }
    setError(null);
    setEntStarting(true);
    let sessionId: string | null = null;
    try {
      const startRes = await apiFetch<{ session: SecurityAuthSession }>("/security/auth-sessions/start", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          mode: "enterprise",
          provider: "bypass",
          baseUrl: baseUrl.trim(),
          role: entRole.trim() || undefined,
          bypassSecretKey: entBypassSecretKey,
          scopeAcknowledged: true,
        }),
      });
      sessionId = startRes.session.id;
      setEntSession(startRes.session);
      const authRes = await apiFetch<{ session: SecurityAuthSession }>(
        `/security/auth-sessions/${sessionId}/bypass-authenticate`,
        { method: "POST" }
      );
      setEntSession(authRes.session);
      loadAuthSessions(projectId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to authenticate via bypass endpoint");
      if (sessionId) {
        apiFetch<{ session: SecurityAuthSession }>(`/security/auth-sessions/${sessionId}/status`)
          .then((res) => setEntSession(res.session))
          .catch(() => {});
        loadAuthSessions(projectId);
      }
    } finally {
      setEntStarting(false);
    }
  }

  async function startProviderAuth(
    provider: "auth0" | "firebase" | "cognito" | "clerk",
    providerConfig: Record<string, string | undefined>,
    passwordSecretKey: string,
    clientSecretKey?: string
  ) {
    if (!projectId) {
      setError("Pick a project first.");
      return;
    }
    if (!passwordSecretKey) {
      setError("Select a project secret holding the test account password.");
      return;
    }
    setError(null);
    setEntStarting(true);
    let sessionId: string | null = null;
    try {
      const startRes = await apiFetch<{ session: SecurityAuthSession }>("/security/auth-sessions/start", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          mode: "enterprise",
          provider,
          role: entRole.trim() || undefined,
          providerConfig,
          providerPasswordSecretKey: passwordSecretKey,
          providerClientSecretKey: clientSecretKey || undefined,
          scopeAcknowledged: true,
        }),
      });
      sessionId = startRes.session.id;
      setEntSession(startRes.session);
      const authRes = await apiFetch<{ session: SecurityAuthSession }>(
        `/security/auth-sessions/${sessionId}/provider-authenticate`,
        { method: "POST" }
      );
      setEntSession(authRes.session);
      loadAuthSessions(projectId);
    } catch (err: any) {
      setError(err?.message ?? `Failed to authenticate via ${provider}`);
      if (sessionId) {
        apiFetch<{ session: SecurityAuthSession }>(`/security/auth-sessions/${sessionId}/status`)
          .then((res) => setEntSession(res.session))
          .catch(() => {});
        loadAuthSessions(projectId);
      }
    } finally {
      setEntStarting(false);
    }
  }

  function startAuth0Auth() {
    if (!auth0Domain.trim() || !auth0ClientId.trim() || !auth0Username.trim()) {
      setError("Auth0 domain, client ID, and username are required.");
      return;
    }
    startProviderAuth(
      "auth0",
      {
        domain: auth0Domain.trim(),
        clientId: auth0ClientId.trim(),
        audience: auth0Audience.trim() || undefined,
        username: auth0Username.trim(),
      },
      auth0PasswordSecretKey,
      auth0ClientSecretKey || undefined
    );
  }

  function startFirebaseAuth() {
    if (!fbApiKey.trim() || !fbEmail.trim()) {
      setError("Firebase API key and email are required.");
      return;
    }
    startProviderAuth("firebase", { apiKey: fbApiKey.trim(), username: fbEmail.trim() }, fbPasswordSecretKey);
  }

  function startCognitoAuth() {
    if (!cogRegion.trim() || !cogClientId.trim() || !cogUsername.trim()) {
      setError("Cognito region, client ID, and username are required.");
      return;
    }
    startProviderAuth(
      "cognito",
      { region: cogRegion.trim(), clientId: cogClientId.trim(), username: cogUsername.trim() },
      cogPasswordSecretKey,
      cogClientSecretKey || undefined
    );
  }

  function startClerkAuth() {
    if (!clerkFrontendApiUrl.trim() || !clerkIdentifier.trim()) {
      setError("Clerk Frontend API URL and identifier (email/username) are required.");
      return;
    }
    startProviderAuth(
      "clerk",
      {
        frontendApiUrl: clerkFrontendApiUrl.trim(),
        username: clerkIdentifier.trim(),
        origin: clerkOrigin.trim() || undefined,
      },
      clerkPasswordSecretKey
    );
  }

  const applyRiskMode = (mode: (typeof RISK_MODES)[number]["value"]) => {
    const config = RISK_MODES.find((m) => m.value === mode);
    if (!config) return;
    setRiskMode(mode);
    setSafeMode(config.safeMode);
    setEnableActive(config.enableActive);
    if (mode === "deep") setScanDepth("deep");
  };

  const applyScanIntent = (intent: (typeof SCAN_INTENTS)[number]["value"]) => {
    const config = SCAN_INTENTS.find((i) => i.value === intent);
    if (!config) return;
    setScanIntent(intent);
    setOwaspCategories([...config.categories]);
    setSetupDirty(true);
  };

  const toggleOwaspCategory = (category: string) => {
    setOwaspCategories((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    );
    setSetupDirty(true);
  };

  const syncAuthProfiles = (next: AuthProfileConfig[]) => {
    setAuthProfiles(next);
    setAuthProfilesJson(prettyJson(next));
    setSetupDirty(true);
  };

  const syncApiFixtures = (next: ApiFixtureConfig[]) => {
    setApiFixtures(next);
    setApiFixturesJson(prettyJson(next));
    setSetupDirty(true);
  };

  const addAuthProfile = () => {
    const defaultSecret = secrets[0]?.key || "";
    syncAuthProfiles([
      ...authProfiles,
      {
        label: `Account ${authProfiles.length + 1}`,
        role: "user",
        type: defaultSecret ? "bearer" : "none",
        tokenSecretKey: defaultSecret || undefined,
      },
    ]);
  };

  const updateAuthProfile = (index: number, patch: Partial<AuthProfileConfig>) => {
    const previousLabel = authProfiles[index]?.label;
    const next = authProfiles.map((profile, currentIndex) => {
      if (currentIndex !== index) return profile;
      const updated = { ...profile, ...patch };
      if (patch.type === "bearer" && !updated.tokenSecretKey && secrets[0]?.key) {
        updated.tokenSecretKey = secrets[0].key;
      }
      if (patch.type === "cookie" && !updated.cookieValueSecretKey && secrets[0]?.key) {
        updated.cookieValueSecretKey = secrets[0].key;
      }
      if (patch.type === "cookie" && !updated.cookieName) {
        updated.cookieName = "session";
      }
      if (patch.type === "basic" && !updated.passwordSecretKey && secrets[0]?.key) {
        updated.passwordSecretKey = secrets[0].key;
      }
      return updated;
    });
    syncAuthProfiles(next);

    if (patch.label !== undefined && previousLabel && previousLabel !== patch.label) {
      const relabeledFixtures = apiFixtures.map((fixture) => ({
        ...fixture,
        ownerProfile: fixture.ownerProfile === previousLabel ? patch.label : fixture.ownerProfile,
        otherProfile: fixture.otherProfile === previousLabel ? patch.label : fixture.otherProfile,
        adminProfile: fixture.adminProfile === previousLabel ? patch.label : fixture.adminProfile,
        lowPrivilegeProfile:
          fixture.lowPrivilegeProfile === previousLabel ? patch.label : fixture.lowPrivilegeProfile,
      }));
      setApiFixtures(relabeledFixtures);
      setApiFixturesJson(prettyJson(relabeledFixtures));
    }
  };

  const removeAuthProfile = (index: number) => {
    const removedLabel = authProfiles[index]?.label;
    syncAuthProfiles(authProfiles.filter((_, currentIndex) => currentIndex !== index));
    if (removedLabel) {
      const nextFixtures = apiFixtures.map((fixture) => ({
        ...fixture,
        ownerProfile: fixture.ownerProfile === removedLabel ? undefined : fixture.ownerProfile,
        otherProfile: fixture.otherProfile === removedLabel ? undefined : fixture.otherProfile,
        adminProfile: fixture.adminProfile === removedLabel ? undefined : fixture.adminProfile,
        lowPrivilegeProfile:
          fixture.lowPrivilegeProfile === removedLabel ? undefined : fixture.lowPrivilegeProfile,
      }));
      setApiFixtures(nextFixtures);
      setApiFixturesJson(prettyJson(nextFixtures));
    }
  };

  const addApiFixture = () => {
    syncApiFixtures([
      ...apiFixtures,
      {
        name: `Protected object ${apiFixtures.length + 1}`,
        method: "GET",
        route: "/api/resource/:id",
        ownerProfile: profileLabels[0],
        otherProfile: profileLabels[1],
        ownerObjectId: "owner-id",
        otherObjectId: "other-id",
        expectedDenyStatuses: [401, 403, 404],
        expectedControls: ["auth_required", "object_owner_required"],
        forbiddenFields: [],
      },
    ]);
  };

  const hydrateSuggestedFixture = (suggestion: ApiFixtureSuggestion): ApiFixtureConfig => ({
    name: suggestion.name,
    method: suggestion.method || "GET",
    route: suggestion.route,
    ownerProfile: suggestion.ownerProfile || profileLabels[0],
    otherProfile: suggestion.otherProfile || profileLabels[1],
    lowPrivilegeProfile: suggestion.lowPrivilegeProfile,
    adminProfile: suggestion.adminProfile || profileLabels.find((label) => /admin/i.test(label)),
    ownerObjectId: suggestion.ownerObjectId,
    otherObjectId: suggestion.otherObjectId,
    expectedDenyStatuses: suggestion.expectedDenyStatuses || [401, 403, 404],
    expectedControls: suggestion.expectedControls,
    forbiddenFields: suggestion.forbiddenFields,
  });

  const addSuggestedFixture = (suggestion: ApiFixtureSuggestion) => {
    if (configuredFixtureKeys.has(apiFixtureKey(suggestion))) return;
    syncApiFixtures([...apiFixtures, hydrateSuggestedFixture(suggestion)]);
  };

  const addAllSuggestedFixtures = () => {
    const additions = contractSuggestions
      .filter((suggestion) => !configuredFixtureKeys.has(apiFixtureKey(suggestion)))
      .map(hydrateSuggestedFixture);
    if (!additions.length) return;
    syncApiFixtures([...apiFixtures, ...additions]);
  };

  const loadContractSuggestions = async () => {
    if (!projectId) {
      setError("Pick a project first.");
      return;
    }
    if (!baseUrl.trim()) {
      setError("Base URL is required before suggesting contracts.");
      return;
    }
    setError(null);
    setSuggestionsLoading(true);
    try {
      const allowedControlSet = new Set<string>(SECURITY_CONTROLS);
      const res = await apiFetch<{
        suggestions: ApiFixtureSuggestion[];
        inventory: { routes: number; sources: Record<string, number> };
      }>(`/projects/${projectId}/security-contract-suggestions`, {
        method: "POST",
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          allowedHosts: splitList(allowedHosts),
          allowedPorts: parseStatusList(allowedPorts) || [],
          scanDepth,
          expectedControls: splitList(expectedControls).filter((control) =>
            allowedControlSet.has(control)
          ),
        }),
      });
      setContractSuggestions(res.suggestions || []);
      setSuggestionInventory(res.inventory || null);
    } catch (err: any) {
      setError(err?.message ?? "Failed to suggest security contracts");
    } finally {
      setSuggestionsLoading(false);
    }
  };

  const updateApiFixture = (index: number, patch: Partial<ApiFixtureConfig>) => {
    syncApiFixtures(
      apiFixtures.map((fixture, currentIndex) =>
        currentIndex === index ? { ...fixture, ...patch } : fixture
      )
    );
  };

  const removeApiFixture = (index: number) => {
    syncApiFixtures(apiFixtures.filter((_, currentIndex) => currentIndex !== index));
  };

  const toggleFixtureControl = (index: number, control: string) => {
    const fixture = apiFixtures[index];
    if (!fixture) return;
    const current = fixture.expectedControls || [];
    const expectedControls = current.includes(control)
      ? current.filter((item) => item !== control)
      : [...current, control];
    updateApiFixture(index, { expectedControls });
  };

  const renderProfileSelect = (
    value: string | undefined,
    onValueChange: (value: string) => void,
    placeholder: string
  ) => (
    <Select value={value || ""} onValueChange={onValueChange}>
      <SelectTrigger className="bg-white">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {profileLabels.map((label) => (
          <SelectItem key={label} value={label}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const parseSetupEditors = () => {
    const normalizedAuthProfiles = authProfiles
      .filter((profile) => profile.label.trim())
      .map(normalizeAuthProfile);
    const normalizedApiFixtures = apiFixtures
      .filter((fixture) => fixture.route.trim())
      .map(normalizeApiFixture);
    return {
      authProfiles: normalizedAuthProfiles,
      apiFixtures: normalizedApiFixtures,
      expectedControls: splitList(expectedControls),
      owaspCategories,
      complianceFrameworks,
    };
  };

  const saveSecuritySetup = async () => {
    if (!projectId) {
      setError("Pick a project first.");
      return;
    }
    setError(null);
    let setup: ReturnType<typeof parseSetupEditors>;
    try {
      setup = parseSetupEditors();
    } catch (err: any) {
      setError(err?.message ?? "Invalid security test setup JSON.");
      return;
    }
    setSetupSaving(true);
    try {
      const res = await apiFetch<{ setup: SecurityTestSetup }>(
        `/projects/${projectId}/security-setup`,
        {
          method: "PUT",
          body: JSON.stringify(setup),
        }
      );
      setAuthProfiles(res.setup.authProfiles || []);
      setApiFixtures(res.setup.apiFixtures || []);
      setAuthProfilesJson(prettyJson(res.setup.authProfiles || []));
      setApiFixturesJson(prettyJson(res.setup.apiFixtures || []));
      setExpectedControls(
        res.setup.expectedControls?.length
          ? res.setup.expectedControls.join(",")
          : DEFAULT_EXPECTED_CONTROLS
      );
      setOwaspCategories(res.setup.owaspCategories || []);
      setSetupDirty(false);
    } catch (err: any) {
      setError(err?.message ?? "Failed to save security test setup");
    } finally {
      setSetupSaving(false);
    }
  };

  const startScan = async () => {
    if (!projectId) {
      setError("Pick a project first.");
      return;
    }
    if (!baseUrl.trim()) {
      setError("Base URL is required.");
      return;
    }
    if (useSavedSetup && setupDirty) {
      setError("Save the security test setup first, or turn off saved setup for this one scan.");
      return;
    }
    let setup = {
      authProfiles: [] as any[],
      apiFixtures: [] as any[],
      expectedControls: [] as string[],
      owaspCategories: [] as string[],
      complianceFrameworks,
    };
    try {
      if (!useSavedSetup) setup = parseSetupEditors();
      else {
        setup = {
          authProfiles,
          apiFixtures,
          expectedControls: splitList(expectedControls),
          owaspCategories,
          complianceFrameworks,
        };
      }
    } catch (err: any) {
      setError(err?.message ?? "Invalid security test JSON.");
      return;
    }
    setError(null);
    setOperatorRequest(null);

    const scanContext = {
      projectId,
      baseUrl: baseUrl.trim(),
      authSessionId: selectedAuthSessionId || undefined,
      apiSpecId: selectedApiSpecId || undefined,
      allowedHosts: allowedHosts
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean),
      allowedPorts: allowedPorts
        .split(",")
        .map((p) => parseInt(p.trim(), 10))
        .filter((n) => !Number.isNaN(n)),
      maxDurationMinutes: maxDuration,
      enableActive,
      environment,
      scanDepth,
      safeMode,
      authProfiles: setup.authProfiles,
      apiFixtures: setup.apiFixtures,
      expectedControls: setup.expectedControls,
      owaspCategories: setup.owaspCategories,
      complianceFrameworks: setup.complianceFrameworks,
    };

    try {
      if (needsOperatorApproval) {
        const res = await apiFetch<{ job: OperatorJobRef }>("/operator/jobs", {
          method: "POST",
          body: JSON.stringify({
            projectId,
            type: "security",
            objective: `Security validation approval for ${baseUrl.trim()}`,
            context: scanContext,
          }),
        });
        setOperatorRequest(res.job);
        return;
      }

      const res = await apiFetch<{ job: SecurityJob }>("/security/scans", {
        method: "POST",
        body: JSON.stringify({
          ...scanContext,
          useSavedSetup,
        }),
      });
      setJob(res.job);
      pollJob(res.job.id);
      // refresh list
      apiFetch<{ jobs: SecurityJob[] }>(`/security/scans?projectId=${projectId}`)
        .then((r) => setRecent(uniqByPage(r.jobs || [])))
        .catch(() => {});
    } catch (err: any) {
      setError(err?.message ?? "Failed to start security scan");
    }
  };

  const approveBaseline = async () => {
    if (!job?.id) return;
    setBaselineApproving(true);
    setError(null);
    try {
      const res = await apiFetch<{ job: SecurityJob }>(
        `/security/scans/${job.id}/approve-baseline`,
        { method: "POST" }
      );
      setJob(res.job);
      if (projectId) {
        apiFetch<{ jobs: SecurityJob[] }>(`/security/scans?projectId=${projectId}`)
          .then((r) => setRecent(uniqByPage(r.jobs || [])))
          .catch(() => {});
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to approve security baseline");
    } finally {
      setBaselineApproving(false);
    }
  };

  // stop polling when job reaches a terminal state
  useEffect(() => {
    if (job && (job.status === "completed" || job.status === "failed")) {
      stopPolling();
    }
  }, [job]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Security</p>
          <h1 className="text-2xl font-semibold text-slate-900">Intelligent security validation</h1>
          <p className="text-sm text-slate-600">
            Validate OWASP controls, API authorization, auth boundaries, and response anomalies with authorized fixtures.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-slate-800">Authentication mode</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <button
              type="button"
              onClick={() => setAuthMode("enterprise")}
              className={`text-left rounded-md border p-4 transition ${
                authMode === "enterprise" ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <div className="flex items-center gap-2 font-semibold text-slate-900">
                <Building2 className="h-4 w-4 text-blue-600" />
                Enterprise / My Application
              </div>
              <p className="mt-1 text-xs text-slate-600">
                Use test accounts, provider integration, stored token, or safe bypass.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setAuthMode("bug_bounty")}
              className={`text-left rounded-md border p-4 transition ${
                authMode === "bug_bounty" ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <div className="flex items-center gap-2 font-semibold text-slate-900">
                <Bug className="h-4 w-4 text-amber-600" />
                Bug Bounty / External Target
              </div>
              <p className="mt-1 text-xs text-slate-600">
                Open browser login, complete MFA manually, then scan using that session.
              </p>
            </button>
          </div>

          {authMode === "bug_bounty" && (
            <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4">
              <div className="text-sm font-semibold text-amber-800">Bug Bounty session capture</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setBbInputMode("live")}
                  className={`rounded-md border px-3 py-1 text-xs font-medium ${
                    bbInputMode === "live"
                      ? "border-amber-500 bg-amber-100 text-amber-900"
                      : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
                  }`}
                >
                  Live browser capture
                </button>
                <button
                  type="button"
                  onClick={() => setBbInputMode("paste")}
                  className={`rounded-md border px-3 py-1 text-xs font-medium ${
                    bbInputMode === "paste"
                      ? "border-amber-500 bg-amber-100 text-amber-900"
                      : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
                  }`}
                >
                  Paste cookies from browser
                </button>
              </div>

              {bbInputMode === "paste" && (
                <div className="space-y-3">
                  <p className="text-xs text-amber-800">
                    If the target blocks automated browsers (Cloudflare Bot Management, etc.), log in manually
                    in your real browser, copy your session cookies from DevTools, and paste them here.
                    <br />
                    <strong>How to copy:</strong> F12 → Application → Cookies → select your target domain → copy the
                    Name=Value pairs, or open the Network tab, click any request, and copy the full Cookie header.
                  </p>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700">Target base URL (for cookie scoping)</label>
                    <Input
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="https://app.chime.com"
                      className="bg-white"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700">Session cookies</label>
                    <textarea
                      value={bbPastedCookies}
                      onChange={(e) => setBbPastedCookies(e.target.value)}
                      placeholder="session_id=abc123; csrf_token=xyz; ..."
                      rows={4}
                      className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400"
                    />
                    <p className="text-xs text-slate-500">
                      Paste the raw Cookie header value — multiple cookies separated by semicolons.
                    </p>
                  </div>
                  {!bbSession && (
                    <Button
                      type="button"
                      onClick={startBugBountySession}
                      disabled={bbStarting || !bbScopeAck}
                      className="bg-amber-600 text-white hover:bg-amber-700"
                    >
                      {bbStarting ? "Creating session..." : "Create session record"}
                    </Button>
                  )}
                  {bbSession && (
                    <Button
                      type="button"
                      onClick={importPastedCookies}
                      disabled={bbPasteImporting || !bbPastedCookies.trim()}
                      className="bg-amber-600 text-white hover:bg-amber-700"
                    >
                      {bbPasteImporting ? "Importing..." : "Import cookies → capture session"}
                    </Button>
                  )}
                  <label className="flex items-start gap-2 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={bbScopeAck}
                      onChange={(e) => setBbScopeAck(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>I confirm this target is in-scope for my bug bounty program and I'm authorized to test it.</span>
                  </label>
                  {bbSession && (
                    <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
                      <div className="font-semibold uppercase tracking-wide text-slate-500">Session status</div>
                      <div className="mt-1">{BB_STATUS_LABEL[bbSession.status] ?? bbSession.status}</div>
                      {bbSession.error && <div className="mt-1 text-rose-600">{bbSession.error}</div>}
                    </div>
                  )}
                </div>
              )}

              {bbInputMode === "live" && (
              <>
              <p className="text-xs text-amber-800">
                Starts a real, server-side browser pointed at the login URL below. Open the live view to log in
                (including MFA) yourself — once you're authenticated, the session is captured automatically and
                reused for the scan.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">Login URL</label>
                  <Input
                    value={bbLoginUrl}
                    onChange={(e) => setBbLoginUrl(e.target.value)}
                    placeholder="https://target.com/login"
                    className="bg-white"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-700">Target base URL</label>
                  <Input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://target.com"
                    className="bg-white"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-700">
                  Outbound proxy <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <Input
                  value={bbProxyUrl}
                  onChange={(e) => setBbProxyUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8080"
                  className="bg-white"
                />
                <p className="text-xs text-slate-500">
                  Route the live browser through a proxy — useful when the target blocks
                  server/datacenter IPs but allows your local machine's IP. Point this at your
                  local Burp listener (http://127.0.0.1:8080) or a residential proxy service.
                </p>
              </div>
              <label className="flex items-start gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={bbScopeAck}
                  onChange={(e) => setBbScopeAck(e.target.checked)}
                  className="mt-0.5"
                />
                <span>I confirm this target is in-scope for my bug bounty program and I'm authorized to test it.</span>
              </label>
              <label className="flex items-start gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={bbAllowInteractiveChallengeHandling}
                  onChange={(e) => setBbAllowInteractiveChallengeHandling(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Allow interactive challenge handling in the live view (sends IP-trust headers such as
                  X-Forwarded-For, to test IP-reputation misconfigurations). Only use this if testing IP-trust
                  handling is explicitly in scope for your engagement.
                </span>
              </label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  onClick={startBugBountySession}
                  disabled={bbStarting}
                  className="bg-amber-600 text-white hover:bg-amber-700"
                >
                  {bbStarting ? "Starting..." : "Start session capture"}
                </Button>
                {bbSession && (bbSession.status === "expired" || bbSession.status === "failed") && (
                  <Button type="button" variant="outline" onClick={refreshBugBountySession}>
                    <RefreshCw className="mr-1 h-4 w-4" /> Re-authenticate
                  </Button>
                )}
                {bbSession && !["captured", "authenticated"].includes(bbSession.status) && !liveViewOpen && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={openLiveView}
                    disabled={liveViewConnecting}
                  >
                    {liveViewConnecting ? "Connecting..." : "Watch live & log in"}
                  </Button>
                )}
                {liveViewOpen && (
                  <Button type="button" variant="outline" onClick={closeLiveView}>
                    Close live view
                  </Button>
                )}
              </div>
              {bbSession && (
                <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
                  <div className="font-semibold uppercase tracking-wide text-slate-500">Session status</div>
                  <div className="mt-1">{BB_STATUS_LABEL[bbSession.status] ?? bbSession.status}</div>
                  {bbSession.error && <div className="mt-1 text-rose-600">{bbSession.error}</div>}
                </div>
              )}
              {liveViewOpen && (
                <div className="space-y-2 rounded border border-amber-300 bg-black/5 p-3">
                  <p className="text-xs text-amber-800">
                    Log in (and complete MFA) inside this live view. Click into it first, then type and click as
                    normal. When you're authenticated, click "I'm logged in" to capture the session.
                  </p>
                  <div
                    className="relative w-full overflow-hidden rounded border border-slate-300 bg-slate-900"
                    style={{ aspectRatio: `${LIVE_VIEWPORT.width} / ${LIVE_VIEWPORT.height}` }}
                    tabIndex={0}
                    onMouseMove={(e) => sendLiveInput({ type: "mouse", event: "move", ...liveCoords(e) })}
                    onMouseDown={(e) => sendLiveInput({ type: "mouse", event: "down", ...liveCoords(e) })}
                    onMouseUp={(e) => sendLiveInput({ type: "mouse", event: "up", ...liveCoords(e) })}
                    onWheel={(e) =>
                      sendLiveInput({ type: "mouse", event: "wheel", ...liveCoords(e), deltaX: e.deltaX, deltaY: e.deltaY })
                    }
                    onKeyDown={(e) => {
                      if (["Tab"].includes(e.key)) e.preventDefault();
                      sendLiveInput({ type: "key", event: "down", key: e.key });
                    }}
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    <img
                      ref={liveImgRef}
                      alt="Live session view"
                      draggable={false}
                      className="h-full w-full select-none"
                    />
                  </div>
                  <Button type="button" onClick={captureLiveSession} className="bg-emerald-600 text-white hover:bg-emerald-700">
                    I'm logged in — capture session
                  </Button>
                </div>
              )}
              </>
              )}
            </div>
          )}

          {authMode === "enterprise" && (
            <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-700">Authentication method</label>
                <Select value={entMethod} onValueChange={(v) => setEntMethod(v as typeof entMethod)}>
                  <SelectTrigger className="bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bypass">Test-only bypass endpoint</SelectItem>
                    <SelectItem value="auth0">Auth0 (test account)</SelectItem>
                    <SelectItem value="firebase">Firebase Authentication (test account)</SelectItem>
                    <SelectItem value="cognito">AWS Cognito (test account)</SelectItem>
                    <SelectItem value="clerk">Clerk (test account)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {entMethod === "bypass" && (
                <>
                  <p className="text-xs text-blue-800">
                    Calls a <code>POST /testmind/auth/session</code> endpoint your app implements for
                    non-production environments only (guarded by <code>TESTMIND_AUTH_BYPASS_ENABLED</code> + a
                    shared secret). On success, the returned session cookie is captured and reused for the scan —
                    no browser automation or real credentials needed.
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Target base URL</label>
                      <Input
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder="https://staging.myapp.com"
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Role to request</label>
                      <Input
                        value={entRole}
                        onChange={(e) => setEntRole(e.target.value)}
                        placeholder="admin"
                        className="bg-white"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700">Shared secret (project secret)</label>
                    <Select value={entBypassSecretKey} onValueChange={setEntBypassSecretKey}>
                      <SelectTrigger className="bg-white" disabled={!secrets.length}>
                        <SelectValue placeholder={secrets.length ? "Select secret" : "No secrets — add one first"} />
                      </SelectTrigger>
                      <SelectContent>
                        {secrets.map((secret) => (
                          <SelectItem key={secret.id} value={secret.key}>
                            {secret.key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      Must match the secret value your app checks against <code>TESTMIND_SHARED_SECRET</code> for
                      the bypass endpoint. Manage project secrets on the Integrations page.
                    </p>
                  </div>
                  <Button
                    type="button"
                    onClick={startEnterpriseBypass}
                    disabled={entStarting}
                    className="bg-blue-600 text-white hover:bg-blue-700"
                  >
                    {entStarting ? "Authenticating..." : "Authenticate via bypass endpoint"}
                  </Button>
                </>
              )}

              {entMethod === "auth0" && (
                <>
                  <p className="text-xs text-blue-800">
                    Signs in a test account directly against Auth0's token endpoint (Resource Owner Password
                    Grant) — no bypass endpoint or browser automation needed. Returns a real access token used as
                    a Bearer credential for the scan.
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Auth0 domain</label>
                      <Input
                        value={auth0Domain}
                        onChange={(e) => setAuth0Domain(e.target.value)}
                        placeholder="your-tenant.us.auth0.com"
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Client ID</label>
                      <Input
                        value={auth0ClientId}
                        onChange={(e) => setAuth0ClientId(e.target.value)}
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Audience (optional)</label>
                      <Input
                        value={auth0Audience}
                        onChange={(e) => setAuth0Audience(e.target.value)}
                        placeholder="https://your-api-identifier"
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Test account username/email</label>
                      <Input
                        value={auth0Username}
                        onChange={(e) => setAuth0Username(e.target.value)}
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Role to request (label only)</label>
                      <Input
                        value={entRole}
                        onChange={(e) => setEntRole(e.target.value)}
                        placeholder="admin"
                        className="bg-white"
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Password (project secret)</label>
                      <Select value={auth0PasswordSecretKey} onValueChange={setAuth0PasswordSecretKey}>
                        <SelectTrigger className="bg-white" disabled={!secrets.length}>
                          <SelectValue placeholder={secrets.length ? "Select secret" : "No secrets"} />
                        </SelectTrigger>
                        <SelectContent>
                          {secrets.map((secret) => (
                            <SelectItem key={secret.id} value={secret.key}>
                              {secret.key}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">
                        Client secret (optional, confidential clients only)
                      </label>
                      <Select value={auth0ClientSecretKey} onValueChange={setAuth0ClientSecretKey}>
                        <SelectTrigger className="bg-white" disabled={!secrets.length}>
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                          {secrets.map((secret) => (
                            <SelectItem key={secret.id} value={secret.key}>
                              {secret.key}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Button
                    type="button"
                    onClick={startAuth0Auth}
                    disabled={entStarting}
                    className="bg-blue-600 text-white hover:bg-blue-700"
                  >
                    {entStarting ? "Authenticating..." : "Authenticate via Auth0"}
                  </Button>
                </>
              )}

              {entMethod === "firebase" && (
                <>
                  <p className="text-xs text-blue-800">
                    Signs in a test account directly against Firebase Authentication's REST API — returns a real
                    ID token used as a Bearer credential for the scan.
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Firebase Web API key</label>
                      <Input value={fbApiKey} onChange={(e) => setFbApiKey(e.target.value)} className="bg-white" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Test account email</label>
                      <Input value={fbEmail} onChange={(e) => setFbEmail(e.target.value)} className="bg-white" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Role to request (label only)</label>
                      <Input
                        value={entRole}
                        onChange={(e) => setEntRole(e.target.value)}
                        placeholder="admin"
                        className="bg-white"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700">Password (project secret)</label>
                    <Select value={fbPasswordSecretKey} onValueChange={setFbPasswordSecretKey}>
                      <SelectTrigger className="bg-white" disabled={!secrets.length}>
                        <SelectValue placeholder={secrets.length ? "Select secret" : "No secrets"} />
                      </SelectTrigger>
                      <SelectContent>
                        {secrets.map((secret) => (
                          <SelectItem key={secret.id} value={secret.key}>
                            {secret.key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    onClick={startFirebaseAuth}
                    disabled={entStarting}
                    className="bg-blue-600 text-white hover:bg-blue-700"
                  >
                    {entStarting ? "Authenticating..." : "Authenticate via Firebase"}
                  </Button>
                </>
              )}

              {entMethod === "cognito" && (
                <>
                  <p className="text-xs text-blue-800">
                    Signs in a test account directly against an AWS Cognito user pool (InitiateAuth,
                    USER_PASSWORD_AUTH) — returns a real ID token used as a Bearer credential for the scan. The
                    test account must not require MFA or a forced password change.
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">AWS region</label>
                      <Input
                        value={cogRegion}
                        onChange={(e) => setCogRegion(e.target.value)}
                        placeholder="us-east-1"
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">App client ID</label>
                      <Input value={cogClientId} onChange={(e) => setCogClientId(e.target.value)} className="bg-white" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Test account username</label>
                      <Input value={cogUsername} onChange={(e) => setCogUsername(e.target.value)} className="bg-white" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Role to request (label only)</label>
                      <Input
                        value={entRole}
                        onChange={(e) => setEntRole(e.target.value)}
                        placeholder="admin"
                        className="bg-white"
                      />
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Password (project secret)</label>
                      <Select value={cogPasswordSecretKey} onValueChange={setCogPasswordSecretKey}>
                        <SelectTrigger className="bg-white" disabled={!secrets.length}>
                          <SelectValue placeholder={secrets.length ? "Select secret" : "No secrets"} />
                        </SelectTrigger>
                        <SelectContent>
                          {secrets.map((secret) => (
                            <SelectItem key={secret.id} value={secret.key}>
                              {secret.key}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">
                        App client secret (optional, if the client is configured with one)
                      </label>
                      <Select value={cogClientSecretKey} onValueChange={setCogClientSecretKey}>
                        <SelectTrigger className="bg-white" disabled={!secrets.length}>
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                          {secrets.map((secret) => (
                            <SelectItem key={secret.id} value={secret.key}>
                              {secret.key}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Button
                    type="button"
                    onClick={startCognitoAuth}
                    disabled={entStarting}
                    className="bg-blue-600 text-white hover:bg-blue-700"
                  >
                    {entStarting ? "Authenticating..." : "Authenticate via Cognito"}
                  </Button>
                </>
              )}

              {entMethod === "clerk" && (
                <>
                  <p className="text-xs text-blue-800">
                    Signs in a test account against Clerk's Frontend API (the same one clerk-js uses) — creates a
                    sign-in attempt, submits the password as the first factor, then mints a session token. Only
                    single-factor test accounts (no MFA) are supported.
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Clerk Frontend API URL</label>
                      <Input
                        value={clerkFrontendApiUrl}
                        onChange={(e) => setClerkFrontendApiUrl(e.target.value)}
                        placeholder="https://clerk.yourapp.com"
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Origin header (optional)</label>
                      <Input
                        value={clerkOrigin}
                        onChange={(e) => setClerkOrigin(e.target.value)}
                        placeholder="https://yourapp.com"
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Test account email/username</label>
                      <Input
                        value={clerkIdentifier}
                        onChange={(e) => setClerkIdentifier(e.target.value)}
                        className="bg-white"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-700">Role to request (label only)</label>
                      <Input
                        value={entRole}
                        onChange={(e) => setEntRole(e.target.value)}
                        placeholder="admin"
                        className="bg-white"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-700">Password (project secret)</label>
                    <Select value={clerkPasswordSecretKey} onValueChange={setClerkPasswordSecretKey}>
                      <SelectTrigger className="bg-white" disabled={!secrets.length}>
                        <SelectValue placeholder={secrets.length ? "Select secret" : "No secrets"} />
                      </SelectTrigger>
                      <SelectContent>
                        {secrets.map((secret) => (
                          <SelectItem key={secret.id} value={secret.key}>
                            {secret.key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    onClick={startClerkAuth}
                    disabled={entStarting}
                    className="bg-blue-600 text-white hover:bg-blue-700"
                  >
                    {entStarting ? "Authenticating..." : "Authenticate via Clerk"}
                  </Button>
                </>
              )}

              {entSession && (
                <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-semibold uppercase tracking-wide text-slate-500">Session status</div>
                    {(entSession.status === "expired" || entSession.status === "failed") && (
                      <Button type="button" variant="outline" size="sm" onClick={refreshEnterpriseSession}>
                        <RefreshCw className="mr-1 h-3 w-3" /> Re-authenticate
                      </Button>
                    )}
                  </div>
                  <div className="mt-1">{BB_STATUS_LABEL[entSession.status] ?? entSession.status}</div>
                  {entSession.error && <div className="mt-1 text-rose-600">{entSession.error}</div>}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-slate-800">API specification</CardTitle>
          <p className="text-sm text-slate-500">
            Import an OpenAPI / Swagger spec to unlock targeted endpoint testing — auth enforcement on every
            route, injection probing with correct parameter types, IDOR detection on ID params, and method
            tampering. This goes deeper than blind scanning.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              value={apiSpecImportUrl}
              onChange={(e) => setApiSpecImportUrl(e.target.value)}
              placeholder="https://api.yourapp.com/openapi.json"
              className="bg-white flex-1"
            />
            <Button
              type="button"
              onClick={importApiSpec}
              disabled={apiSpecImporting || !projectId}
              className="shrink-0"
            >
              {apiSpecImporting ? "Importing…" : "Import spec"}
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            Accepts OpenAPI 3.x or Swagger 2.0 (JSON). Paste directly in Configure Scan below if you have
            the JSON already.
          </p>
          {apiSpecs.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-600">Imported specs</div>
              {apiSpecs.map((spec) => (
                <div
                  key={spec.id}
                  className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2 text-xs"
                >
                  <div>
                    <span className="font-medium text-slate-800">{spec.title}</span>
                    {spec.version && <span className="ml-1 text-slate-400">v{spec.version}</span>}
                    <span className="ml-2 text-slate-500">{spec.endpointCount} endpoints</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400">{new Date(spec.createdAt).toLocaleDateString()}</span>
                    <button
                      type="button"
                      className="text-rose-500 hover:text-rose-700 text-xs"
                      onClick={() =>
                        apiFetch(`/security/api-specs/${spec.id}`, { method: "DELETE" })
                          .then(() => loadApiSpecs(projectId))
                          .catch(() => {})
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-slate-800">Configure scan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Project</label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Base URL</label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://app.yoursite.com"
                className="bg-white"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">
              Captured auth session <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <Select
              value={selectedAuthSessionId || "__none__"}
              onValueChange={(v) => setSelectedAuthSessionId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger className="bg-white">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {usableAuthSessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.mode === "bug_bounty" ? "Bug Bounty" : "Enterprise"} — {s.role || "no role"} —{" "}
                    {new Date(s.createdAt).toLocaleString()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-slate-500">
              Use a captured/authenticated session (from the Authentication mode card above) for this scan's
              requests, instead of (or in addition to) the auth profiles below.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">
              API specification <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <Select
              value={selectedApiSpecId || "__none__"}
              onValueChange={(v) => setSelectedApiSpecId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger className="bg-white">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {apiSpecs.map((spec) => (
                  <SelectItem key={spec.id} value={spec.id}>
                    {spec.title} — {spec.endpointCount} endpoints
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-slate-500">
              Select an imported OpenAPI spec to run targeted endpoint-level checks (auth enforcement,
              injection, IDOR detection) on top of the standard scan.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Allowed hosts (comma)</label>
              <Input
                value={allowedHosts}
                onChange={(e) => setAllowedHosts(e.target.value)}
                placeholder="localhost, 127.0.0.1"
                className="bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Allowed ports (comma)</label>
              <Input
                value={allowedPorts}
                onChange={(e) => setAllowedPorts(e.target.value)}
                placeholder="80,443,3000"
                className="bg-white"
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Max duration (minutes)</label>
              <Input
                type="number"
                min={1}
                max={60}
                value={maxDuration}
                onChange={(e) => setMaxDuration(parseInt(e.target.value, 10) || 10)}
                className="bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Environment</label>
              <Select value={environment} onValueChange={(v) => setEnvironment(v as typeof environment)}>
                <SelectTrigger className="bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dev">Dev</SelectItem>
                  <SelectItem value="qa">QA</SelectItem>
                  <SelectItem value="stage">Stage</SelectItem>
                  <SelectItem value="prod">Prod</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Scan depth</label>
              <Select value={scanDepth} onValueChange={(v) => setScanDepth(v as typeof scanDepth)}>
                <SelectTrigger className="bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="baseline">Baseline</SelectItem>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="deep">Deep</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Scan intent</label>
              <Select value={scanIntent} onValueChange={(v) => applyScanIntent(v as typeof scanIntent)}>
                <SelectTrigger className="bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCAN_INTENTS.map((intent) => (
                    <SelectItem key={intent.value} value={intent.value}>
                      {intent.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500">Applies a starting OWASP category set below — adjust freely after.</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Risk mode</label>
              <Select value={riskMode} onValueChange={(v) => applyRiskMode(v as typeof riskMode)}>
                <SelectTrigger className="bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RISK_MODES.map((mode) => (
                    <SelectItem key={mode.value} value={mode.value}>
                      {mode.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500">
                {RISK_MODES.find((m) => m.value === riskMode)?.description}
              </p>
            </div>
          </div>

          <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">OWASP coverage selection</div>
                <p className="text-xs text-slate-500">
                  Findings are mapped against the categories selected here. {owaspCategories.length} selected.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setOwaspCategories([...ALL_WEB_CATEGORIES, ...ALL_API_CATEGORIES]);
                    setSetupDirty(true);
                  }}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setOwaspCategories([]);
                    setSetupDirty(true);
                  }}
                >
                  Clear
                </Button>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  OWASP Web Top 10
                </div>
                <div className="flex flex-wrap gap-2">
                  {OWASP_WEB_TOP_10.map((category) => {
                    const checked = owaspCategories.includes(category.value);
                    return (
                      <label
                        key={category.value}
                        className={`inline-flex items-center gap-2 rounded border px-2 py-1 text-xs ${
                          checked
                            ? "border-blue-200 bg-blue-50 text-blue-800"
                            : "border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOwaspCategory(category.value)}
                        />
                        <span>{category.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  OWASP API Top 10
                </div>
                <div className="flex flex-wrap gap-2">
                  {OWASP_API_TOP_10.map((category) => {
                    const checked = owaspCategories.includes(category.value);
                    return (
                      <label
                        key={category.value}
                        className={`inline-flex items-center gap-2 rounded border px-2 py-1 text-xs ${
                          checked
                            ? "border-indigo-200 bg-indigo-50 text-indigo-800"
                            : "border-slate-200 bg-white text-slate-600"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOwaspCategory(category.value)}
                        />
                        <span>{category.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">Authorized test identities</div>
                {setupLoading && <div className="text-xs text-slate-500">Loading setup...</div>}
              </div>
              <Button type="button" size="sm" variant="outline" onClick={addAuthProfile}>
                <Plus className="h-4 w-4" />
                Add profile
              </Button>
            </div>

            {secrets.length > 0 && (
              <div className="flex flex-wrap gap-2 text-xs">
                {secrets.map((secret) => (
                  <span
                    key={secret.id}
                    className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-slate-700"
                  >
                    <KeyRound className="h-3 w-3" />
                    {secret.key}
                  </span>
                ))}
              </div>
            )}

            {authProfiles.length === 0 ? (
              <div className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-4 text-sm text-slate-500">
                No authorized identities configured.
              </div>
            ) : (
              <div className="space-y-3">
                {authProfiles.map((profile, index) => (
                  <div key={`${profile.label}-${index}`} className="rounded-md border border-slate-200 bg-white p-3">
                    <div className="flex items-start gap-3">
                      <div className="grid flex-1 gap-3 md:grid-cols-4">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-slate-600">Label</label>
                          <Input
                            value={profile.label}
                            onChange={(e) => updateAuthProfile(index, { label: e.target.value })}
                            className="bg-white"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-slate-600">Role</label>
                          <Input
                            value={profile.role || ""}
                            onChange={(e) => updateAuthProfile(index, { role: e.target.value })}
                            placeholder="user"
                            className="bg-white"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-slate-600">Auth type</label>
                          <Select
                            value={profile.type}
                            onValueChange={(value) =>
                              updateAuthProfile(index, {
                                type: value as AuthProfileConfig["type"],
                              })
                            }
                          >
                            <SelectTrigger className="bg-white">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              <SelectItem value="bearer">Bearer token</SelectItem>
                              <SelectItem value="cookie">Cookie</SelectItem>
                              <SelectItem value="basic">Basic auth</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {profile.type === "bearer" && (
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-slate-600">Token secret</label>
                            <Select
                              value={profile.tokenSecretKey || ""}
                              onValueChange={(value) =>
                                updateAuthProfile(index, { tokenSecretKey: value })
                              }
                            >
                              <SelectTrigger className="bg-white" disabled={!secrets.length}>
                                <SelectValue placeholder={secrets.length ? "Select secret" : "No secrets"} />
                              </SelectTrigger>
                              <SelectContent>
                                {secrets.map((secret) => (
                                  <SelectItem key={secret.id} value={secret.key}>
                                    {secret.key}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        {profile.type === "cookie" && (
                          <>
                            <div className="space-y-1">
                              <label className="text-xs font-medium text-slate-600">Cookie name</label>
                              <Input
                                value={profile.cookieName || ""}
                                onChange={(e) =>
                                  updateAuthProfile(index, { cookieName: e.target.value })
                                }
                                placeholder="session"
                                className="bg-white"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-xs font-medium text-slate-600">Cookie secret</label>
                              <Select
                                value={profile.cookieValueSecretKey || ""}
                                onValueChange={(value) =>
                                  updateAuthProfile(index, { cookieValueSecretKey: value })
                                }
                              >
                                <SelectTrigger className="bg-white" disabled={!secrets.length}>
                                  <SelectValue placeholder={secrets.length ? "Select secret" : "No secrets"} />
                                </SelectTrigger>
                                <SelectContent>
                                  {secrets.map((secret) => (
                                    <SelectItem key={secret.id} value={secret.key}>
                                      {secret.key}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </>
                        )}
                        {profile.type === "basic" && (
                          <>
                            <div className="space-y-1">
                              <label className="text-xs font-medium text-slate-600">Username</label>
                              <Input
                                value={profile.username || ""}
                                onChange={(e) =>
                                  updateAuthProfile(index, { username: e.target.value })
                                }
                                className="bg-white"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-xs font-medium text-slate-600">Password secret</label>
                              <Select
                                value={profile.passwordSecretKey || ""}
                                onValueChange={(value) =>
                                  updateAuthProfile(index, { passwordSecretKey: value })
                                }
                              >
                                <SelectTrigger className="bg-white" disabled={!secrets.length}>
                                  <SelectValue placeholder={secrets.length ? "Select secret" : "No secrets"} />
                                </SelectTrigger>
                                <SelectContent>
                                  {secrets.map((secret) => (
                                    <SelectItem key={secret.id} value={secret.key}>
                                      {secret.key}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove auth profile"
                        onClick={() => removeAuthProfile(index)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-semibold text-slate-800">Protected object contracts</div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={loadContractSuggestions}
                  disabled={suggestionsLoading || !projectId || !baseUrl.trim()}
                >
                  <ShieldCheck className="h-4 w-4" />
                  {suggestionsLoading ? "Suggesting..." : "Suggest from routes"}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={addApiFixture}>
                  <Plus className="h-4 w-4" />
                  Add contract
                </Button>
              </div>
            </div>

            {suggestionInventory && (
              <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                <span className="rounded bg-white px-2 py-1">
                  Routes inspected: {suggestionInventory.routes}
                </span>
                {Object.entries(suggestionInventory.sources).map(([source, count]) => (
                  <span key={source} className="rounded bg-white px-2 py-1">
                    {source}: {count}
                  </span>
                ))}
              </div>
            )}

            {contractSuggestions.length > 0 && (
              <div className="space-y-2 rounded-md border border-blue-100 bg-blue-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-blue-800">
                    Suggested contracts
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={addAllSuggestedFixtures}
                    disabled={contractSuggestions.every((suggestion) =>
                      configuredFixtureKeys.has(apiFixtureKey(suggestion))
                    )}
                  >
                    Add all new
                  </Button>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {contractSuggestions.map((suggestion) => {
                    const configured = configuredFixtureKeys.has(apiFixtureKey(suggestion));
                    return (
                      <div
                        key={`${suggestion.method}-${suggestion.route}`}
                        className="rounded-md border border-blue-100 bg-white p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-2">
                            <div className="text-sm font-semibold text-slate-900">
                              {(suggestion.method || "GET").toUpperCase()} {suggestion.route}
                            </div>
                            <div className="flex flex-wrap gap-1 text-xs">
                              {(suggestion.expectedControls || []).map((control) => (
                                <span
                                  key={control}
                                  className="rounded bg-blue-50 px-2 py-1 text-blue-800"
                                >
                                  {control}
                                </span>
                              ))}
                              {suggestion.objectIdRequired && (
                                <span className="rounded bg-amber-50 px-2 py-1 text-amber-800">
                                  object IDs needed
                                </span>
                              )}
                              {suggestion.source && (
                                <span className="rounded bg-slate-100 px-2 py-1 text-slate-700">
                                  {suggestion.source}
                                </span>
                              )}
                            </div>
                            {suggestion.rationale && (
                              <div className="text-xs text-slate-600">{suggestion.rationale}</div>
                            )}
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant={configured ? "ghost" : "outline"}
                            disabled={configured}
                            onClick={() => addSuggestedFixture(suggestion)}
                          >
                            {configured ? "Added" : "Add"}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {suggestionInventory && !contractSuggestions.length && !suggestionsLoading && (
              <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500">
                No new contracts suggested.
              </div>
            )}

            {apiFixtures.length === 0 ? (
              <div className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-4 text-sm text-slate-500">
                No protected object contracts configured.
              </div>
            ) : (
              <div className="space-y-3">
                {apiFixtures.map((fixture, index) => (
                  <div key={`${fixture.route}-${index}`} className="rounded-md border border-slate-200 bg-white p-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 space-y-3">
                        <div className="grid gap-3 md:grid-cols-4">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-slate-600">Name</label>
                            <Input
                              value={fixture.name || ""}
                              onChange={(e) => updateApiFixture(index, { name: e.target.value })}
                              className="bg-white"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-slate-600">Method</label>
                            <Select
                              value={fixture.method || "GET"}
                              onValueChange={(value) => updateApiFixture(index, { method: value })}
                            >
                              <SelectTrigger className="bg-white">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {HTTP_METHODS.map((method) => (
                                  <SelectItem key={method} value={method}>
                                    {method}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1 md:col-span-2">
                            <label className="text-xs font-medium text-slate-600">Route</label>
                            <Input
                              value={fixture.route}
                              onChange={(e) => updateApiFixture(index, { route: e.target.value })}
                              placeholder="/api/orders/:id"
                              className="bg-white"
                            />
                          </div>
                        </div>

                        <div className="grid gap-3 md:grid-cols-4">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-slate-600">Owner</label>
                            {renderProfileSelect(
                              fixture.ownerProfile,
                              (value) => updateApiFixture(index, { ownerProfile: value }),
                              "Owner profile"
                            )}
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-slate-600">Other account</label>
                            {renderProfileSelect(
                              fixture.otherProfile,
                              (value) => updateApiFixture(index, { otherProfile: value }),
                              "Other profile"
                            )}
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-slate-600">Low privilege</label>
                            {renderProfileSelect(
                              fixture.lowPrivilegeProfile,
                              (value) => updateApiFixture(index, { lowPrivilegeProfile: value }),
                              "Low role"
                            )}
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-slate-600">Admin</label>
                            {renderProfileSelect(
                              fixture.adminProfile,
                              (value) => updateApiFixture(index, { adminProfile: value }),
                              "Admin profile"
                            )}
                          </div>
                        </div>

                        <div className="grid gap-3 md:grid-cols-4">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-slate-600">Owner object ID</label>
                            <Input
                              value={fixture.ownerObjectId || ""}
                              onChange={(e) =>
                                updateApiFixture(index, { ownerObjectId: e.target.value })
                              }
                              className="bg-white"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-slate-600">Other object ID</label>
                            <Input
                              value={fixture.otherObjectId || ""}
                              onChange={(e) =>
                                updateApiFixture(index, { otherObjectId: e.target.value })
                              }
                              className="bg-white"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-slate-600">Deny statuses</label>
                            <Input
                              value={(fixture.expectedDenyStatuses || [401, 403, 404]).join(",")}
                              onChange={(e) =>
                                updateApiFixture(index, {
                                  expectedDenyStatuses: parseStatusList(e.target.value),
                                })
                              }
                              className="bg-white"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-slate-600">Forbidden fields</label>
                            <Input
                              value={(fixture.forbiddenFields || []).join(",")}
                              onChange={(e) =>
                                updateApiFixture(index, {
                                  forbiddenFields: parseStringList(e.target.value),
                                })
                              }
                              placeholder="adminNotes,internalCost"
                              className="bg-white"
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="text-xs font-medium text-slate-600">Expected controls</div>
                          <div className="flex flex-wrap gap-2">
                            {SECURITY_CONTROLS.map((control) => {
                              const checked = (fixture.expectedControls || []).includes(control);
                              return (
                                <label
                                  key={control}
                                  className={`inline-flex items-center gap-2 rounded border px-2 py-1 text-xs ${
                                    checked
                                      ? "border-blue-200 bg-blue-50 text-blue-800"
                                      : "border-slate-200 bg-white text-slate-600"
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => toggleFixtureControl(index, control)}
                                  />
                                  <span>{control}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove API contract"
                        onClick={() => removeApiFixture(index)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowSetupJson((visible) => !visible)}
            >
              <Code2 className="h-4 w-4" />
              {showSetupJson ? "Hide JSON preview" : "Show JSON preview"}
            </Button>
          </div>

          {showSetupJson && (
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Auth profiles JSON preview</label>
                <Textarea
                  value={authProfilesJson}
                  readOnly
                  rows={8}
                  className="bg-white font-mono text-xs"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">API fixtures JSON preview</label>
                <Textarea
                  value={apiFixturesJson}
                  readOnly
                  rows={8}
                  className="bg-white font-mono text-xs"
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Expected controls</label>
            <Input
              value={expectedControls}
              onChange={(e) => {
                setExpectedControls(e.target.value);
                setSetupDirty(true);
              }}
              className="bg-white"
            />
          </div>

          <div className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={useSavedSetup}
              onChange={(e) => setUseSavedSetup(e.target.checked)}
            />
            <span>Use saved security test setup for this scan</span>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={saveSecuritySetup}
              variant="outline"
              disabled={setupSaving || !projectId}
            >
              <Save className="mr-2 h-4 w-4" />
              {setupSaving ? "Saving..." : setupDirty ? "Save Security Test Setup" : "Saved Security Test Setup"}
            </Button>
            <Button
              onClick={startScan}
              className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
            >
              <ShieldCheck className="mr-2 h-4 w-4" />
              {needsOperatorApproval ? "Request Operator Approval" : "Run Intelligent Security Scan"}
            </Button>
          </div>
          {needsOperatorApproval && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Deep, active, production, or non-safe scans run through Operator approval. After approval, Operator enqueues the same intelligent security scan worker with anomaly baseline checks.
            </div>
          )}
          {operatorRequest && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              Operator approval requested for job <span className="font-mono">{operatorRequest.id.slice(0, 8)}</span>.{" "}
              <a href="/operator" className="font-medium text-blue-700 underline">
                Open Operator approvals
              </a>
            </div>
          )}
        </CardContent>
      </Card>

      {job && (
        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800">Scan status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-3 items-center">
              <span className="font-semibold capitalize">Status: {job.status}</span>
              {job.phase && (
                <span className="text-slate-600">
                  Phase:{" "}
                  {{
                    recon: "Reconnaissance",
                    static_analysis: "Static analysis",
                    dependency: "Dependency scan",
                    dynamic: "Dynamic probing",
                    intelligent_validation: "Access control validation",
                    graphql_audit: "GraphQL audit",
                    openapi_scan: "OpenAPI endpoint scan",
                    js_analysis: "JavaScript bundle analysis",
                    advanced_analysis: "JWT · IDOR · Race conditions · Nuclei",
                    business_logic_cors: "Business logic · CORS audit",
                    mobile_scan: "Mobile security · Performance baseline",
                    anomaly_baseline: "Anomaly baseline",
                  }[job.phase] ?? job.phase}
                </span>
              )}
              <span className="text-xs text-slate-500">
                Updated {new Date(job.updatedAt).toLocaleString()}
              </span>
              {job.status === "completed" && (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const url = apiUrl(`/security/scans/${job.id}/compliance-report?format=html`);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `compliance-report-${job.id.slice(-8)}.html`;
                      a.click();
                    }}
                  >
                    Download HTML report
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        const res = await apiFetch<{ report: any }>(`/security/scans/${job.id}/compliance-report`);
                        const blob = new Blob([JSON.stringify(res.report, null, 2)], { type: "application/json" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `compliance-report-${job.id.slice(-8)}.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                      } catch (err: any) {
                        setError(err?.message ?? "Failed to download compliance report");
                      }
                    }}
                  >
                    Download JSON
                  </Button>
                </div>
              )}
              {job.error && <span className="text-rose-600">Error: {job.error}</span>}
            </div>
            {job.summary?.counts && (
              <div className="flex gap-2 text-xs text-slate-700 flex-wrap">
                {Object.entries(job.summary.counts).map(([k, v]) => (
                  <span key={k} className="bg-slate-100 rounded px-2 py-1">
                    {k}: {v as any}
                  </span>
                ))}
              </div>
            )}
            {job.summary?.owaspCounts && Object.keys(job.summary.owaspCounts).length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  OWASP coverage with findings
                </div>
                <div className="flex gap-2 text-xs text-slate-700 flex-wrap">
                  {Object.entries(job.summary.owaspCounts).map(([k, v]) => (
                    <span key={k} className="bg-blue-50 text-blue-800 rounded px-2 py-1">
                      {k}: {v as any}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {job.summary?.owaspApiCounts && Object.keys(job.summary.owaspApiCounts).length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  API Security coverage with findings
                </div>
                <div className="flex gap-2 text-xs text-slate-700 flex-wrap">
                  {Object.entries(job.summary.owaspApiCounts).map(([k, v]) => (
                    <span key={k} className="bg-indigo-50 text-indigo-800 rounded px-2 py-1">
                      {k}: {v as any}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {job.summary?.routeInventory && (
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded border border-slate-200 bg-white px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Routes</div>
                  <div className="text-lg font-semibold text-slate-900">
                    {job.summary.routeInventory.routes ?? 0}
                  </div>
                </div>
                <div className="rounded border border-slate-200 bg-white px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Contracts</div>
                  <div className="text-lg font-semibold text-slate-900">
                    {job.summary.routeInventory.contracts ?? 0}
                  </div>
                </div>
                <div className="rounded border border-slate-200 bg-white px-3 py-2">
                  <div className="text-xs uppercase tracking-wide text-slate-500">Baselines</div>
                  <div className="text-lg font-semibold text-slate-900">
                    {job.summary.routeInventory.anomalyBaselines ?? 0}
                  </div>
                </div>
              </div>
            )}
            {job.summary?.authMatrix && (
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Auth matrix
                </div>
                <div className="grid gap-2 sm:grid-cols-5">
                  {[
                    ["Routes", job.summary.authMatrix.routes ?? 0],
                    ["Probes", job.summary.authMatrix.probes ?? 0],
                    ["Passed", job.summary.authMatrix.passed ?? 0],
                    ["Failed", job.summary.authMatrix.failed ?? 0],
                    ["Object swaps", job.summary.authMatrix.objectSwaps ?? 0],
                  ].map(([label, value]) => (
                    <div key={label as string} className="rounded border border-slate-200 bg-white px-3 py-2">
                      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
                      <div
                        className={`text-lg font-semibold ${
                          label === "Failed" && Number(value) > 0 ? "text-rose-600" : "text-slate-900"
                        }`}
                      >
                        {value as any}
                      </div>
                    </div>
                  ))}
                </div>
                {job.summary.authMatrix.failuresByProbe &&
                  Object.keys(job.summary.authMatrix.failuresByProbe).length > 0 && (
                    <div className="flex flex-wrap gap-2 text-xs">
                      {Object.entries(job.summary.authMatrix.failuresByProbe).map(([label, value]) => (
                        <span key={label} className="rounded bg-rose-50 px-2 py-1 text-rose-700">
                          {label}: {value as any}
                        </span>
                      ))}
                    </div>
                  )}
                {Array.isArray(job.summary.authMatrix.routesWithFailures) &&
                  job.summary.authMatrix.routesWithFailures.length > 0 && (
                    <div className="space-y-2">
                      {job.summary.authMatrix.routesWithFailures.map((route: any, index: number) => (
                        <div
                          key={`${route.method}-${route.route}-${index}`}
                          className="rounded border border-rose-100 bg-rose-50/60 px-3 py-2"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-slate-900">
                              {route.method} {route.route}
                            </div>
                            <div className="text-xs text-rose-700">{route.failCount} failed probe(s)</div>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-2 text-xs">
                            {(route.controls ?? []).map((control: string) => (
                              <span key={control} className="rounded bg-white px-2 py-1 text-slate-700">
                                {control}
                              </span>
                            ))}
                          </div>
                          <div className="mt-2 grid gap-1 md:grid-cols-2">
                            {(route.probes ?? [])
                              .filter((probe: any) => probe.passed === false)
                              .map((probe: any) => (
                                <div key={probe.label} className="rounded bg-white px-2 py-1 text-xs text-slate-700">
                                  <span className="font-semibold">{probe.label}</span>
                                  <span> expected {probe.expected}</span>
                                  <span> got HTTP {probe.status ?? "error"}</span>
                                  {probe.profile && <span> as {probe.profile}</span>}
                                </div>
                              ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
            )}
            {job.summary?.baseline && (
              <div className="space-y-2 rounded border border-slate-200 bg-white px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Security baseline
                    </div>
                    <div className="text-sm text-slate-700">
                      {job.summary.baseline.approved
                        ? `Compared to approved baseline from ${new Date(
                            job.summary.baseline.approved.approvedAt
                          ).toLocaleString()}`
                        : "No approved baseline for this environment and origin yet."}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={approveBaseline}
                    disabled={
                      baselineApproving ||
                      job.status !== "completed" ||
                      !job.summary.baseline.candidate?.fingerprints?.length
                    }
                  >
                    {baselineApproving ? "Approving..." : "Approve as baseline"}
                  </Button>
                </div>
                {job.summary.baseline.drift && (
                  <div className="grid gap-2 sm:grid-cols-4">
                    {[
                      ["Drift findings", job.summary.baseline.drift.driftFindings ?? 0],
                      ["Denied to allowed", job.summary.baseline.drift.deniedToAllowed ?? 0],
                      ["Status changes", job.summary.baseline.drift.statusClassChanges ?? 0],
                      ["New probes", job.summary.baseline.drift.newProbes ?? 0],
                    ].map(([label, value]) => (
                      <div key={label as string} className="rounded bg-slate-50 px-3 py-2">
                        <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
                        <div
                          className={`text-lg font-semibold ${
                            Number(value) > 0 && label !== "New probes" ? "text-rose-600" : "text-slate-900"
                          }`}
                        >
                          {value as any}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-xs text-slate-500">
                  Scope: {job.summary.baseline.scopeKey || "unknown"} · Candidate fingerprints:{" "}
                  {job.summary.baseline.candidate?.fingerprints?.length ?? 0}
                </div>
              </div>
            )}
            {accessControlMatrix && (
              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-800">Access control coverage</div>
                <p className="text-xs text-slate-500">
                  Which roles this scan actually had a session for, cross-referenced against confirmed findings.
                  "Covered" means a session was available and no vulnerability of that class was found for that
                  role — it isn't a guarantee every code path was exercised.
                </p>
                <div className="overflow-x-auto rounded-md border border-slate-200">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 text-left text-slate-600">
                        <th className="p-2 font-medium">Category</th>
                        {accessControlMatrix.roles.map((role) => (
                          <th key={role} className="p-2 font-medium capitalize">
                            {role}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {accessControlMatrix.rows.map((row) => (
                        <tr key={row.vulnerabilityClass} className="border-t border-slate-200">
                          <td className="p-2">
                            <div className="font-medium text-slate-800">{row.label}</div>
                            <div className="text-slate-500">{row.owaspApiCategory}</div>
                          </td>
                          {accessControlMatrix.roles.map((role) => {
                            const status = row.cells.get(role);
                            return (
                              <td key={role} className="p-2">
                                <span
                                  className={
                                    status === "vulnerable"
                                      ? "rounded bg-rose-100 px-2 py-1 text-rose-800"
                                      : "rounded bg-emerald-100 px-2 py-1 text-emerald-800"
                                  }
                                >
                                  {status === "vulnerable" ? "Vulnerable" : "No issues found"}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {job.findings && job.findings.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-800">Findings</div>
                <div className="space-y-2">
                  {job.findings.map((f) => (
                    <div
                      key={f.id}
                      className="rounded-md border border-slate-200 bg-white p-3 shadow-sm cursor-pointer hover:border-slate-300"
                      onClick={() => {
                        setSelectedFinding(f);
                        setFindingExplain(null);
                        setFindingTest("");
                      }}
                    >
                      <div className="flex justify-between text-sm">
                        <span className="font-semibold text-slate-900">{f.title}</span>
                        <span className="text-xs uppercase tracking-wide text-slate-600">
                          {f.severity}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600">
                        {f.type} · {f.tool || "tool"}
                      </div>
                      {f.evidence?.owaspCategory && (
                        <div className="text-xs text-blue-700">{f.evidence.owaspCategory}</div>
                      )}
                      {f.evidence?.owaspApiCategory && (
                        <div className="text-xs text-indigo-700">{f.evidence.owaspApiCategory}</div>
                      )}
                      {f.location && <div className="text-xs text-slate-500">Location: {f.location}</div>}
                      {f.description && <div className="text-sm text-slate-700">{f.description}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {recent.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800">Recent scans</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {recent.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between rounded border border-slate-200 bg-white px-3 py-2 hover:bg-slate-50 cursor-pointer"
                onClick={() =>
                  apiFetch<{ job: SecurityJob }>(`/security/scans/${r.id}`)
                    .then((res) => setJob(res.job))
                    .catch(() => {})
                }
              >
                <div className="flex flex-col">
                  <span className="font-semibold text-slate-900">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                  <span className="text-xs text-slate-500">#{r.id.slice(0, 8)}</span>
                </div>
                <div className="text-xs uppercase tracking-wide text-slate-700">
                  {r.status}
                  {r.phase ? ` · ${r.phase}` : ""}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {selectedFinding && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full mx-4 p-4 space-y-3 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center">
              <div>
                <div className="text-xs uppercase text-slate-500">Finding detail</div>
                <div className="text-lg font-semibold text-slate-900">{selectedFinding.title}</div>
              </div>
              <button
                className="text-slate-500 hover:text-slate-800"
                onClick={() => setSelectedFinding(null)}
              >
                ✕
              </button>
            </div>
            <div className="text-sm text-slate-700 space-y-1">
              <div>Type: {selectedFinding.type}</div>
              <div>Severity: {selectedFinding.severity}</div>
              {selectedFinding.location && <div>Location: {selectedFinding.location}</div>}
              {selectedFinding.tool && <div>Tool: {selectedFinding.tool}</div>}
              {selectedFinding.description && <div>{selectedFinding.description}</div>}
            </div>
            <div className="flex gap-3 flex-wrap">
              <Button
                onClick={async () => {
                  setFindingLoading((s) => ({ ...s, explain: true }));
                  setFindingExplain(null);
                  try {
                    const res = await apiFetch<{ detail: SecurityFindingDetail }>(
                      `/security/findings/${selectedFinding.id}/explain`,
                      { method: "POST" }
                    );
                    setFindingExplain(res.detail);
                  } catch (err: any) {
                    setFindingExplain({
                      title: selectedFinding.title,
                      severity: selectedFinding.severity,
                      summary: err?.message ?? "Failed to load explanation.",
                      affectedAsset: selectedFinding.location || "Unknown asset",
                      whyItMatters: "The finding detail could not be loaded.",
                      confidence: {
                        score: 0,
                        label: "low",
                        rationale: "No analysis was returned.",
                      },
                      evidence: [],
                      safeVerificationSteps: [],
                      recommendedFix: [],
                      defensiveNote: "",
                      cve: null,
                    });
                  } finally {
                    setFindingLoading((s) => ({ ...s, explain: false }));
                  }
                }}
                className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
                disabled={findingLoading.explain}
              >
                {findingLoading.explain ? "Loading..." : "Explain & mitigate"}
              </Button>
              <Button
                onClick={async () => {
                  setFindingLoading((s) => ({ ...s, test: true }));
                  setFindingTest("");
                  try {
                    const res = await apiFetch<{ test: string }>(
                      `/security/findings/${selectedFinding.id}/generate-test`,
                      { method: "POST" }
                    );
                    setFindingTest(res.test);
                  } catch (err: any) {
                    setFindingTest(err?.message ?? "Failed to generate test.");
                  } finally {
                    setFindingLoading((s) => ({ ...s, test: false }));
                  }
                }}
                className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
                disabled={findingLoading.test}
              >
                {findingLoading.test ? "Generating..." : "Generate regression test"}
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    const res = await apiFetch<{ report: { markdown: string; title: string; cvssScore: number; severity: string } }>(
                      `/security/findings/${selectedFinding.id}/bug-bounty-report`,
                      { method: "POST", body: JSON.stringify({ format: "json" }) }
                    );
                    const blob = new Blob([res.report.markdown], { type: "text/markdown" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `bug-bounty-report-${selectedFinding.id.slice(-8)}.md`;
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch (err: any) {
                    setError(err?.message ?? "Failed to generate bug bounty report");
                  }
                }}
              >
                Generate bug bounty report
              </Button>
            </div>
            {(findingExplain || findingTest) && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 space-y-3 text-sm">
                {findingExplain && (
                  <div className="space-y-3">
                    <div>
                      <div className="text-xs uppercase text-slate-500 mb-1">Analysis</div>
                      <div className="rounded border border-slate-200 bg-white p-3 space-y-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="rounded bg-slate-100 px-2 py-1 uppercase tracking-wide text-slate-700">
                            Severity {findingExplain.severity}
                          </span>
                          <span className="rounded bg-slate-100 px-2 py-1 uppercase tracking-wide text-slate-700">
                            Confidence {findingExplain.confidence.score}/100
                          </span>
                          <span className="rounded bg-slate-100 px-2 py-1 uppercase tracking-wide text-slate-700">
                            {findingExplain.confidence.label}
                          </span>
                          {findingExplain.cve && (
                            <span className="rounded bg-amber-100 px-2 py-1 uppercase tracking-wide text-amber-800">
                              {findingExplain.cve}
                            </span>
                          )}
                        </div>
                        {(findingExplain.owaspCategory || findingExplain.owaspApiCategory) && (
                          <div className="flex flex-wrap gap-2 text-xs">
                            {findingExplain.owaspCategory && (
                              <span className="rounded bg-blue-50 px-2 py-1 text-blue-800">
                                {findingExplain.owaspCategory}
                              </span>
                            )}
                            {findingExplain.owaspApiCategory && (
                              <span className="rounded bg-indigo-50 px-2 py-1 text-indigo-800">
                                {findingExplain.owaspApiCategory}
                              </span>
                            )}
                          </div>
                        )}
                        <div>
                          <div className="text-xs uppercase text-slate-500">Summary</div>
                          <div className="text-slate-800">{findingExplain.summary}</div>
                        </div>
                        {findingExplain.expectedBehavior && (
                          <div>
                            <div className="text-xs uppercase text-slate-500">Expected Behavior</div>
                            <div className="text-slate-800">{findingExplain.expectedBehavior}</div>
                          </div>
                        )}
                        {findingExplain.observedBehavior && (
                          <div>
                            <div className="text-xs uppercase text-slate-500">Observed Behavior</div>
                            <div className="text-slate-800">{findingExplain.observedBehavior}</div>
                          </div>
                        )}
                        <div>
                          <div className="text-xs uppercase text-slate-500">Affected Asset</div>
                          <div className="text-slate-800">{findingExplain.affectedAsset}</div>
                        </div>
                        <div>
                          <div className="text-xs uppercase text-slate-500">Why It Matters</div>
                          <div className="text-slate-800">{findingExplain.whyItMatters}</div>
                        </div>
                        <div>
                          <div className="text-xs uppercase text-slate-500">Confidence Rationale</div>
                          <div className="text-slate-800">{findingExplain.confidence.rationale}</div>
                        </div>
                        {findingExplain.evidence.length > 0 && (
                          <div>
                            <div className="text-xs uppercase text-slate-500">Evidence</div>
                            <ul className="list-disc pl-5 space-y-1 text-slate-800">
                              {findingExplain.evidence.map((line, index) => (
                                <li key={`${line}-${index}`}>{line}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {findingExplain.safeVerificationSteps.length > 0 && (
                          <div>
                            <div className="text-xs uppercase text-slate-500">Safe Verification</div>
                            <ol className="list-decimal pl-5 space-y-1 text-slate-800">
                              {findingExplain.safeVerificationSteps.map((step, index) => (
                                <li key={`${step}-${index}`}>{step}</li>
                              ))}
                            </ol>
                          </div>
                        )}
                        {findingExplain.recommendedFix.length > 0 && (
                          <div>
                            <div className="text-xs uppercase text-slate-500">Recommended Fix</div>
                            <ul className="list-disc pl-5 space-y-1 text-slate-800">
                              {findingExplain.recommendedFix.map((step, index) => (
                                <li key={`${step}-${index}`}>{step}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {findingExplain.complianceRefs && findingExplain.complianceRefs.length > 0 && (
                          <div>
                            <div className="text-xs uppercase text-slate-500">Compliance Mapping</div>
                            <div className="flex flex-wrap gap-2">
                              {findingExplain.complianceRefs.map((ref) => (
                                <span key={ref} className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">
                                  {ref}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {findingExplain.complianceSteps && findingExplain.complianceSteps.length > 0 && (
                          <div>
                            <div className="text-xs uppercase text-slate-500">Compliance Steps</div>
                            <ol className="list-decimal pl-5 space-y-1 text-slate-800">
                              {findingExplain.complianceSteps.map((step, index) => (
                                <li key={`${step}-${index}`}>{step}</li>
                              ))}
                            </ol>
                          </div>
                        )}
                        {findingExplain.defensiveNote && (
                          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">
                            {findingExplain.defensiveNote}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {findingTest && (
                  <div>
                    <div className="text-xs uppercase text-slate-500 mb-1">Test</div>
                    <code className="block whitespace-pre-wrap">{findingTest}</code>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
