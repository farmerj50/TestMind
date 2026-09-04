import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

type Project = { id: string; name: string; repoUrl?: string | null };

type QaTask = {
  id: string;
  type: "discover" | "execute" | "triage" | "repair" | "retest" | "verify" | string;
  status: "running" | "succeeded" | "failed" | string;
  testRunId?: string | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  outputJson?: Record<string, any> | null;
};

type QaJob = {
  id: string;
  projectId: string;
  baseUrl?: string;
  parallel?: boolean;
  status: "queued" | "running" | "succeeded" | "failed" | string;
  runId?: string | null;
  error?: string;
  autonomous?: boolean;
  createdAt: string;
  updatedAt: string;
  tasks?: QaTask[];
};

// ── Autonomous v1 read models — mirrors of the certified backend types these tabs call.
// Kept as thin local types (not re-exported) since this page is the only frontend consumer.

type FindingValidationStatus =
  | "confirmed"
  | "likely"
  | "suspected"
  | "inconclusive"
  | "not_exploitable"
  | "false_positive"
  | "not_applicable"
  | null;

type AttributedFinding = {
  id: string;
  routeHint: string;
  severity: string;
  title: string;
  tool: string | null;
  validationStatus: FindingValidationStatus;
  createdAt: string;
  scanId: string;
};

type NotAttributableFinding = {
  id: string;
  severity: string;
  title: string;
  tool: string | null;
  location: string | null;
  validationStatus: FindingValidationStatus;
  createdAt: string;
  scanId: string;
};

// A finding's "location" for display/grouping purposes regardless of which branch it's in -
// attributed findings carry a normalized routeHint, notAttributable findings carry a raw
// location (may be null for tools whose location isn't URL/path-shaped at all).
type AnyFinding = (AttributedFinding & { location?: undefined }) | NotAttributableFinding;

function findingLocation(f: AnyFinding): string | null {
  return "routeHint" in f ? f.routeHint : f.location;
}

// QA Agent Security tab: groups re-detections of the same finding across scans into one row
// (identity = tool + title + location) so re-scanning a project updates "last seen"/occurrences
// in place instead of re-listing every SecurityFinding as its own row. The group's representative
// row (and the finding id that triage/persist-regression act on) is always the most recent
// occurrence by createdAt.
type FindingGroup = {
  key: string;
  representative: AnyFinding;
  location: string | null;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
};

function groupFindings(findings: AnyFinding[]): FindingGroup[] {
  const groups = new Map<string, AnyFinding[]>();
  for (const f of findings) {
    const key = `${f.tool ?? "unknown"} ${f.title} ${findingLocation(f) ?? ""}`;
    const existing = groups.get(key);
    if (existing) existing.push(f);
    else groups.set(key, [f]);
  }
  return Array.from(groups.entries()).map(([key, members]) => {
    const sorted = [...members].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      key,
      representative: sorted[0],
      location: findingLocation(sorted[0]),
      firstSeen: sorted[sorted.length - 1].createdAt,
      lastSeen: sorted[0].createdAt,
      occurrences: sorted.length,
    };
  });
}

type WorkflowCoverage = {
  key: string;
  name: string;
  riskTags: string[];
  routeHints: string[];
  apiHints: string[];
  coveredRouteHints: number;
  totalRouteHints: number;
  coveragePercent: number | null;
  observedApiHints: number;
  totalApiHints: number;
};

type ApplicationBrainSnapshot = {
  workflows: WorkflowCoverage[];
  securityFindings: {
    attributed: AttributedFinding[];
    notAttributable: NotAttributableFinding[];
  };
};

type PlannerScoreBreakdown = {
  coverageGap: number;
  qaFailures: number;
  securityFindings: number;
  riskTags: number;
  recentlyChanged: number;
};

type PlannerItem = {
  key: string;
  name: string;
  score: number;
  breakdown: PlannerScoreBreakdown;
  coveragePercent: number;
  routeHints: string[];
  riskTags: string[];
};

type UnrankableWorkflow = { key: string; name: string; reason: string };

type PlanResponse = {
  ranked: PlannerItem[];
  unrankable: UnrankableWorkflow[];
  notAttributableFindings: NotAttributableFinding[];
  objective: string | null;
  asOf: string;
};

type SecurityFindingValidationStatusCounts = {
  confirmed: number;
  likely: number;
  suspected: number;
  inconclusive: number;
  not_exploitable: number;
  false_positive: number;
  not_applicable: number;
  untriaged: number;
};

type WorkflowCoverageEntry = {
  key: string;
  name: string;
  coveragePercent: number | null;
  coverageGapPercent: number | null;
  qaFailuresCount: number;
  securityFindingsByValidationStatus: SecurityFindingValidationStatusCounts;
};

type CoverageReport = {
  workflows: WorkflowCoverageEntry[];
  notAttributableFindings: NotAttributableFinding[];
  openItems: { untriagedFindingsCount: number; unresolvedQaFailuresCount: number };
};

type InvestigatorVerdict =
  | "PRODUCT_DEFECT"
  | "AUTOMATION_DRIFT"
  | "ENVIRONMENT_FAILURE"
  | "DATA_FAILURE"
  | "DEPENDENCY_FAILURE"
  | "SECURITY_ANOMALY"
  | "EXPECTED_CHANGE"
  | "UNKNOWN";

type InvestigatorSignal = { source: "repairFailureClass"; value: string } | { source: "infraError"; value: "infra-error" };

type InvestigatorResult = {
  verdict: InvestigatorVerdict;
  evidenceAvailable: boolean;
  matchedSignals: InvestigatorSignal[];
  testResultId: string;
  healingHistory: "prior-heal-succeeded" | "prior-heal-not-succeeded" | "no-history";
};

type TestRunLite = {
  id: string;
  status: string;
  createdAt: string;
  finishedAt?: string | null;
};

type RunResultRow = {
  id: string;
  status: string;
  durationMs: number | null;
  message: string | null;
  case: { id: string; title: string; key: string };
};

// Ticket for the QA Agent workspace: `select` extended with securityFindingId (a one-line,
// disclosed backend change to GET /tests/cases) so Regression Protection can find the TestCases
// VR.3B's persist-regression-test flow created without a new endpoint.
type RegressionTestCase = {
  id: string;
  key: string;
  title: string;
  status: string;
  updatedAt: string;
  securityFindingId: string | null;
};

const TASK_LABELS: Record<string, string> = {
  discover: "Scan and generate",
  execute: "Run suite",
  triage: "Classify failures",
  repair: "Self-heal",
  retest: "Retest",
  verify: "Verify fix",
};

const TASK_STATUS_CLASS: Record<string, string> = {
  running: "border-blue-200 bg-blue-50 text-blue-700",
  succeeded: "border-emerald-200 bg-emerald-50 text-emerald-700",
  failed: "border-rose-200 bg-rose-50 text-rose-700",
};

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "plan", label: "Plan" },
  { id: "execution", label: "Execution" },
  { id: "investigation", label: "Investigation" },
  { id: "coverage", label: "Coverage" },
  { id: "security", label: "Security" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function isTabId(v: string | null): v is TabId {
  return !!v && TABS.some((t) => t.id === v);
}

function fmtPercent(n: number | null): string {
  return n === null ? "—" : `${Math.round(n)}%`;
}

const VALIDATION_STATUS_OPTIONS: Array<{ value: Exclude<FindingValidationStatus, null>; label: string }> = [
  { value: "confirmed", label: "Confirmed" },
  { value: "likely", label: "Likely" },
  { value: "suspected", label: "Suspected" },
  { value: "inconclusive", label: "Inconclusive" },
  { value: "not_exploitable", label: "Not exploitable" },
  { value: "false_positive", label: "False positive" },
  { value: "not_applicable", label: "Not applicable" },
];

const NO_REGRESSION_STATUSES: FindingValidationStatus[] = ["false_positive", "not_exploitable", "not_applicable"];

function validationStatusLabel(status: FindingValidationStatus): string {
  if (status === null) return "Untriaged";
  return VALIDATION_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

const SEVERITY_TONE: Record<string, string> = {
  critical: "border-rose-300 bg-rose-50 text-rose-800",
  high: "border-rose-200 bg-rose-50 text-rose-700",
  medium: "border-amber-200 bg-amber-50 text-amber-700",
  low: "border-slate-200 bg-slate-50 text-slate-600",
  info: "border-slate-200 bg-slate-50 text-slate-500",
};

function TabBar({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            active === t.id
              ? "bg-blue-600 text-white shadow-sm"
              : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function RefreshButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="text-xs font-medium text-blue-600 hover:underline disabled:opacity-50"
    >
      {loading ? "Refreshing…" : "Refresh"}
    </button>
  );
}

function TaskRow({ task }: { task: QaTask }) {
  const label = TASK_LABELS[task.type] ?? task.type;
  const tone = TASK_STATUS_CLASS[task.status] ?? "border-slate-200 bg-slate-50 text-slate-600";

  // Pull classification summary from triage task output
  const classifications: Array<{ type: string }> =
    task.type === "triage" && Array.isArray(task.outputJson?.classifications)
      ? task.outputJson!.classifications
      : [];
  const selfHealCount = classifications.filter((c) => c.type === "self-heal").length;
  const defectCount = classifications.filter((c) => c.type === "defect").length;
  const blockedCount = classifications.filter((c) => c.type === "blocked").length;

  // Pull defect list from defect triage output
  const defects: Array<{ title: string; routeTo?: string }> =
    task.type === "triage" && Array.isArray(task.outputJson?.defects)
      ? task.outputJson!.defects
      : [];
  const phase = typeof task.outputJson?.phase === "string" ? task.outputJson.phase : null;
  const summary = typeof task.outputJson?.summary === "string" ? task.outputJson.summary : null;
  const specCount =
    typeof task.outputJson?.specCount === "number"
      ? task.outputJson.specCount
      : typeof task.outputJson?.specFileCount === "number"
        ? task.outputJson.specFileCount
        : null;

  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium capitalize">{label}</span>
        <div className="flex items-center gap-2">
          <span className="capitalize opacity-80">{task.status}</span>
          {task.testRunId && (
            <a
              href={`/test-runs/${task.testRunId}`}
              target="_blank"
              rel="noreferrer"
              className="underline text-xs"
            >
              View run
            </a>
          )}
        </div>
      </div>

      {/* Triage classification summary */}
      {classifications.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-2 text-xs">
          {selfHealCount > 0 && (
            <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-violet-700">
              {selfHealCount} self-heal
            </span>
          )}
          {defectCount > 0 && (
            <span className="rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-rose-700">
              {defectCount} defect{defectCount > 1 ? "s" : ""}
            </span>
          )}
          {blockedCount > 0 && (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700">
              {blockedCount} blocked
            </span>
          )}
        </div>
      )}

      {/* Defect list */}
      {defects.length > 0 && (
        <ul className="mt-1.5 space-y-1 text-xs">
          {defects.map((d, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span className="h-1 w-1 rounded-full bg-rose-500 shrink-0" />
              <span className="truncate">{d.title}</span>
              {d.routeTo && (
                <span className="shrink-0 opacity-60">→ {d.routeTo}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {task.error && (
        <div className="mt-1 text-xs opacity-80 truncate">Error: {task.error}</div>
      )}
      {(phase || summary || specCount !== null) && (
        <div className="mt-1 text-xs opacity-80 truncate">
          {[phase, summary, specCount !== null ? `${specCount} spec${specCount === 1 ? "" : "s"}` : null]
            .filter(Boolean)
            .join(" | ")}
        </div>
      )}
    </div>
  );
}

function jobStatusTone(status: string) {
  if (status === "succeeded") return "text-emerald-700";
  if (status === "failed") return "text-rose-700";
  if (status === "running") return "text-blue-700";
  return "text-amber-700";
}

export default function QaAgentPage() {
  const { apiFetch } = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const fromUrl = searchParams.get("tab");
    return isTabId(fromUrl) ? fromUrl : "overview";
  });

  function goToTab(tab: TabId) {
    setActiveTab(tab);
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setSearchParams(next, { replace: true });
  }

  const [projects, setProjects] = useState<Project[]>([]);
  const [suites, setSuites] = useState<
    Array<{ id: string; name: string; type: string; projectId?: string }>
  >([]);
  const [projectId, setProjectId] = useState("");
  const [suiteId, setSuiteId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [parallel, setParallel] = useState(false);
  const [autonomousAvailable, setAutonomousAvailable] = useState(false);
  const [autonomousMode, setAutonomousMode] = useState(false);
  const [job, setJob] = useState<QaJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operatorAfterType, setOperatorAfterType] = useState<"none" | "qa" | "repair" | "discovery" | "security">("none");
  const [operatorJob, setOperatorJob] = useState<{ id: string; status: string; error?: string } | null>(null);
  const pollRef = useRef<number | null>(null);
  const opPollRef = useRef<number | null>(null);

  // ── Autonomous v1 workspace data — one Brain snapshot shared by Overview/Coverage/Security,
  // plus per-tab state for Plan, Investigation, and Coverage's Regression Protection list.
  const [brain, setBrain] = useState<ApplicationBrainSnapshot | null>(null);
  const [brainLoaded, setBrainLoaded] = useState(false);
  const [brainLoading, setBrainLoading] = useState(false);
  const [brainError, setBrainError] = useState<string | null>(null);

  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [planLoaded, setPlanLoaded] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [coverageLoaded, setCoverageLoaded] = useState(false);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState<string | null>(null);

  const [regressionCases, setRegressionCases] = useState<RegressionTestCase[]>([]);
  const [regressionCasesLoaded, setRegressionCasesLoaded] = useState(false);
  const [regressionCasesLoading, setRegressionCasesLoading] = useState(false);

  const [investigationRuns, setInvestigationRuns] = useState<TestRunLite[]>([]);
  const [investigationRunsLoading, setInvestigationRunsLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [runResults, setRunResults] = useState<RunResultRow[]>([]);
  const [runResultsLoading, setRunResultsLoading] = useState(false);
  const [selectedResultId, setSelectedResultId] = useState("");
  const [investigatorResult, setInvestigatorResult] = useState<InvestigatorResult | null>(null);
  const [investigatorLoading, setInvestigatorLoading] = useState(false);
  const [investigatorError, setInvestigatorError] = useState<string | null>(null);

  const [triagingFindingId, setTriagingFindingId] = useState<string | null>(null);
  const [triagingBusy, setTriagingBusy] = useState(false);
  const [persistingFindingId, setPersistingFindingId] = useState<string | null>(null);
  const [securityActionError, setSecurityActionError] = useState<string | null>(null);
  const [persistedSpecPath, setPersistedSpecPath] = useState<string | null>(null);

  function resetWorkspaceData() {
    setBrain(null);
    setBrainLoaded(false);
    setPlan(null);
    setPlanLoaded(false);
    setCoverage(null);
    setCoverageLoaded(false);
    setRegressionCases([]);
    setRegressionCasesLoaded(false);
    setInvestigationRuns([]);
    setSelectedRunId("");
    setRunResults([]);
    setSelectedResultId("");
    setInvestigatorResult(null);
    setTriagingFindingId(null);
    setPersistingFindingId(null);
    setSecurityActionError(null);
    setPersistedSpecPath(null);
  }

  async function loadBrain() {
    if (!projectId) return;
    setBrainLoading(true);
    setBrainError(null);
    try {
      const snapshot = await apiFetch<ApplicationBrainSnapshot>(`/projects/${projectId}/application-brain`);
      setBrain(snapshot);
      setBrainLoaded(true);
    } catch (err: any) {
      setBrainError(err?.message ?? "Failed to load Application Brain");
    } finally {
      setBrainLoading(false);
    }
  }

  async function loadPlan() {
    if (!projectId) return;
    setPlanLoading(true);
    setPlanError(null);
    try {
      const asOf = new Date().toISOString();
      const res = await apiFetch<PlanResponse>(`/projects/${projectId}/plan?asOf=${encodeURIComponent(asOf)}`);
      setPlan(res);
      setPlanLoaded(true);
    } catch (err: any) {
      setPlanError(err?.message ?? "Failed to load the plan");
    } finally {
      setPlanLoading(false);
    }
  }

  async function loadCoverage() {
    if (!projectId) return;
    setCoverageLoading(true);
    setCoverageError(null);
    try {
      const res = await apiFetch<CoverageReport>(`/projects/${projectId}/coverage`);
      setCoverage(res);
      setCoverageLoaded(true);
    } catch (err: any) {
      setCoverageError(err?.message ?? "Failed to load coverage");
    } finally {
      setCoverageLoading(false);
    }
  }

  async function loadRegressionCases() {
    if (!projectId) return;
    setRegressionCasesLoading(true);
    try {
      const res = await apiFetch<{ cases: RegressionTestCase[] }>(`/tests/cases?projectId=${projectId}`);
      setRegressionCases((res.cases || []).filter((c) => !!c.securityFindingId));
      setRegressionCasesLoaded(true);
    } catch {
      // surfaced via the Coverage tab's own empty state; not worth a second error banner
    } finally {
      setRegressionCasesLoading(false);
    }
  }

  async function loadInvestigationRuns(preselectRunId?: string) {
    if (!projectId) return;
    setInvestigationRunsLoading(true);
    try {
      const res = await apiFetch<{ runs: TestRunLite[] }>(`/reports/recent?projectId=${projectId}&take=20`);
      setInvestigationRuns(res.runs || []);
      const preferred = preselectRunId && res.runs.some((r) => r.id === preselectRunId) ? preselectRunId : res.runs[0]?.id;
      if (preferred) setSelectedRunId(preferred);
    } catch {
      // empty picker is a legible empty state on its own
    } finally {
      setInvestigationRunsLoading(false);
    }
  }

  async function loadRunResults(runId: string) {
    setRunResultsLoading(true);
    setSelectedResultId("");
    setInvestigatorResult(null);
    try {
      const res = await apiFetch<{ results: RunResultRow[] }>(`/runner/test-runs/${runId}/results`);
      setRunResults((res.results || []).filter((r) => r.status !== "passed"));
    } catch {
      setRunResults([]);
    } finally {
      setRunResultsLoading(false);
    }
  }

  async function loadInvestigation(testResultId: string) {
    if (!projectId) return;
    setSelectedResultId(testResultId);
    setInvestigatorLoading(true);
    setInvestigatorError(null);
    try {
      const res = await apiFetch<InvestigatorResult>(`/projects/${projectId}/investigator/${testResultId}`);
      setInvestigatorResult(res);
    } catch (err: any) {
      setInvestigatorError(err?.message ?? "Failed to load the investigator verdict");
    } finally {
      setInvestigatorLoading(false);
    }
  }

  // Ticket VR.1/VR.3B wired into the UI. A validationStatus change or a persisted regression
  // test changes what Overview/Coverage would show, so both are marked stale (refetch on next
  // visit) while the Brain snapshot - which Security's own table is sourced from - is refetched
  // immediately so this tab reflects the mutation without a manual refresh.
  async function updateValidationStatus(findingId: string, status: Exclude<FindingValidationStatus, null>) {
    setSecurityActionError(null);
    setTriagingBusy(true);
    try {
      await apiFetch(`/security/findings/${findingId}/validation-status`, {
        method: "PATCH",
        body: JSON.stringify({ validationStatus: status }),
      });
      setTriagingFindingId(null);
      await loadBrain();
      setCoverageLoaded(false);
      setRegressionCasesLoaded(false);
    } catch (err: any) {
      setSecurityActionError(err?.message ?? "Failed to update validation status");
    } finally {
      setTriagingBusy(false);
    }
  }

  async function persistRegression(findingId: string) {
    setSecurityActionError(null);
    setPersistingFindingId(findingId);
    setPersistedSpecPath(null);
    try {
      const res = await apiFetch<{ specPath: string }>(`/security/findings/${findingId}/persist-regression-test`, {
        method: "POST",
      });
      setPersistedSpecPath(res.specPath);
      await loadBrain();
      setCoverageLoaded(false);
      setRegressionCasesLoaded(false);
    } catch (err: any) {
      setSecurityActionError(err?.message ?? "Failed to persist a regression test");
    } finally {
      setPersistingFindingId(null);
    }
  }

  // Fetch-on-first-visit per tab: only the active tab's dependencies are loaded, and only once
  // per project selection (see resetWorkspaceData, called whenever projectId changes below).
  useEffect(() => {
    if (!projectId) return;
    if ((activeTab === "overview" || activeTab === "coverage" || activeTab === "security") && !brainLoaded && !brainLoading) {
      loadBrain();
    }
    if (activeTab === "plan" && !planLoaded && !planLoading) {
      loadPlan();
    }
    if (activeTab === "coverage") {
      if (!coverageLoaded && !coverageLoading) loadCoverage();
      if (!regressionCasesLoaded && !regressionCasesLoading) loadRegressionCases();
    }
    if (activeTab === "investigation" && investigationRuns.length === 0 && !investigationRunsLoading) {
      loadInvestigationRuns(job?.runId ?? undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, projectId]);

  useEffect(() => {
    if (activeTab === "investigation" && selectedRunId) {
      loadRunResults(selectedRunId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId]);

  useEffect(() => {
    let mounted = true;
    apiFetch<{ autonomousQaEnabled: boolean }>("/qa-agent/capabilities")
      .then((res) => {
        if (!mounted) return;
        setAutonomousAvailable(Boolean(res.autonomousQaEnabled));
      })
      .catch(() => {
        if (!mounted) return;
        setAutonomousAvailable(false);
      });
    return () => {
      mounted = false;
    };
  }, [apiFetch]);

  useEffect(() => {
    let mounted = true;
    apiFetch<{ projects: Project[] }>("/projects")
      .then((res) => {
        if (!mounted) return;
        setProjects(res.projects || []);
        if (res.projects?.length && !projectId) setProjectId(res.projects[0].id);
      })
      .catch((err: any) => {
        if (!mounted) return;
        setError(err?.message ?? "Failed to load projects");
      });

    apiFetch<{ projects: Array<{ id: string; name: string; type: string; projectId?: string }> }>(
      "/tm/suite/projects"
    )
      .then((res) => {
        if (!mounted) return;
        const curated = (res.projects || []).filter((p) => p.type === "curated");
        setSuites(curated);
        if (!suiteId && curated.length) {
          setSuiteId(curated[0].id);
          if (!projectId && curated[0].projectId) setProjectId(curated[0].projectId);
        }
      })
      .catch(() => {});

    return () => {
      mounted = false;
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (opPollRef.current) window.clearInterval(opPollRef.current);
    };
  }, [apiFetch, projectId, suiteId]);

  const initialProjectId = useRef(projectId);
  useEffect(() => {
    if (projectId === initialProjectId.current) return;
    initialProjectId.current = projectId;
    resetWorkspaceData();
    setJob(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Auto-populate baseUrl from project.repoUrl when it's an app URL (not a git repo)
  useEffect(() => {
    if (!projectId) return;
    const project = projects.find((p) => p.id === projectId);
    if (!project?.repoUrl) return;
    const url = project.repoUrl.trim();
    const isGitRepo = url.endsWith('.git') || url.startsWith('git@') || /github\.com|gitlab\.com|bitbucket\.org/.test(url);
    if (!isGitRepo && /^https?:\/\//i.test(url)) {
      setBaseUrl(url);
    }
  }, [projectId, projects]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId]
  );

  const startJob = async () => {
    if (!projectId) { setError("Pick a project first."); return; }
    if (!suiteId && !autonomousMode) { setError("Pick a suite to run."); return; }
    setError(null);
    try {
      const res = await apiFetch<{ job: QaJob }>("/qa-agent/start", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          suiteId: suiteId || undefined,
          baseUrl: baseUrl.trim() || undefined,
          parallel,
          autonomous: autonomousMode,
          enableGitHubWriteback: false,
        }),
      });
      setJob(res.job);
      if (pollRef.current) window.clearInterval(pollRef.current);
      const capturedProjectId = res.job.projectId;
      const capturedAutonomous = res.job.autonomous === true;
      pollRef.current = window.setInterval(() => {
        apiFetch<{ job: QaJob }>(`/qa-agent/jobs/${res.job.id}`)
          .then((j) => {
            setJob(j.job);
            if (j.job.status === "succeeded" || j.job.status === "failed") {
              if (pollRef.current) window.clearInterval(pollRef.current);
              // The run this job produced changes what Overview/Investigation/Coverage/Plan
              // would show - mark them stale so revisiting the tab refetches instead of
              // showing pre-run data.
              setBrainLoaded(false);
              setPlanLoaded(false);
              setCoverageLoaded(false);
              setRegressionCasesLoaded(false);
              setInvestigationRuns([]);
              if (!capturedAutonomous && operatorAfterType !== "none") {
                apiFetch<{ job: { id: string; status: string } }>("/operator/jobs", {
                  method: "POST",
                  body: JSON.stringify({
                    projectId: capturedProjectId,
                    type: operatorAfterType,
                    context: { runId: j.job.runId },
                  }),
                }).then((opRes) => {
                  setOperatorJob(opRes.job);
                  opPollRef.current = window.setInterval(() => {
                    apiFetch<{ job: { id: string; status: string; error?: string } }>(
                      `/operator/jobs/${opRes.job.id}`
                    ).then((r) => {
                      setOperatorJob(r.job);
                      if (r.job.status === "succeeded" || r.job.status === "failed") {
                        window.clearInterval(opPollRef.current!);
                      }
                    }).catch(() => {});
                  }, 3000);
                }).catch(() => {});
              }
            }
          })
          .catch(() => {});
      }, 2000);
    } catch (err: any) {
      setError(err?.message ?? "Failed to start QA agent");
    }
  };

  const isActive = job?.status === "queued" || job?.status === "running";

  return (
    <div className="p-6 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">QA Agent</p>
        <h1 className="text-2xl font-semibold text-slate-900">Autonomous QA Workspace</h1>
        <p className="text-sm text-slate-600 mt-1">
          Understand the project, prioritize what matters, run and observe tests, investigate failures,
          protect confirmed security findings with regression tests, and track coverage — all for one
          project, in one place.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="pt-4">
          <div className="max-w-xs space-y-2">
            <label className="text-sm font-medium text-slate-700">Project</label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="bg-white">
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <TabBar active={activeTab} onChange={goToTab} />

      {activeTab === "overview" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800 flex items-center justify-between">
              <span>Application Brain</span>
              <RefreshButton onClick={loadBrain} loading={brainLoading} />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {brainError && <div className="text-sm text-rose-600">{brainError}</div>}
            {!brain && brainLoading && <div className="text-sm text-slate-500">Loading…</div>}
            {brain && (
              <>
                <div className="flex flex-wrap gap-3 text-xs">
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-slate-700">
                    {brain.workflows.length} workflow{brain.workflows.length === 1 ? "" : "s"}
                  </span>
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-amber-700">
                    {brain.securityFindings.attributed.length} findings attributed to a workflow
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-slate-600">
                    {brain.securityFindings.notAttributable.length} findings not attributable to any route
                  </span>
                </div>
                {brain.workflows.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No workflows declared yet for this project. Workflows are authored via the Application Brain
                    API and drive both the Plan and Coverage tabs below.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {brain.workflows.map((w) => (
                      <div key={w.key} className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm">
                        <div>
                          <div className="font-medium text-slate-800">{w.name}</div>
                          <div className="text-xs text-slate-500">
                            {w.coveredRouteHints}/{w.totalRouteHints} route hints covered
                            {w.riskTags.length > 0 && <> · {w.riskTags.join(", ")}</>}
                          </div>
                        </div>
                        <span className="font-mono text-xs text-slate-600">{fmtPercent(w.coveragePercent)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === "plan" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800 flex items-center justify-between">
              <span>Autonomous Planner — ranked workflows</span>
              <RefreshButton onClick={loadPlan} loading={planLoading} />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {planError && <div className="text-sm text-rose-600">{planError}</div>}
            {!plan && planLoading && <div className="text-sm text-slate-500">Loading…</div>}
            {plan && (
              <>
                {plan.ranked.length === 0 ? (
                  <p className="text-sm text-slate-500">No rankable workflows yet.</p>
                ) : (
                  <div className="space-y-2">
                    {plan.ranked.map((item, i) => (
                      <div key={item.key} className="rounded-md border border-slate-200 px-3 py-2 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-slate-800">#{i + 1} {item.name}</span>
                          <span className="font-mono text-xs text-slate-600">score {item.score}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
                          <span>coverage gap {item.breakdown.coverageGap}</span>
                          <span>QA failures {item.breakdown.qaFailures}</span>
                          <span>security findings {item.breakdown.securityFindings}</span>
                          <span>risk tags {item.breakdown.riskTags}</span>
                          <span>recently changed {item.breakdown.recentlyChanged}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {plan.unrankable.length > 0 && (
                  <div className="text-xs text-slate-500">
                    <div className="font-medium uppercase tracking-wide text-slate-400 mb-1">Unrankable</div>
                    {plan.unrankable.map((u) => (
                      <div key={u.key}>{u.name} — {u.reason}</div>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === "execution" && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-slate-800">Start a QA job</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">
                    Suite {autonomousMode && <span className="font-normal text-slate-400">(optional)</span>}
                  </label>
                  <Select value={suiteId} onValueChange={(id) => {
                    setSuiteId(id);
                    const suite = suites.find((s) => s.id === id);
                    if (suite?.projectId) setProjectId(suite.projectId);
                  }}>
                    <SelectTrigger className="bg-white">
                      <SelectValue placeholder="Select suite" />
                    </SelectTrigger>
                    <SelectContent>
                      {suites.map((s) => (
                        <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">Base URL (optional)</label>
                  <Input
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://app.yoursite.com"
                    className="bg-white"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-3">
                <label
                  className="flex items-center gap-2 text-sm text-slate-700"
                  title={autonomousAvailable ? undefined : "Waiting for the API feature flag"}
                >
                  <input
                    type="checkbox"
                    checked={autonomousMode}
                    onChange={(e) => setAutonomousMode(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 accent-blue-600"
                  />
                  Run full autonomous flow
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={parallel} onChange={(e) => setParallel(e.target.checked)} />
                  Run tests in parallel
                </label>
                {!autonomousMode && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">
                    Auto-start Operator job when QA completes
                  </label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {([
                      { value: "none", label: "None — skip" },
                      { value: "qa", label: "QA — run tests" },
                      { value: "repair", label: "Repair — fix failures" },
                      { value: "discovery", label: "Discovery — find routes" },
                      { value: "security", label: "Security — scan vulnerabilities" },
                    ] as const).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setOperatorAfterType(opt.value)}
                        className={`rounded-md border px-3 py-2 text-left text-xs font-medium transition-colors ${
                          operatorAfterType === opt.value
                            ? "border-blue-500 bg-blue-50 text-blue-700"
                            : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                )}
              </div>
              <Button
                onClick={startJob}
                disabled={isActive}
                className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
              >
                {isActive ? "Running…" : "Start QA agent"}
              </Button>
            </CardContent>
          </Card>

          {operatorJob && (
            <Card>
              <CardHeader>
                <CardTitle className="text-slate-800 flex items-center justify-between">
                  <span>Operator — {operatorAfterType !== "none" ? operatorAfterType.charAt(0).toUpperCase() + operatorAfterType.slice(1) : ""} job</span>
                  <span className={`text-sm font-semibold capitalize ${jobStatusTone(operatorJob.status)}`}>
                    {operatorJob.status}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-slate-600 space-y-2">
                <span className="font-mono bg-slate-100 rounded px-2 py-1 text-xs">
                  #{operatorJob.id.slice(0, 8)}
                </span>
                {operatorJob.error && (
                  <div className="text-rose-600 text-xs">{operatorJob.error}</div>
                )}
                <div>
                  <a
                    href={`/operator?jobId=${operatorJob.id}`}
                    className="text-blue-600 hover:underline text-xs"
                    target="_blank"
                    rel="noreferrer"
                  >
                    View in Operator →
                  </a>
                </div>
              </CardContent>
            </Card>
          )}

          {job && (
            <Card>
              <CardHeader>
                <CardTitle className="text-slate-800 flex items-center justify-between">
                  <span>Job status</span>
                  <span className={`text-sm font-semibold capitalize ${jobStatusTone(job.status)}`}>
                    {job.status}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                  <span className="font-mono bg-slate-100 rounded px-2 py-1">#{job.id.slice(0, 8)}</span>
                  <span>Project: {selectedProject?.name || job.projectId}</span>
                  <span>Updated: {new Date(job.updatedAt).toLocaleString()}</span>
                  {job.runId && (
                    <>
                      <a href={`/test-runs/${job.runId}`} target="_blank" rel="noreferrer"
                        className="text-blue-600 hover:underline">
                        View run report
                      </a>
                      {(job.status === "succeeded" || job.status === "failed") && (
                        <button
                          type="button"
                          className="text-blue-600 hover:underline"
                          onClick={() => {
                            setSelectedRunId(job.runId!);
                            goToTab("investigation");
                          }}
                        >
                          View investigation →
                        </button>
                      )}
                    </>
                  )}
                </div>

                {job.error && (
                  <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                    {job.error}
                  </div>
                )}

                {/* Task phase timeline */}
                {job.tasks && job.tasks.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      Execution phases
                    </div>
                    {job.tasks.map((task) => (
                      <TaskRow key={task.id} task={task} />
                    ))}
                  </div>
                )}

                {/* Healed summary if job succeeded */}
                {job.status === "succeeded" && job.tasks && (() => {
                  const triage = job.tasks.find((t) => t.type === "triage" && Array.isArray(t.outputJson?.classifications));
                  const healedCount = triage
                    ? (triage.outputJson!.classifications as any[]).filter((c) => c.type === "self-heal").length
                    : 0;
                  return healedCount > 0 ? (
                    <div className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                      {healedCount} {healedCount === 1 ? "test" : "tests"} routed to self-heal
                    </div>
                  ) : null;
                })()}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {activeTab === "investigation" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800 flex items-center justify-between">
              <span>Investigator</span>
              <RefreshButton onClick={() => loadInvestigationRuns(selectedRunId)} loading={investigationRunsLoading} />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-w-sm space-y-2">
              <label className="text-sm font-medium text-slate-700">Run</label>
              <Select value={selectedRunId} onValueChange={setSelectedRunId}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="Select a run" />
                </SelectTrigger>
                <SelectContent>
                  {investigationRuns.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {new Date(r.createdAt).toLocaleString()} — {r.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {investigationRuns.length === 0 && !investigationRunsLoading && (
                <p className="text-xs text-slate-500">No runs found for this project yet.</p>
              )}
            </div>

            {runResultsLoading && <div className="text-sm text-slate-500">Loading results…</div>}
            {!runResultsLoading && selectedRunId && runResults.length === 0 && (
              <p className="text-sm text-slate-500">This run has no failed results — nothing to investigate.</p>
            )}
            {runResults.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Failed results</div>
                {runResults.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => loadInvestigation(r.id)}
                    className={`block w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                      selectedResultId === r.id
                        ? "border-blue-400 bg-blue-50"
                        : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    <div className="font-medium text-slate-800">{r.case.title}</div>
                    <div className="text-xs text-slate-500 truncate">{r.message}</div>
                  </button>
                ))}
              </div>
            )}

            {investigatorError && <div className="text-sm text-rose-600">{investigatorError}</div>}
            {investigatorLoading && <div className="text-sm text-slate-500">Loading verdict…</div>}
            {investigatorResult && (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm space-y-2">
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-800">
                    {investigatorResult.verdict}
                  </span>
                  <span className="text-xs text-slate-500">
                    {investigatorResult.evidenceAvailable ? "evidence available" : "no evidence to classify"}
                  </span>
                </div>
                <div className="text-xs text-slate-600">
                  Healing history: {investigatorResult.healingHistory.replace(/-/g, " ")}
                </div>
                {investigatorResult.matchedSignals.length > 0 && (
                  <div className="text-xs text-slate-600">
                    Matched signals: {investigatorResult.matchedSignals.map((s) => s.value).join(", ")}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === "coverage" && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-slate-800 flex items-center justify-between">
                <span>Coverage report</span>
                <RefreshButton onClick={loadCoverage} loading={coverageLoading} />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {coverageError && <div className="text-sm text-rose-600">{coverageError}</div>}
              {!coverage && coverageLoading && <div className="text-sm text-slate-500">Loading…</div>}
              {coverage && (
                <>
                  <div className="flex flex-wrap gap-3 text-xs">
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-amber-700">
                      {coverage.openItems.untriagedFindingsCount} untriaged findings
                    </span>
                    <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-rose-700">
                      {coverage.openItems.unresolvedQaFailuresCount} unresolved QA failures
                    </span>
                  </div>
                  {coverage.workflows.length === 0 ? (
                    <p className="text-sm text-slate-500">No workflows to report coverage for yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {coverage.workflows.map((w) => (
                        <div key={w.key} className="rounded-md border border-slate-200 px-3 py-2 text-sm">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-slate-800">{w.name}</span>
                            <span className="font-mono text-xs text-slate-600">
                              {fmtPercent(w.coveragePercent)} covered · {fmtPercent(w.coverageGapPercent)} gap
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-slate-500">
                            {w.qaFailuresCount} QA failure{w.qaFailuresCount === 1 ? "" : "s"} · confirmed findings{" "}
                            {w.securityFindingsByValidationStatus.confirmed}, untriaged{" "}
                            {w.securityFindingsByValidationStatus.untriaged}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-slate-800 flex items-center justify-between">
                <span>Regression protection</span>
                <RefreshButton onClick={loadRegressionCases} loading={regressionCasesLoading} />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {regressionCasesLoading && regressionCases.length === 0 && (
                <div className="text-sm text-slate-500">Loading…</div>
              )}
              {!regressionCasesLoading && regressionCases.length === 0 && (
                <p className="text-sm text-slate-500">
                  No regression tests have been created from confirmed security findings yet — see the Security tab.
                </p>
              )}
              {regressionCases.map((tc) => {
                const finding =
                  brain?.securityFindings.attributed.find((f) => f.id === tc.securityFindingId) ??
                  brain?.securityFindings.notAttributable.find((f) => f.id === tc.securityFindingId);
                return (
                  <div key={tc.id} className="rounded-md border border-slate-200 px-3 py-2 text-sm">
                    <div className="font-medium text-slate-800">{tc.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>From: {finding?.title ?? tc.securityFindingId}</span>
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">
                        Regression created — execution not wired
                      </span>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "security" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800 flex items-center justify-between">
              <span>Security validation</span>
              <RefreshButton onClick={loadBrain} loading={brainLoading} />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {brainError && <div className="text-sm text-rose-600">{brainError}</div>}
            {securityActionError && <div className="text-sm text-rose-600">{securityActionError}</div>}
            {persistedSpecPath && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                Regression test written to {persistedSpecPath}. See the Coverage tab's Regression protection section.
              </div>
            )}
            {!brain && brainLoading && <div className="text-sm text-slate-500">Loading…</div>}
            {brain && (() => {
              const findings: AnyFinding[] = [...brain.securityFindings.attributed, ...brain.securityFindings.notAttributable];
              if (findings.length === 0) {
                return <p className="text-sm text-slate-500">No security findings for this project yet.</p>;
              }
              const groups = groupFindings(findings).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                        <th className="py-2 pr-3">Finding</th>
                        <th className="py-2 pr-3">Location</th>
                        <th className="py-2 pr-3">Severity</th>
                        <th className="py-2 pr-3">Tool</th>
                        <th className="py-2 pr-3">Validation status</th>
                        <th className="py-2 pr-3">Last seen</th>
                        <th className="py-2 pr-3">First seen</th>
                        <th className="py-2 pr-3">Occurrences</th>
                        <th className="py-2 pr-3">Source scan</th>
                        <th className="py-2 pr-3">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => {
                        const f = g.representative;
                        const isTriaging = triagingFindingId === f.id;
                        const noRegression = NO_REGRESSION_STATUSES.includes(f.validationStatus);
                        return (
                          <tr key={g.key} className="border-b border-slate-100 align-top">
                            <td className="py-2 pr-3 max-w-xs">
                              <div className="font-medium text-slate-800 truncate">{f.title}</div>
                            </td>
                            <td className="py-2 pr-3 max-w-xs text-xs text-slate-600 truncate" title={g.location ?? undefined}>
                              {g.location ?? "—"}
                            </td>
                            <td className="py-2 pr-3">
                              <span className={`rounded-full border px-2 py-0.5 text-xs ${SEVERITY_TONE[f.severity] ?? SEVERITY_TONE.low}`}>
                                {f.severity}
                              </span>
                            </td>
                            <td className="py-2 pr-3 text-xs text-slate-600">{f.tool ?? "—"}</td>
                            <td className="py-2 pr-3 text-xs text-slate-700">{validationStatusLabel(f.validationStatus)}</td>
                            <td className="py-2 pr-3 text-xs text-slate-600">{new Date(g.lastSeen).toLocaleDateString()}</td>
                            <td className="py-2 pr-3 text-xs text-slate-600">{new Date(g.firstSeen).toLocaleDateString()}</td>
                            <td className="py-2 pr-3 text-xs text-slate-600">{g.occurrences}</td>
                            <td className="py-2 pr-3 text-xs font-mono text-slate-500">#{f.scanId.slice(0, 8)}</td>
                            <td className="py-2 pr-3">
                              {isTriaging ? (
                                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                                  {VALIDATION_STATUS_OPTIONS.map((opt) => (
                                    <button
                                      key={opt.value}
                                      type="button"
                                      disabled={triagingBusy}
                                      onClick={() => updateValidationStatus(f.id, opt.value)}
                                      className="rounded-md border border-slate-200 bg-white px-2 py-1 text-left text-xs font-medium text-slate-600 hover:border-blue-300 hover:bg-blue-50 disabled:opacity-50"
                                    >
                                      {opt.label}
                                    </button>
                                  ))}
                                  <button
                                    type="button"
                                    onClick={() => setTriagingFindingId(null)}
                                    className="rounded-md border border-slate-200 bg-white px-2 py-1 text-left text-xs text-slate-400 hover:bg-slate-50"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <div className="flex flex-wrap items-center gap-2">
                                  {f.validationStatus === "confirmed" && (
                                    <Button
                                      size="sm"
                                      disabled={persistingFindingId === f.id}
                                      onClick={() => persistRegression(f.id)}
                                      className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
                                    >
                                      {persistingFindingId === f.id ? "Persisting…" : "Persist regression test"}
                                    </Button>
                                  )}
                                  {noRegression && <span className="text-xs text-slate-400">No regression action</span>}
                                  <button
                                    type="button"
                                    onClick={() => setTriagingFindingId(f.id)}
                                    className="text-xs font-medium text-blue-600 hover:underline"
                                  >
                                    {f.validationStatus === null ? "Select validation" : "Update validation"}
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
