import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { CheckCircle2, XCircle, Loader2, Trash2 } from "lucide-react";

type Project = { id: string; name: string; repoUrl?: string | null };

type OperatorTask = {
  id: string;
  type: string;
  status: string;
  testRunId?: string | null;
  error?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  inputJson?: Record<string, any> | null;
  outputJson?: Record<string, any> | null;
  resolvedTarget?: {
    testResultId?: string | null;
    testCaseId?: string | null;
    testTitle?: string | null;
    testCaseKey?: string | null;
  } | null;
};

type OperatorJob = {
  id: string;
  projectId: string;
  type: string;
  status: string;
  objective?: string | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  contextJson?: Record<string, any> | null;
  tasks: OperatorTask[];
};

type Schedule = {
  id: string;
  projectId: string;
  cron: string;
  enabled: boolean;
  lastRunAt?: string | null;
  createdAt: string;
};

const PIPELINE_STEPS = [
  { type: "discover", label: "Discovering site" },
  { type: "execute",  label: "Running tests" },
  { type: "triage",   label: "Triaging failures" },
  { type: "repair",   label: "Repairing failures" },
  { type: "retest",   label: "Re-running patched tests" },
  { type: "verify",   label: "Verifying suite" },
] as const;

const CRON_PRESETS = [
  { label: "Daily 2 AM", value: "0 2 * * *" },
  { label: "Weekly Mon 9 AM", value: "0 9 * * 1" },
  { label: "Daily midnight", value: "0 0 * * *" },
];

type OperatorApproval = {
  id: string;
  actionType: string;
  status: string;
  requestedAt: string;
  contextJson?: { prompt?: string } | null;
  job: {
    id: string;
    projectId: string;
    type: string;
    objective?: string | null;
  };
};

const STATUS_COLORS: Record<string, string> = {
  queued:    "bg-slate-100 text-slate-600",
  running:   "bg-blue-100 text-blue-700",
  succeeded: "bg-emerald-100 text-emerald-700",
  failed:    "bg-rose-100 text-rose-700",
  canceled:  "bg-amber-100 text-amber-700",
  blocked:   "bg-orange-100 text-orange-700",
  pending:   "bg-slate-100 text-slate-500",
  skipped:   "bg-slate-100 text-slate-400",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? "bg-slate-100 text-slate-600";
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium capitalize ${cls}`}>
      {status}
    </span>
  );
}

function fmtTime(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString();
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString();
}

function taskLabel(task: OperatorTask) {
  if (task.type === "repair") return "Repair testcase";
  if (task.type === "triage") return "Triage";
  if (task.type === "execute") return "Execute";
  if (task.type === "discover") return "Discover";
  return task.type;
}

function taskTargetTitle(task: OperatorTask) {
  const resolved = task.resolvedTarget ?? {};
  const input = task.inputJson ?? {};
  const output = task.outputJson ?? {};
  return (
    (typeof resolved.testTitle === "string" && resolved.testTitle.trim()) ||
    (typeof input.testTitle === "string" && input.testTitle.trim()) ||
    (typeof output.testTitle === "string" && output.testTitle.trim()) ||
    (typeof output.title === "string" && output.title.trim()) ||
    null
  );
}

function taskTargetKey(task: OperatorTask) {
  const resolved = task.resolvedTarget ?? {};
  const input = task.inputJson ?? {};
  const raw =
    (typeof resolved.testCaseKey === "string" && resolved.testCaseKey.trim()) ||
    (typeof input.testCaseKey === "string" && input.testCaseKey.trim()) ||
    null;
  if (!raw) return null;
  return raw;
}

function taskTargetFile(task: OperatorTask) {
  const key = taskTargetKey(task);
  if (!key) return null;
  const [specPath] = key.split("#");
  return specPath || key;
}

function taskTargetId(task: OperatorTask) {
  const resolved = task.resolvedTarget ?? {};
  const input = task.inputJson ?? {};
  return (
    (typeof resolved.testResultId === "string" && resolved.testResultId.trim()) ||
    (typeof input.testResultId === "string" && input.testResultId.trim()) ||
    null
  );
}

function taskOutcome(task: OperatorTask) {
  const output = task.outputJson ?? {};
  const finalStatus =
    typeof output.finalStatus === "string" && output.finalStatus.trim()
      ? output.finalStatus.trim()
      : null;
  if (task.type !== "repair") return null;
  if (finalStatus === "succeeded") return "patched";
  if (finalStatus === "failed") return "repair failed";
  if (finalStatus === "skipped") return "skipped";
  if (task.status === "succeeded") return "patched";
  if (task.status === "failed") return "repair failed";
  return null;
}

export default function OperatorPage() {
  const { apiFetch } = useApi();

  // form state
  const [projects, setProjects] = useState<Project[]>([]);
  const [suites, setSuites] = useState<Array<{ id: string; name: string; projectId?: string }>>([]);
  const [environments, setEnvironments] = useState<Array<{ id: string; name: string; baseUrl: string }>>([]);
  const [projectId, setProjectId] = useState("");
  const [suiteId, setSuiteId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [jobType, setJobType] = useState<"qa" | "repair" | "discovery" | "security" | "autonomous">("qa");
  const [enableGitHubWriteback, setEnableGitHubWriteback] = useState(false);
  const [searchParams] = useSearchParams();
  const [enableActive, setEnableActive] = useState(false);
  const [securityScanDepth, setSecurityScanDepth] = useState<"baseline" | "standard" | "deep">("standard");
  const [securitySafeMode, setSecuritySafeMode] = useState(true);
  const [objective, setObjective] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // active job being watched
  const [job, setJob] = useState<OperatorJob | null>(null);
  const pollRef = useRef<number | null>(null);

  // job history
  const [history, setHistory] = useState<OperatorJob[]>([]);
  const historyPollRef = useRef<number | null>(null);

  // pending approvals
  const [approvals, setApprovals] = useState<OperatorApproval[]>([]);
  const approvalPollRef = useRef<number | null>(null);
  const [approvalLoading, setApprovalLoading] = useState<Record<string, boolean>>({});

  // schedules
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [scheduleCron, setScheduleCron] = useState("0 9 * * 1");
  const [scheduleSubmitting, setScheduleSubmitting] = useState(false);
  const [scheduleErr, setScheduleErr] = useState<string | null>(null);

  // ── helpers ──────────────────────────────────────────────────────────────

  const fetchHistory = useCallback(async () => {
    try {
      const res = await apiFetch<{ jobs: OperatorJob[] }>("/operator/jobs?limit=20");
      setHistory(res.jobs ?? []);
    } catch {
      // silently ignore
    }
  }, [apiFetch]);

  const fetchApprovals = useCallback(async () => {
    try {
      const res = await apiFetch<{ approvals: OperatorApproval[] }>("/operator/approvals?status=pending");
      setApprovals(res.approvals ?? []);
    } catch {
      // silently ignore
    }
  }, [apiFetch]);

  const fetchSchedules = useCallback(async (pid: string) => {
    if (!pid) return;
    try {
      const res = await apiFetch<{ schedules: Schedule[] }>(`/schedules?projectId=${pid}`);
      setSchedules(res.schedules ?? []);
    } catch {
      setSchedules([]);
    }
  }, [apiFetch]);

  const createSchedule = async () => {
    if (!projectId) { setScheduleErr("Select a project first."); return; }
    if (!scheduleCron.trim()) { setScheduleErr("Cron expression required."); return; }
    setScheduleSubmitting(true);
    setScheduleErr(null);
    try {
      await apiFetch("/schedules", {
        method: "POST",
        body: JSON.stringify({ projectId, cron: scheduleCron.trim() }),
      });
      await fetchSchedules(projectId);
    } catch (err: any) {
      setScheduleErr(err?.message ?? "Failed to create schedule");
    } finally {
      setScheduleSubmitting(false);
    }
  };

  const toggleSchedule = async (id: string, enabled: boolean) => {
    try {
      await apiFetch(`/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      setSchedules((prev) => prev.map((s) => s.id === id ? { ...s, enabled } : s));
    } catch { /* ignore */ }
  };

  const deleteSchedule = async (id: string, cron: string) => {
    if (!confirm(`Delete schedule "${cron}"?`)) return;
    try {
      await apiFetch(`/schedules/${id}`, { method: "DELETE" });
      setSchedules((prev) => prev.filter((s) => s.id !== id));
    } catch { /* ignore */ }
  };

  // ── mount / unmount ───────────────────────────────────────────────────────

  useEffect(() => {
    let mounted = true;

    apiFetch<{ projects: Project[] }>("/projects")
      .then((res) => {
        if (!mounted) return;
        setProjects(res.projects ?? []);
        if (res.projects?.length && !projectId) setProjectId(res.projects[0].id);
      })
      .catch(() => {});

    apiFetch<{ projects: Array<{ id: string; name: string; type: string; projectId?: string }> }>("/tm/suite/projects")
      .then((res) => {
        if (!mounted) return;
        const curated = (res.projects ?? []).filter((p) => p.type === "curated");
        setSuites(curated);
        if (!suiteId && curated.length) setSuiteId(curated[0].id);
      })
      .catch(() => {});

    fetchHistory();
    fetchApprovals();

    // Pre-select autonomous mode from URL query param
    if (searchParams.get("mode") === "autonomous") setJobType("autonomous");
    const qProjectId = searchParams.get("projectId");
    if (qProjectId) setProjectId(qProjectId);

    // Auto-load a specific job from URL (e.g. from the Dashboard Auto Run toast)
    const qJobId = searchParams.get("jobId");
    if (qJobId) {
      apiFetch<{ job: OperatorJob }>(`/operator/jobs/${qJobId}`)
        .then(({ job: j }) => {
          if (!mounted) return;
          setJob(j);
          if (!["succeeded", "failed", "canceled"].includes(j.status)) {
            startPolling(j.id);
          }
        })
        .catch(() => {});
    }

    // poll history every 10 s, approvals every 5 s
    historyPollRef.current = window.setInterval(fetchHistory, 10_000);
    approvalPollRef.current = window.setInterval(fetchApprovals, 5_000);

    return () => {
      mounted = false;
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (historyPollRef.current) window.clearInterval(historyPollRef.current);
      if (approvalPollRef.current) window.clearInterval(approvalPollRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-populate environment + baseUrl when project changes
  useEffect(() => {
    if (!projectId) return;

    // Fetch environments for this project
    apiFetch<{ environments: Array<{ id: string; name: string; baseUrl: string }> }>(`/environments?projectId=${projectId}`)
      .then((res) => {
        const envs = res.environments ?? [];
        setEnvironments(envs);
        const first = envs[0];
        if (first) {
          setEnvironmentId(first.id);
          setBaseUrl(first.baseUrl);
        } else {
          setEnvironmentId("");
          // Fallback: auto-populate from project repoUrl if it's an app URL
          const project = projects.find((p) => p.id === projectId);
          const url = project?.repoUrl?.trim() ?? "";
          const isGit = url.endsWith(".git") || url.startsWith("git@") || /github\.com|gitlab\.com|bitbucket\.org/.test(url);
          setBaseUrl(!isGit && /^https?:\/\//i.test(url) ? url : "");
        }
      })
      .catch(() => {});

    // Reset suiteId to first suite for this project
    const projectSuites = suites.filter((s) => s.projectId === projectId);
    if (projectSuites.length) setSuiteId(projectSuites[0].id);
    else setSuiteId("");

    // Load schedules for this project
    fetchSchedules(projectId);
  }, [projectId, projects, suites, apiFetch, fetchSchedules]);

  // ── active job polling ────────────────────────────────────────────────────

  const stopPolling = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startPolling = (jobId: string) => {
    stopPolling();
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await apiFetch<{ job: OperatorJob }>(`/operator/jobs/${jobId}`);
        setJob(res.job);
        // update the same row in history if present
        setHistory((prev) => prev.map((j) => j.id === res.job.id ? res.job : j));
        if (["succeeded", "failed", "canceled"].includes(res.job.status)) {
          stopPolling();
          fetchHistory();
        }
      } catch {
        // keep polling on transient errors
      }
    }, 2000);
  };

  // ── actions ───────────────────────────────────────────────────────────────

  const startJob = async () => {
    if (!projectId) { setError("Select a project first."); return; }
    if (jobType === "autonomous" && !baseUrl.trim()) { setError("Base URL is required for Full Autonomous Run."); return; }
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ job: OperatorJob }>("/operator/jobs", {
        method: "POST",
        body: JSON.stringify(
          jobType === "autonomous"
            ? {
                projectId,
                type: "qa",
                objective: objective.trim() || undefined,
                context: {
                  autonomous: true,
                  baseUrl: baseUrl.trim(),
                  enableGitHubWriteback,
                  ...(environmentId ? { environmentId } : {}),
                },
              }
            : {
                projectId,
                type: jobType,
                objective: objective.trim() || undefined,
                context: {
                  ...(environmentId ? { environmentId } : {}),
                  ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
                  ...(jobType === "qa" && suiteId ? { suiteId } : {}),
                  ...(jobType === "security"
                    ? { enableActive, scanDepth: securityScanDepth, safeMode: securitySafeMode }
                    : {}),
                },
              }
        ),
      });
      setJob(res.job);
      setHistory((prev) => [res.job, ...prev]);
      startPolling(res.job.id);
    } catch (err: any) {
      setError(err?.message ?? "Failed to start operator job");
    } finally {
      setSubmitting(false);
    }
  };

  const resolveApproval = async (approvalId: string, decision: "approve" | "deny") => {
    setApprovalLoading((prev) => ({ ...prev, [approvalId]: true }));
    try {
      await apiFetch(`/operator/approvals/${approvalId}/${decision}`, { method: "POST" });
      setApprovals((prev) => prev.filter((a) => a.id !== approvalId));
    } catch (err: any) {
      setError(err?.message ?? `Failed to ${decision} approval`);
    } finally {
      setApprovalLoading((prev) => ({ ...prev, [approvalId]: false }));
    }
  };

  const viewJob = (j: OperatorJob) => {
    setJob(j);
    if (!["succeeded", "failed", "canceled"].includes(j.status)) {
      startPolling(j.id);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const isTerminal = job && ["succeeded", "failed", "canceled"].includes(job.status);

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">Operator</p>
        <h1 className="text-2xl font-semibold text-slate-900">Operator jobs</h1>
        <p className="text-sm text-slate-600">
          Create and monitor autonomous operator jobs. Jobs orchestrate tasks and link back to test runs.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* ── Pending approvals ───────────────────────────────────────────── */}
      {approvals.length > 0 && (
        <Card className="border-orange-200 bg-orange-50">
          <CardHeader className="pb-2">
            <CardTitle className="text-orange-800 text-base flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-orange-500 animate-pulse" />
              Pending approvals ({approvals.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {approvals.map((a) => (
              <div
                key={a.id}
                className="rounded-md border border-orange-200 bg-white px-4 py-3 space-y-2"
              >
                <p className="text-sm font-medium text-slate-800">{a.contextJson?.prompt ?? a.actionType}</p>
                <p className="text-xs text-slate-500">
                  Job <span className="font-mono">{a.job.id.slice(0, 8)}…</span>
                  {a.job.objective && ` — ${a.job.objective}`}
                  {" · "}
                  {fmtDate(a.requestedAt)}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={!!approvalLoading[a.id]}
                    onClick={() => resolveApproval(a.id, "approve")}
                    className="bg-emerald-600 text-white hover:bg-emerald-700 h-7 px-3 text-xs"
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!approvalLoading[a.id]}
                    onClick={() => resolveApproval(a.id, "deny")}
                    className="border-rose-300 text-rose-700 hover:bg-rose-50 h-7 px-3 text-xs"
                  >
                    Deny
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── Start a job ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-slate-800">Start a job</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
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
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Job type</label>
              <Select value={jobType} onValueChange={(v) => setJobType(v as typeof jobType)}>
                <SelectTrigger className="bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="qa">QA — run tests</SelectItem>
                  <SelectItem value="repair">Repair — fix failing tests</SelectItem>
                  <SelectItem value="discovery">Discovery — find uncovered routes</SelectItem>
                  <SelectItem value="security">Security — scan for vulnerabilities</SelectItem>
                  <SelectItem value="autonomous">Full Autonomous Run — scan → generate → test → fix</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {jobType === "qa" && (
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Suite</label>
                <Select value={suiteId} onValueChange={setSuiteId}>
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="Select suite (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    {suites.filter((s) => !s.projectId || s.projectId === projectId).map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Objective (optional)</label>
              <Input
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="e.g. Run smoke tests and report failures"
                className="bg-white"
              />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Environment</label>
              {environments.length > 0 ? (
                <Select
                  value={environmentId}
                  onValueChange={(v) => {
                    setEnvironmentId(v);
                    const env = environments.find((e) => e.id === v);
                    if (env) setBaseUrl(env.baseUrl);
                  }}
                >
                  <SelectTrigger className="bg-white">
                    <SelectValue placeholder="Select environment" />
                  </SelectTrigger>
                  <SelectContent>
                    {environments.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name} — <span className="font-mono text-xs">{e.baseUrl}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-slate-500 pt-1">
                  No environments configured. <a href="/environments" className="underline text-blue-600">Add one</a> or enter a URL below.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">
                {environments.length > 0 ? "Override URL (optional)" : "Base URL"}
              </label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="e.g. https://www.justicepath.com"
                className="bg-white"
              />
            </div>
          </div>
          {jobType === "autonomous" && (
            <div className="space-y-3 rounded-md border border-blue-200 bg-blue-50 p-4">
              <p className="text-sm font-medium text-blue-800">
                Full Autonomous Run: crawls the site, generates Playwright specs, runs them, auto-heals every failure, then verifies all tests pass.
              </p>
              <p className="text-xs text-blue-700">
                <strong>Base URL is required</strong> — enter it in the URL field above. The job will use <code>TM_AUTONOMOUS_QA_ENABLED</code> on the server.
              </p>
              <label className="flex items-center gap-3 cursor-pointer select-none rounded border border-blue-200 bg-white px-3 py-2">
                <input
                  type="checkbox"
                  checked={enableGitHubWriteback}
                  onChange={(e) => setEnableGitHubWriteback(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 accent-blue-600"
                />
                <span className="text-sm text-slate-700">Enable GitHub branch + PR after successful repair</span>
              </label>
            </div>
          )}
          {jobType === "security" && (
            <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">Scan depth</label>
                  <Select value={securityScanDepth} onValueChange={(v) => setSecurityScanDepth(v as typeof securityScanDepth)}>
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
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">Validation mode</label>
                  <label className="flex items-center gap-3 cursor-pointer select-none rounded border border-slate-200 bg-white px-3 py-2">
                    <input
                      type="checkbox"
                      checked={securitySafeMode}
                      onChange={(e) => setSecuritySafeMode(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 accent-blue-600"
                    />
                    <span className="text-sm text-slate-700">Safe mode</span>
                  </label>
                </div>
              </div>
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={enableActive}
                onChange={(e) => setEnableActive(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 accent-rose-600"
              />
              <span className="text-sm text-slate-700">
                Enable active probes
                <span className="ml-2 text-xs text-rose-600 font-medium">
                  (XSS, SQLi, path traversal — requires approval)
                </span>
              </span>
            </label>
              <p className="text-xs text-slate-500">
                Deep, active, production, or non-safe security jobs create an approval before the scan worker runs.
              </p>
            </div>
          )}
          <Button
            onClick={startJob}
            disabled={submitting || (!!job && !isTerminal)}
            className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
          >
            {submitting ? "Starting…" : "Start operator job"}
          </Button>
        </CardContent>
      </Card>

      {/* ── Active job status ────────────────────────────────────────────── */}
      {job && (
        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800 flex items-center gap-3">
              Job status
              <StatusBadge status={job.status} />
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-xs font-mono text-slate-500">#{job.id}</div>

            {job.objective && (
              <p className="text-sm text-slate-700">{job.objective}</p>
            )}

            <div className="flex flex-wrap gap-4 text-sm text-slate-600">
              <span>Type: <span className="font-medium capitalize">{job.type}</span></span>
              <span>Started: <span className="font-medium">{fmtTime(job.startedAt)}</span></span>
              {job.finishedAt && (
                <span>Finished: <span className="font-medium">{fmtTime(job.finishedAt)}</span></span>
              )}
            </div>

            {job.error && (
              <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {job.error}
              </div>
            )}

            {/* Autonomous pipeline checklist — visible only for autonomous runs */}
            {job.contextJson?.autonomous === true && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">Autonomous QA Pipeline</p>
                {PIPELINE_STEPS.map((step) => {
                  const stepTasks = job.tasks.filter((t) => t.type === step.type);
                  const total = stepTasks.length;
                  const done = stepTasks.filter((t) => t.status === "succeeded").length;
                  const failed = stepTasks.filter((t) => t.status === "failed").length;
                  const running = stepTasks.filter((t) => t.status === "running").length;
                  const hasAny = total > 0;
                  const allDone = hasAny && done === total;
                  const hasFailed = failed > 0;
                  const isRunning = running > 0;
                  return (
                    <div key={step.type} className="flex items-center gap-3 py-1.5">
                      <span className="w-5 h-5 flex items-center justify-center shrink-0">
                        {allDone ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                        ) : hasFailed ? (
                          <XCircle className="h-5 w-5 text-rose-500" />
                        ) : isRunning ? (
                          <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />
                        ) : (
                          <span className="h-4 w-4 rounded-full border-2 border-slate-300" />
                        )}
                      </span>
                      <span className={`text-sm ${allDone ? "text-emerald-700 font-medium" : hasFailed ? "text-rose-700" : isRunning ? "text-blue-700 font-medium" : "text-slate-500"}`}>
                        {step.label}
                      </span>
                      {total > 1 && (
                        <span className="ml-auto text-xs text-slate-400">{done}/{total}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {job.tasks.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tasks</p>
                <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
                  {job.tasks.map((task) => (
                    <div key={task.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div className="min-w-0 flex items-start gap-3">
                        <StatusBadge status={task.status} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-slate-700">{taskLabel(task)}</span>
                            {taskOutcome(task) && (
                              <span className="text-xs text-slate-400 uppercase tracking-wide">{taskOutcome(task)}</span>
                            )}
                          </div>
                          {taskTargetTitle(task) && (
                            <div
                              className="truncate text-xs text-slate-500"
                              title={taskTargetTitle(task) ?? undefined}
                            >
                              {taskTargetTitle(task)}
                            </div>
                          )}
                          {taskTargetFile(task) && (
                            <div
                              className="truncate font-mono text-[11px] text-slate-400"
                              title={taskTargetKey(task) ?? undefined}
                            >
                              {taskTargetFile(task)}
                              {taskTargetId(task) ? ` · ${taskTargetId(task)!.slice(0, 8)}` : ""}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 pl-3">
                        {task.testRunId && (
                          <a
                            href={`/test-runs/${task.testRunId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 hover:underline text-xs"
                          >
                            View run →
                          </a>
                        )}
                        {task.error && (
                          <span className="text-xs text-rose-600 max-w-xs truncate" title={task.error}>
                            {task.error}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Security output */}
            {job.type === "security" && job.status === "succeeded" && (() => {
              const execTask = job.tasks.find((t) => t.type === "execute");
              const output = (execTask as any)?.outputJson as {
                scanId?: string;
                findingCounts?: Record<string, number>;
              } | undefined;
              if (!output?.findingCounts) return null;
              const counts = output.findingCounts;
              const severityOrder = ["critical", "high", "medium", "low", "info"];
              const severityColors: Record<string, string> = {
                critical: "bg-red-100 text-red-800",
                high: "bg-orange-100 text-orange-800",
                medium: "bg-amber-100 text-amber-800",
                low: "bg-yellow-100 text-yellow-800",
                info: "bg-slate-100 text-slate-600",
              };
              return (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Security findings</p>
                  <div className="flex flex-wrap gap-2">
                    {severityOrder.filter((s) => counts[s]).map((s) => (
                      <span key={s} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium capitalize ${severityColors[s]}`}>
                        {s} <span className="font-bold">{counts[s]}</span>
                      </span>
                    ))}
                  </div>
                  {output.scanId && (
                    <a
                      href={`/security-scan?jobId=${output.scanId}`}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      View full report →
                    </a>
                  )}
                </div>
              );
            })()}

            {/* Discovery output */}
            {job.type === "discovery" && job.status === "succeeded" && (() => {
              const discoverTask = job.tasks.find((t) => t.type === "discover");
              const output = (discoverTask as any)?.outputJson as {
                discoveredRoutes?: Array<{ route: string; status: number; reachable: boolean }>;
                uncoveredRoutes?: string[];
                summary?: string;
              } | undefined;
              if (!output) return null;
              return (
                <div className="space-y-3">
                  {output.summary && (
                    <p className="text-sm text-slate-700 font-medium">{output.summary}</p>
                  )}
                  {(output.uncoveredRoutes?.length ?? 0) > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-semibold uppercase tracking-wide text-amber-600">Uncovered routes</p>
                      <div className="rounded-md border border-amber-200 bg-amber-50 divide-y divide-amber-100">
                        {output.uncoveredRoutes!.map((r) => (
                          <div key={r} className="px-3 py-1.5 text-sm font-mono text-amber-800">{r}</div>
                        ))}
                      </div>
                    </div>
                  )}
                  {(output.discoveredRoutes?.length ?? 0) > 0 && (
                    <details className="text-xs text-slate-500 cursor-pointer">
                      <summary className="hover:text-slate-700">All discovered routes ({output.discoveredRoutes!.length})</summary>
                      <div className="mt-1 rounded border border-slate-200 divide-y divide-slate-100">
                        {output.discoveredRoutes!.map((r) => (
                          <div key={r.route} className="flex items-center gap-2 px-3 py-1">
                            <span className={r.reachable ? "text-emerald-600" : "text-rose-500"}>{r.status || "—"}</span>
                            <span className="font-mono">{r.route}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              );
            })()}

            {!isTerminal && (
              <p className="text-xs text-slate-400 animate-pulse">Polling for updates…</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Job history ──────────────────────────────────────────────────── */}
      {history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800 text-base">Recent jobs</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-slate-100">
              {history.map((j) => (
                <div
                  key={j.id}
                  className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <StatusBadge status={j.status} />
                    <div className="min-w-0">
                      <p className="text-sm text-slate-800 truncate">
                        {j.objective ?? <span className="text-slate-400 italic">No objective</span>}
                      </p>
                      <p className="text-xs text-slate-400 font-mono">
                        {j.id.slice(0, 8)}… · {fmtDate(j.createdAt)}
                      </p>
                      {j.tasks.some((t) => t.type === "repair" && taskTargetTitle(t)) && (
                        <p
                          className="truncate text-xs text-slate-500"
                          title={j.tasks
                            .filter((t) => t.type === "repair")
                            .map((t) => {
                              const title = taskTargetTitle(t);
                              const file = taskTargetFile(t);
                              return [title, file].filter(Boolean).join(" — ");
                            })
                            .filter(Boolean)
                            .join(", ")}
                        >
                          {(j.tasks
                            .filter((t) => t.type === "repair")
                            .map((t) => {
                              const title = taskTargetTitle(t);
                              const file = taskTargetFile(t);
                              return [title, file].filter(Boolean).join(" — ");
                            })
                            .filter(Boolean) as string[])
                            .slice(0, 2)
                            .join(" · ")}
                          {(j.tasks.filter((t) => t.type === "repair" && taskTargetTitle(t)).length > 2)
                            ? ` +${j.tasks.filter((t) => t.type === "repair" && taskTargetTitle(t)).length - 2} more`
                            : ""}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-3">
                    {j.tasks.some((t) => t.testRunId) && (
                      <a
                        href={`/test-runs/${j.tasks.find((t) => t.testRunId)!.testRunId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 hover:underline text-xs"
                      >
                        View run →
                      </a>
                    )}
                    <button
                      onClick={() => viewJob(j)}
                      className="text-xs text-slate-500 hover:text-slate-800 underline-offset-2 hover:underline"
                    >
                      Details
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Schedules ──────────────────────────────────────────────────────── */}
      {projectId && (
        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800 text-base">Scheduled runs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {schedules.length > 0 && (
              <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
                {schedules.map((s) => (
                  <div key={s.id} className="flex items-center justify-between px-3 py-2.5 text-sm">
                    <div>
                      <code className="font-mono text-xs text-slate-700">{s.cron}</code>
                      {s.lastRunAt && (
                        <p className="text-xs text-slate-400 mt-0.5">Last run: {new Date(s.lastRunAt).toLocaleString()}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleSchedule(s.id, !s.enabled)}
                        className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                          s.enabled
                            ? "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                            : "border-slate-300 bg-slate-50 text-slate-500 hover:bg-slate-100"
                        }`}
                      >
                        {s.enabled ? "Enabled" : "Disabled"}
                      </button>
                      <button
                        onClick={() => deleteSchedule(s.id, s.cron)}
                        className="text-slate-400 hover:text-rose-600 transition-colors"
                        title="Delete schedule"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {schedules.length === 0 && (
              <p className="text-sm text-slate-500">No schedules yet.</p>
            )}
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-700">Add schedule</p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setScheduleCron(p.value)}
                    className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                      scheduleCron === p.value
                        ? "border-slate-800 bg-slate-800 text-white"
                        : "border-slate-300 text-slate-600 hover:border-slate-500"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2 items-center">
                <Input
                  value={scheduleCron}
                  onChange={(e) => setScheduleCron(e.target.value)}
                  placeholder="cron expression (e.g. 0 9 * * 1)"
                  className="font-mono text-sm flex-1"
                />
                <Button
                  size="sm"
                  disabled={!scheduleCron.trim() || scheduleSubmitting}
                  onClick={createSchedule}
                >
                  {scheduleSubmitting ? "Saving…" : "Save"}
                </Button>
              </div>
              {scheduleErr && <p className="text-xs text-rose-600">{scheduleErr}</p>}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
