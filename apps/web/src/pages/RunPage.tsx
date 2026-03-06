// apps/web/src/pages/RunPage.tsx



import { useCallback, useEffect, useMemo, useRef, useState } from "react";



import { useParams, Link, useNavigate } from "react-router-dom";



import { apiUrl, useApi } from "../lib/api";



import StatusBadge from "../components/StatusBadge";



import { Button } from "../components/ui/button";



import { ExternalLink } from "lucide-react";



import RunResults from "../components/RunResults";



import RunLogs from "../components/RunLogs";
import { LoadingOverlay } from "../components/ui/LoadingOverlay";
import { useTelemetryStream, type TelemetryEvent } from "../hooks/useTelemetryStream";
import { toast } from "sonner";







type TestRunStatus = "queued" | "running" | "succeeded" | "failed";



type Run = {



  id: string;



  status: TestRunStatus;
  lifecycleStatus?: "queued" | "running" | "completed" | "failed";
  artifactsState?: "none" | "partial" | "complete";



  summary?: string | null;



  error?: string | null;
  errors?: Array<{ code: string; message: string; source: "runner" | "summary" }>;



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



  healingAttempts: {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed" | "skipped";
    attempt?: number;
    summary?: string | null;
    error?: string | null;
    createdAt?: string;
    updatedAt?: string;
    mode?: "structured" | "full-rewrite" | null;
    structuredFallbackReason?: string | null;
    operationCount?: number | null;
    operationTypes?: string[];
  }[];



  paramsJson?: {



    headful?: boolean;



    reporter?: string;



    specFile?: string | null;



    grep?: string | null;

    suiteId?: string | null;
    livePreview?: boolean;



  } | null;



  artifactsJson?: Record<string, string> | null;
  publicArtifacts?: {
    reportJsonUrl: string;
    allureReportUrl?: string | null;
    allureResultsUrl?: string | null;
    analysisUrl: string;
    stdoutUrl: string;
    stderrUrl: string;
    liveEventsUrl: string;
    runViewUrl: string;
  } | null;



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



  const { runId: routeRunId } = useParams<{ runId: string }>();



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
  const [promotingHighConfidenceLocators, setPromotingHighConfidenceLocators] = useState(false);
  const [promotingHighConfidenceNav, setPromotingHighConfidenceNav] = useState(false);

  const [stopping, setStopping] = useState(false);
  const [telemetryEvents, setTelemetryEvents] = useState<TelemetryEvent[]>([]);
  const [telemetryFilter, setTelemetryFilter] = useState<"all" | "errors">("errors");
  const [livePreviewEnabled, setLivePreviewEnabled] = useState(false);
  const livePreviewTouchedRef = useRef(false);
  const [liveFrameUrl, setLiveFrameUrl] = useState<string | null>(null);
  const [liveFrames, setLiveFrames] = useState<Array<{ url: string; path: string; mtimeMs?: number }>>([]);
  const [livePreviewPreferStatic, setLivePreviewPreferStatic] = useState(false);
  const livePollRef = useRef<number | null>(null);
  const livePollStopRef = useRef<number | null>(null);
  const liveStreamRef = useRef<EventSource | null>(null);
  const livePreviewEnabledRef = useRef(false);
  const liveAiModeRef = useRef(false);
  const lastTelemetryRunRef = useRef<string | null>(null);
const parsedSummary = useMemo(() => {



    if (!run?.summary) return null;



    try {



      return JSON.parse(run.summary);



    } catch {



      return null;



    }



  }, [run?.summary]);

  const normalizeLiveUrl = useCallback(
    (rawPath: string) => {
      const origin = new URL(apiUrl("/")).origin;
      const normalized = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
      const resolvedPath = livePreviewPreferStatic
        ? normalized.replace("/runner-logs/", "/_static/runner-logs/")
        : normalized;
      return `${origin}${resolvedPath}`;
    },
    [livePreviewPreferStatic]
  );

  const resolvedRunId = routeRunId;

  const attemptLiveFrame = useCallback((url: string) => {
    const img = new Image();
    img.onload = () => setLiveFrameUrl(url);
    img.onerror = () => {
      if (!livePreviewPreferStatic && url.includes("/runner-logs/")) {
        setLivePreviewPreferStatic(true);
      }
    };
    img.src = url;
  }, [livePreviewPreferStatic]);

  const startLivePolling = useCallback(
    (durationMs = 10000, intervalMs = 1000) => {
      if (!resolvedRunId) return;
      const base = normalizeLiveUrl(`/runner-logs/${resolvedRunId}/live/latest.png`);
      const tick = () => {
        if (!livePreviewEnabledRef.current) return;
        attemptLiveFrame(`${base}?t=${Date.now()}`);
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
    [resolvedRunId, normalizeLiveUrl, attemptLiveFrame]
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
        if (!livePreviewEnabledRef.current || !liveAiModeRef.current) return;
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

  useTelemetryStream(resolvedRunId ?? null, handleTelemetryEvent);

  useEffect(() => {
    livePreviewEnabledRef.current = livePreviewEnabled;
  }, [livePreviewEnabled]);

  const params = run?.paramsJson ?? null;
  const isAiAnalyzeRun = (params as any)?.mode === "ai";

  useEffect(() => {
    liveAiModeRef.current = isAiAnalyzeRun;
  }, [isAiAnalyzeRun]);

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
    if (!resolvedRunId || !livePreviewEnabled || !isAiAnalyzeRun) {
      if (liveStreamRef.current) {
        liveStreamRef.current.close();
        liveStreamRef.current = null;
      }
      if (livePollRef.current !== null) {
        window.clearInterval(livePollRef.current);
        livePollRef.current = null;
      }
      if (livePollStopRef.current !== null) {
        window.clearTimeout(livePollStopRef.current);
        livePollStopRef.current = null;
      }
      return;
    }

    const es = new EventSource(apiUrl(`/test-runs/${resolvedRunId}/live`), {
      withCredentials: true,
    } as any);
    liveStreamRef.current = es;

    es.addEventListener("artifact", (evt: MessageEvent) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload?.path) {
          const rawPath = String(payload.path);
          const baseUrl = normalizeLiveUrl(rawPath);
          const withBust = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
          attemptLiveFrame(withBust);
          setLiveFrames((prev) => {
            const key = `${rawPath}|${payload?.mtimeMs ?? "na"}`;
            if (prev.some((item) => `${item.path}|${item.mtimeMs ?? "na"}` === key)) return prev;
            const next = [...prev, { url: withBust, path: rawPath, mtimeMs: payload?.mtimeMs }];
            return next.length > 50 ? next.slice(-50) : next;
          });
        }
      } catch {
        // ignore malformed events
      }
    });

    return () => {
      es.close();
      liveStreamRef.current = null;
    };
  }, [resolvedRunId, livePreviewEnabled, isAiAnalyzeRun, normalizeLiveUrl]);

  useEffect(() => {
    if (!resolvedRunId || !livePreviewEnabled || !isAiAnalyzeRun) return;
    startLivePolling(30000, 1000);
  }, [resolvedRunId, livePreviewEnabled, isAiAnalyzeRun, startLivePolling]);

  useEffect(() => {
    if (livePreviewTouchedRef.current) return;
    if (isAiAnalyzeRun && run?.paramsJson && (run.paramsJson as any).livePreview) {
      setLivePreviewEnabled(true);
    }
  }, [run?.paramsJson, isAiAnalyzeRun]);

  useEffect(() => {
    if (!livePreviewEnabled || !isAiAnalyzeRun) return;
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key !== "Escape") return;
      livePreviewTouchedRef.current = true;
      setLivePreviewEnabled(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [livePreviewEnabled, isAiAnalyzeRun]);

  useEffect(() => {
    if (!routeRunId) return;
    setRun(null);
    setErr(null);
    setLoading(true);
    setLiveFrameUrl(null);
    setLiveFrames([]);
    setLivePreviewPreferStatic(false);
  }, [routeRunId]);

  useEffect(() => {
    if (!run?.id) return;
    if (lastTelemetryRunRef.current === run.id) return;
    lastTelemetryRunRef.current = run.id;
    apiFetch("/telemetry/events", {
      method: "POST",
      body: JSON.stringify({
        event: "page_view_run_detail",
        properties: { runId: run.id, projectId: run.project.id },
      }),
    }).catch(() => {});
  }, [apiFetch, run?.id, run?.project?.id]);


  const suiteIdFromRun = (params as any)?.suiteId as string | undefined;



  const artifacts = run?.artifactsJson ?? null;
  const publicArtifacts = run?.publicArtifacts ?? null;



  const summaryErrors: string[] = Array.isArray(parsedSummary?.errors) ? parsedSummary.errors : [];



  const buildStaticUrl = (rel?: string | null, opts: { index?: boolean } = {}) => {



    if (!rel) return null;



    const clean = rel.replace(/^[/\\]+/, "").replace(/\\/g, "/");



    const path = opts.index ? `${clean.replace(/\/$/, "")}/index.html` : clean;



    return apiUrl(`/_static/${path}`);



  };

  const allureReportHref =
    publicArtifacts?.allureReportUrl ??
    buildStaticUrl(artifacts?.["allure-report"], { index: true }) ??
    null;
  const reportJsonHref =
    publicArtifacts?.reportJsonUrl ??
    buildStaticUrl(artifacts?.reportJson) ??
    null;







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

    async (item: MissingLocatorItem, selectorOverride?: string) => {

      if (!run) return false;

      const key = locatorKey(item);

      const selector = (selectorOverride ?? selectorValues[key] ?? "").trim();

      if (!selector) {

        setSaveStates((prev) => ({

          ...prev,

          [key]: { loading: false, error: "Selector is required" },

        }));

        return false;

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

        apiFetch("/telemetry/events", {
          method: "POST",
          body: JSON.stringify({
            event: "locator_promoted",
            properties: {
              runId: run.id,
              projectId: run.project.id,
              pagePath: item.pagePath,
              bucket: item.bucket,
              name: item.name,
              source: "run_detail",
            },
          }),
        }).catch(() => {});

        await fetchMissingLocators({ projectId: run.project.id, runId: run.id });
        return true;

      } catch (e: any) {

        setSaveStates((prev) => ({

          ...prev,

          [key]: {

            loading: false,

            error: e?.message ?? "Failed to save locator",

          },

        }));

      }
      return false;

    },

    [apiFetch, run, selectorValues, locatorKey, fetchMissingLocators]

  );

  const getSuggestedSelector = useCallback(
    (item: MissingLocatorItem) => item.suggestions.find((s) => typeof s === "string" && s.trim().length > 0)?.trim() ?? "",
    []
  );

  const handleQuickPromote = useCallback(
    async (item: MissingLocatorItem) => {
      const key = locatorKey(item);
      const suggested = getSuggestedSelector(item);
      const current = (selectorValues[key] ?? "").trim();
      const selector = current || suggested;
      if (!selector) {
        setSaveStates((prev) => ({
          ...prev,
          [key]: { loading: false, error: "No suggested selector available" },
        }));
        return false;
      }
      if (!current) {
        setSelectorValues((prev) => ({
          ...prev,
          [key]: selector,
        }));
      }
      return handleLocatorSave(item, selector);
    },
    [getSuggestedSelector, handleLocatorSave, locatorKey, selectorValues]
  );

  const hasSavingLocator = useMemo(
    () => Object.values(saveStates).some((state) => state.loading),
    [saveStates]
  );

  const handlePromoteAll = useCallback(
    async (items: MissingLocatorItem[]) => {
      if (!run) return;
      let attempted = 0;
      let saved = 0;
      for (const item of items) {
        const key = locatorKey(item);
        if (saveStates[key]?.success) continue;
        attempted += 1;
        const ok = await handleQuickPromote(item);
        if (ok) saved += 1;
      }
      apiFetch("/telemetry/events", {
        method: "POST",
        body: JSON.stringify({
          event: "locator_promote_all",
          properties: {
            runId: run.id,
            projectId: run.project.id,
            attempted,
            saved,
            failed: attempted - saved,
            source: "run_detail",
          },
        }),
      }).catch(() => {});
      if (attempted === 0) {
        toast.message("All missing locators are already promoted.");
      } else if (saved === attempted) {
        toast.success(`Promoted ${saved} locator${saved === 1 ? "" : "s"}.`);
      } else {
        toast.error(`Promoted ${saved}/${attempted} locators. ${attempted - saved} failed.`);
      }
    },
    [apiFetch, handleQuickPromote, locatorKey, run, saveStates]
  );







  const handlePromoteHighConfidenceLocators = useCallback(async () => {
    if (!run || promotingHighConfidenceLocators) return;
    setPromotingHighConfidenceLocators(true);
    try {
      const res = await apiFetch<{ promotedCount?: number }>(
        `/projects/${run.project.id}/locators/promote-high-confidence`,
        {
          method: "POST",
          body: JSON.stringify({
            minConfidence: 75,
            limit: 300,
            overwriteExisting: false,
          }),
        }
      );
      const promotedCount = typeof res?.promotedCount === "number" ? res.promotedCount : 0;
      if (promotedCount > 0) {
        toast.success(`Promoted ${promotedCount} high-confidence locator${promotedCount === 1 ? "" : "s"}.`);
      } else {
        toast.message("No high-confidence locators were eligible for promotion.");
      }
      await fetchMissingLocators({ projectId: run.project.id, runId: run.id });
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to promote high-confidence locators.");
    } finally {
      setPromotingHighConfidenceLocators(false);
    }
  }, [apiFetch, fetchMissingLocators, promotingHighConfidenceLocators, run]);

  const handlePromoteHighConfidenceNav = useCallback(async () => {
    if (!run || promotingHighConfidenceNav) return;
    setPromotingHighConfidenceNav(true);
    try {
      const res = await apiFetch<{ promotedCount?: number }>(
        `/projects/${run.project.id}/nav-suggestions/promote-high-confidence`,
        {
          method: "POST",
          body: JSON.stringify({
            minConfidence: 75,
            removeAfterPromote: true,
            limit: 100,
          }),
        }
      );
      const promotedCount = typeof res?.promotedCount === "number" ? res.promotedCount : 0;
      if (promotedCount > 0) {
        toast.success(`Promoted ${promotedCount} high-confidence nav mapping${promotedCount === 1 ? "" : "s"}.`);
      } else {
        toast.message("No high-confidence nav suggestions were eligible for promotion.");
      }
      await fetchMissingLocators({ projectId: run.project.id, runId: run.id });
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to promote high-confidence nav suggestions.");
    } finally {
      setPromotingHighConfidenceNav(false);
    }
  }, [apiFetch, fetchMissingLocators, promotingHighConfidenceNav, run]);

  // load + live updates via SSE (fallback to polling on error)

  useEffect(() => {

    if (!routeRunId) return;



    let cancelled = false;

    let source: { close?: () => void } | null = null as { close?: () => void } | null;

    let interval: number | undefined;



    const load = async () => {

      try {

        const { run: r } = await apiFetch<{ run: Run }>(`/runner/test-runs/${routeRunId}`);

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

  }, [routeRunId, apiFetch, friendlyError]);







  const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString() : "-");







  // Load AI analysis once the run finishes (best effort)



  useEffect(() => {



    if (!routeRunId || !run || run.status === "queued" || run.status === "running") return;



    let cancelled = false;



    (async () => {



      try {



        const res = await apiFetch<{ analysis: Analysis }>(`/runner/test-runs/${routeRunId}/analysis`);



        if (!cancelled) setAnalysis(res.analysis ?? null);



      } catch {



        if (!cancelled) setAnalysis(null);



      }



    })();



    return () => {



      cancelled = true;



    };





  }, [routeRunId, run?.status]);







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
      <LoadingOverlay open={loading} subtitle="Loading test run..." showTimer />



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

          <div className="text-xs text-slate-500">
            Lifecycle: {run.lifecycleStatus ?? "unknown"} • Artifacts: {run.artifactsState ?? "unknown"}
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



                
                <div className="mb-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Self-heal attempts
                  </div>
                  {healingAttempts.length > 0 ? (
                    <ul className="space-y-2">
                      {healingAttempts.map((attempt) => (
                        <li
                          key={attempt.id}
                          className="rounded-md border border-slate-200 bg-white p-3 text-sm"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">Attempt {attempt.attempt ?? "?"}</span>
                              {attempt.mode && (
                                <span className="rounded-full border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600">
                                  {attempt.mode === "structured" ? "Structured patch" : "Full rewrite"}
                                </span>
                              )}
                            </div>
                            <StatusBadge status={attempt.status as any} />
                          </div>
                          {attempt.summary && (
                            <div className="mt-1 text-xs text-slate-600">{attempt.summary}</div>
                          )}
                          {attempt.structuredFallbackReason && (
                            <div className="mt-1 text-xs text-amber-700">
                              Structured fallback: {attempt.structuredFallbackReason}
                            </div>
                          )}
                          {attempt.mode === "structured" && (
                            <div className="mt-1 text-xs text-slate-500">
                              Operations: {attempt.operationCount ?? 0}
                              {attempt.operationTypes && attempt.operationTypes.length > 0
                                ? ` (${attempt.operationTypes.join(", ")})`
                                : ""}
                            </div>
                          )}
                          {attempt.error && (
                            <div className="mt-1 text-xs text-rose-700">{attempt.error}</div>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                      No self-heal attempts recorded yet.
                    </div>
                  )}
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



                {allureReportHref && (



                  <Button asChild size="sm" variant="outline">



                    <a href={allureReportHref} target="_blank" rel="noreferrer">



                      View Allure report



                    </a>



                  </Button>



                )}



                {reportJsonHref && (



                  <Button asChild size="sm" variant="outline">



                    <a href={reportJsonHref} target="_blank" rel="noreferrer">



                      Download raw JSON



                    </a>



                  </Button>



                )}



              </div>



              {!artifacts && (



                <div className="mt-1 text-sm text-slate-500">No artifacts were produced for this run.</div>



              )}



              {artifacts && !allureReportHref && (



                <div className="mt-1 text-xs text-slate-500">



                  Allure report not available for this run (no allure-results folder was generated).



                </div>



              )}



              {artifacts && !reportJsonHref && (



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
                  {missingNavMappings.length > 0 && (

                    <Button

                      size="sm"

                      variant="outline"

                      onClick={() => handlePromoteAll(missingNavMappings)}

                      disabled={missingLoading || hasSavingLocator}

                    >

                      {hasSavingLocator ? "Promoting..." : "Promote all suggestions"}

                    </Button>

                  )}
                  {run && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handlePromoteHighConfidenceNav}
                      disabled={promotingHighConfidenceNav || missingLoading || hasSavingLocator}
                    >
                      {promotingHighConfidenceNav ? "Promoting..." : "Promote high-confidence"}
                    </Button>
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

                          <Button

                            size="sm"

                            variant="outline"

                            onClick={() => handleQuickPromote(item)}

                            disabled={state?.loading || state?.success}

                          >

                            {state?.success ? "Promoted" : "Promote suggestion"}

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
                  {missingLocators.length > 0 && (

                    <Button

                      size="sm"

                      variant="outline"

                      onClick={() => handlePromoteAll(missingLocators)}

                      disabled={missingLoading || hasSavingLocator}

                    >

                      {hasSavingLocator ? "Promoting..." : "Promote all suggestions"}

                    </Button>

                  )}
                  {run && (

                    <Button

                      size="sm"

                      variant="outline"

                      onClick={handlePromoteHighConfidenceLocators}

                      disabled={promotingHighConfidenceLocators || missingLoading || hasSavingLocator}

                    >

                      {promotingHighConfidenceLocators ? "Promoting..." : "Promote high-confidence"}

                    </Button>

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



                            {state?.loading ? "Saving..." : state?.success ? "Saved" : "Save locator"}

                          </Button>

                          <Button

                            size="sm"

                            variant="outline"

                            onClick={() => handleQuickPromote(item)}

                            disabled={state?.loading || state?.success}

                          >

                            {state?.success ? "Promoted" : "Promote suggestion"}

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

            {livePreviewEnabled && isAiAnalyzeRun && (
              <div className="fixed inset-x-2 bottom-4 top-20 z-50 sm:inset-x-auto sm:right-4 sm:w-[520px] sm:max-w-[90vw]">
                <div className="flex h-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
                  <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                    <div className="text-sm font-semibold text-slate-800">Live preview</div>
                    <button
                      type="button"
                      className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                      onClick={() => {
                        livePreviewTouchedRef.current = true;
                        setLivePreviewEnabled(false);
                      }}
                    >
                      Close
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 bg-slate-50">
                    {liveFrameUrl ? (
                      <img
                        src={liveFrameUrl}
                        alt="Live preview"
                        className="h-full w-full object-contain"
                        onError={() => {
                          if (!livePreviewPreferStatic) {
                            setLivePreviewPreferStatic(true);
                          }
                        }}
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-slate-500">
                        Waiting for live preview...
                      </div>
                    )}
                  </div>
                  {liveFrames.length > 0 && (
                    <div className="max-h-28 overflow-x-auto border-t border-slate-200 bg-white p-2">
                      <div className="flex gap-2">
                        {liveFrames.map((frame, idx) => (
                          <button
                            key={`${frame.path}-${frame.mtimeMs ?? idx}`}
                            type="button"
                            className="h-20 w-20 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-50"
                            onClick={() => setLiveFrameUrl(frame.url)}
                            title={frame.path}
                          >
                            <img src={frame.url} alt={`Live frame ${idx + 1}`} className="h-full w-full object-cover" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {run.errors && run.errors.length > 0 && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                <div className="font-medium text-slate-800">Structured errors</div>
                <ul className="mt-1 list-disc pl-5">
                  {run.errors.map((entry, idx) => (
                    <li key={`${entry.source}:${entry.code}:${idx}`}>
                      [{entry.source}] {entry.message}
                    </li>
                  ))}
                </ul>
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

















