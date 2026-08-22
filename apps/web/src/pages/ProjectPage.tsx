import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useApi } from "../lib/api";
import { Card, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Checkbox } from "../components/ui/checkbox";
import { toast } from "sonner";
import { DEFAULT_FRAMEWORK_ID } from "@testmind/core/framework";
import { matchFrameworkIdFromValue } from "@testmind/core/framework-registry";
import CaseFilterBar, { type CaseFilters, EMPTY_FILTERS } from "../components/CaseFilterBar";
import BulkActionToolbar from "../components/BulkActionToolbar";
import CreateCaseModal, { type CreateCasePayload } from "../components/CreateCaseModal";
import ImportCaseModal, { type ImportRow } from "../components/ImportCaseModal";

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
  locators?: string | null;
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
  const [sharedStepsText, setSharedStepsText] = useState("{}");
  const [savingSharedSteps, setSavingSharedSteps] = useState(false);
  const [sharedStepsError, setSharedStepsError] = useState<string | null>(null);
  const [aiSpecPreview, setAiSpecPreview] = useState<{
    content: string;
    curatedPath: string;
    fileName: string;
  } | null>(null);
  const [aiSpecBusy, setAiSpecBusy] = useState(false);

  // Management features
  const [filters, setFilters] = useState<CaseFilters>(EMPTY_FILTERS);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);

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
          apiFetch<{ project: { name: string; sharedSteps?: Record<string, any> } }>(`/projects/${id}`),
          apiFetch<{ suites: Suite[] }>(`/tests/suites?projectId=${id}`),
          apiFetch<{ cases: CaseListItem[] }>(`/tests/cases?projectId=${id}`),
          apiFetch<{ runs: TestRun[] }>(`/projects/${id}/test-runs`).catch(() => ({
            runs: [],
          })),
        ]);
        setProjectName(project.name);
        setSharedStepsText(JSON.stringify(project.sharedSteps ?? {}, null, 2));
        setSuites(suitesRes.suites);
        setCases(casesRes.cases);
        setRuns(runsRes.runs);
      } catch (e: any) {
        toast.error(e?.message || "Failed to load project");
      }
    };

    load();
  }, [id, apiFetch]);

  // Re-fetch cases when suite selection or filters change
  useEffect(() => {
    if (!id) return;
    refreshCases();
    setSelectedIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSuiteId, filters]);

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

  // visibleCases: server already applies suite + filter params; client just renders what came back
  const visibleCases = cases;

  function formatCaseTitle(title: string) {
    // Split optional path from step description (e.g., "path/spec.ts > Navigate /...")
    const [rawPath, ...restParts] = title.split(">");
    const pathBits = rawPath.split(/[/\\]/);
    const base = (pathBits[pathBits.length - 1] || rawPath).trim();
    const rest = restParts.join(">").trim();
    return rest ? `${base} > ${rest}` : base;
  }

  const dedupedCases = useMemo(() => {
    const seen = new Set<string>();
    return visibleCases.filter((c) => {
      const key = formatCaseTitle(c.title).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [visibleCases]);

  async function refreshCases(overrideFilters?: CaseFilters) {
    if (!id) return;
    const f = overrideFilters ?? filters;
    const params = new URLSearchParams({ projectId: id });
    if (selectedSuiteId) params.set("suiteId", selectedSuiteId);
    if (f.q) params.set("q", f.q);
    if (f.status) params.set("status", f.status);
    if (f.priority) params.set("priority", f.priority);
    if (f.type) params.set("type", f.type);
    if (f.tag) params.set("tag", f.tag);
    const res = await apiFetch<{ cases: CaseListItem[] }>(`/tests/cases?${params}`);
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

  function handleAddCase() {
    setShowCreateModal(true);
  }

  async function handleCreateCase(payload: CreateCasePayload) {
    if (!id) return;
    const res = await apiFetch<{ case: CaseListItem }>("/tests/cases", {
      method: "POST",
      body: JSON.stringify({ projectId: id, ...payload }),
    });
    toast.success("Case created");
    await refreshCases();
    setSelectedCaseId(res.case.id);
    setShowCreateModal(false);
  }

  async function handleDuplicateCase(caseId: string) {
    if (!id) return;
    try {
      const res = await apiFetch<{ case: CaseListItem }>(`/tests/cases/${caseId}/duplicate`, { method: "POST" });
      toast.success("Case duplicated");
      await refreshCases();
      setSelectedCaseId(res.case.id);
    } catch (e: any) {
      toast.error(e?.message || "Failed to duplicate case");
    }
  }

  // The backend caps /tests/cases/bulk at 100 ids per request (a safety limit against
  // one request updating an unbounded number of rows), but selections here can be much
  // larger — batch into chunks so bulk actions work regardless of selection size.
  const BULK_ACTION_BATCH_SIZE = 100;

  async function runBulkActionBatched(action: string, value: string | undefined, ids: string[]) {
    let updated = 0;
    for (let i = 0; i < ids.length; i += BULK_ACTION_BATCH_SIZE) {
      const batch = ids.slice(i, i + BULK_ACTION_BATCH_SIZE);
      const res = await apiFetch<{ updated: number }>("/tests/cases/bulk", {
        method: "POST",
        body: JSON.stringify({ projectId: id, ids: batch, action, value }),
      });
      updated += res.updated ?? batch.length;
    }
    return updated;
  }

  async function handleBulkAction(action: string, value?: string) {
    if (!id || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    try {
      if (action === "createAndMoveSuite") {
        if (!value?.trim()) return;
        const { suite } = await apiFetch<{ suite: Suite }>("/tests/suites", {
          method: "POST",
          body: JSON.stringify({ projectId: id, name: value.trim() }),
        });
        await refreshSuites();
        await runBulkActionBatched("moveSuite", suite.id, ids);
        toast.success(`Created "${value.trim()}" and moved ${ids.length} case(s)`);
        setSelectedIds(new Set());
        await refreshCases();
        return;
      }

      await runBulkActionBatched(action, value, ids);
      const label = action === "delete" ? "Archived" : "Updated";
      toast.success(`${label} ${ids.length} case(s)`);
      setSelectedIds(new Set());
      await refreshCases();
    } catch (e: any) {
      toast.error(e?.message || "Bulk action failed");
    }
  }

  async function handleExportCsv() {
    if (!id) return;
    try {
      const params = new URLSearchParams({ projectId: id });
      if (selectedSuiteId) params.set("suiteId", selectedSuiteId);
      if (filters.q) params.set("q", filters.q);
      if (filters.status) params.set("status", filters.status);
      if (filters.priority) params.set("priority", filters.priority);
      if (filters.type) params.set("type", filters.type);
      if (filters.tag) params.set("tag", filters.tag);
      const res = await apiFetch<Response>(`/tests/cases/export?${params}`, { rawResponse: true } as any);
      const blob = await (res as unknown as Response).blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `cases-${id}.csv`;
      a.click();
      URL.revokeObjectURL(href);
    } catch (e: any) {
      toast.error(e?.message || "Export failed");
    }
  }

  async function handleImport(projectId: string, suiteId: string | null, importedCases: ImportRow[]) {
    const res = await apiFetch<{ created: number }>("/tests/cases/import", {
      method: "POST",
      body: JSON.stringify({ projectId, suiteId: suiteId ?? undefined, cases: importedCases }),
    });
    toast.success(`Imported ${res.created} case(s)`);
    await refreshCases();
    setShowImportModal(false);
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
      await saveCasePayload();
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

  async function handleSaveSharedSteps() {
    if (!id) return;
    setSavingSharedSteps(true);
    setSharedStepsError(null);
    try {
      const parsed = sharedStepsText.trim()
        ? JSON.parse(sharedStepsText)
        : {};
      await apiFetch(`/projects/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ sharedSteps: parsed }),
      });
      toast.success("Shared steps saved");
      setSharedStepsText(JSON.stringify(parsed, null, 2));
    } catch (e: any) {
      const message = e?.message || "Invalid JSON";
      setSharedStepsError(message);
      toast.error(message);
    } finally {
      setSavingSharedSteps(false);
    }
  }

  async function saveCasePayload() {
    if (!caseDetail) return;
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
        locators: caseDetail.locators,
        steps: caseDetail.steps.map((s) => ({
          action: s.action,
          expected: s.expected,
        })),
      }),
    });
  }

  async function handleGeneratePlaywright() {
    if (!caseDetail) return;
    try {
      // Ensure latest edits (steps/base URL) are saved before generation.
      await saveCasePayload();
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

  async function handleAiGenerateSpec() {
    if (!caseDetail) return;
    setAiSpecBusy(true);
    try {
      await saveCasePayload();
      const res = await apiFetch<{
        fileName: string;
        curatedPath: string;
        preview: string;
      }>(`/tests/cases/${caseDetail.id}/ai-generate-spec`, {
        method: "POST",
      });
      setAiSpecPreview({
        content: res.preview,
        curatedPath: res.curatedPath,
        fileName: res.fileName,
      });
      toast.success("AI spec generated");
    } catch (e: any) {
      toast.error(e?.message || "Failed to generate AI spec");
    } finally {
      setAiSpecBusy(false);
    }
  }

  async function generateTests() {
    if (!id) return;
    try {
      setGenBusy(true);
      const adapterId =
        typeof window === "undefined"
          ? DEFAULT_FRAMEWORK_ID
          : matchFrameworkIdFromValue(window.localStorage.getItem("tm-adapterId")) ?? DEFAULT_FRAMEWORK_ID;
      const { run } = await apiFetch<{ run: TestRun }>(`/projects/${id}/test-runs`, {
        method: "POST",
        body: JSON.stringify({ adapterId }),
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

  const availableTags = useMemo(
    () => [...new Set(cases.flatMap((c) => c.tags ?? []))].sort(),
    [cases]
  );

  const allVisibleSelected = dedupedCases.length > 0 && dedupedCases.every((c) => selectedIds.has(c.id));

  function toggleAll() {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(dedupedCases.map((c) => c.id)));
    }
  }

  function toggleCase(caseId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(caseId)) next.delete(caseId); else next.add(caseId);
      return next;
    });
  }

  const summarizeRun = (r: TestRun) => {
    if (r.summary) {
      try {
        const parsed = JSON.parse(r.summary);
        const parts: string[] = [];
        if (parsed.framework) parts.push(String(parsed.framework));
        if (parsed.baseUrl) parts.push(String(parsed.baseUrl));
        const counts = [
          `parsed:${parsed.parsedCount ?? 0}`,
          `passed:${parsed.passed ?? 0}`,
          `failed:${parsed.failed ?? 0}`,
          `skipped:${parsed.skipped ?? 0}`,
        ];
        parts.push(counts.join(" "));
        return parts.filter(Boolean).join(" \u00b7 ");
      } catch {
        /* fall through */
      }
    }
    if (r.error) return r.error;
    return "Run started";
  };

  return (
    <div className="space-y-6 px-4 sm:px-6 lg:px-8">
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
        <Card className="bg-white shadow-sm border border-slate-200">
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
                  className={`w-full rounded border px-3 py-2 text-left text-sm bg-white ${
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
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={handleExportCsv} title="Export CSV">Export</Button>
                <Button size="sm" variant="ghost" onClick={() => setShowImportModal(true)} title="Import CSV">Import</Button>
                <Button size="sm" variant="outline" onClick={handleAddCase}>Add case</Button>
              </div>
            </div>

            {/* Filter bar */}
            <CaseFilterBar
              filters={filters}
              availableTags={availableTags}
              onChange={(f) => setFilters(f)}
              onClear={() => setFilters(EMPTY_FILTERS)}
            />

            {/* Select-all header */}
            {dedupedCases.length > 0 && (
              <div className="flex items-center gap-2 px-1 py-1">
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                />
                <span className="text-xs text-slate-500">
                  {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select all"}
                </span>
              </div>
            )}

            <div className="space-y-2">
              {dedupedCases.map((c) => (
                <div
                  key={c.id}
                  className={`flex items-start gap-2 rounded border px-3 py-2 text-sm bg-white ${
                    selectedCaseId === c.id
                      ? "border-blue-500 bg-blue-50"
                      : selectedIds.has(c.id)
                      ? "border-violet-300 bg-violet-50"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <Checkbox
                    checked={selectedIds.has(c.id)}
                    onCheckedChange={() => toggleCase(c.id)}
                    className="mt-0.5 shrink-0"
                    aria-label="Select case"
                    onClick={(e) => e.stopPropagation()}
                  />
                  <button
                    className="flex-1 text-left min-w-0"
                    onClick={() => {
                      setSelectedCaseId(c.id);
                    }}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className={`font-semibold break-words ${selectedCaseId === c.id ? "text-blue-800" : "text-slate-900"}`}>
                        {formatCaseTitle(c.title)}
                      </span>
                      <span className="text-xs uppercase text-slate-500 shrink-0">{c.priority}</span>
                    </div>
                    <div className="text-xs text-slate-500">
                      {suiteLookup.get(c.suiteId || "")?.name || "Unassigned"}
                    </div>
                  </button>
                  {/* Kebab menu */}
                  <div className="relative shrink-0">
                    <details className="group">
                      <summary className="list-none cursor-pointer p-1 rounded hover:bg-slate-100 text-slate-400">
                        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 16 16">
                          <circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/>
                        </svg>
                      </summary>
                      <div className="absolute right-0 top-6 z-20 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[110px]">
                        <button
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 text-slate-700"
                          onClick={(e) => { e.preventDefault(); handleDuplicateCase(c.id); }}
                        >
                          Duplicate
                        </button>
                        <button
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-red-50 text-red-600"
                          onClick={(e) => { e.preventDefault(); handleDeleteCase(c.id); }}
                        >
                          Delete
                        </button>
                      </div>
                    </details>
                  </div>
                </div>
              ))}
              {dedupedCases.length === 0 && (
                <p className="text-sm text-slate-500 px-1">No cases match the current filters.</p>
              )}
            </div>
          </div>
        </Card>

        {/* Right: case editor */}
        <div className="space-y-4">
          <Card className="bg-white shadow-sm border border-slate-200">
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

                  <div className="space-y-1">
                    <label className="text-xs text-slate-600">
                      Locators <span className="text-slate-400">(optional — hints for AI spec generation)</span>
                    </label>
                    <Textarea
                      className="w-full font-mono text-xs"
                      rows={3}
                      placeholder={'e.g. login-btn=[data-testid="login-button"], email=#email-input'}
                      value={caseDetail.locators ?? ""}
                      onChange={(e) => updateCaseField("locators", e.target.value)}
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
                      variant="outline"
                      onClick={handleAiGenerateSpec}
                      disabled={aiSpecBusy}
                    >
                      {aiSpecBusy ? "Generating AI spec..." : "AI Generate Spec"}
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

                  {aiSpecPreview && (
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-3 space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                        AI Spec Preview
                      </div>
                      <div className="text-xs text-slate-600">
                        Saved to: <code className="rounded bg-white px-1">{aiSpecPreview.curatedPath}</code>
                      </div>
                      <pre className="max-h-64 overflow-auto rounded bg-white p-3 text-xs text-slate-800">
{aiSpecPreview.content}
                      </pre>
                    </div>
                  )}

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

          <Card className="bg-white shadow-sm border border-slate-200">
            <CardHeader>
              <CardTitle>Shared steps</CardTitle>
            </CardHeader>
            <div className="space-y-3 p-6">
              <p className="text-sm text-slate-600">
                Define the shared navigation/login steps as JSON. These values drive manual execution and generated suites.
              </p>
              <Textarea
                rows={6}
                className="font-mono text-xs"
                value={sharedStepsText}
                onChange={(e) => setSharedStepsText(e.target.value)}
              />
              {sharedStepsError && (
                <p className="text-sm text-red-500">{sharedStepsError}</p>
              )}
              <Button onClick={handleSaveSharedSteps} disabled={savingSharedSteps}>
                {savingSharedSteps ? "Saving..." : "Save shared steps"}
              </Button>
            </div>
          </Card>

          {/* Automated runs */}
          <Card className="bg-white shadow-sm border border-slate-200">
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
                        <div className="flex flex-wrap items-center gap-2 leading-tight">
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
                          <span className="text-sm text-slate-700 whitespace-normal break-words leading-snug min-w-0">
                            {summarizeRun(r)}
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

      {/* Bulk action toolbar */}
      <BulkActionToolbar
        selectedIds={selectedIds}
        suites={suites}
        onAction={handleBulkAction}
        onClear={() => setSelectedIds(new Set())}
      />

      {/* Create case modal */}
      <CreateCaseModal
        open={showCreateModal}
        suites={suites}
        defaultSuiteId={selectedSuiteId}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreateCase}
      />

      {/* Import modal */}
      {id && (
        <ImportCaseModal
          open={showImportModal}
          projectId={id}
          suites={suites}
          defaultSuiteId={selectedSuiteId}
          onClose={() => setShowImportModal(false)}
          onImport={handleImport}
        />
      )}
    </div>
  );
}
