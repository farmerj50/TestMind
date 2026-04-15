import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

type Project = { id: string; name: string; repoUrl?: string | null };

type QaTask = {
  id: string;
  type: "execute" | "triage" | "repair" | "verify" | string;
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
  createdAt: string;
  updatedAt: string;
  tasks?: QaTask[];
};

const TASK_LABELS: Record<string, string> = {
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
    if (!suiteId) { setError("Pick a suite to run."); return; }
    setError(null);
    try {
      const res = await apiFetch<{ job: QaJob }>("/qa-agent/start", {
        method: "POST",
        body: JSON.stringify({ projectId, suiteId, baseUrl: baseUrl.trim() || undefined, parallel }),
      });
      setJob(res.job);
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(() => {
        apiFetch<{ job: QaJob }>(`/qa-agent/jobs/${res.job.id}`)
          .then((j) => {
            setJob(j.job);
            if (j.job.status === "succeeded" || j.job.status === "failed") {
              if (pollRef.current) window.clearInterval(pollRef.current);
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
        <h1 className="text-2xl font-semibold text-slate-900">Autonomous QA Execution</h1>
        <p className="text-sm text-slate-600 mt-1">
          Runs your test suite, classifies failures, routes self-healable issues to AI repair, and surfaces product defects for developer review.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-slate-800">Start a QA job</CardTitle>
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
              <label className="text-sm font-medium text-slate-700">Suite</label>
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
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={parallel} onChange={(e) => setParallel(e.target.checked)} />
            Run tests in parallel
          </label>
          <Button
            onClick={startJob}
            disabled={isActive}
            className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
          >
            {isActive ? "Running…" : "Start QA agent"}
          </Button>
        </CardContent>
      </Card>

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
                <a href={`/test-runs/${job.runId}`} target="_blank" rel="noreferrer"
                  className="text-blue-600 hover:underline">
                  View run report
                </a>
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
  );
}
