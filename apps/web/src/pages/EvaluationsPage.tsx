import { useEffect, useRef, useState } from "react";
import { useApi } from "../lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type Project = { id: string; name: string };

type EvaluationResult = {
  id: string;
  caseId: string;
  recallAtK: number | null;
  precisionAtK: number | null;
  requiredFactRate: number | null;
  abstainedCorrectly: boolean | null;
  latencyMs: number | null;
};

type MetricValue = { value: number | null; applicable_cases: number; metric_kind: "deterministic" | "llm_judged" };

// EvaluationRunStatus's own vocabulary - "succeeded", not ApiTestRun's "completed".
type RunStatus = "queued" | "running" | "succeeded" | "failed";

type EvaluationRun = {
  id: string;
  projectId: string;
  status: RunStatus;
  datasetId: string;
  datasetVersion: string;
  applicationId: string;
  applicationVersion: string;
  evaluatorVersion: string | null;
  overallGateStatus: "pass" | "fail" | "skipped_no_data" | null;
  metricsSummary: Record<string, MetricValue> | null;
  error: string | null;
  createdAt: string;
};

type FullRun = EvaluationRun & { results: EvaluationResult[]; openHumanReviewCount?: number };

// ── Gate-status badge ─────────────────────────────────────────────────────────

const GATE_STATUS_COLORS: Record<string, string> = {
  pass: "bg-green-100 text-green-800",
  fail: "bg-red-100 text-red-800",
  skipped_no_data: "bg-slate-100 text-slate-700",
};

function GateStatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${GATE_STATUS_COLORS[status] ?? "bg-slate-100 text-slate-700"}`}>
      {status}
    </span>
  );
}

const RUN_STATUS_COLORS: Record<string, string> = {
  queued: "bg-slate-100 text-slate-700",
  running: "bg-blue-100 text-blue-800",
  succeeded: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

function RunStatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${RUN_STATUS_COLORS[status] ?? "bg-slate-100 text-slate-700"}`}>
      {status}
    </span>
  );
}

const DEFAULT_CASES_JSON = JSON.stringify(
  [
    {
      case_id: "q-001",
      retrieved_doc_ids: ["doc-12", "doc-7"],
      relevant_doc_ids: ["doc-12"],
      required_facts: ["founded in 1998"],
      answer_text: "Founded in 1998.",
      should_abstain: false,
      abstained: false,
      latency_ms: 500,
    },
  ],
  null,
  2
);

const DEFAULT_GATES_JSON = JSON.stringify(
  {
    recall_at_k: { k: 5, min: 0.8 },
    required_fact_rate: { min: 0.9 },
  },
  null,
  2
);

export default function EvaluationsPage() {
  const { apiFetch } = useApi();

  // Project selection
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");

  // Runs list
  const [runs, setRuns] = useState<EvaluationRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  // Run detail / polling
  const [selectedRun, setSelectedRun] = useState<FullRun | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // New-run form
  const [datasetId, setDatasetId] = useState("support-kb-v3");
  const [datasetVersion, setDatasetVersion] = useState("2026-11-01");
  const [applicationId, setApplicationId] = useState("testmind-rag-bot");
  const [applicationVersion, setApplicationVersion] = useState("1.0.0");
  const [gatesJson, setGatesJson] = useState(DEFAULT_GATES_JSON);
  const [casesJson, setCasesJson] = useState(DEFAULT_CASES_JSON);
  const [starting, setStarting] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // ── Load projects on mount ───────────────────────────────────────────────

  useEffect(() => {
    apiFetch<{ projects: Project[] }>("/projects")
      .then((d) => {
        setProjects(d.projects ?? []);
        if (d.projects?.length) setProjectId(d.projects[0].id);
      })
      .catch(() => {});
  }, []);

  // ── Load runs when project changes ───────────────────────────────────────

  useEffect(() => {
    if (!projectId) return;
    setRunsLoading(true);
    setSelectedRun(null);
    setError(null);
    apiFetch<{ runs: EvaluationRun[] }>(`/evaluations/runs?projectId=${projectId}`)
      .then((d) => setRuns(d.runs ?? []))
      .catch((e) => setError(e?.message ?? "Failed to load evaluation runs"))
      .finally(() => setRunsLoading(false));
  }, [projectId]);

  // ── Start a new run ──────────────────────────────────────────────────────

  const startRun = async () => {
    setError(null);
    let gates: unknown;
    let cases: unknown;
    try {
      gates = gatesJson.trim() ? JSON.parse(gatesJson) : undefined;
      cases = JSON.parse(casesJson);
    } catch {
      setError("Gates and cases must be valid JSON.");
      return;
    }
    setStarting(true);
    try {
      const data = await apiFetch<{ runId: string }>("/evaluations/runs", {
        method: "POST",
        body: JSON.stringify({ projectId, datasetId, datasetVersion, applicationId, applicationVersion, gates, cases }),
      });
      const listed = await apiFetch<{ runs: EvaluationRun[] }>(`/evaluations/runs?projectId=${projectId}`);
      setRuns(listed.runs ?? []);
      pollRun(data.runId);
    } catch (e: any) {
      setError(e?.message ?? "Failed to start evaluation run");
    } finally {
      setStarting(false);
    }
  };

  // ── Poll run (exact pattern from ApiTestingPage.tsx's pollRun) ───────────

  const pollRun = (runId: string) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    const fetchRun = async () => {
      try {
        const data = await apiFetch<{ run: FullRun }>(`/evaluations/runs/${runId}`);
        setSelectedRun(data.run);
        if (data.run.status === "queued" || data.run.status === "running") {
          pollRef.current = setTimeout(fetchRun, 2000);
        }
      } catch (e: any) {
        setError(e?.message ?? "Failed to fetch evaluation run");
      }
    };
    fetchRun();
  };

  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Evaluations</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            RAG/LLM evaluation runs against the standalone evaluation service — deterministic metrics only in this phase.
          </p>
        </div>

        {error && (
          <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600 dark:text-slate-300">Project</label>
          <select
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:bg-slate-900"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="rounded border border-slate-200 bg-white p-4 dark:bg-slate-900 dark:border-slate-700">
          <h2 className="mb-3 text-sm font-medium text-slate-800 dark:text-slate-200">Start a new run</h2>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="flex flex-col gap-1">
              Dataset ID
              <input className="rounded border border-slate-300 px-2 py-1 dark:bg-slate-800" value={datasetId} onChange={(e) => setDatasetId(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              Dataset version
              <input className="rounded border border-slate-300 px-2 py-1 dark:bg-slate-800" value={datasetVersion} onChange={(e) => setDatasetVersion(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              Application ID
              <input className="rounded border border-slate-300 px-2 py-1 dark:bg-slate-800" value={applicationId} onChange={(e) => setApplicationId(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              Application version
              <input className="rounded border border-slate-300 px-2 py-1 dark:bg-slate-800" value={applicationVersion} onChange={(e) => setApplicationVersion(e.target.value)} />
            </label>
          </div>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            Gates (JSON, optional)
            <textarea
              className="h-28 rounded border border-slate-300 px-2 py-1 font-mono text-xs dark:bg-slate-800"
              value={gatesJson}
              onChange={(e) => setGatesJson(e.target.value)}
            />
          </label>
          <label className="mt-3 flex flex-col gap-1 text-sm">
            Cases (JSON array)
            <textarea
              className="h-40 rounded border border-slate-300 px-2 py-1 font-mono text-xs dark:bg-slate-800"
              value={casesJson}
              onChange={(e) => setCasesJson(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={starting || !projectId}
            onClick={startRun}
            className="mt-3 rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {starting ? "Starting…" : "Start run"}
          </button>
        </div>

        <div className="rounded border border-slate-200 bg-white p-4 dark:bg-slate-900 dark:border-slate-700">
          <h2 className="mb-3 text-sm font-medium text-slate-800 dark:text-slate-200">Runs</h2>
          {runsLoading && <p className="text-sm text-slate-500">Loading…</p>}
          {!runsLoading && runs.length === 0 && <p className="text-sm text-slate-500">No evaluation runs yet.</p>}
          <ul className="divide-y divide-slate-200 dark:divide-slate-700">
            {runs.map((run) => (
              <li key={run.id} className="flex items-center justify-between py-2 text-sm">
                <button type="button" className="text-left hover:underline" onClick={() => pollRun(run.id)}>
                  {run.datasetId}/{run.datasetVersion} vs {run.applicationId}/{run.applicationVersion}
                </button>
                <div className="flex items-center gap-2">
                  <GateStatusBadge status={run.overallGateStatus} />
                  <RunStatusBadge status={run.status} />
                </div>
              </li>
            ))}
          </ul>
        </div>

        {selectedRun && (
          <div className="rounded border border-slate-200 bg-white p-4 dark:bg-slate-900 dark:border-slate-700">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-slate-800 dark:text-slate-200">
                Run {selectedRun.id.slice(0, 8)}
              </h2>
              <div className="flex items-center gap-2">
                {!!selectedRun.openHumanReviewCount && (
                  <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800">
                    {selectedRun.openHumanReviewCount} needs human review
                  </span>
                )}
                <GateStatusBadge status={selectedRun.overallGateStatus} />
                <RunStatusBadge status={selectedRun.status} />
              </div>
            </div>
            {selectedRun.error && <p className="mb-2 text-sm text-red-700">{selectedRun.error}</p>}
            {selectedRun.metricsSummary && (
              <table className="mb-4 w-full text-left text-sm">
                <thead>
                  <tr className="text-slate-500">
                    <th className="pr-4">Metric</th>
                    <th className="pr-4">Value</th>
                    <th className="pr-4">Applicable cases</th>
                    <th>Kind</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(selectedRun.metricsSummary).map(([name, metric]) => (
                    <tr key={name}>
                      <td className="pr-4 font-mono text-xs">{name}</td>
                      <td className="pr-4">{metric.value === null ? "—" : metric.value.toFixed(3)}</td>
                      <td className="pr-4">{metric.applicable_cases}</td>
                      <td className="text-xs text-slate-500">{metric.metric_kind}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-slate-500">
                  <th className="pr-4">Case</th>
                  <th className="pr-4">Recall@k</th>
                  <th className="pr-4">Precision@k</th>
                  <th className="pr-4">Required fact rate</th>
                  <th>Latency (ms)</th>
                </tr>
              </thead>
              <tbody>
                {selectedRun.results.map((r) => (
                  <tr key={r.id}>
                    <td className="pr-4 font-mono text-xs">{r.caseId}</td>
                    <td className="pr-4">{r.recallAtK ?? "—"}</td>
                    <td className="pr-4">{r.precisionAtK ?? "—"}</td>
                    <td className="pr-4">{r.requiredFactRate ?? "—"}</td>
                    <td>{r.latencyMs ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
