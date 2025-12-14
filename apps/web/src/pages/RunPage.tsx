// apps/web/src/pages/RunPage.tsx

import { useCallback, useEffect, useMemo, useState } from "react";

import { useParams, Link, useNavigate } from "react-router-dom";

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

  healingAttempts: { id: string; status: "queued" | "running" | "succeeded" | "failed" | "skipped" }[];

  paramsJson?: {

    headful?: boolean;

    reporter?: string;

    specFile?: string | null;

    grep?: string | null;
    suiteId?: string | null;

  } | null;

  artifactsJson?: Record<string, string> | null;

  reportPath?: string | null;

};



type Analysis = {

  summary: string;

  cause: string;

  suggestion: string;

  model?: string;

} | null;



type IntegrationSummary = {

  id: string;

  provider: string;

  name?: string | null;

  enabled: boolean;

};



const GITHUB_PROVIDER = "github-issues";



export default function RunPage() {

  const { runId } = useParams<{ runId: string }>();

  const { apiFetch } = useApi();

  const navigate = useNavigate();



  const [run, setRun] = useState<Run | null>(null);

  const [err, setErr] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);

  const [creatingIssue, setCreatingIssue] = useState(false);

  const [triggeringRerun, setTriggeringRerun] = useState(false);

  const [githubIntegrationId, setGithubIntegrationId] = useState<string | null>(null);

  const [analysis, setAnalysis] = useState<Analysis>(null);



  const parsedSummary = useMemo(() => {

    if (!run?.summary) return null;

    try {

      return JSON.parse(run.summary);

    } catch {

      return null;

    }

  }, [run?.summary]);



  const params = run?.paramsJson ?? null;
  const suiteIdFromRun = (params as any)?.suiteId as string | undefined;

  const artifacts = run?.artifactsJson ?? null;

  const summaryErrors: string[] = Array.isArray(parsedSummary?.errors) ? parsedSummary.errors : [];

  const buildStaticUrl = (rel?: string | null, opts: { index?: boolean } = {}) => {

    if (!rel) return null;

    const clean = rel.replace(/^[/\\]+/, "").replace(/\\/g, "/");

    const path = opts.index ? `${clean.replace(/\/$/, "")}/index.html` : clean;

    return `/_static/${path}`;

  };



  const done = useMemo(

    () => !!run && run.status !== "queued" && run.status !== "running",

    [run]

  );

  const reruns = run?.reruns ?? [];

  const isRerun = Boolean(run?.rerunOfId);

  const rerunsInProgress = reruns.some(

    (r) => r.status === "running" || r.status === "queued"

  );

  const rerunsCompleted = reruns.filter((r) => r.status === "succeeded" || r.status === "failed");

  const healingAttempts = run?.healingAttempts ?? [];

  const healingInProgress = healingAttempts.some(

    (a) => a.status === "queued" || a.status === "running"

  );

  const hasHealingAttempts = healingAttempts.length > 0 || reruns.length > 0;

  const healStatusMessage = (() => {

    if (isRerun) {

      if (run?.rerunOf) {

        return (

          <>

            This run was triggered automatically after{" "}

            <Link to={`/test-runs/${run.rerunOf.id}`} className="underline">

              run {run.rerunOf.id}

            </Link>{" "}

            failed.

          </>

        );

      }

      return "This run was triggered automatically.";

    }

    if (!run) return "";

    if (run.status === "running" || run.status === "queued")

      return "Run is still in progress; self-heal will start if failures occur.";

    if (!hasHealingAttempts) return "No self-heal attempts were triggered.";

    if (run.status === "succeeded") return "Original run passed; self-heal was not required.";

    if (healingInProgress) return "Tests failed. Self-heal is runningâ€¦";

    if (rerunsInProgress) return "Self-heal reruns are still running.";

    if (rerunsCompleted.length > 0) return "Self-heal reruns have completed.";

    if (reruns.length > 0) return "Self-heal reruns are queued.";

    if (hasHealingAttempts) return "Self-heal attempts have finished.";

    return "Self-heal will start shortly.";

  })();

  const friendlyError = useCallback((raw?: string | null) => {
    if (!raw) return "Failed to load run";
    const msg = String(raw);
    if (msg.includes("P1001") || msg.toLowerCase().includes("can't reach database server")) {
      return "Could not load run: API cannot reach the database (is Postgres running on the configured host/port?).";
    }
    if (msg.toLowerCase().includes("unauthorized")) {
      return "You are not authorized to view this run. Please sign in and try again.";
    }
    try {
      const parsed = JSON.parse(msg);
      if (parsed?.message) return parsed.message;
    } catch {
      /* ignore */
    }
    return msg.length > 400 ? `${msg.slice(0, 400)}â€¦` : msg;
  }, []);



  // load + (light) poll until finished

  useEffect(() => {

    if (!runId) return;



    let cancelled = false;

    let interval: number | undefined;



    const load = async () => {

      try {

        const { run: r } = await apiFetch<{ run: Run }>(`/runner/test-runs/${runId}`);

        if (!cancelled) {

          setRun(r);

          setErr(null);

        }

      } catch (e: any) {

        if (!cancelled) setErr(friendlyError(e?.message ?? (e as any)?.error ?? null));

      } finally {

        if (!cancelled) setLoading(false);

      }

    };



    load();



    const shouldPoll =

      !run ||

      run.status === "queued" ||

      run.status === "running" ||

      healingInProgress ||

      rerunsInProgress ||

      (hasHealingAttempts && rerunsCompleted.length === 0);



    if (shouldPoll) {

      interval = window.setInterval(load, 2000) as unknown as number;

    }



    return () => {

      cancelled = true;

      if (interval) window.clearInterval(interval);

    };

    // eslint-disable-next-line react-hooks/exhaustive-deps

  }, [runId, run, healingInProgress, rerunsInProgress, hasHealingAttempts, rerunsCompleted.length]);



  const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString() : "-");



  // Load AI analysis once the run finishes (best effort)

  useEffect(() => {

    if (!runId || !run || run.status === "queued" || run.status === "running") return;

    let cancelled = false;

    (async () => {

      try {

        const res = await apiFetch<{ analysis: Analysis }>(`/test-runs/${runId}/analysis`);

        if (!cancelled) setAnalysis(res.analysis ?? null);

      } catch {

        if (!cancelled) setAnalysis(null);

      }

    })();

    return () => {

      cancelled = true;

    };

    // eslint-disable-next-line react-hooks/exhaustive-deps

  }, [runId, run?.status]);



  const ensureGitHubIntegration = useCallback(async () => {

    if (!run) throw new Error("Run not loaded");

    if (githubIntegrationId) return githubIntegrationId;

    const qs = new URLSearchParams({ projectId: run.project.id });

    const { integrations } = await apiFetch<{ integrations: IntegrationSummary[] }>(

      `/integrations?${qs.toString()}`

    );

    let integration = integrations.find((i) => i.provider === GITHUB_PROVIDER) ?? null;

    if (!integration) {

      const created = await apiFetch<{ integration: IntegrationSummary }>("/integrations", {

        method: "POST",

        body: JSON.stringify({

          projectId: run.project.id,

          provider: GITHUB_PROVIDER,

          name: "GitHub Issues",

        }),

      });

      integration = created.integration;

    }

    setGithubIntegrationId(integration.id);

    return integration.id;

  }, [apiFetch, run, githubIntegrationId]);



  async function handleCreateIssue() {

    if (!run) return;

    try {

      setCreatingIssue(true);

      const integrationId = await ensureGitHubIntegration();

      const res = await apiFetch<{ url: string }>(

        `/integrations/${integrationId}/actions/create-issue`,

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



  async function handleManualRerun() {

    if (!run || triggeringRerun) return;

    try {

      setTriggeringRerun(true);

      const res = await apiFetch<{ runId: string }>(

        `/runner/test-runs/${run.id}/rerun`,

        { method: "POST" }

      );

      navigate(`/test-runs/${res.runId}`);

    } catch (e: any) {

      alert(e?.message ?? "Failed to trigger rerun");

    } finally {

      setTriggeringRerun(false);

    }

  }



  return (

    <div className="p-6 space-y-4">

      <h1 className="text-xl font-semibold">Test run</h1>



      {err && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {err}
        </div>
      )}

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

                <div>Framework: {parsedSummary.framework ?? "â€”"}</div>

                <div>Base URL: {parsedSummary.baseUrl ?? "â€”"}</div>

                <div>Parsed: {parsedSummary.parsedCount ?? 0}</div>

                <div>Passed: {parsedSummary.passed ?? 0}</div>

                <div>Failed: {parsedSummary.failed ?? 0}</div>

                <div>Skipped: {parsedSummary.skipped ?? 0}</div>

              </div>

            ) : (

              <div>Summary: {run.summary || "â€”"}</div>

            )}

            {params && (

              <div className="text-xs text-slate-500">

                Options: reporter {params.reporter ?? "json"} ï¿½ {params.headful ? "headed" : "headless"}

                {params.specFile ? ` ï¿½ file ${params.specFile}` : ""}{params.grep ? ` ï¿½ grep "${params.grep}"` : ""}

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

            <div>Error: {run.error || "-"}</div>

            {analysis && (

              <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3">

                <div className="mb-1 text-sm font-semibold text-slate-800">AI analysis</div>

                <dl className="space-y-1 text-sm text-slate-700">

                  <div>

                    <dt className="font-medium text-slate-800">Summary</dt>

                    <dd>{analysis.summary || "-"}</dd>

                  </div>

                  {analysis.cause && (

                    <div>

                      <dt className="font-medium text-slate-800">Likely cause</dt>

                      <dd>{analysis.cause}</dd>

                    </div>

                  )}

                  {analysis.suggestion && (

                    <div>

                      <dt className="font-medium text-slate-800">Suggested fix</dt>

                      <dd>{analysis.suggestion}</dd>

                    </div>

                  )}

                  {analysis.model && (

                    <div className="text-xs text-slate-500">Model: {analysis.model}</div>

                  )}

                </dl>

              </div>

            )}

          </div>

          <hr className="my-4" />



          <div className="space-y-6">

            {run && (

              <section>

                <div className="mb-1 flex flex-col gap-1 text-slate-800">

                  <div className="font-medium">Self-heal reruns</div>

                  <div className="text-xs text-slate-500">{healStatusMessage}</div>

                </div>

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
                            {child.finishedAt ? ` â€¢ Finished: ${fmt(child.finishedAt)}` : ""}
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
                  <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                    No reruns were recorded for this run. If self-heal ran but did not queue reruns, check runner logs
                    for details.
                  </div>
                )}
              </section>

            )}

            <section>

              <div className="mb-2 font-medium text-slate-800">Artifacts</div>

              <div className="flex flex-wrap gap-2">

                {buildStaticUrl(artifacts?.["allure-report"], { index: true }) && (

                  <Button asChild size="sm" variant="outline">

                    <a href={buildStaticUrl(artifacts?.["allure-report"], { index: true })!} target="_blank" rel="noreferrer">

                      View Allure report

                    </a>

                  </Button>

                )}

                {buildStaticUrl(artifacts?.reportJson) && (

                  <Button asChild size="sm" variant="outline">

                    <a href={buildStaticUrl(artifacts?.reportJson)!} target="_blank" rel="noreferrer">

                      Download raw JSON

                    </a>

                  </Button>

                )}

              </div>

              {!artifacts && (

                <div className="mt-1 text-sm text-slate-500">No artifacts were produced for this run.</div>

              )}

              {artifacts && !artifacts["allure-report"] && (

                <div className="mt-1 text-xs text-slate-500">

                  Allure report not available for this run (no allure-results folder was generated).

                </div>

              )}

              {artifacts && !artifacts.reportJson && (

                <div className="mt-1 text-xs text-slate-500">

                  report.json not found; the test command may have failed before producing a JSON report.

                </div>

              )}

            </section>

            <section>

          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">

            <div className="font-medium text-slate-800">Results</div>

            <Button

              size="sm"

              variant="outline"

              disabled={!run || rerunsInProgress || healingInProgress || triggeringRerun}

              onClick={handleManualRerun}

              title={

                !run

                  ? "Run not loaded yet"

                  : healingInProgress || rerunsInProgress

                      ? "Self-heal is still running"

                      : "Trigger a new run for this suite"

                  }

                >

                  {triggeringRerun ? "Starting rerunâ€¦" : "Rerun this suite"}

                </Button>

              </div>

              <RunResults runId={run.id} active={!done} projectId={run.project.id} suiteId={suiteIdFromRun} />

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

                  {creatingIssue ? "Creatingâ€¦" : "Create GitHub issue"}

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












