import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useApi } from "../lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Loader2, RefreshCw } from "lucide-react";
import { Checkbox } from "../components/ui/checkbox";
import HowToHint from "../components/HowToHint";

type Scenario = {
  id: string;
  title: string;
  coverageType: string;
  status: string;
  specPath?: string | null;
  description?: string | null;
  steps?: Array<{ kind: string; target?: string; value?: string; url?: string; selector?: string }>;
};

type Page = {
  id: string;
  path: string;
  url: string;
  status: string;
  summary?: string | null;
  coverage?: Record<string, number>;
  error?: string | null;
  scenarios: Scenario[];
  sessionId?: string;
};

type Session = {
  id: string;
  name?: string | null;
  baseUrl: string;
  status: string;
  projectId?: string | null;
  pages: Page[];
};

export default function AgentSessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { apiFetch } = useApi();
const [session, setSession] = useState<Session | null>(null);
const [loading, setLoading] = useState(false);
const [error, setError] = useState<string | null>(null);
const [busyScenario, setBusyScenario] = useState<string | null>(null);
const [busyPage, setBusyPage] = useState<string | null>(null);
const [busyGenerateAll, setBusyGenerateAll] = useState<string | null>(null);
const [filterAccepted, setFilterAccepted] = useState(true);
const [filterSuggested, setFilterSuggested] = useState(true);
const [filterRejected, setFilterRejected] = useState(true);
const [filterCompleted, setFilterCompleted] = useState(true);
const [autoRefresh, setAutoRefresh] = useState(true);
  const [runInfo, setRunInfo] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"pages" | "scenarios" | "activity">("pages");
  const [selectedScenario, setSelectedScenario] = useState<{ scenario: Scenario; page: Page } | null>(null);
  const [busyRunScenario, setBusyRunScenario] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<
    Array<{ id: string; status: string; createdAt: string; error?: string | null }>
  >([]);
  const [runPanelOpen, setRunPanelOpen] = useState(true);
  const hasInFlightRuns = useMemo(
    () => recentRuns.some((r) => r.status === "running" || r.status === "queued"),
    [recentRuns]
  );

  const hasRunning = useMemo(
    () => !!session?.pages.some((p) => p.status !== "completed" && p.status !== "failed"),
    [session]
  );

  useEffect(() => {
    if (!id) return;
    load();
  }, [id]);

  useEffect(() => {
    if (!autoRefresh || !hasRunning || !id) return;
    const t = setInterval(() => load(true), 4000);
    return () => clearInterval(t);
  }, [autoRefresh, hasRunning, id]);

  // Poll run status while any recent run is in-flight (even if pages are already completed)
  useEffect(() => {
    if (!autoRefresh || !session?.projectId) return;
    if (!hasInFlightRuns) return;
    const t = setInterval(() => loadRecentRuns(session.projectId, true), 4000);
    return () => clearInterval(t);
  }, [autoRefresh, session?.projectId, hasInFlightRuns]);

  async function load(silent = false) {
    if (!id) return;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ session: Session | null }>(`/tm/agent/sessions/${id}`);
      setSession(res.session);
      await loadRecentRuns(res.session?.projectId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load session");
      setSession(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  function activityItems() {
    if (!session) return [];
    const items: Array<{ label: string; detail?: string }> = [];
    items.push({ label: `Session status: ${session.status}` });
    session.pages.forEach((p) => {
      items.push({ label: `Page ${p.path || p.url} status: ${p.status}`, detail: p.error || undefined });
      p.scenarios.forEach((s) => {
        items.push({
          label: `Scenario "${s.title}" status: ${s.status}`,
          detail: s.specPath ? `spec: ${s.specPath}` : undefined,
        });
      });
    });
    return items.slice(0, 30); // avoid huge lists
  }

  async function startSession() {
    if (!id) return;
    setError(null);
    setLoading(true);
    try {
      await apiFetch(`/tm/agent/sessions/${id}/start`, { method: "POST" });
      await load();
    } catch (err: any) {
      setError(err?.message ?? "Failed to start");
    } finally {
      setLoading(false);
    }
  }

  async function runPage(pageId: string) {
    if (!session?.projectId) {
      setError("Attach the session to a project before running.");
      return;
    }
    const page = session.pages.find((p) => p.id === pageId);
    if (!page) {
      setError("Page not found in session.");
      return;
    }

    setBusyPage(pageId);
    setError(null);
    try {
      // kick off a fresh page analysis (optional; keeps page status current)
      await apiFetch(`/tm/agent/pages/${pageId}/run`, { method: "POST" }).catch(() => {});

      // run all scenarios for this page that already have specs
      const runnable = page.scenarios.filter((s) => s.specPath);
      if (runnable.length === 0) {
        setRunInfo("Generate tests before running this page.");
      } else {
        for (const sc of runnable) {
          await apiFetch("/runner/run", {
            method: "POST",
            body: JSON.stringify({ projectId: session.projectId, specPath: sc.specPath }),
          });
        }
        setRunInfo(`Triggered ${runnable.length} run(s) for this page.`);
        await loadRecentRuns(session.projectId);
      }

      // optimistically mark page running
      setSession((prev) =>
        prev
          ? {
              ...prev,
              pages: prev.pages.map((p) =>
                p.id === pageId ? { ...p, status: "running", error: null } : p
              ),
            }
          : prev
      );
      await load(true);
    } catch (err: any) {
      setError(err?.message ?? "Failed to run page");
    } finally {
      setBusyPage(null);
    }
  }

  async function attachAndGenerate(scenarioId: string) {
    if (!session?.projectId) {
      setError("Attach the session to a project before generating tests.");
      return;
    }
    setBusyScenario(scenarioId);
    setError(null);
    try {
      await apiFetch(`/tm/agent/scenarios/${scenarioId}/attach`, {
        method: "POST",
        body: JSON.stringify({ projectId: session.projectId }),
      });
      await apiFetch(`/agent/scenarios/${scenarioId}/generate-test`, { method: "POST" });
      await load(true);
    } catch (err: any) {
      setError(err?.message ?? "Failed to generate test");
    } finally {
      setBusyScenario(null);
    }
  }

  function filteredScenarios(list: Scenario[]) {
    return list.filter((sc) => {
      if (sc.status === "accepted" && !filterAccepted) return false;
      if (sc.status === "suggested" && !filterSuggested) return false;
      if (sc.status === "rejected" && !filterRejected) return false;
      if (sc.status === "completed" && !filterCompleted) return false;
      return true;
    });
  }

  async function loadRecentRuns(projectId?: string | null, silent = false) {
    if (!projectId) return;
    try {
      const res = await apiFetch<{ runs: Array<{ id: string; status: string; createdAt: string; error?: string | null }> }>(
        `/projects/${projectId}/test-runs`
      );
      const latest = res.runs.slice(0, 5);

      // Proactively refresh any in-flight runs so the UI reflects completion without waiting for the next poll
      const withDetails = await Promise.all(
        latest.map(async (run) => {
          if (run.status !== "running" && run.status !== "queued") return run;
          try {
            const detail = await apiFetch<{ run: { status: string } }>(`/runner/test-runs/${run.id}`, {
              method: "GET",
              auth: "include",
            });
            const updatedStatus =
              (detail as any)?.status ||
              (detail as any)?.run?.status ||
              (detail as any)?.run?.status === "" ? (detail as any)?.run?.status : undefined;
            return updatedStatus ? { ...run, status: updatedStatus } : run;
          } catch {
            return run;
          }
        })
      );

      setRecentRuns(withDetails);
    } catch {
      // ignore
    }
  }

  async function runScenario(scenarioId: string) {
    if (!session?.projectId) {
      setError("Attach the session to a project before running.");
      return;
    }
    setBusyRunScenario(scenarioId);
    setError(null);
    setRunInfo("Run triggered. Check recent runs for status.");
    try {
      const spec = session.pages.flatMap((p) => p.scenarios).find((s) => s.id === scenarioId)?.specPath;
      if (!spec) {
        setError("Generate the test first before running.");
        return;
      }
      await apiFetch("/runner/run", {
        method: "POST",
        body: JSON.stringify({ projectId: session.projectId, specPath: spec }),
      });
      await loadRecentRuns(session.projectId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to run scenario");
    } finally {
      setBusyRunScenario(null);
    }
  }

  async function generateAllAccepted(page: Page) {
    if (!session?.projectId) {
      setError("Attach the session to a project before generating tests.");
      return;
    }
    const toGenerate = page.scenarios.filter((s) => s.status === "accepted" && !s.specPath);
    if (toGenerate.length === 0) {
      setRunInfo("No accepted scenarios needing generation on this page.");
      return;
    }
    setBusyGenerateAll(page.id);
    setError(null);
    try {
      for (const sc of toGenerate) {
        // Ensure attached to project, then generate
        await apiFetch(`/tm/agent/scenarios/${sc.id}/attach`, {
          method: "POST",
          body: JSON.stringify({ projectId: session.projectId }),
        });
        await apiFetch(`/agent/scenarios/${sc.id}/generate-test`, { method: "POST" });
      }
      await load(true);
      setRunInfo(`Generated ${toGenerate.length} test(s) for accepted scenarios.`);
      await loadRecentRuns(session.projectId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to generate tests");
    } finally {
      setBusyGenerateAll(null);
    }
  }

  return (
    <div className="px-4 py-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Agent session</h1>
          <p className="text-sm text-slate-600">View pages and scenarios for this session.</p>
          {session && (
            <div className="text-xs text-slate-500 break-all">{session.baseUrl}</div>
          )}
        </div>
        <HowToHint
          storageKey="tm-howto-agent-session"
          title="How to use Agent sessions"
          steps={[
            "Add or scan pages to discover scenarios.",
            "Attach & generate to push scenarios into the agent curated suite.",
            "Run scenario or Run page to trigger tests; check Reports for status.",
            "Edit generated specs later via the Suites editor when needed.",
          ]}
        />
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setAutoRefresh((v) => !v)}>
            <span className="text-xs">{autoRefresh ? "⏸ Auto-refresh" : "▶ Auto-refresh"}</span>
          </Button>
          <Button variant="outline" onClick={() => load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button onClick={startSession} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Starting…
              </>
            ) : (
              "Start / Restart"
            )}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}
      {runInfo && (
        <div className="rounded-md border border-sky-200 bg-sky-50 px-4 py-3 space-y-2 text-sm text-slate-700">
          <div className="flex items-center justify-between">
            <span>{runInfo}</span>
            <Link
              to="/reports"
              className="text-blue-600 underline text-xs"
            >
              View reports
            </Link>
          </div>
          {recentRuns.length > 0 && (
            <div className="text-xs text-slate-600">
              Recent runs:
              <ul className="mt-1 space-y-1">
                {recentRuns.slice(0, 3).map((r) => (
                  <li key={r.id} className="flex justify-between">
                    <span>{new Date(r.createdAt).toLocaleTimeString()}</span>
                    <span
                      className={
                        r.status === "succeeded"
                          ? "text-emerald-700"
                          : r.status === "failed"
                          ? "text-rose-700"
                          : "text-slate-700"
                      }
                    >
                      {r.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {loading && !session ? (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading session…
        </div>
      ) : !session ? (
        <p className="text-sm text-slate-600">Session not found.</p>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Badge className="border-slate-200 text-slate-800">{session.status}</Badge>
                {session.projectId && (
                  <Link to={`/projects/${session.projectId}`} className="text-sm text-slate-600 underline">
                    View project
                  </Link>
                )}
              </CardTitle>
              <div className="mt-2 flex flex-wrap gap-3 text-sm text-slate-600">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={filterAccepted}
                    onCheckedChange={(v) => setFilterAccepted(!!v)}
                    id="filter-accepted"
                  />
                  <label htmlFor="filter-accepted" className="text-xs text-slate-700">
                    Accepted
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={filterSuggested}
                    onCheckedChange={(v) => setFilterSuggested(!!v)}
                    id="filter-suggested"
                  />
                  <label htmlFor="filter-suggested" className="text-xs text-slate-700">
                    Suggested
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={filterRejected}
                    onCheckedChange={(v) => setFilterRejected(!!v)}
                    id="filter-rejected"
                  />
                  <label htmlFor="filter-rejected" className="text-xs text-slate-700">
                    Rejected
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={filterCompleted}
                    onCheckedChange={(v) => setFilterCompleted(!!v)}
                    id="filter-completed"
                  />
                  <label htmlFor="filter-completed" className="text-xs text-slate-700">
                    Completed
                  </label>
                </div>
              </div>
              </CardHeader>
            <CardContent>
              <div className="flex gap-4 mb-3">
                <Button
                  size="sm"
                  variant={activeTab === "pages" ? "secondary" : "outline"}
                  onClick={() => setActiveTab("pages")}
                >
                  Pages
                </Button>
                <Button
                  size="sm"
                  variant={activeTab === "scenarios" ? "secondary" : "outline"}
                  onClick={() => setActiveTab("scenarios")}
                >
                  Scenarios
                </Button>
                <Button
                  size="sm"
                  variant={activeTab === "activity" ? "secondary" : "outline"}
                  onClick={() => setActiveTab("activity")}
                >
                  Activity
                </Button>
              </div>

              {activeTab === "pages" && (
                <>
                  {session.pages.length === 0 ? (
                    <p className="text-sm text-slate-600">No pages yet. Start the session.</p>
                  ) : (
                    <div className="space-y-3">
                      {session.pages.map((page) => (
                        <Card key={page.id} className="border-slate-200">
                          <CardHeader>
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="text-sm font-semibold text-slate-900">
                                  <Link to={`/agent/pages/${page.id}`} className="hover:underline">
                                    {page.path || page.url}
                                  </Link>
                                </div>
                                <div className="text-xs text-slate-500 break-all">{page.url}</div>
                              </div>
                              <div className="flex gap-2 items-center">
                                <Badge
                                  className={
                                    page.status === "completed"
                                      ? "border-emerald-200 text-emerald-700"
                                      : page.status === "failed"
                                      ? "border-rose-200 text-rose-700"
                                      : "border-slate-200 text-slate-700"
                                  }
                            >
                              {page.status}
                            </Badge>
                            <Button
                              size="sm"
                                  variant="ghost"
                                  onClick={() => runPage(page.id)}
                                  disabled={busyPage === page.id}
                                >
                                  {busyPage === page.id ? (
                                    <>
                                      <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Running…
                                    </>
                              ) : (
                                "Run page"
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => generateAllAccepted(page)}
                              disabled={
                                busyGenerateAll === page.id ||
                                !page.scenarios.some((s) => s.status === "accepted" && !s.specPath)
                              }
                            >
                              {busyGenerateAll === page.id ? "Generating…" : "Generate all accepted"}
                            </Button>
                          </div>
                            </div>
                            {page.coverage && (
                              <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-slate-600">
                                {Object.entries(page.coverage).map(([k, v]) => (
                                  <span key={k}>
                                    {k}: <strong className="text-slate-800">{v as number}</strong>
                                  </span>
                                ))}
                              </div>
                            )}
                            {page.error && <p className="text-xs text-rose-600">{page.error}</p>}
                          </CardHeader>
                          <CardContent className="space-y-2">
                            {page.scenarios.length === 0 ? (
                              <p className="text-xs text-slate-500">No scenarios yet.</p>
                            ) : (
                              filteredScenarios(page.scenarios).map((sc) => (
                                <div key={sc.id} className="rounded border border-slate-200 px-3 py-2">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <div className="text-sm font-medium text-slate-900">{sc.title}</div>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
                                  <Badge className="border-slate-200 bg-slate-50 text-slate-800">
                                    {sc.coverageType || "coverage"}
                                  </Badge>
                                  <Badge
                                    className={
                                      sc.status === "accepted"
                                        ? "border-emerald-200 text-emerald-700 bg-emerald-50"
                                        : sc.status === "rejected"
                                        ? "border-rose-200 text-rose-700 bg-rose-50"
                                        : "border-slate-200 text-slate-700 bg-slate-50"
                                    }
                                  >
                                    {sc.status}
                                  </Badge>
                                  {sc.specPath && (
                                    <a
                                      href={`/#/suite/playwright-ts?spec=${encodeURIComponent(sc.specPath)}`}
                                      className="text-blue-600 hover:underline"
                                    >
                                      {sc.specPath}
                                    </a>
                                  )}
                                </div>
                                {sc.description && (
                                  <p className="text-xs text-slate-600 mt-1">{sc.description}</p>
                                )}
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  variant={sc.status === "accepted" ? "secondary" : "outline"}
                                  disabled={busyScenario === sc.id || sc.status === "accepted"}
                                  onClick={() => attachAndGenerate(sc.id)}
                                >
                                  {busyScenario === sc.id
                                    ? "Working..."
                                    : sc.specPath
                                    ? "Test generated"
                                    : "Attach & generate"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={!sc.specPath || busyRunScenario === sc.id}
                                  onClick={() => runScenario(sc.id)}
                                >
                                  {busyRunScenario === sc.id ? "Running..." : "Run scenario"}
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setSelectedScenario({ scenario: sc, page })}>
                                  View
                                </Button>
                              </div>
                            </div>
                                </div>
                              ))
                            )}
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </>
              )}

              {activeTab === "scenarios" && (
                <div className="space-y-3">
                  {session.pages.flatMap((p) => p.scenarios).length === 0 ? (
                    <p className="text-sm text-slate-600">No scenarios.</p>
                  ) : (
                    session.pages.flatMap((p) => p.scenarios).map((sc) => (
                      <div key={sc.id} className="rounded border border-slate-200 px-3 py-2">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <div className="text-sm font-medium text-slate-900">{sc.title}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
                                <Badge className="border-slate-200 bg-slate-50 text-slate-800">
                                  {sc.coverageType || "coverage"}
                                </Badge>
                                <Badge className="border-slate-200 text-slate-800">{sc.status}</Badge>
                                {sc.specPath && (
                                  <a
                                    href={`/#/suite/playwright-ts?spec=${encodeURIComponent(sc.specPath)}`}
                                    className="text-blue-600 hover:underline"
                                  >
                                    {sc.specPath}
                                  </a>
                                )}
                              </div>
                              {sc.description && <p className="text-xs text-slate-600 mt-1">{sc.description}</p>}
                            </div>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant={sc.status === "accepted" ? "secondary" : "outline"}
                                disabled={busyScenario === sc.id || sc.status === "accepted"}
                                onClick={() => attachAndGenerate(sc.id)}
                              >
                                {busyScenario === sc.id
                                  ? "Working..."
                                  : sc.specPath
                                  ? "Test generated"
                                  : "Attach & generate"}
                              </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!sc.specPath || busyRunScenario === sc.id}
                              onClick={() => runScenario(sc.id)}
                            >
                              {busyRunScenario === sc.id ? "Running..." : "Run scenario"}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setSelectedScenario({ scenario: sc, page: session.pages.find(p=>p.scenarios.some(s=>s.id===sc.id)) || session.pages[0] })}>
                              View
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {activeTab === "activity" && (
                <div className="space-y-4 text-sm text-slate-600">
                  <div className="space-y-2">
                    {activityItems().map((item, idx) => (
                      <div key={idx} className="rounded border border-slate-200 px-3 py-2">
                        <div className="text-sm text-slate-800">{item.label}</div>
                        {item.detail && <div className="text-xs text-slate-500 mt-1">{item.detail}</div>}
                      </div>
                    ))}
                    {activityItems().length === 0 && (
                      <p className="text-xs text-slate-500">No activity yet.</p>
                    )}
                  </div>

                  <div className="rounded border border-slate-200 px-3 py-2">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-sm font-semibold text-slate-900">Recent runs</div>
                      <Button size="sm" variant="ghost" onClick={() => loadRecentRuns(session?.projectId)}>
                        Refresh runs
                      </Button>
                    </div>
                    {recentRuns.length === 0 ? (
                      <p className="text-xs text-slate-500">No runs yet.</p>
                    ) : (
                      <ul className="space-y-1">
                        {recentRuns.map((r) => (
                          <li key={r.id} className="flex justify-between text-xs">
                            <span>{new Date(r.createdAt).toLocaleString()}</span>
                            <span
                              className={
                                r.status === "succeeded"
                                  ? "text-emerald-700"
                                  : r.status === "failed"
                                  ? "text-rose-700"
                                  : "text-slate-700"
                              }
                            >
                              {r.status}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      <ScenarioDrawer selected={selectedScenario} onClose={() => setSelectedScenario(null)} />
    </div>
  );
}

function ScenarioDrawer({
  selected,
  onClose,
}: {
  selected: { scenario: Scenario; page: Page } | null;
  onClose: () => void;
}) {
  if (!selected) return null;
  const { scenario, page } = selected;
  return (
    <div className="fixed right-0 top-14 h-[calc(100vh-56px)] w-full max-w-md border-l bg-white shadow-lg z-40 overflow-y-auto">
      <div className="p-4 border-b flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Scenario detail</div>
          <div className="text-xs text-slate-500">Page: {page.path || page.url}</div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="p-4 space-y-3">
        <div>
          <div className="text-base font-semibold text-slate-900">{scenario.title}</div>
          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-600">
            <Badge className="border-slate-200 bg-slate-50 text-slate-800">
              {scenario.coverageType || "coverage"}
            </Badge>
            <Badge className="border-slate-200 text-slate-800">{scenario.status}</Badge>
            {scenario.specPath && (
              <a
                href={`/#/suite/playwright-ts?spec=${encodeURIComponent(scenario.specPath)}`}
                className="text-blue-600 hover:underline"
              >
                {scenario.specPath}
              </a>
            )}
          </div>
        </div>
        {scenario.description && <p className="text-sm text-slate-700">{scenario.description}</p>}
        <div className="text-xs text-slate-500 space-y-1">
          <div className="font-semibold text-slate-600">Steps</div>
          {Array.isArray((scenario as any).steps) && (scenario as any).steps.length > 0 ? (
            <ul className="list-disc pl-4 space-y-1">
              {(scenario as any).steps.map((step: any, idx: number) => (
                <li key={idx}>
                  <span className="font-medium">{step.kind}</span>{" "}
                  {step.url || step.selector || step.value || ""}
                </li>
              ))}
            </ul>
          ) : (
            <div>No steps provided.</div>
          )}
        </div>
      </div>
    </div>
  );
}
