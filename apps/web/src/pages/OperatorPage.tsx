import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

type Project = { id: string; name: string };

type OperatorTask = {
  id: string;
  type: string;
  status: string;
  testRunId?: string | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
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
  tasks: OperatorTask[];
};

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

export default function OperatorPage() {
  const { apiFetch } = useApi();

  // form state
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
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

    fetchHistory();
    fetchApprovals();

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
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ job: OperatorJob }>("/operator/jobs", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          type: "qa",
          objective: objective.trim() || undefined,
          context: baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {},
        }),
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
          <div className="grid gap-3 md:grid-cols-2">
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
              <label className="text-sm font-medium text-slate-700">Objective (optional)</label>
              <Input
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder="e.g. Run smoke tests and report failures"
                className="bg-white"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Base URL (optional)</label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="e.g. https://www.justicepath.com"
              className="bg-white"
            />
          </div>
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

            {job.tasks.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tasks</p>
                <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
                  {job.tasks.map((task) => (
                    <div key={task.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div className="flex items-center gap-3">
                        <StatusBadge status={task.status} />
                        <span className="capitalize text-slate-700">{task.type}</span>
                      </div>
                      <div className="flex items-center gap-3">
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
    </div>
  );
}
