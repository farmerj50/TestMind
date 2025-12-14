import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

type Project = { id: string; name: string };
type SecurityJob = {
  id: string;
  projectId: string;
  status: "queued" | "running" | "completed" | "failed";
  phase?: string | null;
  summary?: any;
  createdAt: string;
  updatedAt: string;
  findings?: SecurityFinding[];
  error?: string | null;
};

type SecurityFinding = {
  id: string;
  type: string;
  severity: string;
  title: string;
  description?: string | null;
  location?: string | null;
  tool?: string | null;
};

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
  const [baseUrl, setBaseUrl] = useState("");
  const [allowedHosts, setAllowedHosts] = useState("");
  const [allowedPorts, setAllowedPorts] = useState("80,443");
  const [maxDuration, setMaxDuration] = useState(10);
  const [enableActive, setEnableActive] = useState(false);
  const [job, setJob] = useState<SecurityJob | null>(null);
  const [recent, setRecent] = useState<SecurityJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const pollFailures = useRef<number>(0);
  const [selectedFinding, setSelectedFinding] = useState<SecurityFinding | null>(null);
  const [findingExplain, setFindingExplain] = useState<string>("");
  const [findingTest, setFindingTest] = useState<string>("");
  const [findingLoading, setFindingLoading] = useState<{ explain?: boolean; test?: boolean }>({});
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
    };
  }, [apiFetch]);

  // load recent scans when project changes
  useEffect(() => {
    if (!projectId) return;
    apiFetch<{ jobs: SecurityJob[] }>(`/security/scans?projectId=${projectId}`)
      .then((res) => setRecent(uniqByPage(res.jobs || [])))
      .catch(() => {});
  }, [apiFetch, projectId]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId]
  );

  const pollJob = (jobId: string) => {
    stopPolling();
    pollRef.current = window.setInterval(() => {
      apiFetch<{ job: SecurityJob }>(`/security/scans/${jobId}`)
        .then((res) => {
          setJob(res.job);
          pollFailures.current = 0;
          if (res.job.status === "completed" || res.job.status === "failed") {
            stopPolling();
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

  const startScan = async () => {
    if (!projectId) {
      setError("Pick a project first.");
      return;
    }
    if (!baseUrl.trim()) {
      setError("Base URL is required.");
      return;
    }
    setError(null);
    try {
      const res = await apiFetch<{ job: SecurityJob }>("/security/scans", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          baseUrl: baseUrl.trim(),
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
          <h1 className="text-2xl font-semibold text-slate-900">Run a security scan</h1>
          <p className="text-sm text-slate-600">
            Scope a scan for your project. Active checks stay within allowed hosts/ports.
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

          <div className="grid gap-3 md:grid-cols-2">
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
              <label className="text-sm font-medium text-slate-700">Active checks</label>
              <div className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={enableActive}
                  onChange={(e) => setEnableActive(e.target.checked)}
                />
                <span>Allow limited active checks (headers/cookies/XSS baseline)</span>
              </div>
            </div>
          </div>

          <Button
            onClick={startScan}
            className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
          >
            Run security scan
          </Button>
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
              {job.phase && <span className="text-slate-600">Phase: {job.phase}</span>}
              <span className="text-xs text-slate-500">
                Updated {new Date(job.updatedAt).toLocaleString()}
              </span>
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
                        setFindingExplain("");
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
          <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full mx-4 p-4 space-y-3">
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
                  setFindingExplain("");
                  try {
                    const res = await apiFetch<{ detail: { repro: string; mitigation: string; cve?: string | null } }>(
                      `/security/findings/${selectedFinding.id}/explain`,
                      { method: "POST" }
                    );
                    const lines = [
                      res.detail.cve ? `CVE: ${res.detail.cve}` : "",
                      `How to reproduce: ${res.detail.repro}`,
                      `Mitigation: ${res.detail.mitigation}`,
                    ]
                      .filter(Boolean)
                      .join("\n");
                    setFindingExplain(lines);
                  } catch (err: any) {
                    setFindingExplain(err?.message ?? "Failed to load explanation.");
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
            </div>
            {(findingExplain || findingTest) && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 space-y-3 text-sm font-mono whitespace-pre-wrap">
                {findingExplain && (
                  <div>
                    <div className="text-xs uppercase text-slate-500 mb-1">Explain / Mitigate</div>
                    {findingExplain}
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
