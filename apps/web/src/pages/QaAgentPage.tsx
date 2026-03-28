import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

type Project = { id: string; name: string };

type TaskOutput = {
  runId?: string;
  finalStatus?: string;
  selfHealCount?: number;
  environmentCount?: number;
  productDefectCount?: number;
  classifications?: Array<{ id: string; title: string; category: string }>;
};

type QaTask = {
  id: string;
  type: "execute" | "triage" | "repair" | "retest" | "verify" | "discover";
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  testRunId?: string | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  outputJson?: TaskOutput | null;
};

type QaJob = {
  id: string;
  projectId: string;
  status: "queued" | "running" | "blocked" | "succeeded" | "failed" | "canceled";
  runId?: string | null;
  baseUrl?: string;
  parallel?: boolean;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
  tasks?: QaTask[];
};

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

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

const TASK_LABELS: Record<string, string> = {
  execute: "Execute tests",
  triage:  "Triage failures",
  repair:  "Self-heal",
  retest:  "Re-test",
  verify:  "Verify",
  discover: "Discover",
};

function TaskRow({ task }: { task: QaTask }) {
  const out = task.outputJson;
  return (
    <div className="flex flex-col gap-1 rounded border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/50">
      <div className="flex items-center gap-2">
        <StatusBadge status={task.status} />
        <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
          {TASK_LABELS[task.type] ?? task.type}
        </span>
        {task.testRunId && (
          <a
            href={`/test-runs/${task.testRunId}`}
            className="ml-auto text-xs text-blue-600 hover:underline dark:text-blue-400"
            target="_blank"
            rel="noreferrer"
          >
            View report
          </a>
        )}
      </div>

      {/* Triage summary */}
      {task.type === "triage" && out && (
        <div className="flex flex-wrap gap-3 text-xs text-slate-600 dark:text-slate-300 pl-1">
          {out.selfHealCount != null && (
            <span className="text-teal-700 dark:text-teal-400">
              {out.selfHealCount} self-healable
            </span>
          )}
          {out.environmentCount != null && out.environmentCount > 0 && (
            <span className="text-amber-700 dark:text-amber-400">
              {out.environmentCount} infra noise
            </span>
          )}
          {out.productDefectCount != null && out.productDefectCount > 0 && (
            <span className="text-rose-700 dark:text-rose-400">
              {out.productDefectCount} product defect
            </span>
          )}
        </div>
      )}

      {task.error && (
        <p className="text-xs text-rose-600 dark:text-rose-400 pl-1 line-clamp-2">{task.error}</p>
      )}
    </div>
  );
}

export default function QaAgentPage() {
  const { apiFetch } = useApi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [suites, setSuites] = useState<
    Array<{ id: string; name: string; type: string; projectId?: string }>
  >([]);
  const [projectId, setProjectId] = useState("");
  const [suiteId, setSuiteId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [parallel, setParallel] = useState(false);
  const [job, setJob] = useState<QaJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<number | null>(null);

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
    };
  }, [apiFetch, projectId, suiteId]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId]
  );

  const stopPoll = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const pollJob = (id: string) => {
    stopPoll();
    pollRef.current = window.setInterval(() => {
      apiFetch<{ job: QaJob }>(`/qa-agent/jobs/${id}`)
        .then((res) => {
          setJob(res.job);
          if (TERMINAL.has(res.job.status)) stopPoll();
        })
        .catch(() => {});
    }, 2000);
  };

  const startJob = async () => {
    if (!projectId) { setError("Pick a project first."); return; }
    if (!suiteId)   { setError("Pick a suite to run."); return; }
    setError(null);
    setStarting(true);
    try {
      const res = await apiFetch<{ job: QaJob }>("/qa-agent/start", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          suiteId,
          baseUrl: baseUrl.trim() || undefined,
          parallel,
        }),
      });
      setJob(res.job);
      pollJob(res.job.id);
    } catch (err: any) {
      setError(err?.message ?? "Failed to start QA agent");
    } finally {
      setStarting(false);
    }
  };

  const executeTasks = job?.tasks?.filter((t) => t.type === "execute") ?? [];
  const triageTasks  = job?.tasks?.filter((t) => t.type === "triage") ?? [];
  const repairTasks  = job?.tasks?.filter((t) => t.type === "repair") ?? [];

  return (
    <div className="p-6 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">QA Agent</p>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Run &amp; heal tests</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Runs your test suite through the operator — automatically triages failures and
          queues self-heal for selector / locator issues.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-900/20 dark:text-rose-400">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-slate-800 dark:text-slate-100">Start a QA job</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Project</label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="bg-white dark:bg-slate-800">
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
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">Suite (curated)</label>
              <Select value={suiteId} onValueChange={setSuiteId}>
                <SelectTrigger className="bg-white dark:bg-slate-800">
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
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Base URL <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://app.yoursite.com"
                className="bg-white dark:bg-slate-800"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={parallel}
              onChange={(e) => setParallel(e.target.checked)}
            />
            Run tests in parallel
          </label>
          <Button
            onClick={startJob}
            disabled={starting}
            className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
          >
            {starting ? "Starting…" : "Start QA agent"}
          </Button>
        </CardContent>
      </Card>

      {job && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-slate-800 dark:text-slate-100">Job status</CardTitle>
              <div className="flex items-center gap-2">
                <StatusBadge status={job.status} />
                <span className="font-mono text-xs text-slate-400">#{job.id.slice(0, 8)}</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <span>Project: <span className="text-slate-700 dark:text-slate-300">{selectedProject?.name || job.projectId}</span></span>
              {job.baseUrl && <span>URL: <span className="text-slate-700 dark:text-slate-300">{job.baseUrl}</span></span>}
              <span>Started: <span className="text-slate-700 dark:text-slate-300">{new Date(job.createdAt).toLocaleString()}</span></span>
              {TERMINAL.has(job.status) && (
                <span>Finished: <span className="text-slate-700 dark:text-slate-300">{new Date(job.updatedAt).toLocaleString()}</span></span>
              )}
            </div>

            {job.error && (
              <p className="text-sm text-rose-600 dark:text-rose-400">{job.error}</p>
            )}

            {/* Task timeline */}
            {job.tasks && job.tasks.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Task timeline
                </p>

                {executeTasks.length > 0 && (
                  <div className="space-y-1">
                    {executeTasks.map((t) => <TaskRow key={t.id} task={t} />)}
                  </div>
                )}

                {triageTasks.length > 0 && (
                  <div className="space-y-1">
                    {triageTasks.map((t) => <TaskRow key={t.id} task={t} />)}
                  </div>
                )}

                {repairTasks.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-slate-500 dark:text-slate-400 pl-1">
                      Self-heal ({repairTasks.filter((t) => t.status === "succeeded").length}/
                      {repairTasks.length} healed)
                    </p>
                    {repairTasks.map((t) => <TaskRow key={t.id} task={t} />)}
                  </div>
                )}

                {job.tasks.filter((t) => !["execute","triage","repair"].includes(t.type)).map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </div>
            )}

            {/* Primary run report link (surfaced from latest execute task) */}
            {job.runId && (
              <a
                href={`/test-runs/${job.runId}`}
                className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
                target="_blank"
                rel="noreferrer"
              >
                View full test report →
              </a>
            )}

            {!TERMINAL.has(job.status) && (
              <p className="text-xs text-slate-400 animate-pulse">Polling for updates…</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
