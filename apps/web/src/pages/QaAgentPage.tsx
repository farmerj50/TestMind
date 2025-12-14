import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

type Project = { id: string; name: string };
type QaJob = {
  id: string;
  projectId: string;
  baseUrl?: string;
  parallel?: boolean;
  includeApi?: boolean;
  status: "queued" | "running" | "succeeded" | "failed";
  runId?: string;
  apiRunId?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
};

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
  const [includeApi, setIncludeApi] = useState(false);
  const [job, setJob] = useState<QaJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

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

    apiFetch<{
      projects: Array<{ id: string; name: string; type: string; projectId?: string }>;
    }>("/tm/suite/projects")
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

  const startJob = async () => {
    if (!projectId) {
      setError("Pick a project first.");
      return;
    }
    if (!suiteId) {
      setError("Pick a suite (curated) to run.");
      return;
    }
    setError(null);
    try {
      const res = await apiFetch<{ job: QaJob }>("/qa-agent/start", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          suiteId,
          baseUrl: baseUrl.trim() || undefined,
          parallel,
          includeApi,
        }),
      });
      setJob(res.job);
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(() => {
        apiFetch<{ job: QaJob }>(`/qa-agent/jobs/${res.job.id}`)
          .then((j) => setJob(j.job))
          .catch(() => {});
      }, 1500);
    } catch (err: any) {
      setError(err?.message ?? "Failed to start QA agent");
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">QA Agent</p>
          <h1 className="text-2xl font-semibold text-slate-900">Run & heal tests</h1>
          <p className="text-sm text-slate-600">
            Start an automated QA job. It will run tests and report status (stubbed loop).
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
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Suite (curated)</label>
              <Select value={suiteId} onValueChange={setSuiteId}>
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder="Select suite" />
                </SelectTrigger>
                <SelectContent>
                  {suites.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
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
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={parallel}
                onChange={(e) => setParallel(e.target.checked)}
              />
              Run in parallel (set workers)
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={includeApi}
                onChange={(e) => setIncludeApi(e.target.checked)}
              />
              Include API run
            </label>
          </div>
          <Button
            onClick={startJob}
            className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
          >
            Start QA agent
          </Button>
        </CardContent>
      </Card>

      {job && (
        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800">Job status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
              <div className="flex flex-wrap gap-2">
                <div className="font-mono text-xs bg-slate-100 rounded px-2 py-1">#{job.id.slice(0, 8)}</div>
                <div>Status: <span className="font-semibold capitalize">{job.status}</span></div>
                {job.runId && (
                  <a className="text-blue-600 hover:underline" href={`/test-runs/${job.runId}`} target="_blank" rel="noreferrer">
                    View report
                  </a>
                )}
                {job.apiRunId && (
                  <a className="text-blue-600 hover:underline" href={`/test-runs/${job.apiRunId}`} target="_blank" rel="noreferrer">
                    API report
                  </a>
                )}
                {job.error && <div className="text-rose-600">Error: {job.error}</div>}
              </div>
            <div className="text-xs text-slate-500">
              Project: {selectedProject?.name || job.projectId} • Updated: {new Date(job.updatedAt).toLocaleString()}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
