import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, Copy, ExternalLink, KeyRound, Loader2, ScanSearch, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { useApi } from "../lib/api";
import { configureSpecEditor } from "../lib/monaco-spec-config";

// ── Types ─────────────────────────────────────────────────────────────────────

type ScanWarning = { code: string; message: string; severity: "info" | "warning" | "error" };
type ScanForm = {
  selector: string;
  action?: string;
  fields: Array<{ name?: string; type: string; label?: string; selector: string }>;
  submit?: { label?: string; selector: string };
};
type ScanPage = {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  pathname: string;
  forms: ScanForm[];
  buttons: Array<{ label: string; selector: string }>;
  fields: Array<{ name?: string; type: string; label?: string; selector: string }>;
  links: Array<{ text: string; href: string }>;
  headings?: string[];
};
type SpecFile = {
  page: string;
  path: string;
  content: string;
  testCount: number;
};
type ScanResult = {
  phase?: "auth_required" | "auth_failed" | "partial" | "ready";
  page: ScanPage;
  pages?: ScanPage[];
  generation: {
    testCases: Array<{ id: string; name: string; group?: { page?: string; url?: string }; steps: unknown[]; coverageType?: string }>;
    specContent: string;
    specFiles?: SpecFile[];
    warnings: ScanWarning[];
  };
  summary: {
    interactiveElements: number;
    forms: number;
    buttons: number;
    links: number;
    routes?: number;
    testCases: number;
    unresolvedLocators: number;
  };
  coverage?: {
    capabilities: string[];
    matrix: Record<string, "not_applicable" | "covered" | "partial" | "runtime_required">;
    gaps: string[];
    observedCount: number;
    inferredCount: number;
    runtimeRequiredCount: number;
    familyCounts?: Record<string, number>;
  };
  routes?: Array<{
    route: string;
    status: "covered" | "partial" | "generation_failed";
    testCaseCount: number;
    runtimeCaseCount: number;
    coverageMatrix?: Record<string, string>;
  }>;
  duplicatesRemoved?: number;
  auth?: {
    loginOutcome: "success" | "failed" | "not_needed";
    authFailureReason?: "AUTH_ENTRY_NOT_FOUND" | "LOGIN_FORM_NOT_FOUND" | "CREDENTIALS_REJECTED" | "MFA_REQUIRED" | "AUTH_TIMEOUT";
    authEntryUsed?: string;
    authTransitions?: number;
    loginRouteDiscovered?: string | null;
  };
};

type Project = { id: string; name: string };

// Technical scan-failure messages (stack traces, engine internals) aren't
// actionable for a user pasting a URL — show a plain-language summary and
// keep the raw message behind a "technical details" toggle instead.
function toFriendlyScanError(raw: string): string {
  if (/ReferenceError|TypeError|page\.evaluate|UtilityScript|at eval/i.test(raw)) {
    return "TestMind couldn't inspect this page — the browser scanner hit an internal error.";
  }
  if (/timeout/i.test(raw)) {
    return "TestMind couldn't inspect this page in time. The site may be slow to load, or unreachable.";
  }
  if (/private network|Invalid URL|Could not resolve hostname/i.test(raw)) {
    return raw; // already a clear, user-facing message from the SSRF guard
  }
  return raw;
}

// ── Progress steps ────────────────────────────────────────────────────────────

const PROGRESS_STEPS = [
  "Opening application",
  "Reading DOM & mapping selectors",
  "Analyzing page capabilities",
  "Generating coverage plan",
  "Critiquing coverage gaps",
  "Building Playwright spec",
];

const STEP_DELAYS_MS = [800, 2500, 6000, 12000, 18000, 22000];

type ProgressState = {
  active: number; // index of current step (spinning)
  done: number[];
  failed: number | null; // index of step that failed
  errorMessage: string;
};

// ── Component ─────────────────────────────────────────────────────────────────

type PageState = "idle" | "scanning" | "results" | "error";
type ResultTab = "tests" | "coverage" | "spec";

const COVERAGE_LABELS: Record<string, string> = {
  happyPath: "Happy path",
  negative: "Negative",
  boundary: "Boundary",
  validation: "Validation",
  state: "State",
  navigation: "Navigation",
  errorRecovery: "Error recovery",
  accessibility: "Accessibility",
};

export default function UrlBuilderPage() {
  const { apiFetch } = useApi();

  const [url, setUrl] = useState("");
  const [instructions, setInstructions] = useState("");
  const [pageState, setPageState] = useState<PageState>("idle");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [progress, setProgress] = useState<ProgressState>({
    active: 0,
    done: [],
    failed: null,
    errorMessage: "",
  });
  const [activeTab, setActiveTab] = useState<ResultTab>("tests");
  const [activeSpecPath, setActiveSpecPath] = useState("");
  const isScanning = pageState === "scanning";
  const [rawErrorMessage, setRawErrorMessage] = useState("");
  const [showErrorDetails, setShowErrorDetails] = useState(false);

  // Auth credentials (optional)
  const [showAuth, setShowAuth] = useState(false);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authOtp, setAuthOtp] = useState("");
  const [showOtp, setShowOtp] = useState(false);
  // Non-blocking "we found a login page while crawling" suggestion — dismissible,
  // separate from showAuth so dismissing it doesn't also collapse the auth_required panel.
  const [dismissedLoginSuggestion, setDismissedLoginSuggestion] = useState(false);

  // Live auth log shown during scanning
  const [authLog, setAuthLog] = useState<string[]>([]);
  const authLogTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Pre-scan result preserved during authenticated re-scan
  const [preScanResult, setPreScanResult] = useState<ScanResult | null>(null);

  // Save flow
  const [projects, setProjects] = useState<Project[]>([]);
  const [saveProjectId, setSaveProjectId] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dismissedSave, setDismissedSave] = useState(false);

  const progressTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Load projects for the save dropdown; auto-select the first one so the
  // "Add to project" button is immediately usable after a scan.
  useEffect(() => {
    apiFetch<{ projects: Project[] }>("/projects")
      .then((d) => {
        const list = d.projects ?? [];
        setProjects(list);
        setSaveProjectId((curr) => curr || list[0]?.id || "");
      })
      .catch(() => {});
  }, [apiFetch]);

  function clearProgressTimers() {
    progressTimers.current.forEach(clearTimeout);
    progressTimers.current = [];
  }

  function clearAuthLogTimers() {
    authLogTimers.current.forEach(clearTimeout);
    authLogTimers.current = [];
  }

  function startAuthAnimation(targetUrl: string, username: string) {
    clearAuthLogTimers();
    setAuthLog([]);
    const entries: [number, string][] = [
      [0,     `Navigating to ${targetUrl}`],
      [1000,  `Looking for Sign In entry point`],
      [2200,  `Login button found — clicking`],
      [3500,  `Credential form appeared`],
      [4400,  `Typing username: ${username}`],
      [5200,  `Typing password`],
      [6000,  `Submitting login form`],
      [7500,  `Waiting for session to establish...`],
      [10000, `Re-scanning the authenticated page`],
    ];
    entries.forEach(([delay, text]) => {
      const t = setTimeout(() => setAuthLog((prev) => [...prev, text]), delay);
      authLogTimers.current.push(t);
    });
  }

  function startProgressAnimation() {
    clearProgressTimers();
    setProgress({ active: 0, done: [], failed: null, errorMessage: "" });

    STEP_DELAYS_MS.forEach((delay, idx) => {
      const t = setTimeout(() => {
        setProgress((prev) => {
          if (prev.failed !== null) return prev; // stop on failure
          return {
            ...prev,
            active: Math.min(idx + 1, PROGRESS_STEPS.length - 1),
            done: [...prev.done, idx],
          };
        });
      }, delay);
      progressTimers.current.push(t);
    });
  }

  function failProgressAt(stepIndex: number, message: string) {
    clearProgressTimers();
    setProgress((prev) => ({
      ...prev,
      active: stepIndex,
      failed: stepIndex,
      errorMessage: message,
    }));
  }

  async function handleScan() {
    const trimmed = url.trim();
    if (!trimmed) return;

    setPageState("scanning");
    startProgressAnimation();
    setDismissedLoginSuggestion(false);
    if (authUsername.trim() && authPassword) {
      startAuthAnimation(trimmed, authUsername.trim());
    }

    try {
      const credentials = authUsername.trim() && authPassword
        ? { username: authUsername.trim(), password: authPassword, otp: authOtp.trim() || undefined }
        : undefined;
      const data = await apiFetch<ScanResult>("/url-inspector/scan", {
        method: "POST",
        body: JSON.stringify({ url: trimmed, instructions: instructions.trim() || undefined, credentials }),
      });
      clearProgressTimers();
      clearAuthLogTimers();
      setProgress({ active: PROGRESS_STEPS.length - 1, done: PROGRESS_STEPS.map((_, i) => i), failed: null, errorMessage: "" });
      setResult(data);
      setActiveSpecPath(data.generation.specFiles?.[0]?.path ?? (data.generation.specContent ? "combined.spec.ts" : ""));
      setPageState("results");
      // Auto-expand auth section when the scan cannot reach the authenticated app.
      const noElements = data.generation.warnings.some((w: any) => w.code === "NO_INTERACTIVE_ELEMENTS")
        || data.summary.interactiveElements === 0;
      const needsAuth = data.generation.warnings.some((w: any) =>
        w.code === "AUTH_REDIRECT" || w.code === "AUTH_PAGE_WITHOUT_CREDENTIALS"
      );
      if ((noElements || needsAuth) && !authUsername) {
        setShowAuth(true);
      }
    } catch (err: any) {
      const msg = err?.message ?? "Scan failed";
      console.error("[url-inspector] scan failed:", msg);
      clearAuthLogTimers();
      setRawErrorMessage(msg);
      setShowErrorDetails(false);
      failProgressAt(progress.active, toFriendlyScanError(msg));
      setPageState("error");
    }
  }

  // Re-scan with credentials after an initial unauthenticated scan.
  // Sends prior test cases so the backend can merge + dedupe into one final result.
  async function handleAuthScan() {
    if (!result) return;
    const priorCases = result.generation.testCases;
    setPreScanResult(result);
    setPageState("scanning");
    startProgressAnimation();
    if (authUsername.trim() && authPassword) {
      startAuthAnimation(url.trim(), authUsername.trim());
    }
    try {
      const data = await apiFetch<ScanResult>("/url-inspector/scan", {
        method: "POST",
        body: JSON.stringify({
          url: url.trim(),
          instructions: instructions.trim() || undefined,
          credentials: { username: authUsername.trim(), password: authPassword, otp: authOtp.trim() || undefined },
          priorCases,
        }),
      });
      clearProgressTimers();
      clearAuthLogTimers();
      setProgress({ active: PROGRESS_STEPS.length - 1, done: PROGRESS_STEPS.map((_, i) => i), failed: null, errorMessage: "" });
      setResult(data);
      setActiveSpecPath(data.generation.specFiles?.[0]?.path ?? (data.generation.specContent ? "combined.spec.ts" : ""));
      setPageState("results");
    } catch (err: any) {
      const msg = err?.message ?? "Scan failed";
      clearAuthLogTimers();
      setRawErrorMessage(msg);
      setShowErrorDetails(false);
      failProgressAt(progress.active, toFriendlyScanError(msg));
      setPageState("error");
    }
  }

  async function handleSave() {
    if (!result || !saveProjectId || result.generation.testCases.length === 0) return;
    setSaving(true);
    try {
      await apiFetch("/url-inspector/save", {
        method: "POST",
        body: JSON.stringify({
          projectId: saveProjectId,
          url: result.page.requestedUrl,
          testCases: result.generation.testCases,
          specContent: result.generation.specContent,
          specFiles: result.generation.specFiles ?? [],
        }),
      });
      toast.success(`Saved ${result.generation.testCases.length} test cases to project`);
      setSaved(true);
    } catch (err: any) {
      toast.error(err?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function copySpec() {
    if (!result) return;
    const files = result.generation.specFiles?.length
      ? result.generation.specFiles
      : result.generation.specContent
        ? [{ page: result.page.pathname, path: "combined.spec.ts", content: result.generation.specContent, testCount: result.generation.testCases.length }]
        : [];
    const selected = files.find((file) => file.path === activeSpecPath) ?? files[0];
    if (!selected) return;
    navigator.clipboard.writeText(selected.content).then(() => {
      toast.success(`Copied ${selected.path}`);
    });
  }

  function reset() {
    clearProgressTimers();
    clearAuthLogTimers();
    setAuthLog([]);
    setPageState("idle");
    setResult(null);
    setPreScanResult(null);
    setSaved(false);
    setDismissedSave(false);
    setActiveSpecPath("");
    setProgress({ active: 0, done: [], failed: null, errorMessage: "" });
  }

  const discoveredPages = result?.pages?.length ? result.pages : result ? [result.page] : [];
  const discoveredForms = discoveredPages.flatMap((page) => page.forms.map((form) => ({ ...form, pathname: page.pathname })));
  const discoveredButtons = discoveredPages.flatMap((page) => page.buttons.map((button) => ({ ...button, pathname: page.pathname })));
  const discoveredLinks = discoveredPages.flatMap((page) => page.links.map((link) => ({ ...link, pathname: page.pathname })));
  const resultNeedsAuth = result?.generation.warnings.some((w) =>
    w.code === "AUTH_REDIRECT" || w.code === "AUTH_PAGE_WITHOUT_CREDENTIALS"
  ) ?? false;
  const resultPhase = result?.phase ?? "ready";
  const resultCanSave = (result?.generation.testCases.length ?? 0) > 0;
  const specFiles: SpecFile[] = result?.generation.specFiles?.length
    ? result.generation.specFiles
    : result?.generation.specContent
      ? [{ page: result.page.pathname, path: "combined.spec.ts", content: result.generation.specContent, testCount: result.generation.testCases.length }]
      : [];
  const activeSpecFile = specFiles.find((file) => file.path === activeSpecPath) ?? specFiles[0];

  return (
    <div className="px-4 py-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-white flex items-center gap-2">
          <ScanSearch className="h-6 w-6 text-violet-600" />
          URL Test Builder
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Paste any URL — TestMind inspects the live page, maps every form and control, and generates a runnable Playwright spec.
        </p>
      </div>

      {/* ── Idle / Input ── */}
      {(pageState === "idle" || pageState === "results" || pageState === "error") && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="flex gap-2">
              <Input
                className="flex-1 font-mono text-sm"
                placeholder="https://your-app.com/dashboard"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleScan()}
              />
              <Button onClick={handleScan} disabled={!url.trim() || isScanning} className="gap-2">
                {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
                Inspect & Build
              </Button>
            </div>
            <Textarea
              className="resize-none text-sm"
              rows={2}
              placeholder="Optional: what should TestMind focus on? (e.g. 'test the checkout flow and form validation')"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />

            {/* Auth section toggle */}
            <button
              type="button"
              onClick={() => setShowAuth((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 transition-colors"
            >
              <KeyRound className="h-3.5 w-3.5" />
              {showAuth ? "Hide" : "Page requires login?"}
              {showAuth ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>

            {showAuth && (
              <form
                onSubmit={(e) => { e.preventDefault(); handleScan(); }}
                className="rounded-md border border-slate-200 bg-slate-50 dark:bg-slate-800/30 p-3 space-y-2"
                autoComplete="off"
              >
                <p className="text-xs text-slate-500">TestMind will log in before scanning. Credentials are used once and never stored.</p>
                <div className="flex gap-2">
                  <Input
                    className="flex-1 text-sm"
                    placeholder="Email or username"
                    value={authUsername}
                    onChange={(e) => setAuthUsername(e.target.value)}
                    autoComplete="off"
                    name="testmind-scan-username"
                  />
                  <Input
                    className="flex-1 text-sm"
                    type="password"
                    placeholder="Password"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    autoComplete="new-password"
                    name="testmind-scan-password"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowOtp((v) => !v)}
                  className="text-xs text-slate-400 hover:text-slate-600"
                >
                  {showOtp ? "− Hide MFA" : "+ Has MFA / OTP code?"}
                </button>
                {showOtp && (
                  <Input
                    className="text-sm font-mono w-36"
                    placeholder="6-digit code"
                    maxLength={8}
                    value={authOtp}
                    onChange={(e) => setAuthOtp(e.target.value.replace(/\D/g, ""))}
                    autoComplete="one-time-code"
                    name="otp"
                  />
                )}
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Scanning — progress steps ── */}
      {pageState === "scanning" && (
        <div className="space-y-3">
          {preScanResult && (
            <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 dark:bg-slate-800/30 px-3 py-2 text-sm text-slate-600">
              <Loader2 className="h-4 w-4 animate-spin text-violet-500 shrink-0" />
              Public scan: <strong>{preScanResult.generation.testCases.length}</strong> test{preScanResult.generation.testCases.length !== 1 ? "s" : ""} — scanning authenticated routes…
            </div>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-slate-700 dark:text-slate-200 text-base">Inspecting page…</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {PROGRESS_STEPS.map((label, idx) => {
                const isDone = progress.done.includes(idx);
                const isActive = progress.active === idx && !isDone;
                const isFailed = progress.failed === idx;
                return (
                  <div key={idx} className="flex items-start gap-3 text-sm">
                    {isFailed ? (
                      <XCircle className="h-4 w-4 text-rose-500 mt-0.5 shrink-0" />
                    ) : isDone ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                    ) : isActive ? (
                      <Loader2 className="h-4 w-4 text-blue-500 mt-0.5 animate-spin shrink-0" />
                    ) : (
                      <Circle className="h-4 w-4 text-slate-300 mt-0.5 shrink-0" />
                    )}
                    <div>
                      <span className={isDone ? "text-slate-700 dark:text-slate-300" : isActive ? "text-blue-600 font-medium" : isFailed ? "text-rose-600" : "text-slate-400"}>
                        {label}
                      </span>
                      {isFailed && progress.errorMessage && (
                        <p className="text-xs text-rose-500 mt-0.5">{progress.errorMessage}</p>
                      )}
                    </div>
                  </div>
                );
              })}
              {/* The checklist above is a fixed-timer animation (22s total) that can finish
                  well before the real scan does, especially for larger sites — AI generation
                  runs per discovered route. Without this, a fully-checked list with no motion
                  reads as frozen/finished rather than "still working". */}
              {progress.failed === null && progress.done.length === PROGRESS_STEPS.length && (
                <div className="flex items-start gap-3 text-sm pt-1 border-t border-slate-100 dark:border-slate-800 mt-1">
                  <Loader2 className="h-4 w-4 text-blue-500 mt-0.5 animate-spin shrink-0" />
                  <span className="text-blue-600 font-medium">
                    Still working — larger sites with more routes can take a bit longer…
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Auth session live log */}
          {authLog.length > 0 && (
            <Card className="border-slate-700 bg-slate-900 dark:bg-slate-950 overflow-hidden">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <KeyRound className="h-3.5 w-3.5 text-violet-400" />
                  <span className="text-[11px] font-semibold text-violet-400 uppercase tracking-widest">Auth Session</span>
                  <span className="ml-auto flex gap-1">
                    <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
                  </span>
                </div>
                <div className="space-y-1.5 font-mono">
                  {authLog.map((entry, i) => {
                    const isLast = i === authLog.length - 1;
                    return (
                      <div key={i} className="flex items-center gap-2.5 text-[12px]">
                        {isLast ? (
                          <Loader2 className="h-3 w-3 text-blue-400 animate-spin shrink-0" />
                        ) : (
                          <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                        )}
                        <span className={isLast ? "text-slate-100" : "text-slate-500"}>
                          {entry}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Error ── */}
      {pageState === "error" && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <div className="flex items-center">
            <span>{progress.errorMessage || "Scan failed. Check the URL and try again."}</span>
            <Button variant="outline" size="sm" className="ml-4" onClick={reset}>Try again</Button>
          </div>
          {rawErrorMessage && rawErrorMessage !== progress.errorMessage && (
            <div className="mt-2">
              <button
                className="text-xs underline text-rose-600"
                onClick={() => setShowErrorDetails((v) => !v)}
              >
                {showErrorDetails ? "Hide" : "Show"} technical details
              </button>
              {showErrorDetails && (
                <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-rose-100 p-2 text-xs text-rose-800">
                  {rawErrorMessage}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Results ── */}
      {pageState === "results" && result && (
        <>
          {/* Auth outcome banners */}
          {result.auth?.loginOutcome === "success" && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              <KeyRound className="h-4 w-4 shrink-0" />
              Authenticated successfully — scan ran on the logged-in page.
            </div>
          )}
          {result.auth?.loginOutcome === "failed" && (
            <div className="flex items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              <XCircle className="h-4 w-4 shrink-0" />
              {result.auth.authFailureReason === "AUTH_ENTRY_NOT_FOUND" &&
                "TestMind couldn't find a Sign In or Log In control on this page. Double-check the URL, or the entry point may need a different label than TestMind recognizes."}
              {result.auth.authFailureReason === "LOGIN_FORM_NOT_FOUND" &&
                "Authentication flow detected, but TestMind could not locate the credential form automatically."}
              {result.auth.authFailureReason === "MFA_REQUIRED" &&
                "This login requires a verification code (MFA/OTP). Add the code below and try again."}
              {result.auth.authFailureReason === "AUTH_TIMEOUT" &&
                "The authentication flow took too long and timed out. Try again, or verify the URL is reachable."}
              {(result.auth.authFailureReason === "CREDENTIALS_REJECTED" || !result.auth.authFailureReason) &&
                "Login failed — credentials were not accepted. Check your username/password and try again."}
              {!showAuth && (
                <button className="ml-auto text-xs underline" onClick={() => setShowAuth(true)}>Edit credentials</button>
              )}
            </div>
          )}
          {/* Growth banner after authenticated re-scan */}
          {preScanResult && !isScanning && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>
                Public scan: <strong>{preScanResult.generation.testCases.length}</strong> test{preScanResult.generation.testCases.length !== 1 ? "s" : ""}
                {" → "}
                Authenticated: <strong>{result.generation.testCases.length}</strong> total
                {(result.duplicatesRemoved ?? 0) > 0
                  ? ` (+${result.generation.testCases.length - preScanResult.generation.testCases.length + (result.duplicatesRemoved ?? 0)} new, ${result.duplicatesRemoved} duplicate${result.duplicatesRemoved !== 1 ? "s" : ""} removed)`
                  : ` (+${Math.max(0, result.generation.testCases.length - preScanResult.generation.testCases.length)} additional scenarios)`}
              </span>
            </div>
          )}

          {/* Non-blocking suggestion: the crawl found a login page even though the
              requested URL scanned fine on its own — offer to also cover it. */}
          {resultPhase === "ready" && result.auth?.loginRouteDiscovered && !dismissedLoginSuggestion && (
            <Card className="border-sky-300 bg-sky-50 dark:bg-sky-900/20">
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center gap-2 text-sky-700 dark:text-sky-400 font-medium text-sm">
                  <KeyRound className="h-4 w-4 shrink-0" />
                  <span>
                    Found a login page at <code>{result.auth.loginRouteDiscovered}</code> while scanning.
                    Add credentials to also cover the authenticated experience.
                  </span>
                  <button
                    type="button"
                    className="ml-auto shrink-0 text-xs underline text-sky-600"
                    onClick={() => setDismissedLoginSuggestion(true)}
                  >
                    Dismiss
                  </button>
                </div>
                <form
                  onSubmit={(e) => { e.preventDefault(); handleAuthScan(); }}
                  autoComplete="off"
                  className="flex flex-wrap gap-2 items-end"
                >
                  <Input
                    className="flex-1 min-w-[160px] text-sm"
                    placeholder="Email or username"
                    value={authUsername}
                    onChange={(e) => setAuthUsername(e.target.value)}
                    autoComplete="off"
                    name="testmind-scan-username"
                  />
                  <Input
                    className="flex-1 min-w-[140px] text-sm"
                    type="password"
                    placeholder="Password"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    autoComplete="new-password"
                    name="testmind-scan-password"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!authUsername.trim() || !authPassword || isScanning}
                    className="shrink-0"
                  >
                    {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : "Scan with authentication"}
                  </Button>
                </form>
                <p className="text-xs text-sky-600/80">Credentials are used once and never stored.</p>
              </CardContent>
            </Card>
          )}

          {/* Inline credential panel for auth_required or auth_failed */}
          {(resultPhase === "auth_required" || resultPhase === "auth_failed") && (
            <Card className="border-amber-300 bg-amber-50 dark:bg-amber-900/20">
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-medium text-sm">
                  <KeyRound className="h-4 w-4 shrink-0" />
                  {resultPhase === "auth_failed"
                    ? "Credentials were rejected — try different credentials to access authenticated routes."
                    : "This app requires login — add credentials to scan authenticated routes and generate full coverage."}
                </div>
                <form
                  onSubmit={(e) => { e.preventDefault(); handleAuthScan(); }}
                  autoComplete="off"
                  className="flex flex-wrap gap-2 items-end"
                >
                  <Input
                    className="flex-1 min-w-[160px] text-sm"
                    placeholder="Email or username"
                    value={authUsername}
                    onChange={(e) => setAuthUsername(e.target.value)}
                    autoComplete="off"
                    name="testmind-scan-username"
                  />
                  <Input
                    className="flex-1 min-w-[140px] text-sm"
                    type="password"
                    placeholder="Password"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    autoComplete="new-password"
                    name="testmind-scan-password"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!authUsername.trim() || !authPassword || isScanning}
                    className="shrink-0"
                  >
                    {isScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : "Scan with authentication"}
                  </Button>
                </form>
                <p className="text-xs text-amber-600/80">Credentials are used once and never stored.</p>
              </CardContent>
            </Card>
          )}

          {/* Summary bar */}
          <div className="flex flex-wrap items-center gap-4 rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 px-4 py-3 text-sm">
            <span className="flex items-center gap-1 text-emerald-700">
              <CheckCircle2 className="h-4 w-4" />
              <strong>{result.summary.interactiveElements}</strong> interactive elements found
            </span>
            <span className="text-slate-400">·</span>
            <span className="text-emerald-700"><strong>{result.summary.routes ?? result.pages?.length ?? 1}</strong> routes scanned</span>
            <span className="text-slate-400">Â·</span>
            <span className="text-emerald-700"><strong>{result.summary.testCases}</strong> test cases generated</span>
            <span className="text-slate-400">·</span>
            <span className={resultPhase === "ready" ? "text-emerald-700" : "text-amber-700"}>
              {resultPhase === "auth_required" ? "Credentials needed for full coverage" :
               resultPhase === "auth_failed" ? "Authentication failed" :
               resultPhase === "partial" ? "Partial coverage — some routes incomplete" :
               "Playwright spec ready"}
            </span>
            {result.page.title && (
              <>
                <span className="text-slate-400">·</span>
                <span className="text-slate-600 italic truncate max-w-[200px]" title={result.page.title}>{result.page.title}</span>
              </>
            )}
            {result.page.finalUrl !== result.page.requestedUrl && (
              <span className="ml-auto flex items-center gap-1 text-amber-600 text-xs">
                <ExternalLink className="h-3 w-3" />
                Redirected to {new URL(result.page.finalUrl).pathname}
              </span>
            )}
          </div>

          {/* Warnings */}
          {result.generation.warnings.length > 0 && (
            <div className="space-y-2">
              {result.generation.warnings.map((w, i) => {
                if (w.code === "NO_INTERACTIVE_ELEMENTS") {
                  return (
                    <div key={i} className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
                      <p className="text-amber-800 font-medium mb-1">No interactive elements found on this page</p>
                      <p className="text-amber-700 text-xs">This is likely a landing page or the app sits behind a login wall. To scan the authenticated experience:</p>
                      <ol className="text-amber-700 text-xs mt-1.5 ml-4 list-decimal space-y-0.5">
                        <li>Expand <strong>Page requires login?</strong> above and enter your credentials</li>
                        <li>Or paste the direct URL of a page inside the app (e.g. <code>/dashboard</code>)</li>
                      </ol>
                    </div>
                  );
                }
                return (
                  <div key={i} className={`rounded px-3 py-2 text-xs ${w.severity === "error" ? "bg-rose-50 text-rose-700 border border-rose-200" : w.severity === "warning" ? "bg-amber-50 text-amber-700 border border-amber-200" : "bg-slate-50 text-slate-600 border border-slate-200"}`}>
                    ⚠ {w.message}
                  </div>
                );
              })}
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-1 border-b border-slate-200">
            {(["tests", "coverage", "spec"] as ResultTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === tab ? "border-violet-600 text-violet-700" : "border-transparent text-slate-500 hover:text-slate-700"}`}
              >
                {tab === "tests" ? `View Tests (${result.generation.testCases.length})` : tab === "coverage" ? "Coverage" : `View Specs (${specFiles.length})`}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2 pb-1">
              {activeTab === "spec" && (
                <>
                  {specFiles.length > 1 && (
                    <Select value={activeSpecFile?.path ?? ""} onValueChange={setActiveSpecPath}>
                      <SelectTrigger className="h-8 w-56 text-xs">
                        <SelectValue placeholder="Select spec file" />
                      </SelectTrigger>
                      <SelectContent>
                        {specFiles.map((file) => (
                          <SelectItem key={file.path} value={file.path}>
                            {file.path} ({file.testCount})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={copySpec} disabled={!activeSpecFile}>
                    <Copy className="h-3 w-3" />
                    Copy spec
                  </Button>
                </>
              )}
              <Select value={saveProjectId} onValueChange={setSaveProjectId}>
                <SelectTrigger className="h-8 w-44 text-xs">
                  <SelectValue placeholder="Save to project…" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={!saveProjectId || saving || !resultCanSave}
                onClick={handleSave}
                className="h-8"
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add to project"}
              </Button>
            </div>
          </div>

          {/* Tab content */}
          {activeTab === "tests" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Left: Discovered elements */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-slate-700">Discovered routes ({discoveredPages.length})</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  {discoveredForms.length > 0 && (
                    <div>
                      <div className="font-medium text-slate-600 mb-2">Forms ({discoveredForms.length})</div>
                      {discoveredForms.slice(0, 8).map((form, i) => (
                        <div key={i} className="ml-2 mb-3">
                          <div className="text-xs font-mono text-slate-500 mb-1">{form.pathname} · {form.selector}</div>
                          {form.fields.map((f, j) => (
                            <div key={j} className="flex items-center gap-2 text-xs text-slate-600 ml-2">
                              <span className="text-slate-400">├──</span>
                              <span>{f.label || f.name}</span>
                              <span className="text-slate-400">[{f.type}]</span>
                              <code className="text-[10px] text-violet-600 font-mono truncate max-w-[160px]" title={f.selector}>{f.selector}</code>
                            </div>
                          ))}
                          {form.submit && (
                            <div className="flex items-center gap-2 text-xs text-slate-600 ml-2">
                              <span className="text-slate-400">└──</span>
                              <span className="font-medium">{form.submit.label || "Submit"}</span>
                              <code className="text-[10px] text-violet-600 font-mono truncate max-w-[160px]" title={form.submit.selector}>{form.submit.selector}</code>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {discoveredButtons.length > 0 && (
                    <div>
                      <div className="font-medium text-slate-600 mb-1">Controls ({discoveredButtons.length})</div>
                      {discoveredButtons.slice(0, 12).map((b, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs text-slate-600 ml-2">
                          <span className="text-slate-400">•</span>
                          <span className="text-slate-400">{b.pathname}</span>
                          <span>"{b.label}"</span>
                          <code className="text-[10px] text-violet-600 font-mono truncate max-w-[160px]" title={b.selector}>{b.selector}</code>
                        </div>
                      ))}
                      {discoveredButtons.length > 12 && <div className="text-xs text-slate-400 ml-2">+{discoveredButtons.length - 12} more controls</div>}
                    </div>
                  )}
                  {discoveredLinks.length > 0 && (
                    <div>
                      <div className="font-medium text-slate-600 mb-1">Links ({discoveredLinks.length})</div>
                      <div className="flex flex-wrap gap-1">
                        {discoveredLinks.slice(0, 20).map((l, i) => (
                          <span key={i} className="text-[10px] bg-slate-100 rounded px-1.5 py-0.5 text-slate-600 font-mono">{l.text || l.href}</span>
                        ))}
                        {discoveredLinks.length > 20 && <span className="text-[10px] text-slate-400">+{discoveredLinks.length - 20} more</span>}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Right: Generated test cases */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-slate-700">Generated test cases</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm max-h-[500px] overflow-y-auto">
                  {result.generation.testCases.length === 0 ? (
                    <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      Login evidence was captured. Add valid credentials and continue the scan to discover authenticated routes and generate testcases.
                    </div>
                  ) : result.generation.testCases.map((tc, i) => (
                    <div key={i} className="rounded border border-slate-200 p-2">
                      <div className="font-medium text-slate-800 text-xs mb-1">{tc.name}</div>
                      <div className="space-y-0.5">
                        {(tc.steps as Array<any>).slice(0, 5).map((step, j) => (
                          <div key={j} className="text-[10px] text-slate-500 font-mono">
                            {step.kind === "goto" && `→ goto ${step.url}`}
                            {step.kind === "fill" && `→ fill ${step.selector}`}
                            {step.kind === "click" && `→ click ${step.selector}`}
                            {step.kind === "expect-text" && `✓ expect "${step.text}"`}
                            {step.kind === "expect-visible" && `✓ visible ${step.selector}`}
                            {step.kind === "custom" && `? ${step.note ?? "custom step"}`}
                          </div>
                        ))}
                        {(tc.steps as unknown[]).length > 5 && (
                          <div className="text-[10px] text-slate-400">…{(tc.steps as unknown[]).length - 5} more steps</div>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === "coverage" && (
            <div className="rounded-md border border-slate-200 p-4 space-y-4 text-sm">
              {result.coverage ? (
                <>
                  {/* Matrix grid */}
                  <div>
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Coverage Analysis</div>
                    <div className="grid grid-cols-2 gap-x-8 gap-y-1.5">
                      {Object.entries(COVERAGE_LABELS).map(([key, label]) => {
                        const status = result.coverage!.matrix[key] ?? "not_applicable";
                        const icon =
                          status === "covered" ? <span className="text-emerald-600 font-bold">✓</span> :
                          status === "partial" ? <span className="text-amber-500 font-bold">~</span> :
                          status === "runtime_required" ? <span className="text-amber-500">⏱</span> :
                          <span className="text-slate-300">–</span>;
                        const textColor =
                          status === "covered" ? "text-slate-700" :
                          status === "partial" ? "text-amber-700" :
                          status === "runtime_required" ? "text-amber-600" :
                          "text-slate-400";
                        const statusLabel =
                          status === "covered" ? "covered" :
                          status === "partial" ? "partial" :
                          status === "runtime_required" ? "runtime req." :
                          "n/a";
                        const count = result.coverage?.familyCounts?.[key] ?? 0;
                        return (
                          <div key={key} className="flex items-center gap-2">
                            {icon}
                            <span className={`${textColor} w-28`}>{label}</span>
                            <span className={`text-xs ${textColor} opacity-70 w-20`}>{statusLabel}</span>
                            <span className="text-xs text-slate-400">{count > 0 ? `${count} cases` : ""}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Capabilities */}
                  {result.coverage.capabilities.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Detected capabilities</div>
                      <div className="flex flex-wrap gap-1.5">
                        {result.coverage.capabilities.map((c, i) => (
                          <span key={i} className="text-xs bg-violet-50 text-violet-700 rounded px-2 py-0.5">{c.replace(/_/g, " ")}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Counts */}
                  <div className="flex flex-wrap gap-6 text-sm border-t border-slate-100 pt-3">
                    <span className="text-slate-700"><strong>{result.summary.testCases}</strong> scenarios generated</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" /><strong>{result.coverage.observedCount}</strong> observed</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-400 inline-block" /><strong>{result.coverage.inferredCount}</strong> inferred</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400 inline-block" /><strong>{result.coverage.runtimeRequiredCount}</strong> require runtime validation</span>
                  </div>

                  {/* Gaps */}
                  {result.coverage.gaps.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Gaps</div>
                      <ul className="space-y-1">
                        {result.coverage.gaps.map((g, i) => (
                          <li key={i} className="text-xs text-slate-600 flex items-start gap-1.5">
                            <span className="text-slate-400 mt-0.5">•</span>{g}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-slate-500 text-sm">Coverage data not available.</p>
              )}
            </div>
          )}

          {activeTab === "spec" && (
            activeSpecFile ? (
              <div className="rounded-md overflow-hidden border border-slate-200">
                <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <span className="font-mono truncate max-w-[260px]" title={activeSpecFile.path}>{activeSpecFile.path}</span>
                  <span className="text-slate-400">/</span>
                  <span>{activeSpecFile.testCount} tests</span>
                  <span className="text-slate-400">/</span>
                  <span className="font-mono truncate max-w-[260px]" title={activeSpecFile.page}>{activeSpecFile.page}</span>
                </div>
                <div className="h-[500px]">
                  <Editor
                    height="100%"
                    defaultLanguage="typescript"
                    theme="vs-dark"
                    value={activeSpecFile.content}
                    beforeMount={configureSpecEditor}
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      fontSize: 12,
                      scrollBeyondLastLine: false,
                      wordWrap: "on",
                      lineNumbers: "on",
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                The Playwright spec will be generated after authenticated route discovery completes.
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
