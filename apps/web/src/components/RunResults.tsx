import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiUrl, useApi } from "../lib/api";
import { CheckCircle2, XCircle, CircleAlert, RotateCcw, ChevronRight, Copy } from "lucide-react";
import { Button } from "./ui/button";

type Result = {
  id: string;
  status: "passed" | "failed" | "skipped" | "error";
  durationMs: number | null;
  message: string | null;
  case: { id: string; title: string; key: string };
  steps?: string[];
  stdout?: string[];
  stderr?: string[];
};

type RunArtifactMeta = {
  artifactsJson?: Record<string, string> | null;
  publicArtifacts?: {
    reportJsonUrl?: string | null;
    allureReportUrl?: string | null;
    allureResultsUrl?: string | null;
    runViewUrl?: string | null;
  } | null;
};

export default function RunResults({
  runId,
  active,
  projectId,
  suiteId,
}: {
  runId: string;
  active: boolean;
  projectId?: string;
  suiteId?: string;
}) {
  const { apiFetch } = useApi();
  const navigate = useNavigate();
  const [results, setResults] = useState<Result[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const [rerunLoadingId, setRerunLoadingId] = useState<string | null>(null);
  const [analyzeLoadingId, setAnalyzeLoadingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "failed" | "passed" | "skipped" | "flaky">("all");
  const [sortBy, setSortBy] = useState<"default" | "duration" | "status">("default");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [artifactMeta, setArtifactMeta] = useState<RunArtifactMeta | null>(null);

  const escapeRegex = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const buildLooseGrep = (title: string) =>
    `(?:^|\\s)${escapeRegex(title)}(?:$|\\s)`;

  const stop = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const load = async () => {
    try {
      const res = await apiFetch<{ results: Result[] }>(`/runner/test-runs/${runId}/results`);
      setResults(res.results);
      setErr(null);
      if (!active) stop();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load results");
    }
  };

  useEffect(() => {
    load();
    if (active && !pollRef.current) {
      pollRef.current = window.setInterval(load, 2000) as unknown as number;
    }
    return () => stop();
  }, [runId, active]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<{ run: RunArtifactMeta }>(`/test-runs/${runId}`);
        if (!cancelled) setArtifactMeta(res.run ?? null);
      } catch {
        if (!cancelled) setArtifactMeta(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiFetch, runId]);

  const normalizeStatus = (s: Result["status"]) => (s === "error" ? "failed" : s);
  const formatDuration = (durationMs: number | null) => {
    if (durationMs == null || Number.isNaN(durationMs)) return "-";
    if (durationMs < 1000) return `${durationMs} ms`;
    if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
    const mins = Math.floor(durationMs / 60_000);
    const secs = Math.round((durationMs % 60_000) / 1000);
    return `${mins}m ${secs}s`;
  };
  const statusOrder = (s: Result["status"]) => {
    const normalized = normalizeStatus(s);
    if (normalized === "failed") return 0;
    if (normalized === "skipped") return 1;
    return 2;
  };
  const durationLabel = (durationMs: number | null) => formatDuration(durationMs);

  const icon = (s: Result["status"]) =>
    normalizeStatus(s) === "passed" ? (
      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
    ) : normalizeStatus(s) === "failed" ? (
      <XCircle className="h-4 w-4 text-rose-600" />
    ) : (
      <CircleAlert className="h-4 w-4 text-amber-500" />
    );
  const statusPillClass = (s: Result["status"]) => {
    const normalized = normalizeStatus(s);
    if (normalized === "passed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
    if (normalized === "failed") return "border-rose-200 bg-rose-50 text-rose-700";
    return "border-amber-200 bg-amber-50 text-amber-700";
  };
  const statusLabel = (s: Result["status"]) => {
    if (s === "error") return "Failed";
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const deriveFallbackSteps = (title: string) => {
    const clean = title.trim();
    if (!clean) return ["Run test"];
    if (clean.toLowerCase().startsWith("page loads ")) {
      const route = clean.slice("Page loads ".length).trim();
      return [`Goto ${route}`, "Wait for page load"];
    }
    if (clean.toLowerCase().startsWith("navigate ")) {
      const arrowParts = clean.split(/→|â†’/).map((p) => p.trim()).filter(Boolean);
      if (arrowParts.length >= 2) {
        return [`${arrowParts[0]}`, `Open ${arrowParts[1]}`];
      }
      return [clean];
    }
    return [clean];
  };
  const inferExpectedPathFromTitle = (title?: string | null) => {
    if (!title) return null;
    const cleaned = title.trim();
    const navMatch = cleaned.match(/^Navigate\s+(.+?)(?:\s*(?:→|â†’)\s*(.+))?$/i);
    if (!navMatch) return null;
    const left = navMatch[1]?.trim();
    if (left && left.startsWith("/")) return left;
    const right = navMatch[2]?.trim();
    if (right && right.startsWith("/")) return right;
    return null;
  };
  const extractExpectedPathFromMessage = (message?: string | null) => {
    if (!message) return null;
    const lines = message.split("\n");
    const expectedLine = lines.find((line) => /Expected pattern:/i.test(line)) || "";
    if (!expectedLine) return null;
    const escapedPath = expectedLine.match(/\\\/([a-z0-9\-_/]+)/i)?.[1];
    if (escapedPath) return `/${escapedPath.replace(/^\/+/, "")}`;
    const plainPath = expectedLine.match(/\/([a-z0-9\-_/]+)(?:\(\?:\$|\[|\)|\/|$)/i)?.[1];
    if (plainPath) return `/${plainPath.replace(/^\/+/, "")}`;
    return null;
  };
  const isUrlAssertionFailure = (message?: string | null, stepText?: string | null) => {
    const haystack = `${message ?? ""}\n${stepText ?? ""}`.toLowerCase();
    return haystack.includes("tohaveurl") || haystack.includes("expected pattern:");
  };
  const estimateStepDurations = (count: number, totalMs: number | null, failedIndex: number | null, timeoutMs: number | null) => {
    if (!count || totalMs == null) return new Array<number | null>(count).fill(null);
    if (failedIndex == null || timeoutMs == null || timeoutMs <= 0 || timeoutMs >= totalMs) {
      const each = Math.max(1, Math.round(totalMs / count));
      return new Array<number | null>(count).fill(each);
    }
    const arr = new Array<number | null>(count).fill(null);
    arr[failedIndex] = timeoutMs;
    const restCount = count - 1;
    const restMs = Math.max(0, totalMs - timeoutMs);
    const each = restCount > 0 ? Math.max(1, Math.round(restMs / restCount)) : null;
    for (let i = 0; i < count; i += 1) {
      if (i !== failedIndex) arr[i] = each;
    }
    return arr;
  };
  const extractSelector = (message?: string | null, stepText?: string | null) => {
    const text = `${message ?? ""}\n${stepText ?? ""}`;
    const selectorLine = text.match(/selector(?:\s+used)?[:\s]+([^\n]+)/i)?.[1]?.trim();
    if (selectorLine) return selectorLine.replace(/^['"`]|['"`]$/g, "");
    const waitingFor = text.match(/waiting for selector[:\s]*["'`]?([^"'`\n]+)/i)?.[1]?.trim();
    if (waitingFor) return waitingFor;
    const cssLike = text.match(/(button\[[^\]]+\]|[a-z]+(?:[.#][\w-]+)+|\[[^\]]+\])/i)?.[1];
    if (cssLike) return cssLike;
    return null;
  };
  const buildSuggestion = (
    selector: string | null,
    failedStepText: string | null,
    message?: string | null,
    testTitle?: string | null
  ) => {
    if (isUrlAssertionFailure(message, failedStepText)) {
      const expectedPath = extractExpectedPathFromMessage(message) || inferExpectedPathFromTitle(testTitle) || "/";
      return {
        text: `await expect(page).toHaveURL(pathRegex('${expectedPath}'), { timeout: 15000 })`,
        confidence: "High" as const,
      };
    }
    if (!selector) return { text: "Try role-based selectors or a stable data-testid.", confidence: "Medium" as const };
    const quoted = failedStepText?.match(/"([^"]+)"/)?.[1]?.trim();
    if (selector.includes("button")) {
      if (quoted) return { text: `getByRole('button', { name: '${quoted}' })`, confidence: "High" as const };
      return { text: "getByRole('button', { name: /.../i })", confidence: "Medium" as const };
    }
    const dataAttr = selector.match(/\[data-([a-z0-9_-]+)=["']?([^"'\\]]+)["']?\]/i);
    if (dataAttr?.[2]) {
      return { text: `getByTestId('${dataAttr[2]}')`, confidence: "High" as const };
    }
    return { text: `page.locator('${selector.replace(/'/g, "\\'")}')`, confidence: "Medium" as const };
  };

  const handleRerun = async (specPath?: string | null, title?: string | null) => {
    if (!specPath) return;
    try {
      setRerunLoadingId(specPath);
      const testTitle = title ?? undefined;
      const grep = testTitle ? buildLooseGrep(testTitle) : undefined;
      await apiFetch(`/runner/test-runs/${runId}/rerun`, {
        method: "POST",
        body: JSON.stringify({ specFile: specPath, grep }),
      });
    } catch (e: any) {
      alert(e?.message ?? "Failed to trigger rerun");
    } finally {
      setRerunLoadingId(null);
    }
  };

  const handleAnalyze = async (specPath?: string | null, title?: string | null) => {
    try {
      setAnalyzeLoadingId(specPath || "run");
      const testTitle = title ?? undefined;
      const grep = specPath && testTitle ? buildLooseGrep(testTitle) : undefined;
      const res = await apiFetch<{ runId: string }>(`/runner/test-runs/${runId}/rerun`, {
        method: "POST",
        body: JSON.stringify({
          specFile: specPath ?? undefined,
          grep,
          mode: "ai",
          livePreview: true,
        }),
      });
      if (res?.runId) {
        navigate(`/test-runs/${res.runId}`);
      } else {
        alert("Rerun queued. Open the latest run to view analysis.");
      }
    } catch (e: any) {
      alert(e?.message ?? "Failed to trigger AI analyze rerun");
    } finally {
      setAnalyzeLoadingId(null);
    }
  };

  const summary = useMemo(() => {
    const out = { passed: 0, failed: 0, skipped: 0, flaky: 0, totalDurationMs: 0 };
    for (const r of results) {
      const s = normalizeStatus(r.status);
      if (s === "passed") out.passed += 1;
      else if (s === "failed") out.failed += 1;
      else out.skipped += 1;
      out.totalDurationMs += r.durationMs ?? 0;
    }
    return out;
  }, [results]);

  const filteredResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    const bySearch = results.filter((r) => {
      if (!q) return true;
      const filePath = r.case.key?.split("#")[0]?.replace(/\\/g, "/") ?? "";
      const fileName = filePath.split("/").pop() ?? "";
      const target = `${r.case.title} ${fileName} ${filePath}`.toLowerCase();
      return target.includes(q);
    });
    const byStatus = bySearch.filter((r) => {
      if (statusFilter === "all") return true;
      if (statusFilter === "flaky") return false;
      return normalizeStatus(r.status) === statusFilter;
    });
    if (sortBy === "duration") {
      return [...byStatus].sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1));
    }
    if (sortBy === "status") {
      return [...byStatus].sort((a, b) => statusOrder(a.status) - statusOrder(b.status));
    }
    return byStatus;
  }, [results, search, statusFilter, sortBy]);

  useEffect(() => {
    if (!filteredResults.length) {
      setSelectedId(null);
      return;
    }
    if (selectedId && filteredResults.some((r) => r.id === selectedId)) return;
    const firstFailed = filteredResults.find((r) => normalizeStatus(r.status) === "failed");
    setSelectedId((firstFailed ?? filteredResults[0]).id);
  }, [filteredResults, selectedId]);

  const selected = filteredResults.find((r) => r.id === selectedId) ?? null;
  const selectedPath = selected?.case.key?.split("#")[0]?.replace(/\\/g, "/") ?? null;
  const selectedHasValidPath = !!selectedPath && selectedPath !== "unknown";
  const selectedFileName = selectedPath ? selectedPath.split("/").pop() : null;
  const selectedTargetSuiteId =
    suiteId ||
    (projectId && projectId.startsWith("agent-") ? projectId : projectId ? `agent-${projectId}` : null);
  const selectedDisplayTitle = (selected?.case.title || "").includes(" > ")
    ? selected?.case.title.split(" > ").pop() || selected?.case.title || ""
    : selected?.case.title || "";
  const selectedErrorLines = (selected?.message || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const selectedTopStackLine =
    selectedErrorLines.find((line) => line.startsWith("at ") || line.includes(".ts:") || line.includes(".js:")) ??
    null;
  const selectedSteps = (selected?.steps && selected.steps.length > 0)
    ? selected.steps
    : deriveFallbackSteps(selectedDisplayTitle);
  const selectedIsFailed = !!selected && normalizeStatus(selected.status) === "failed";
  const buildStaticUrl = (rel?: string | null, opts: { index?: boolean } = {}) => {
    if (!rel) return null;
    const clean = rel.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    const path = opts.index ? `${clean.replace(/\/$/, "")}/index.html` : clean;
    return apiUrl(`/_static/${path}`);
  };
  const allureTraceHref =
    artifactMeta?.publicArtifacts?.allureReportUrl ??
    buildStaticUrl(artifactMeta?.artifactsJson?.["allure-report"], { index: true }) ??
    null;
  const reportJsonHref =
    artifactMeta?.publicArtifacts?.reportJsonUrl ??
    buildStaticUrl(artifactMeta?.artifactsJson?.reportJson) ??
    null;
  const openTraceHref = allureTraceHref ?? reportJsonHref ?? null;
  const inferStepState = (stepIndex: number, totalSteps: number, status: Result["status"]) => {
    const normalized = normalizeStatus(status);
    if (normalized === "passed") return "passed";
    if (normalized === "skipped") return "skipped";
    return stepIndex === totalSteps - 1 ? "failed" : "passed";
  };
  const stepDetailText = (step: string, stepState: "passed" | "failed" | "skipped") => {
    const lower = step.toLowerCase();
    if (stepState === "failed") {
      if (lower.includes("click")) return "Timeout waiting for selector";
      if (lower.includes("goto") || lower.includes("navigate") || lower.includes("open ")) return "Navigation timeout or redirect mismatch";
      if (lower.includes("fill") || lower.includes("type")) return "Input target not interactable";
      return "Step execution failed";
    }
    if (stepState === "skipped") return "Skipped by runner";
    if (lower.includes("goto") || lower.includes("navigate") || lower.includes("open ")) return "Page loaded";
    if (lower.includes("click")) return "Element found";
    if (lower.includes("fill") || lower.includes("type")) return "Input accepted";
    if (lower.includes("wait")) return "Condition satisfied";
    return "Step completed";
  };
  const detectedFailedStepIndex = useMemo(() => {
    if (!selected) return null;
    if (normalizeStatus(selected.status) !== "failed") return null;
    const timeoutInStep = selectedSteps.findIndex((step) => /timeout/i.test(step));
    if (timeoutInStep >= 0) return timeoutInStep;
    return selectedSteps.length > 0 ? selectedSteps.length - 1 : null;
  }, [selected, selectedSteps]);
  const timeoutFromMessage = useMemo(() => {
    const m = selected?.message?.match(/(\d+)\s*ms/i);
    return m ? Number(m[1]) : null;
  }, [selected?.message]);
  const stepDurations = useMemo(
    () => estimateStepDurations(selectedSteps.length, selected?.durationMs ?? null, detectedFailedStepIndex, timeoutFromMessage),
    [selectedSteps.length, selected?.durationMs, detectedFailedStepIndex, timeoutFromMessage]
  );
  const failedStepText = detectedFailedStepIndex != null ? selectedSteps[detectedFailedStepIndex] : null;
  const failedUrlAssertion = isUrlAssertionFailure(selected?.message, failedStepText);
  const failedSelector = failedUrlAssertion ? null : extractSelector(selected?.message, failedStepText);
  const failedExpectedPath = extractExpectedPathFromMessage(selected?.message) || inferExpectedPathFromTitle(selectedDisplayTitle);
  const failedSuggestion = buildSuggestion(failedSelector, failedStepText, selected?.message, selectedDisplayTitle);

  if (err) return <div className="text-sm text-rose-600">{err}</div>;
  if (!results.length) return <div className="text-sm text-slate-500">No results yet.</div>;

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <div className="mb-3 font-semibold text-slate-900">Run Results</div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">✔ Passed {summary.passed}</div>
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">✖ Failed {summary.failed}</div>
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">⚠ Skipped {summary.skipped}</div>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">⏱ Total {formatDuration(summary.totalDurationMs)}</div>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(340px,420px)_1fr]">
        <section className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
          <div className="space-y-3">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by test, file, or tag"
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-0 focus:border-slate-300"
            />
            <div className="flex flex-wrap items-center gap-2">
              {(["all", "failed", "passed", "skipped", "flaky"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setStatusFilter(f)}
                  className={`rounded-full px-3 py-1 text-xs ${
                    statusFilter === f ? "bg-slate-200 text-slate-900" : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <span>Sort</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as "default" | "duration" | "status")}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
              >
                <option value="default">Default</option>
                <option value="duration">Duration</option>
                <option value="status">Status</option>
              </select>
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {filteredResults.length === 0 && <div className="text-sm text-slate-500">No tests match your filters.</div>}
            {filteredResults.map((r) => {
              const path = r.case.key?.split("#")[0]?.replace(/\\/g, "/");
              const fileName = path ? path.split("/").pop() : null;
              const displayTitle = r.case.title.includes(" > ")
                ? r.case.title.split(" > ").pop() || r.case.title
                : r.case.title;
              const selectedRow = selectedId === r.id;
              const failedTint = normalizeStatus(r.status) === "failed";
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={`w-full rounded-md border p-3 text-left ${
                    selectedRow
                      ? "border-slate-300 bg-slate-50"
                      : failedTint
                        ? "border-rose-200 bg-rose-50/40"
                        : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {icon(r.status)}
                        <div className="truncate font-medium text-slate-800">{displayTitle}</div>
                      </div>
                      <div className="mt-1 truncate text-xs text-slate-500">{fileName ?? "unknown file"}</div>
                    </div>
                    <div className="flex items-center gap-2 pl-2 text-xs text-slate-600">
                      <span className={`rounded px-2 py-0.5 ${failedTint ? "bg-rose-100 text-rose-700" : "bg-slate-100 text-slate-700"}`}>
                        {statusLabel(r.status)}
                      </span>
                      <span>{durationLabel(r.durationMs)}</span>
                      <ChevronRight className={`h-4 w-4 text-slate-400 ${selectedRow ? "rotate-90" : ""}`} />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4 shadow-sm">
          {!selected && <div className="text-sm text-slate-500">Select a test to inspect details.</div>}
          {selected && (
            <div className="space-y-4">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-900">{selectedDisplayTitle}</div>
                    <div className="mt-1 text-xs text-slate-500">{selectedPath ?? "unknown file"}</div>
                  </div>
                  <div className="text-right">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusPillClass(selected.status)}`}>
                      {statusLabel(selected.status)}
                    </span>
                    <div className="mt-1 text-xs text-slate-600">{durationLabel(selected.durationMs)}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!selectedHasValidPath || rerunLoadingId === selectedPath}
                    onClick={() => handleRerun(selectedHasValidPath ? selectedPath : null, selected.case.title)}
                  >
                    <RotateCcw className="mr-1 h-4 w-4" />
                    {rerunLoadingId === selectedPath ? "Rerunning..." : "Rerun"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!selectedIsFailed || !selectedHasValidPath || analyzeLoadingId === (selectedPath || "run")}
                    onClick={() => {
                      if (!selectedIsFailed || !selectedHasValidPath) return;
                      handleAnalyze(selectedHasValidPath ? selectedPath : null, selected.case.title);
                    }}
                  >
                    {analyzeLoadingId === (selectedPath || "run")
                      ? "Analyzing..."
                      : selectedIsFailed && selectedHasValidPath
                        ? "AI analyze"
                        : "AI analyze (needs failed spec)"}
                  </Button>
                  {openTraceHref ? (
                    <Button asChild size="sm" variant="outline">
                      <a href={openTraceHref} target="_blank" rel="noreferrer">
                        Open trace
                      </a>
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled>Open trace</Button>
                  )}
                </div>
              </div>

              {selectedIsFailed && (
                <div className="rounded-md border border-rose-200 bg-rose-50 p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-rose-700">Error</div>
                  <pre className="whitespace-pre-wrap font-mono text-xs text-rose-900">{selected.message || "No error message captured."}</pre>
                  {selectedTopStackLine && (
                    <div className="mt-2 rounded border border-rose-200 bg-white/70 px-2 py-1 font-mono text-xs text-rose-900">
                      {selectedTopStackLine}
                    </div>
                  )}
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(selected.message || "");
                        } catch {
                          alert("Unable to copy error");
                        }
                      }}
                    >
                      <Copy className="mr-1 h-4 w-4" />
                      Copy error
                    </Button>
                  </div>
                </div>
              )}

              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600">Steps timeline</div>
                {selectedSteps.length > 0 && (
                  <div className="space-y-2">
                    {selectedSteps.map((step, idx) => {
                      const inferredState = inferStepState(idx, selectedSteps.length, selected.status);
                      const stepState =
                        detectedFailedStepIndex != null && idx === detectedFailedStepIndex ? "failed" : inferredState;
                      const stepDuration = stepDurations[idx];
                      const detail = stepDetailText(step, stepState);
                      return (
                        <div
                          key={`${selected.id}-step-${idx}`}
                          className={`flex items-start justify-between gap-2 rounded border px-2 py-1.5 ${
                            stepState === "failed" ? "border-rose-200 bg-rose-50/40" : "border-slate-200 bg-white"
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 text-sm">
                              {stepState === "passed" ? (
                                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                              ) : stepState === "failed" ? (
                                <XCircle className="h-4 w-4 text-rose-600" />
                              ) : (
                                <CircleAlert className="h-4 w-4 text-amber-500" />
                              )}
                              <span className="text-slate-800">{idx + 1}. {step}</span>
                            </div>
                            <div className={`ml-6 mt-1 text-xs ${stepState === "failed" ? "text-rose-700" : "text-slate-500"}`}>
                              {detail}
                            </div>
                          </div>
                          <div className="shrink-0 text-xs text-slate-500">{formatDuration(stepDuration)}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {normalizeStatus(selected.status) === "failed" && failedStepText && (
                  <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-rose-700">Failed step</div>
                    <div className="mt-1 text-sm text-rose-900">{failedStepText}</div>
                    {selected.message && <div className="mt-2 text-xs text-rose-800">❌ {selected.message.split("\n")[0]}</div>}
                    {failedUrlAssertion ? (
                      <div className="mt-2 font-mono text-xs text-rose-900">Expected path: {failedExpectedPath ?? "Not detected"}</div>
                    ) : (
                      <div className="mt-2 font-mono text-xs text-rose-900">Selector: {failedSelector ?? "Not detected"}</div>
                    )}
                    <div className="mt-1 font-mono text-xs text-rose-900">Suggestion: {failedSuggestion.text}</div>
                    <div className="mt-1 text-xs text-rose-700">Confidence: {failedSuggestion.confidence}</div>
                  </div>
                )}
              </div>

              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600">Artifacts</div>
                <div className="flex flex-wrap gap-2">
                  {reportJsonHref ? (
                    <Button asChild size="sm" variant="outline">
                      <a href={reportJsonHref} target="_blank" rel="noreferrer">Raw log</a>
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled>Raw log</Button>
                  )}
                  <Button size="sm" variant="outline" disabled>Screenshot</Button>
                  <Button size="sm" variant="outline" disabled>Video</Button>
                  <Button size="sm" variant="outline" disabled>Trace (.zip)</Button>
                </div>
              </div>

              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600">Actions</div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link
                      to={
                        selectedPath && selectedTargetSuiteId
                          ? `/suite/${encodeURIComponent(
                              selectedTargetSuiteId
                            )}?project=${encodeURIComponent(
                              selectedTargetSuiteId
                            )}&spec=${encodeURIComponent(selectedPath)}&returnTo=${encodeURIComponent(`/test-runs/${runId}`)}`
                          : selectedPath
                            ? `/suites?spec=${encodeURIComponent(selectedPath)}&returnTo=${encodeURIComponent(`/test-runs/${runId}`)}`
                            : `/suites?returnTo=${encodeURIComponent(`/test-runs/${runId}`)}`
                      }
                    >
                      Edit in suite
                    </Link>
                  </Button>
                  <Button size="sm" variant="outline" disabled>Promote locator</Button>
                </div>
                {selectedFileName && <div className="mt-2 text-xs text-slate-500">Spec: {selectedFileName}</div>}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
