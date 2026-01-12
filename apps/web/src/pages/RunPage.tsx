// apps/web/src/pages/RunPage.tsx



import { useCallback, useEffect, useMemo, useRef, useState } from "react";



import { useParams, Link, useNavigate } from "react-router-dom";



import { apiUrl, useApi } from "../lib/api";



import StatusBadge from "../components/StatusBadge";



import { Button } from "../components/ui/button";



import { ExternalLink } from "lucide-react";



import RunResults from "../components/RunResults";



import RunLogs from "../components/RunLogs";
import { useTelemetryStream, type TelemetryEvent } from "../hooks/useTelemetryStream";







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
    livePreview?: boolean;



  } | null;



  artifactsJson?: Record<string, string> | null;



  reportPath?: string | null;



};



type LocatorBucket = "fields" | "buttons" | "links" | "locators";



type MissingLocatorItem = {

  pagePath: string;

  bucket: LocatorBucket;

  name: string;

  stepText: string;

  suggestions: string[];

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



  const [missingLocators, setMissingLocators] = useState<MissingLocatorItem[]>([]);

  const [missingNavMappings, setMissingNavMappings] = useState<MissingLocatorItem[]>([]);

  const [missingLoading, setMissingLoading] = useState(false);

  const [missingError, setMissingError] = useState<string | null>(null);

  const [selectorValues, setSelectorValues] = useState<Record<string, string>>({});

  const [saveStates, setSaveStates] = useState<

    Record<string, { loading: boolean; error?: string; success?: boolean }>

  >({});

  const [stopping, setStopping] = useState(false);
  const [telemetryEvents, setTelemetryEvents] = useState<TelemetryEvent[]>([]);
  const [telemetryFilter, setTelemetryFilter] = useState<"all" | "errors">("errors");
  const [livePreviewEnabled, setLivePreviewEnabled] = useState(false);
  const livePreviewTouchedRef = useRef(false);
  const [liveFrameUrl, setLiveFrameUrl] = useState<string | null>(null);
  const livePollRef = useRef<number | null>(null);
  const livePollStopRef = useRef<number | null>(null);
  const liveStreamRef = useRef<EventSource | null>(null);
const parsedSummary = useMemo(() => {



    if (!run?.summary) return null;



    try {



      return JSON.parse(run.summary);



    } catch {



      return null;



    }



  }, [run?.summary]);

  const startLivePolling = useCallback(
    (durationMs = 10000, intervalMs = 1000) => {
      if (!runId) return;
      const base = apiUrl(`/runner-logs/${runId}/live/latest.png`);
      const tick = () => {
        setLiveFrameUrl(`${base}?t=${Date.now()}`);
      };

      if (livePollRef.current !== null) {
        window.clearInterval(livePollRef.current);
      }
      if (livePollStopRef.current !== null) {
        window.clearTimeout(livePollStopRef.current);
      }

      tick();
      livePollRef.current = window.setInterval(tick, intervalMs);
      livePollStopRef.current = window.setTimeout(() => {
        if (livePollRef.current !== null) {
          window.clearInterval(livePollRef.current);
          livePollRef.current = null;
        }
      }, durationMs);
    },
    [runId]
  );

  const handleTelemetryEvent = useCallback(
    (event: TelemetryEvent) => {
      setTelemetryEvents((prev) => {
        const next = [...prev, event];
        return next.length > 800 ? next.slice(-800) : next;
      });
      if (
        event.type === "healer_start" ||
        event.type === "healer_retry_start" ||
        event.type === "telemetry_hooked"
      ) {
        startLivePolling();
      }
    },
    [startLivePolling]
  );

  const visibleTelemetry = useMemo(() => {
    if (telemetryFilter === "all") return telemetryEvents;
    return telemetryEvents.filter((event) => {
      if (event.type === "pageerror" || event.type === "requestfailed") return true;
      if (event.type === "console") {
        return event.level === "error" || event.level === "warning";
      }
      return false;
    });
  }, [telemetryEvents, telemetryFilter]);

  useTelemetryStream(runId ?? null, handleTelemetryEvent);

  useEffect(() => {
    return () => {
      if (liveStreamRef.current) {
        liveStreamRef.current.close();
        liveStreamRef.current = null;
      }
      if (livePollRef.current !== null) {
        window.clearInterval(livePollRef.current);
      }
      if (livePollStopRef.current !== null) {
        window.clearTimeout(livePollStopRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!runId || !livePreviewEnabled) {
      if (liveStreamRef.current) {
        liveStreamRef.current.close();
        liveStreamRef.current = null;
      }
      return;
    }

    const es = new EventSource(apiUrl(`/test-runs/${runId}/live`), {
      withCredentials: true,
    } as any);
    liveStreamRef.current = es;

    es.addEventListener("artifact", (evt: MessageEvent) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload?.path) {
          setLiveFrameUrl(apiUrl(payload.path));
        }
      } catch {
        // ignore malformed events
      }
    });

    return () => {
      es.close();
      liveStreamRef.current = null;
    };
  }, [runId, livePreviewEnabled]);

  useEffect(() => {
    if (livePreviewTouchedRef.current) return;
    if (run?.paramsJson && (run.paramsJson as any).livePreview) {
      setLivePreviewEnabled(true);
    }
  }, [run?.paramsJson]);








  const params = run?.paramsJson ?? null;

  const suiteIdFromRun = (params as any)?.suiteId as string | undefined;



  const artifacts = run?.artifactsJson ?? null;



  const summaryErrors: string[] = Array.isArray(parsedSummary?.errors) ? parsedSummary.errors : [];



  const buildStaticUrl = (rel?: string | null, opts: { index?: boolean } = {}) => {



    if (!rel) return null;



    const clean = rel.replace(/^[/\\]+/, "").replace(/\\/g, "/");



    const path = opts.index ? `${clean.replace(/\/$/, "")}/index.html` : clean;



    return apiUrl(`/_static/${path}`);



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



    if (healingInProgress) return "Tests failed. Self-heal is running…";



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

    return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;

  }, []);







  const locatorKey = useCallback(

    (item: MissingLocatorItem) => `${item.pagePath}|${item.bucket}|${item.name}`,

    []

  );



  

  const isGlobalNavItem = useCallback(

    (item: MissingLocatorItem) =>

      item.pagePath === "__global_nav__" &&

      typeof item.name === "string" &&

      item.name.startsWith("nav."),

    []

  );



const fetchMissingLocators = useCallback(

    async ({ projectId, runId }: { projectId: string; runId: string }) => {

      setMissingLoading(true);

      setMissingError(null);

      try {

        const { missingLocators } = await apiFetch<{

          missingLocators: MissingLocatorItem[];

        }>(`/projects/${projectId}/test-runs/${runId}/missing-locators`);

        const items = missingLocators ?? [];

        setMissingLocators(items.filter((item) => !isGlobalNavItem(item)));

        const navItems = items.filter((item) => isGlobalNavItem(item));

        setMissingNavMappings(navItems);

        setSelectorValues((prev) => {

          const next = { ...prev };

          items.forEach((item) => {

            const key = locatorKey(item);

            if (next[key] === undefined) {

              next[key] = item.suggestions[0] ?? "";

            }

          });

          return next;

        });

      } catch (e: any) {

        setMissingError(e?.message ?? "Failed to load missing locators");

      } finally {

        setMissingLoading(false);

      }

    },

    [apiFetch, locatorKey, isGlobalNavItem]

  );



  const lastFetchRef = useRef<{ id?: string; status?: string }>({});

  useEffect(() => {

    if (!run) {

      setMissingLocators([]);

      setMissingNavMappings([]);

      setSelectorValues({});

      setMissingError(null);

      lastFetchRef.current = {};

      return;

    }

    const { id, project } = run;

    if (

      lastFetchRef.current.id === id &&

      lastFetchRef.current.status === run.status

    ) {

      return;

    }

    lastFetchRef.current = { id, status: run.status };

    fetchMissingLocators({ projectId: project.id, runId: id });

  }, [run, fetchMissingLocators]);



  const handleLocatorSave = useCallback(

    async (item: MissingLocatorItem) => {

      if (!run) return;

      const key = locatorKey(item);

      const selector = (selectorValues[key] ?? "").trim();

      if (!selector) {

        setSaveStates((prev) => ({

          ...prev,

          [key]: { loading: false, error: "Selector is required" },

        }));

        return;

      }

      setSaveStates((prev) => ({

        ...prev,

        [key]: { loading: true },

      }));

      try {

        await apiFetch(`/projects/${run.project.id}/shared-locators`, {

          method: "POST",

          body: JSON.stringify({

            projectId: run.project.id,

            pagePath: item.pagePath,

            bucket: item.bucket,

            name: item.name,

            selector,

          }),

        });

        setSaveStates((prev) => ({

          ...prev,

          [key]: { loading: false, success: true },

        }));

        await fetchMissingLocators({ projectId: run.project.id, runId: run.id });

      } catch (e: any) {

        setSaveStates((prev) => ({

          ...prev,

          [key]: {

            loading: false,

            error: e?.message ?? "Failed to save locator",

          },

        }));

      }

    },

    [apiFetch, run, selectorValues, locatorKey, fetchMissingLocators]

  );







  // load + live updates via SSE (fallback to polling on error)

  useEffect(() => {

    if (!runId) return;



    let cancelled = false;

    let source: { close?: () => void } | null = null as { close?: () => void } | null;

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



    const startFallbackPolling = () => {

      if (interval) return;

      interval = window.setInterval(load, 2000) as unknown as number;

    };



    load();



    startFallbackPolling();

    return () => {

      cancelled = true;

      if (source && typeof source.close === "function") source.close();

      if (interval) window.clearInterval(interval);

    };

  }, [runId, apiFetch, friendlyError]);







  const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString() : "-");







  // Load AI analysis once the run finishes (best effort)



  useEffect(() => {



    if (!runId || !run || run.status === "queued" || run.status === "running") return;



    let cancelled = false;



    (async () => {



      try {



        const res = await apiFetch<{ analysis: Analysis }>(`/runner/test-runs/${runId}/analysis`);



        if (!cancelled) setAnalysis(res.analysis ?? null);



      } catch {



        if (!cancelled) setAnalysis(null);



      }



    })();



    return () => {



      cancelled = true;



    };





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

    const rerunTargetId = run.rerunOfId ?? run.id;



    try {



      setTriggeringRerun(true);



      const res = await apiFetch<{ runId: string }>(



        `/runner/test-runs/${rerunTargetId}/rerun`,



        {
          method: "POST",
          body: JSON.stringify({ livePreview: livePreviewEnabled, runAll: true }),
        }



      );



      navigate(`/test-runs/${res.runId}`);



    } catch (e: any) {



      alert(e?.message ?? "Failed to trigger rerun");



    } finally {



      setTriggeringRerun(false);



    }



  }







  async function handleStopRun() {

    if (!run || stopping) return;

    try {

      setStopping(true);

      await apiFetch(`/runner/test-runs/${run.id}/stop`, { method: "POST" });

    } catch (e: any) {

      alert(e?.message ?? "Failed to stop run");

    } finally {

      setStopping(false);

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



      {loading && !run && <div>Loading�</div>}







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



          

            {(run.status === "running" || run.status === "queued") && (

              <Button size="sm" variant="outline" onClick={handleStopRun} disabled={stopping}>

                {stopping ? "Stopping..." : "Stop run"}

              </Button>

            )}
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



                Options: reporter {params.reporter ?? "json"} � {params.headful ? "headed" : "headless"}



                {params.specFile ? ` � file ${params.specFile}` : ""}{params.grep ? ` � grep "${params.grep}"` : ""}



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

                            {child.finishedAt ? ` • Finished: ${fmt(child.finishedAt)}` : ""}

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



              <div className="mb-2 flex items-center justify-between gap-2">



                <div className="font-medium text-slate-800">Missing nav mappings</div>



                <div className="flex items-center gap-2">

                  {missingLoading && (

                    <span className="text-xs text-slate-500">Refreshing locators.</span>

                  )}

                  {run && (

                    <Button asChild size="sm" variant="outline">

                      <Link to={`/locators?projectId=${run.project.id}`}>

                        Open locator library

                      </Link>

                    </Button>

                  )}

                </div>



              </div>



              {missingNavMappings.length === 0 && !missingLoading ? (



                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">



                  No missing nav mappings were emitted for this run.



                </div>



              ) : (



                <ul className="space-y-3">



                  {missingNavMappings.map((item) => {



                    const key = locatorKey(item);



                    const inputValue = selectorValues[key] ?? "";



                    const state = saveStates[key];



                    return (



                      <li



                        key={key}



                        className="rounded-md border border-slate-200 bg-white/80 p-3"



                      >



                        <div className="flex flex-wrap items-center justify-between gap-2">



                          <div>



                            <div className="text-sm font-semibold text-slate-800">{item.stepText}</div>



                            <div className="text-xs text-slate-500">



                              Global nav ? {item.name}



                            </div>



                          </div>



                          <span className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600">



                            global nav



                          </span>



                        </div>



                        {item.suggestions.length > 0 && (



                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">



                            Suggestions:



                            {item.suggestions.map((suggestion) => (



                              <button



                                key={suggestion}



                                type="button"



                                className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-600 transition hover:bg-slate-100"



                                onClick={() =>



                                  setSelectorValues((prev) => ({



                                    ...prev,



                                    [key]: suggestion,



                                  }))



                                }



                              >



                                {suggestion}



                              </button>



                            ))}



                          </div>



                        )}



                        <div className="mt-3 flex flex-wrap items-center gap-2">



                          <input



                            className="flex-1 min-w-[220px] rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"



                            placeholder="CSS selector"



                            value={inputValue}



                            onChange={(event) =>



                              setSelectorValues((prev) => ({



                                ...prev,



                                [key]: event.target.value,



                              }))



                            }



                          />



                          <Button



                            size="sm"



                            variant="outline"



                            onClick={() => handleLocatorSave(item)}



                            disabled={state?.loading}



                          >



                            {state?.loading ? "Saving?" : state?.success ? "Saved" : "Add to Global nav"}



                          </Button>



                        </div>



                        {state?.error && (



                          <p className="mt-1 text-xs text-rose-600">{state.error}</p>



                        )}



                        {state?.success && (



                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-emerald-600">



                            <span>Global nav saved.</span>



                            <Button



                              size="sm"



                              variant="outline"



                              onClick={handleManualRerun}



                              disabled={



                                !run || healingInProgress || rerunsInProgress || triggeringRerun



                              }



                            >



                              Rerun suite



                            </Button>



                          </div>



                        )}



                      </li>



                    );



                  })}



                </ul>



              )}



            </section>



<section>



              <div className="mb-2 flex items-center justify-between gap-2">



                <div className="font-medium text-slate-800">Missing locators</div>



                <div className="flex items-center gap-2">

                  {missingLoading && (

                    <span className="text-xs text-slate-500">Refreshing locators.</span>

                  )}

                  {run && (

                    <Button asChild size="sm" variant="outline">

                      <Link to={`/locators?projectId=${run.project.id}`}>

                        Open locator library

                      </Link>

                    </Button>

                  )}

                </div>



              </div>



              {missingError && (



                <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">



                  {missingError}



                </div>



              )}



              {missingLocators.length === 0 && !missingLoading ? (



                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">



                  No missing locators were emitted for this run.



                </div>



              ) : (



                <ul className="space-y-3">



                  {missingLocators.map((item) => {



                    const key = locatorKey(item);



                    const inputValue = selectorValues[key] ?? "";



                    const state = saveStates[key];



                    return (



                      <li



                        key={key}



                        className="rounded-md border border-slate-200 bg-white/80 p-3"



                      >



                        <div className="flex flex-wrap items-center justify-between gap-2">



                          <div>



                            <div className="text-sm font-semibold text-slate-800">{item.stepText}</div>



                            <div className="text-xs text-slate-500">



                              {item.pagePath} � {item.name}



                            </div>



                          </div>



                          <span className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600">



                            {item.bucket}



                          </span>



                        </div>



                        {item.suggestions.length > 0 && (



                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">



                            Suggestions:



                            {item.suggestions.map((suggestion) => (



                              <button



                                key={suggestion}



                                type="button"



                                className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-600 transition hover:bg-slate-100"



                                onClick={() =>



                                  setSelectorValues((prev) => ({



                                    ...prev,



                                    [key]: suggestion,



                                  }))



                                }



                              >



                                {suggestion}



                              </button>



                            ))}



                          </div>



                        )}



                        <div className="mt-3 flex flex-wrap items-center gap-2">



                          <input



                            className="flex-1 min-w-[220px] rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"



                            placeholder="CSS selector"



                            value={inputValue}



                            onChange={(event) =>



                              setSelectorValues((prev) => ({



                                ...prev,



                                [key]: event.target.value,



                              }))



                            }



                          />



                          <Button



                            size="sm"



                            variant="outline"



                            onClick={() => handleLocatorSave(item)}



                            disabled={state?.loading}



                          >



                            {state?.loading ? "Saving�" : state?.success ? "Saved" : "Save locator"}



                          </Button>



                        </div>



                        {state?.error && (



                          <p className="mt-1 text-xs text-rose-600">{state.error}</p>



                        )}



                        {state?.success && (



                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-emerald-600">



                            <span>Locator saved.</span>



                            <Button



                              size="sm"



                              variant="outline"



                              onClick={handleManualRerun}



                              disabled={



                                !run || healingInProgress || rerunsInProgress || triggeringRerun



                              }



                            >



                              Rerun suite



                            </Button>



                          </div>



                        )}



                      </li>



                    );



                  })}



                </ul>



              )}



            </section>



                        <section>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium text-slate-800">Results</div>
                <div className="flex flex-wrap items-center gap-2">
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
                    {triggeringRerun ? "Starting rerun..." : "Rerun this suite"}
                  </Button>
                  <div className="flex items-center gap-2 text-xs text-slate-600">
                    <input
                      id="live-preview-toggle"
                      type="checkbox"
                      checked={livePreviewEnabled}
                      onChange={(e) => {
                        livePreviewTouchedRef.current = true;
                        setLivePreviewEnabled(e.target.checked);
                      }}
                    />
                    <label htmlFor="live-preview-toggle">Live preview</label>
                  </div>
                </div>
              </div>
              <RunResults runId={run.id} active={!done} projectId={run.project.id} suiteId={suiteIdFromRun} />
            </section>

            <section>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium text-slate-800">Live telemetry</div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={`rounded-full px-3 py-1 text-xs ${
                      telemetryFilter === "errors"
                        ? "bg-slate-200 text-slate-900"
                        : "bg-slate-100 text-slate-600"
                    }`}
                    onClick={() => setTelemetryFilter("errors")}
                  >
                    Errors
                  </button>
                  <button
                    type="button"
                    className={`rounded-full px-3 py-1 text-xs ${
                      telemetryFilter === "all"
                        ? "bg-slate-200 text-slate-900"
                        : "bg-slate-100 text-slate-600"
                    }`}
                    onClick={() => setTelemetryFilter("all")}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600"
                    onClick={() => setTelemetryEvents([])}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="mb-3 text-xs text-slate-500">
                Live preview opens in a floating window during AI runs.
              </div>
              <div className="max-h-[360px] overflow-auto rounded-md border border-slate-200 bg-white p-3">
                {visibleTelemetry.length === 0 ? (
                  <div className="text-xs text-slate-500">Waiting for telemetry...</div>
                ) : (
                  <div className="space-y-2">
                    {visibleTelemetry.map((event, i) => (
                      <div key={`${event.ts ?? "na"}-${i}`} className="text-xs font-mono text-slate-800">
                        <span className="mr-2 text-slate-400">
                          {event.ts ? new Date(event.ts).toLocaleTimeString() : ""}
                        </span>
                        <span className="mr-2 text-slate-500">{event.type}</span>
                        {event.type === "console" && (
                          <span
                            className={
                              event.level === "error"
                                ? "text-rose-600"
                                : event.level === "warning"
                                ? "text-amber-600"
                                : ""
                            }
                          >
                            [{event.level}] {event.text}
                          </span>
                        )}
                        {event.type === "pageerror" && (
                          <span className="text-rose-600">{event.message}</span>
                        )}
                        {event.type === "requestfailed" && (
                          <span className="text-rose-600">
                            {event.method} {event.url} ({event.failure || "failed"})
                          </span>
                        )}
                        {event.type === "runner_start" && (
                          <span className="text-emerald-600">runner start</span>
                        )}
                        {event.type === "runner_end" && (
                          <span className="text-emerald-600">runner end</span>
                        )}
                        {event.type === "telemetry_hooked" && (
                          <span className="text-emerald-600">telemetry hooked</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {livePreviewEnabled && (run?.paramsJson as any)?.livePreview && (
              <div className="fixed bottom-6 right-6 z-50 w-[520px] max-w-[90vw]">
                <div className="flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
                  <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                    <div className="text-sm font-semibold text-slate-800">Live preview</div>
                    <button
                      type="button"
                      className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                      onClick={() => setLivePreviewEnabled(false)}
                    >
                      Close
                    </button>
                  </div>
                  <div className="aspect-square bg-slate-50">
                    {liveFrameUrl ? (
                      <img
                        src={liveFrameUrl}
                        alt="Live preview"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-slate-500">
                        Waiting for live preview...
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <section>



              <div className="mb-2 font-medium text-slate-800">Logs</div>



              <RunLogs runId={run.id} refreshKey={run.status ?? "unknown"} />



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













