import { useEffect, useRef, useState } from "react";
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

export default function OperatorPage() {
  const { apiFetch } = useApi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [objective, setObjective] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [job, setJob] = useState<OperatorJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    apiFetch<{ projects: Project[] }>("/projects")
      .then((res) => {
        if (!mounted) return;
        setProjects(res.projects ?? []);
        if (res.projects?.length && !projectId) setProjectId(res.projects[0].id);
      })
      .catch(() => {});
    return () => {
      mounted = false;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [apiFetch, projectId]);

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
        if (res.job.status === "succeeded" || res.job.status === "failed" || res.job.status === "canceled") {
          stopPolling();
        }
      } catch {
        // keep polling on transient errors
      }
    }, 2000);
  };

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
      startPolling(res.job.id);
    } catch (err: any) {
      setError(err?.message ?? "Failed to start operator job");
    } finally {
      setSubmitting(false);
    }
  };

  const isTerminal = job && ["succeeded", "failed", "canceled"].includes(job.status);

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
              <span>Started: <span className="font-medium">{job.startedAt ? new Date(job.startedAt).toLocaleTimeString() : "—"}</span></span>
              {job.finishedAt && (
                <span>Finished: <span className="font-medium">{new Date(job.finishedAt).toLocaleTimeString()}</span></span>
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
    </div>
  );
}
