import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "../components/ui/select";
import { Loader2, RefreshCw } from "lucide-react";

type Project = {
  id: string;
  name: string;
  repoUrl: string;
};

type AgentScenario = {
  id: string;
  title: string;
  coverageType: string;
  description?: string;
  risk?: string;
  status: "suggested" | "accepted" | "rejected" | "completed";
  specPath?: string | null;
};

type AgentPage = {
  id: string;
  path: string;
  url: string;
  status: string;
  summary?: string;
  error?: string | null;
  coverage?: Record<string, number>;
  scenarios: AgentScenario[];
};

type AgentSession = {
  id: string;
  name?: string | null;
  projectId?: string | null;
  baseUrl: string;
  instructions?: string | null;
  status: string;
  pages: AgentPage[];
  coverage?: {
    coverageTotals: Record<string, number>;
    completedPages: number;
    failedPages: number;
    pageCount: number;
  };
};

const baseUrlKey = (projectId: string) => `agent:baseUrl:${projectId}`;

export default function AgentScanPage() {
  const { apiFetch } = useApi();
  const [searchParams] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [session, setSession] = useState<AgentSession | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [pageInput, setPageInput] = useState("/");
  const [instructions, setInstructions] = useState("");
  const [loadingSession, setLoadingSession] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [attachBusy, setAttachBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectSessions, setProjectSessions] = useState<AgentSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [busyGenerateAll, setBusyGenerateAll] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<{ projects: Project[] }>("/projects");
        // Agent scan requires real projects (FK in DB). Do not merge curated suites here.
        setProjects(data.projects);
        const fromQuery = searchParams.get("projectId");
        if (fromQuery && data.projects.some((p) => p.id === fromQuery)) {
          setSelectedProject(fromQuery);
        } else if (data.projects.length) {
          setSelectedProject(data.projects[0].id);
        }
      } catch (err: any) {
        setError(err?.message ?? "Failed to load projects");
      }
    })();
  }, [apiFetch, searchParams]);

  useEffect(() => {
    if (!selectedProject) return;
    const stored = localStorage.getItem(baseUrlKey(selectedProject)) || "";
    setBaseUrl(stored);
    fetchSession(selectedProject);
    fetchSessionsForProject(selectedProject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject]);

  async function fetchSession(projectId: string, opts?: { silent?: boolean }) {
    if (!opts?.silent) setLoadingSession(true);
    try {
      const { session } = await apiFetch<{ session: AgentSession | null }>(
        `/tm/agent/projects/${projectId}/session`
      );
      setSession(session);
      if (session?.baseUrl) {
        setBaseUrl(session.baseUrl);
      } else {
        const stored = localStorage.getItem(baseUrlKey(projectId)) || "";
        setBaseUrl(stored);
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to load session");
      setSession(null);
    } finally {
      if (!opts?.silent) setLoadingSession(false);
    }
  }

  async function fetchSessionsForProject(projectId: string) {
    try {
      const res = await apiFetch<{ sessions: AgentSession[] }>("/tm/agent/sessions");
      const filtered = res.sessions.filter((s) => s.projectId === projectId);
      setProjectSessions(filtered);
      if (filtered.length && !selectedSessionId) {
        setSelectedSessionId(filtered[0].id);
      }
    } catch {
      // ignore
    }
  }

  async function loadSelectedSession() {
    if (!selectedSessionId) return;
    setLoadingSession(true);
    setError(null);
    try {
      const res = await apiFetch<{ session: { session: AgentSession } | AgentSession | null }>(
        `/tm/agent/sessions/${selectedSessionId}`
      );
      const sess = (res as any).session?.session || (res as any).session || res;
      setSession(sess);
      if (sess?.baseUrl) {
        setBaseUrl(sess.baseUrl);
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to load session");
      setSession(null);
    } finally {
      setLoadingSession(false);
    }
  }

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects]
  );

  const hasInProgress = useMemo(
    () => !!session?.pages.some((p) => p.status !== "completed" && p.status !== "failed"),
    [session]
  );

  useEffect(() => {
    if (!selectedProject || !hasInProgress) return;
    const id = setInterval(() => {
      fetchSession(selectedProject, { silent: true });
    }, 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject, hasInProgress]);

  async function handleScan(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProject) return;
    const trimmedBase = baseUrl.trim();
    const target = pageInput.trim() || "/";
    if (!trimmedBase) {
      setError("Enter a base URL to scan.");
      return;
    }

    const body: Record<string, string> = {
      baseUrl: trimmedBase,
    };
    if (/^https?:\/\//i.test(target)) body.url = target;
    else body.path = target.startsWith("/") ? target : `/${target}`;
    if (instructions.trim()) body.instructions = instructions.trim();

    setScanning(true);
    setError(null);
    try {
      const { session } = await apiFetch<{ session: AgentSession }>(
        `/tm/agent/projects/${selectedProject}/scans`,
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );
      setSession(session);
      localStorage.setItem(baseUrlKey(selectedProject), trimmedBase);
      setPageInput("");
    } catch (err: any) {
      setError(err?.message ?? "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  async function attachScenario(scenarioId: string) {
    if (!selectedProject) return;
    setAttachBusy(scenarioId);
    try {
      await apiFetch(`/tm/agent/scenarios/${scenarioId}/attach`, {
        method: "POST",
        body: JSON.stringify({ projectId: selectedProject }),
      });
      await fetchSession(selectedProject);
      // auto-generate test after attach
      await apiFetch(`/agent/scenarios/${scenarioId}/generate-test`, {
        method: "POST",
      });
      await fetchSession(selectedProject, { silent: true });
    } catch (err: any) {
      setError(err?.message ?? "Attach failed");
    } finally {
      setAttachBusy(null);
    }
  }

  async function handleCreateProject() {
    if (!baseUrl.trim()) {
      setError("Enter a Base URL first to create a project.");
      return;
    }
    const name = new URL(baseUrl).hostname || baseUrl;
    setCreatingProject(true);
    setError(null);
    try {
      await apiFetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name, repoUrl: baseUrl.trim() }),
      });
      // reload projects and select the newly created one
      const data = await apiFetch<{ projects: Project[] }>("/projects");
      setProjects(data.projects);
      const created = data.projects.find((p) => p.repoUrl === baseUrl.trim()) || data.projects[0];
      if (created) setSelectedProject(created.id);
    } catch (err: any) {
      setError(err?.message ?? "Failed to create project");
    } finally {
      setCreatingProject(false);
    }
  }

  return (
    <div className="px-4 py-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            AI Page Scanner
          </h1>
          <p className="text-sm text-slate-600">
            Crawl a page, generate exhaustive scenarios, and add them to a
            project.
          </p>
        </div>
        {selectedProject && (
          <Link
            to={`/projects/${selectedProject}`}
            className="text-sm text-slate-600 underline"
          >
            View project runs
          </Link>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Scan a page</CardTitle>
          <CardDescription>
            Choose a project, set the site base URL once, then scan pages as
            needed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleScan}>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-slate-700">
                Project
              </label>
              <div className="flex items-center gap-2">
                <Select
                  value={selectedProject}
                  onValueChange={(val) => setSelectedProject(val)}
                >
                  <SelectTrigger className="min-w-[200px]" />
                  <SelectContent>
                    {sortedProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCreateProject}
                  disabled={creatingProject}
                  title="Create a project using the Base URL as repoUrl"
                >
                  {creatingProject ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating...
                    </>
                  ) : (
                    "New project from Base URL"
                  )}
                </Button>
              </div>
            </div>

            {projectSessions.length > 0 && (
              <div className="grid gap-2">
                <label className="text-sm font-medium text-slate-700">Existing session</label>
                <div className="flex items-center gap-2">
                  <select
                    className="min-w-[200px] rounded-md border border-slate-200 px-3 py-2 text-sm"
                    value={selectedSessionId}
                    onChange={(e) => setSelectedSessionId(e.target.value)}
                  >
                    {projectSessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name || "Session"} — {s.status}
                      </option>
                    ))}
                  </select>
                  <Button type="button" size="sm" variant="outline" onClick={loadSelectedSession}>
                    Load session
                  </Button>
                </div>
              </div>
            )}

            <div className="grid gap-2">
              <label className="text-sm font-medium text-slate-700">
                Base URL
              </label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://app.yoursite.com"
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium text-slate-700">
                Page URL or path
              </label>
              <Input
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
                placeholder="/dashboard or https://example.com/dashboard"
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium text-slate-700">
                Instructions (optional)
              </label>
              <textarea
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                rows={3}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Highlight specific flows, risk areas, etc."
              />
            </div>

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={scanning || !selectedProject}>
                {scanning ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Scanningï¿½?ï¿½
                  </>
                ) : (
                  "Scan page"
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => fetchSession(selectedProject)}
                disabled={!selectedProject || loadingSession}
                title="Refresh session"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent scans</CardTitle>
          <CardDescription>
            Attach any promising scenario to the project to include it in the
            next run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {session?.coverage && (
            <div className="flex flex-wrap gap-3 text-xs text-slate-600">
              <span>
                Pages:{" "}
                <strong className="text-slate-800">
                  {session.coverage.completedPages}/{session.coverage.pageCount}
                </strong>{" "}
                completed
              </span>
              {session.coverage.failedPages > 0 && (
                <span className="text-rose-600">
                  Failed: {session.coverage.failedPages}
                </span>
              )}
              {Object.entries(session.coverage.coverageTotals).map(([key, value]) => (
                <span key={key}>
                  {key}: <strong className="text-slate-800">{value as number}</strong>
                </span>
              ))}
            </div>
          )}
          {session && session.pages.length > 0 && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 text-xs font-medium text-slate-700">Page map</div>
              <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                {session.pages.map((page) => (
                  <div key={page.id} className="rounded border border-slate-200 bg-white px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-slate-900 truncate">
                      {page.path || page.url}
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          page.status === "completed"
                            ? "bg-emerald-50 text-emerald-700"
                            : page.status === "failed"
                            ? "bg-rose-50 text-rose-700"
                            : "bg-slate-100 text-slate-700"
                        }`}
                    >
                      {page.status}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => apiFetch(`/tm/agent/pages/${page.id}/run`, { method: "POST" }).then(()=>fetchSession(selectedProject,{silent:true}))}>
                      Run page
                    </Button>
                  </div>
                    {page.coverage && (
                      <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-slate-600">
                        {Object.entries(page.coverage).map(([k, v]) => (
                          <span key={k}>
                            {k}: <strong className="text-slate-800">{v as number}</strong>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-1 text-[10px] text-slate-500">
                      {page.scenarios.length} scenario{page.scenarios.length === 1 ? "" : "s"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {loadingSession ? (
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading session...
            </div>
          ) : !session ? (
            <p className="text-sm text-slate-500">
              No scans yet. Submit the form above to generate scenarios.
            </p>
          ) : session.pages.length === 0 ? (
            <p className="text-sm text-slate-500">No pages scanned yet.</p>
          ) : (
            session.pages.map((page) => (
              <div key={page.id} className="rounded-lg border p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">
                      {page.path}
                    </div>
                    <div className="text-xs text-slate-500 break-all">
                      {page.url}
                    </div>
                  </div>
                  <span
                    className={`rounded-full px-3 py-0.5 text-xs font-medium ${
                      page.status === "completed"
                        ? "bg-emerald-50 text-emerald-700"
                        : page.status === "failed"
                        ? "bg-rose-50 text-rose-700"
                        : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {page.status}
                  </span>
                </div>
                {page.summary && (
                  <p className="text-sm text-slate-600">{page.summary}</p>
                )}
                {page.coverage && (
                  <div className="flex flex-wrap gap-4 text-xs text-slate-500">
                    {Object.entries(page.coverage).map(([key, value]) => (
                      <span key={key}>
                        {key}:{" "}
                        <strong className="text-slate-700">
                          {value as number}
                        </strong>
                      </span>
                    ))}
                  </div>
                )}
                {page.error && (
                  <p className="text-xs text-rose-600">{page.error}</p>
                )}
                <div className="flex flex-wrap gap-2 text-xs mb-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => apiFetch(`/tm/agent/pages/${page.id}/run`, { method: "POST" }).then(()=>fetchSession(selectedProject,{silent:true}))}
                    disabled={busyGenerateAll === page.id}
                  >
                    Run page
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyGenerateAll === page.id}
                    onClick={() => generateAllAccepted(page)}
                  >
                    {busyGenerateAll === page.id ? "Generating…" : "Generate all accepted"}
                  </Button>
                </div>

                <div className="space-y-2">
                  {page.scenarios.length === 0 ? (
                    <p className="text-xs text-slate-500">
                      No scenarios generated.
                    </p>
                  ) : (
                    page.scenarios.map((scenario) => (
                      <div
                        key={scenario.id}
                        className="rounded-md border px-3 py-2"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-slate-900">
                              {scenario.title}
                            </div>
                            <div className="text-xs text-slate-500">
                              {scenario.coverageType} - {scenario.status}
                            </div>
                            {scenario.description && (
                              <p className="text-xs text-slate-600 mt-1">
                                {scenario.description}
                              </p>
                            )}
                          </div>
                          <Button
                            size="sm"
                            variant={
                              scenario.status === "accepted"
                                ? "secondary"
                                : "outline"
                            }
                            disabled={
                              scenario.status === "accepted" ||
                              attachBusy === scenario.id
                            }
                            onClick={() => attachScenario(scenario.id)}
                          >
                            {scenario.status === "accepted"
                              ? scenario.specPath
                                ? "Test generated"
                                : "Added"
                              : attachBusy === scenario.id
                              ? "Adding..."
                              : "Add to suite"}
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}



