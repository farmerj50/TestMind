import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useApi } from "../lib/api";
import { Card, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { toast } from "sonner";

type TestRunStatus = "queued" | "running" | "succeeded" | "failed";

export type TestRun = {
  id: string;
  projectId: string;
  status: TestRunStatus;
  summary?: string | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

type Suite = { id: string; name: string; parentId: string | null; order: number };

type CaseListItem = {
  id: string;
  key: string;
  title: string;
  status: "draft" | "active" | "archived";
  priority: "low" | "medium" | "high";
  type: "functional" | "regression" | "security" | "accessibility" | "other";
  suiteId: string | null;
  tags: string[];
  updatedAt: string;
};

type Step = { id?: string; idx?: number; action: string; expected: string };
type CaseRun = {
  id: string;
  status: "passed" | "failed" | "skipped" | "error";
  note?: string | null;
  createdAt: string;
  userId?: string | null;
};

type CaseDetail = CaseListItem & {
  preconditions?: string | null;
  lastAiSyncAt?: string | null;
  steps: Step[];
  runs: CaseRun[];
};

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const { apiFetch } = useApi();

  const [projectName, setProjectName] = useState("");
  const [suites, setSuites] = useState<Suite[]>([]);
  const [cases, setCases] = useState<CaseListItem[]>([]);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [loadingCase, setLoadingCase] = useState(false);
  const [savingCase, setSavingCase] = useState(false);
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [genBusy, setGenBusy] = useState(false);
  const [runNote, setRunNote] = useState("");

  const hasActiveRun = useMemo(
    () => runs.some((r) => r.status === "queued" || r.status === "running"),
    [runs]
  );

  // Fetch project + suites + cases + runs
  useEffect(() => {
    if (!id) return;

    const load = async () => {
      try {
        const [{ project }, suitesRes, casesRes, runsRes] = await Promise.all([
          apiFetch<{ project: { name: string } }>(`/projects/${id}`),
          apiFetch<{ suites: Suite[] }>(`/tests/suites?projectId=${id}`),
          apiFetch<{ cases: CaseListItem[] }>(`/tests/cases?projectId=${id}`),
          apiFetch<{ runs: TestRun[] }>(`/projects/${id}/test-runs`).catch(() => ({
            runs: [],
          })),
        ]);
        setProjectName(project.name);
        setSuites(suitesRes.suites);
        setCases(casesRes.cases);
        setRuns(runsRes.runs);
      } catch (e: any) {
        toast.error(e?.message || "Failed to load project");
      }
    };

    load();
  }, [id, apiFetch]);

  // Poll automated runs while active
  useEffect(() => {
    if (!id || !hasActiveRun) return;
    const t = setInterval(async () => {
      try {
        const res = await apiFetch<{ runs: TestRun[] }>(`/projects/${id}/test-runs`);
        setRuns(res.runs);
      } catch {
        // ignore
      }
    }, 1500);
    return () => clearInterval(t);
  }, [id, hasActiveRun, apiFetch]);

  // Case detail loading
  useEffect(() => {
    if (!selectedCaseId) {
      setCaseDetail(null);
      return;
    }
    setLoadingCase(true);
    apiFetch<{ case: CaseDetail }>(`/tests/cases/${selectedCaseId}`)
      .then((res) => setCaseDetail(res.case))
      .catch((e) => toast.error(e?.message || "Failed to load case"))
      .finally(() => setLoadingCase(false));
  }, [selectedCaseId, apiFetch]);

  const visibleCases = useMemo(() => {
    if (!selectedSuiteId) return cases;
    return cases.filter((c) => c.suiteId === selectedSuiteId);
  }, [cases, selectedSuiteId]);

  async function refreshCases() {
    if (!id) return;
    const res = await apiFetch<{ cases: CaseListItem[] }>(`/tests/cases?projectId=${id}`);
    setCases(res.cases);
  }

  async function refreshSuites() {
    if (!id) return;
    const res = await apiFetch<{ suites: Suite[] }>(`/tests/suites?projectId=${id}`);
    setSuites(res.suites);
  }

  // Mutations
  async function handleAddSuite() {
    if (!id) return;
    const name = prompt("Suite name?");
    if (!name) return;
    try {
      await apiFetch("/tests/suites", {
        method: "POST",
        body: JSON.stringify({ projectId: id, name }),
      });
      toast.success("Suite created");
      await refreshSuites();
    } catch (e: any) {
      toast.error(e?.message || "Failed to create suite");
    }
  }

  async function handleAddCase() {
    if (!id) return;
    const title = prompt("Case title?");
    if (!title) return;
    try {
      const res = await apiFetch<{ case: CaseListItem }>("/tests/cases", {
        method: "POST",
        body: JSON.stringify({
          projectId: id,
          suiteId: selectedSuiteId || undefined,
          title,
        }),
      });
      toast.success("Case created");
      await refreshCases();
      setSelectedCaseId(res.case.id);
    } catch (e: any) {
      toast.error(e?.message || "Failed to create case");
    }
  }

  async function handleDeleteCase(caseId: string) {
    if (!confirm("Delete this case?")) return;
    try {
      await apiFetch(`/tests/cases/${caseId}`, { method: "DELETE" });
      toast.success("Case deleted");
      setSelectedCaseId(null);
      await refreshCases();
    } catch (e: any) {
      toast.error(e?.message || "Failed to delete case");
    }
  }

  async function handleSaveCase() {
    if (!caseDetail) return;
    setSavingCase(true);
    try {
      await apiFetch(`/tests/cases/${caseDetail.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: caseDetail.title,
          suiteId: caseDetail.suiteId,
          priority: caseDetail.priority,
          type: caseDetail.type,
          status: caseDetail.status,
          tags: caseDetail.tags,
          preconditions: caseDetail.preconditions,
          steps: caseDetail.steps.map((s) => ({
            action: s.action,
            expected: s.expected,
          })),
        }),
      });
      toast.success("Case saved");
      await refreshCases();
    } catch (e: any) {
      toast.error(e?.message || "Failed to save case");
    } finally {
      setSavingCase(false);
    }
  }

  async function handleManualRun(status: CaseRun["status"]) {
    if (!caseDetail) return;
    try {
      await apiFetch(`/tests/cases/${caseDetail.id}/runs`, {
        method: "POST",
        body: JSON.stringify({ status, note: runNote || undefined }),
      });
      toast.success("Run recorded");
      const runsRes = await apiFetch<{ runs: CaseRun[] }>(
        `/tests/cases/${caseDetail.id}/runs`
      );
      setCaseDetail({ ...caseDetail, runs: runsRes.runs });
      setRunNote("");
    } catch (e: any) {
      toast.error(e?.message || "Failed to record run");
    }
  }

  async function handleGeneratePlaywright() {
    if (!caseDetail) return;
    try {
      await apiFetch(`/tests/cases/${caseDetail.id}/generate-playwright`, {
        method: "POST",
      });
      toast.success("Generation queued");
      setCaseDetail({ ...caseDetail, lastAiSyncAt: new Date().toISOString() });
      const runsRes = await apiFetch<{ runs: TestRun[] }>(`/projects/${id}/test-runs`);
      setRuns(runsRes.runs);
    } catch (e: any) {
      toast.error(e?.message || "Failed to queue generation");
    }
  }

  async function generateTests() {
    if (!id) return;
    try {
      setGenBusy(true);
      const { run } = await apiFetch<{ run: TestRun }>(`/projects/${id}/test-runs`, {
        method: "POST",
      });
      setRuns((prev) => [run, ...prev]);
      toast("Test run started");
    } catch (e: any) {
      toast.error(e?.message || "Failed to start test run");
    } finally {
      setGenBusy(false);
    }
  }

  // UI helpers
  function updateCaseField<K extends keyof CaseDetail>(key: K, value: CaseDetail[K]) {
    if (!caseDetail) return;
    setCaseDetail({ ...caseDetail, [key]: value });
  }

  function updateStep(idx: number, next: Partial<Step>) {
    if (!caseDetail) return;
    const copy = [...caseDetail.steps];
    copy[idx] = { ...copy[idx], ...next };
    setCaseDetail({ ...caseDetail, steps: copy });
  }

  function addStep() {
    if (!caseDetail) return;
    setCaseDetail({
      ...caseDetail,
      steps: [...caseDetail.steps, { action: "", expected: "" }],
    });
  }

  function removeStep(idx: number) {
    if (!caseDetail) return;
    const copy = [...caseDetail.steps];
    copy.splice(idx, 1);
    setCaseDetail({ ...caseDetail, steps: copy });
  }

  const suiteLookup = useMemo(() => {
    const map = new Map<string, Suite>();
    suites.forEach((s) => map.set(s.id, s));
    return map;
  }, [suites]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Project</p>
          <h1 className="text-2xl font-semibold text-slate-900">
            {projectName || "Project"}
          </h1>
        </div>
        <div className="flex gap-2">
          <Button onClick={generateTests} disabled={genBusy}>
            {genBusy ? "Starting..." : "Generate tests"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px,1fr]">
        {/* Left: suites + cases */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Manual suites</CardTitle>
            <Button size="sm" variant="outline" onClick={handleAddSuite}>
              Add suite
            </Button>
          </CardHeader>
          <div className="space-y-4 p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-slate-700">Suites</div>
              <Button size="sm" variant="ghost" onClick={() => setSelectedSuiteId(null)}>
                All
              </Button>
            </div>
            <div className="space-y-2">
              {suites.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedSuiteId(s.id)}
                  className={`w-full rounded border px-3 py-2 text-left text-sm ${
                    selectedSuiteId === s.id
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  {s.name}
                </button>
              ))}
              {suites.length === 0 && (
                <p className="text-sm text-slate-500">No suites yet.</p>
              )}
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div className="text-sm font-medium text-slate-700">Cases</div>
              <Button size="sm" variant="outline" onClick={handleAddCase}>
                Add case
              </Button>
            </div>
            <div className="space-y-2">
              {visibleCases.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setSelectedCaseId(c.id);
                    setSelectedSuiteId(c.suiteId ?? null);
                  }}
                  className={`w-full rounded border px-3 py-2 text-left text-sm ${
                    selectedCaseId === c.id
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={
                        "font-semibold " +
                        (selectedCaseId === c.id ? "text-blue-800" : "text-slate-900")
                      }
                    >
                      {c.title}
                    </span>
                    <span className="text-xs uppercase text-slate-500">{c.priority}</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    {suiteLookup.get(c.suiteId || "")?.name || "Unassigned"}
                  </div>
                </button>
              ))}
              {visibleCases.length === 0 && (
                <p className="text-sm text-slate-500">No cases in this suite.</p>
              )}
            </div>
          </div>
        </Card>

        {/* Right: case editor */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Manual test</CardTitle>
            </CardHeader>
            <div className="space-y-4 p-6">
              {!selectedCaseId && (
                <p className="text-sm text-slate-500">
                  Select a case to edit, or create a new one.
                </p>
              )}

              {loadingCase && <p className="text-sm text-slate-500">Loading...</p>}

              {caseDetail && !loadingCase && (
                <div className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-xs text-slate-600">Title</label>
                      <Input
                        value={caseDetail.title}
                        onChange={(e) => updateCaseField("title", e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-slate-600">Suite</label>
                      <select
                        className="w-full rounded border border-slate-200 px-2 py-2 text-sm"
                        value={caseDetail.suiteId ?? ""}
                        onChange={(e) =>
                          updateCaseField("suiteId", e.target.value || null)
                        }
                      >
                        <option value="">Unassigned</option>
                        {suites.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-slate-600">Priority</label>
                      <select
                        className="w-full rounded border border-slate-200 px-2 py-2 text-sm"
                        value={caseDetail.priority}
                        onChange={(e) =>
                          updateCaseField("priority", e.target.value as CaseDetail["priority"])
                        }
                      >
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-slate-600">Type</label>
                      <select
                        className="w-full rounded border border-slate-200 px-2 py-2 text-sm"
                        value={caseDetail.type}
                        onChange={(e) =>
                          updateCaseField("type", e.target.value as CaseDetail["type"])
                        }
                      >
                        <option value="functional">Functional</option>
                        <option value="regression">Regression</option>
                        <option value="security">Security</option>
                        <option value="accessibility">Accessibility</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-slate-600">Status</label>
                      <select
                        className="w-full rounded border border-slate-200 px-2 py-2 text-sm"
                        value={caseDetail.status}
                        onChange={(e) =>
                          updateCaseField("status", e.target.value as CaseDetail["status"])
                        }
                      >
                        <option value="draft">Draft</option>
                        <option value="active">Active</option>
                        <option value="archived">Archived</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-slate-600">Tags (comma separated)</label>
                      <Input
                        value={caseDetail.tags.join(", ")}
                        onChange={(e) =>
                          updateCaseField(
                            "tags",
                            e.target.value
                              .split(",")
                              .map((t) => t.trim())
                              .filter(Boolean)
                          )
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs text-slate-600">Preconditions</label>
                    <Textarea
                      className="w-full"
                      rows={3}
                      value={caseDetail.preconditions ?? ""}
                      onChange={(e) => updateCaseField("preconditions", e.target.value)}
                    />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-medium text-slate-800">Steps</div>
                      <Button size="sm" variant="outline" onClick={addStep}>
                        Add step
                      </Button>
                    </div>
                    {caseDetail.steps.length === 0 && (
                      <p className="text-sm text-slate-500">No steps yet.</p>
                    )}
                    <div className="space-y-3">
                      {caseDetail.steps.map((step, idx) => (
                        <div
                          key={idx}
                          className="rounded border border-slate-200 p-3 shadow-sm space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <div className="text-xs font-medium text-slate-600">
                              Step {idx + 1}
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => removeStep(idx)}
                            >
                              Remove
                            </Button>
                          </div>
                          <div className="grid gap-2 md:grid-cols-2">
                            <div className="space-y-1">
                              <label className="text-xs text-slate-600">Action</label>
                              <Textarea
                                rows={2}
                                value={step.action}
                                onChange={(e) => updateStep(idx, { action: e.target.value })}
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-xs text-slate-600">Expected result</label>
                              <Textarea
                                rows={2}
                                value={step.expected}
                                onChange={(e) =>
                                  updateStep(idx, { expected: e.target.value })
                                }
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button onClick={handleSaveCase} disabled={savingCase}>
                      {savingCase ? "Saving..." : "Save case"}
                    </Button>
                    <Button variant="secondary" onClick={() => handleManualRun("passed")}>
                      Mark pass
                    </Button>
                    <Button variant="secondary" onClick={() => handleManualRun("failed")}>
                      Mark fail
                    </Button>
                    <Button variant="outline" onClick={handleGeneratePlaywright}>
                      Generate Playwright from this case
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => handleDeleteCase(caseDetail.id)}
                    >
                      Delete
                    </Button>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs text-slate-600">Actual result / notes</label>
                    <Textarea
                      className="w-full"
                      rows={2}
                      value={runNote}
                      onChange={(e) => setRunNote(e.target.value)}
                      placeholder="Record observations when marking pass/fail."
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="text-sm font-medium text-slate-800">Run history</div>
                    {caseDetail.runs.length === 0 ? (
                      <p className="text-sm text-slate-500">No manual runs recorded.</p>
                    ) : (
                      <ul className="divide-y">
                        {caseDetail.runs.map((r) => (
                          <li key={r.id} className="py-2">
                            <div className="flex items-center gap-2">
                              <span
                                className={
                                  "inline-flex items-center rounded-full px-2 py-0.5 text-xs " +
                                  (r.status === "passed"
                                    ? "bg-emerald-50 text-emerald-700"
                                    : r.status === "failed"
                                    ? "bg-rose-50 text-rose-700"
                                    : "bg-slate-100 text-slate-700")
                                }
                              >
                                {r.status}
                              </span>
                              <span className="text-sm text-slate-700">
                                {r.note || "Manual run"}
                              </span>
                            </div>
                            <div className="text-xs text-slate-500">
                              {new Date(r.createdAt).toLocaleString()}
                            </div>
                            <div className="text-xs">
                              <a
                                className="text-blue-700 underline"
                                href={`/test-runs/${r.id}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                View run
                              </a>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {caseDetail.lastAiSyncAt && (
                    <div className="text-xs text-slate-500">
                      Last AI sync: {new Date(caseDetail.lastAiSyncAt).toLocaleString()}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>

          {/* Automated runs */}
          <Card>
            <CardHeader>
              <CardTitle>Automated test runs</CardTitle>
            </CardHeader>
            <div className="p-6">
              {runs.length === 0 ? (
                <p className="text-sm text-slate-500">No test runs yet.</p>
              ) : (
                <ul className="divide-y">
                  {runs.map((r) => (
                    <li key={r.id} className="flex items-start justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={
                              "inline-flex items-center rounded-full px-2 py-0.5 text-xs " +
                              (r.status === "succeeded"
                                ? "bg-emerald-50 text-emerald-700"
                                : r.status === "failed"
                                ? "bg-rose-50 text-rose-700"
                                : "bg-slate-100 text-slate-700")
                            }
                          >
                            {r.status}
                          </span>
                          <span className="truncate text-sm text-slate-700">
                            {r.summary || r.error || "Run started"}
                          </span>
                          <a
                            className="text-xs underline text-slate-600 hover:text-slate-900"
                            href={`/test-runs/${r.id}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View
                          </a>
                        </div>
                        <div className="text-xs text-slate-500">
                          {new Date(r.createdAt).toLocaleString()}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
