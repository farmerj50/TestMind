// apps/web/src/pages/RunPage.tsx
import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useApi } from "../lib/api";
import StatusBadge from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { ExternalLink } from "lucide-react";
import RunResults from "../components/RunResults";
import RunLogs from "../components/RunLogs";

type TestRunStatus = "queued" | "running" | "succeeded" | "failed";
type Run = {
  id: string;
  status: TestRunStatus;
  summary?: string | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  project: { id: string; name: string };
  issueUrl?: string | null;
  rerunOfId?: string | null;
  rerunOf?: { id: string; status: TestRunStatus } | null;
  reruns: {
    id: string;
    status: TestRunStatus;
    createdAt: string;
    startedAt?: string | null;
    finishedAt?: string | null;
  }[];
  paramsJson?: {
    headful?: boolean;
    reporter?: string;
    specFile?: string | null;
    grep?: string | null;
  } | null;
  artifactsJson?: Record<string, string> | null;
  reportPath?: string | null;
};

export default function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const { apiFetch } = useApi();

  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingIssue, setCreatingIssue] = useState(false);

  const parsedSummary = useMemo(() => {
    if (!run?.summary) return null;
    try {
      return JSON.parse(run.summary);
    } catch {
      return null;
    }
  }, [run?.summary]);

  const params = run?.paramsJson ?? null;
  const artifacts = run?.artifactsJson ?? null;
  const summaryErrors: string[] = Array.isArray(parsedSummary?.errors) ? parsedSummary.errors : [];
  const buildStaticUrl = (rel?: string | null, opts: { index?: boolean } = {}) => {
    if (!rel) return null;
    const clean = rel.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    const path = opts.index ? `${clean.replace(/\/$/, "")}/index.html` : clean;
    return `/_static/${path}`;
  };

  const done = useMemo(
    () => !!run && (run.status === "succeeded" || run.status === "failed"),
    [run]
  );
  const reruns = run?.reruns ?? [];
  const isRerun = Boolean(run?.rerunOfId);

  // load + (light) poll until finished
  useEffect(() => {
    if (!runId) return;

    let cancelled = false;
    let interval: number | undefined;

    const load = async () => {
      try {
        // API returns { run }
        const { run: r } = await apiFetch<{ run: Run }>(`/runner/test-runs/${runId}`);
        if (!cancelled) {
          setRun(r);
          setErr(null);
        }
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "Failed to load run");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    if (!done) {
      interval = window.setInterval(load, 2000) as unknown as number;
    }

    return () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, done]);

  const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString() : "—");
  const describeStatus = (s: TestRunStatus) => {
    switch (s) {
      case "queued":
        return "is queued";
      case "running":
        return "is running";
      case "succeeded":
        return "succeeded";
      case "failed":
        return "failed";
      default:
        return s;
    }
  };

  async function handleCreateIssue() {
    if (!run) return;
    try {
      setCreatingIssue(true);
      const res = await apiFetch<{ url: string }>(
        "/integrations/github/create-issue",
        {
          method: "POST",
          body: JSON.stringify({ runId: run.id }),
        }
      );
      setRun((prev) => (prev ? { ...prev, issueUrl: res.url } : prev));
    } catch (e: any) {
      alert(e?.message ?? "Failed to create GitHub issue");
    } finally {
      setCreatingIssue(false);
    }
  }

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">Test run</h1>

      {err && <div className="text-rose-600">{err}</div>}
      {loading && !run && <div>Loading…</div>}

      {run && (
        <>
          <div className="text-sm text-slate-600">
            Project:{" "}
            <Link to={`/projects/${run.project.id}`} className="underline">
              {run.project.name}
            </Link>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">Status:</span>
            <StatusBadge status={run.status} />
          </div>

          <div className="space-y-1">
            {parsedSummary ? (
              <div className="grid gap-1 text-sm text-slate-700 md:grid-cols-2">
                <div>Framework: {parsedSummary.framework ?? "—"}</div>
                <div>Base URL: {parsedSummary.baseUrl ?? "—"}</div>
                <div>Parsed: {parsedSummary.parsedCount ?? 0}</div>
                <div>Passed: {parsedSummary.passed ?? 0}</div>
                <div>Failed: {parsedSummary.failed ?? 0}</div>
                <div>Skipped: {parsedSummary.skipped ?? 0}</div>
              </div>
            ) : (
              <div>Summary: {run.summary || "—"}</div>
            )}
            {params && (
              <div className="text-xs text-slate-500">
                Options: reporter {params.reporter ?? "json"} · {params.headful ? "headed" : "headless"}
                {params.specFile ? ` · file ${params.specFile}` : ""}{params.grep ? ` · grep "${params.grep}"` : ""}
              </div>
            )}
            {summaryErrors.length > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <div className="font-medium text-amber-900">Reporter errors</div>
                <ul className="mt-1 list-disc pl-5">
                  {summaryErrors.map((msg, idx) => (
                    <li key={idx}>{msg}</li>
                  ))}
                </ul>
              </div>
            )}
            <div>Error: {run.error || "—"}</div>
          </div>
          <hr className="my-4" />

          <div className="space-y-6">
            {(isRerun || reruns.length > 0) && (
              <section>
                <div className="mb-2 font-medium text-slate-800">Self-heal reruns</div>
                {isRerun && run.rerunOf && (
                  <div className="mb-2 text-sm text-slate-600">
                    This run was triggered automatically after{" "}
                    <Link to={`/test-runs/${run.rerunOf.id}`} className="underline">
                      run {run.rerunOf.id}
                    </Link>{" "}
                    {describeStatus(run.rerunOf.status)}.
                  </div>
                )}
                {reruns.length > 0 ? (
                  <ul className="space-y-2">
                    {reruns.map((child, idx) => (
                      <li
                        key={child.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 p-3 text-sm"
                      >
                        <div className="space-y-1">
                          <div className="font-medium">Rerun #{idx + 1}</div>
                          <div className="text-xs text-slate-500">
                            Started: {fmt(child.startedAt ?? child.createdAt)}
                            {child.finishedAt ? ` · Finished: ${fmt(child.finishedAt)}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={child.status} />
                          <Button asChild size="sm" variant="outline">
                            <Link to={`/test-runs/${child.id}`}>View</Link>
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  !isRerun && (
                    <div className="text-sm text-slate-500">
                      No self-heal reruns have been triggered for this run.
                    </div>
                  )
                )}
              </section>
            )}
            {(artifacts && (artifacts["allure-report"] || artifacts.reportJson)) && (
              <section>
                <div className="mb-2 font-medium text-slate-800">Artifacts</div>
                <div className="flex flex-wrap gap-2">
                  {buildStaticUrl(artifacts["allure-report"], { index: true }) && (
                    <Button asChild size="sm" variant="outline">
                      <a href={buildStaticUrl(artifacts["allure-report"], { index: true })!} target="_blank" rel="noreferrer">
                        View Allure report
                      </a>
                    </Button>
                  )}
                  {buildStaticUrl(artifacts.reportJson) && (
                    <Button asChild size="sm" variant="outline">
                      <a href={buildStaticUrl(artifacts.reportJson)!} target="_blank" rel="noreferrer">
                        Download raw JSON
                      </a>
                    </Button>
                  )}
                </div>
              </section>
            )}
            <section>
              <div className="mb-2 font-medium text-slate-800">Results</div>
              <RunResults runId={run.id} active={!done} />
            </section>
            <section>
              <div className="mb-2 font-medium text-slate-800">Logs</div>
              <RunLogs runId={run.id} />
            </section>
          </div>

          {/* GitHub Issue Actions */}
          <div className="mt-2">
            {done ? (
              run.issueUrl ? (
                <Button asChild variant="outline" size="sm" title="View the GitHub issue">
                  <a href={run.issueUrl} target="_blank" rel="noreferrer">
                    View GitHub issue <ExternalLink className="ml-1 h-3 w-3" />
                  </a>
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleCreateIssue}
                  disabled={creatingIssue}
                  title="Create a GitHub issue for this run"
                >
                  {creatingIssue ? "Creating…" : "Create GitHub issue"}
                </Button>
              )
            ) : (
              <Button size="sm" variant="secondary" disabled title="Available after run completes">
                Create GitHub issue
              </Button>
            )}
          </div>

          <div className="grid gap-1">
            <div>Created: {fmt(run.createdAt)}</div>
            <div>Started: {fmt(run.startedAt)}</div>
            <div>Finished: {fmt(run.finishedAt)}</div>
          </div>
        </>
      )}
    </div>
  );
}
