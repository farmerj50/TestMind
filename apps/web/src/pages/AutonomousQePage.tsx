import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Editor from "@monaco-editor/react";
import { useApi } from "../lib/api";
import { configureSpecEditor } from "../lib/monaco-spec-config";

// Autonomous QE run view (B1): start a run from an app URL, page, user story or repository,
// then follow it stage by stage - with truthful outcomes, artifacts, per-test results,
// pending approvals, and pause / resume / cancel.

type Project = { id: string; name: string };
type Capabilities = { autonomousQa: boolean; appCodeFix: boolean; github: { repository: string; defaultBranch: string } | null; savedCredentialKeys: Array<{ key: string; name: string }> };
type InputKind = "app_url" | "page" | "user_story" | "repository";
type Outcome = "pending" | "running" | "succeeded" | "partial" | "failed" | "unverified" | "blocked" | "skipped" | "canceled" | "awaitingApproval";

type RunListItem = { id: string; status: string; objective: string | null; error: string | null; createdAt: string; inputKind: InputKind; stages: Array<{ stage: string; outcome: Outcome | null }> };
type Artifact = { id: string; type: string; testRunId: string | null; meta: any; createdAt: string; viewable: boolean; proposal?: any; pr?: any };
type StageView = {
  id: string; stage: string; order: number; outcome: Outcome | null; reason: string | null;
  startedAt: string | null; finishedAt: string | null; checkpointSavedAt: string | null; output: any;
  tasks: Array<{ id: string; type: string; status: string; error: string | null; testRunId: string | null; phase: string | null }>;
  artifacts: Artifact[];
};
type TestRunView = { id: string; status: string; error: string | null; results: Array<{ id: string; title: string; status: string; durationMs: number | null; message: string | null }> };
type Approval = { id: string; actionType: string; status: string; prompt: string | null; requestedAt: string; expiresAt: string | null };
type RunDetail = {
  run: { id: string; projectName: string; status: string; objective: string | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; context: any; hold: string | null };
  stages: StageView[];
  testRuns: TestRunView[];
  approvals: Approval[];
};

const INPUT_LABELS: Record<InputKind, string> = { app_url: "Application URL", page: "Single page", user_story: "User story", repository: "Repository" };
const STAGE_LABELS: Record<string, string> = { input: "Input", discovery: "Discovery", plan: "Plan", generate: "Generate", execute: "Execute", repair: "Repair", review: "Review" };
const TERMINAL = new Set(["succeeded", "failed", "canceled", "partial", "unverified", "blocked"]);

const TONE: Record<string, string> = {
  succeeded: "bg-emerald-100 text-emerald-800", partial: "bg-amber-100 text-amber-800", unverified: "bg-amber-100 text-amber-800",
  failed: "bg-rose-100 text-rose-700", blocked: "bg-orange-100 text-orange-800", canceled: "bg-slate-200 text-slate-700",
  running: "bg-blue-100 text-blue-700", queued: "bg-slate-100 text-slate-600", paused: "bg-violet-100 text-violet-700",
  awaitingApproval: "bg-violet-100 text-violet-700", pending: "bg-slate-100 text-slate-500", skipped: "bg-slate-100 text-slate-400",
  passed: "bg-emerald-100 text-emerald-800",
};
const DOT: Record<string, string> = {
  succeeded: "bg-emerald-500", partial: "bg-amber-500", unverified: "bg-amber-500", failed: "bg-rose-500", blocked: "bg-orange-500",
  canceled: "bg-slate-400", running: "bg-blue-500", awaitingApproval: "bg-violet-500", pending: "bg-slate-300", skipped: "bg-slate-200",
};

function Badge({ value }: { value: string | null }) {
  const v = value ?? "pending";
  const label = v === "awaitingApproval" ? "awaiting approval" : v;
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${TONE[v] ?? "bg-slate-100 text-slate-600"}`}>{label}</span>;
}

const fmtTime = (s: string | null) => (s ? new Date(s).toLocaleTimeString() : "—");

export default function AutonomousQePage() {
  const { id: runId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { apiFetch } = useApi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Unified run form: application URL (+ optional objective, credentials and repository).
  const [appUrl, setAppUrl] = useState("");
  const [objective, setObjective] = useState("");
  const [singlePage, setSinglePage] = useState(false);
  const [maxPages, setMaxPages] = useState("10");
  const [planReview, setPlanReview] = useState(false);
  const [credMode, setCredMode] = useState<"none" | "saved" | "run">("none");
  const [savedEmailKey, setSavedEmailKey] = useState("");
  const [savedPasswordKey, setSavedPasswordKey] = useState("");
  const [runEmail, setRunEmail] = useState("");
  const [runPassword, setRunPassword] = useState("");
  const [loginPath, setLoginPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoBranch, setRepoBranch] = useState("");
  const [allowCodeFix, setAllowCodeFix] = useState(false);
  const [testCommand, setTestCommand] = useState("");
  const [caps, setCaps] = useState<Capabilities | null>(null);

  useEffect(() => {
    apiFetch<{ projects: Project[] }>("/projects")
      .then((d) => { setProjects(d.projects ?? []); if (!projectId && d.projects?.[0]) setProjectId(d.projects[0].id); })
      .catch((e) => setError(String(e)));
  }, []);

  const loadRuns = useCallback(() => {
    if (!projectId) return;
    apiFetch<{ runs: RunListItem[] }>(`/operator/qe/runs?projectId=${encodeURIComponent(projectId)}`).then((d) => setRuns(d.runs)).catch(() => {});
  }, [apiFetch, projectId]);

  const loadDetail = useCallback(() => {
    if (!runId) { setDetail(null); return; }
    apiFetch<RunDetail>(`/operator/qe/runs/${runId}`).then(setDetail).catch((e) => setError(String(e)));
  }, [apiFetch, runId]);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { loadDetail(); }, [loadDetail]);
  const live = detail ? !TERMINAL.has(detail.run.status) : false;
  useEffect(() => {
    const t = setInterval(() => { loadRuns(); if (live) loadDetail(); }, 3000);
    return () => clearInterval(t);
  }, [loadRuns, loadDetail, live]);

  useEffect(() => {
    if (!projectId) return;
    apiFetch<Capabilities>(`/operator/qe/capabilities?projectId=${encodeURIComponent(projectId)}`).then(setCaps).catch(() => setCaps(null));
  }, [apiFetch, projectId]);

  // Routes the request to the existing pipelines: objective -> user-story run, otherwise URL/page run;
  // credentials by reference (or stored for this run only); repository through the GitHub integration.
  async function start() {
    setError(null);
    setBusy(true);
    try {
      const url = appUrl.trim();
      const goal = objective.trim();
      const inputKind: InputKind = goal ? "user_story" : singlePage ? "page" : "app_url";
      const body: Record<string, unknown> = { projectId, inputKind, input: goal || url, planReview };
      if (goal) body.baseUrl = url;
      if (inputKind !== "page") body.maxPages = Number(maxPages) || undefined;
      const lp = loginPath.trim() || undefined;
      if (credMode === "saved") body.credentials = { emailKey: savedEmailKey, passwordKey: savedPasswordKey, ...(lp ? { loginPath: lp } : {}) };
      if (credMode === "run") body.runCredentials = { email: runEmail, password: runPassword, ...(lp ? { loginPath: lp } : {}) };
      if (repoUrl.trim()) {
        body.repository = { url: repoUrl.trim(), ...(repoBranch.trim() ? { branch: repoBranch.trim() } : {}) };
        if (allowCodeFix) body.codeFix = { targetRepo: repoUrl.trim(), confirmExternalRepo: true, ...(testCommand.trim() ? { testCommand: testCommand.trim() } : {}) };
      }
      const res = await apiFetch<{ run: { id: string } }>("/operator/qe/runs", { method: "POST", body: JSON.stringify(body) });
      setObjective("");
      setRunPassword("");
      loadRuns();
      navigate(`/operator/qe/${res.run.id}`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function control(action: "pause" | "resume" | "cancel") {
    if (!runId) return;
    setError(null);
    try {
      await apiFetch(`/operator/qe/runs/${runId}/${action}`, { method: "POST" });
      loadDetail();
      loadRuns();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function resolveApproval(id: string, decision: "approve" | "deny") {
    setError(null);
    try {
      await apiFetch(`/operator/approvals/${id}/${decision}`, { method: "POST" });
      loadDetail();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  const credsReady = credMode === "none" || (credMode === "saved" ? !!savedEmailKey && !!savedPasswordKey : !!runEmail.trim() && !!runPassword);
  const canStart = !!projectId && /^https?:\/\//i.test(appUrl.trim()) && credsReady && !busy;
  // What this run will be able to do (shown before starting).
  const modes = [
    { key: "url", label: "URL-only", on: true, detail: "Discover, generate, execute, investigate; results saved to Suites. No Git needed." },
    { key: "auth", label: "Authenticated", on: credMode !== "none", detail: "Isolated signed-in browser sessions; credentials never enter tests, prompts, logs or artifacts." },
    { key: "repo", label: "Repository-enabled", on: !!repoUrl.trim(), detail: "Source inspection from a temporary checkout (deleted after use); draft PRs only after your approval." },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">
            <Link to="/operator" className="hover:underline">Operator</Link> / Autonomous QE
          </p>
          <h1 className="text-2xl font-semibold text-slate-900">Autonomous QE runs</h1>
          <p className="text-sm text-slate-600">Discover, plan, generate, execute and repair tests autonomously. Every stage reports a truthful outcome.</p>
        </div>
        <select className="rounded-md border px-2 py-1.5 text-sm" value={projectId} onChange={(e) => { setProjectId(e.target.value); navigate("/operator/qe"); }}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-1">
          {/* Start a run */}
          <section className="rounded-lg border bg-white p-4 space-y-3">
            <h2 className="text-base font-semibold text-slate-800">Start an autonomous agent run</h2>
            <div className="flex flex-wrap gap-1.5">
              {modes.map((m) => (
                <span key={m.key} title={m.detail} className={`rounded-full px-2 py-0.5 text-xs font-medium ${m.on ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-400"}`}>{m.on ? "✓ " : ""}{m.label}</span>
              ))}
            </div>

            <label className="block text-sm font-medium text-slate-700">Application URL
              <input className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm font-normal" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://www.example.com" />
            </label>
            <label className="block text-sm font-medium text-slate-700">Instruction / objective <span className="font-normal text-slate-400">(optional)</span>
              <textarea className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm font-normal" rows={3} value={objective} onChange={(e) => setObjective(e.target.value)}
                placeholder={"Leave empty to test the whole application.\nOr describe a goal / user story with acceptance criteria."} />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-700">
              {!objective.trim() && <label className="flex items-center gap-2"><input type="checkbox" checked={singlePage} onChange={(e) => setSinglePage(e.target.checked)} /> Only this page</label>}
              {!singlePage && <label className="flex items-center gap-2">Max pages <input className="w-16 rounded-md border px-2 py-1 text-sm" type="number" min={1} max={50} value={maxPages} onChange={(e) => setMaxPages(e.target.value)} /></label>}
            </div>

            <fieldset className="space-y-2 rounded-md border p-2">
              <legend className="px-1 text-xs font-semibold uppercase text-slate-500">Credentials (optional)</legend>
              <div className="grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1 text-xs">
                {([["none", "None"], ["saved", "Saved secret"], ["run", "This run only"]] as const).map(([k, l]) => (
                  <button key={k} onClick={() => setCredMode(k)} className={`rounded px-2 py-1 ${credMode === k ? "bg-white font-semibold shadow-sm" : "text-slate-600"}`}>{l}</button>
                ))}
              </div>
              {credMode === "saved" && (
                (caps?.savedCredentialKeys.length ?? 0) === 0 ? <p className="text-xs text-slate-500">No project secrets yet - add them under the project's secrets, or use "This run only".</p> : (
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {([["Email / username secret", savedEmailKey, setSavedEmailKey], ["Password secret", savedPasswordKey, setSavedPasswordKey]] as const).map(([l, v, set]) => (
                      <select key={l} className="rounded-md border px-2 py-1" value={v} onChange={(e) => set(e.target.value)}>
                        <option value="">{l}</option>
                        {caps!.savedCredentialKeys.map((s) => <option key={s.key} value={s.key}>{s.key}</option>)}
                      </select>
                    ))}
                  </div>
                )
              )}
              {credMode === "run" && (
                <div className="grid grid-cols-2 gap-2">
                  <input className="rounded-md border px-2 py-1 text-xs" autoComplete="off" value={runEmail} onChange={(e) => setRunEmail(e.target.value)} placeholder="Email / username" />
                  <input className="rounded-md border px-2 py-1 text-xs" type="password" autoComplete="new-password" value={runPassword} onChange={(e) => setRunPassword(e.target.value)} placeholder="Password" />
                  <p className="col-span-2 text-[11px] text-slate-500">Stored encrypted for this run only and deleted when it ends.</p>
                </div>
              )}
              {credMode !== "none" && <input className="w-full rounded-md border px-2 py-1 text-xs" value={loginPath} onChange={(e) => setLoginPath(e.target.value)} placeholder="Login path (optional, e.g. /login)" />}
            </fieldset>

            <fieldset className="space-y-2 rounded-md border p-2">
              <legend className="px-1 text-xs font-semibold uppercase text-slate-500">GitHub repository (optional)</legend>
              {caps?.github ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <input className="col-span-2 rounded-md border px-2 py-1 text-xs" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder={caps.github.repository} />
                    <input className="rounded-md border px-2 py-1 text-xs" value={repoBranch} onChange={(e) => setRepoBranch(e.target.value)} placeholder={caps.github.defaultBranch} />
                  </div>
                  <p className="text-[11px] text-slate-500">Only {caps.github.repository} (this project's GitHub integration). Fetched as a temporary checkout for this run and deleted afterwards.</p>
                  {repoUrl.trim() && (
                    <>
                      <label className={`flex items-center gap-2 text-xs ${caps.appCodeFix ? "text-slate-700" : "text-slate-400"}`}>
                        <input type="checkbox" disabled={!caps.appCodeFix} checked={allowCodeFix && caps.appCodeFix} onChange={(e) => setAllowCodeFix(e.target.checked)} />
                        Allow application-code fix proposals {caps.appCodeFix ? "(draft PRs only after your approval)" : "(disabled on this server)"}
                      </label>
                      {allowCodeFix && caps.appCodeFix && <input className="w-full rounded-md border px-2 py-1 text-xs" value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder="Regression test command (e.g. npm test)" />}
                    </>
                  )}
                </>
              ) : (
                <p className="text-xs text-slate-500">Connect the project's GitHub integration to let the agent inspect source and prepare draft PRs.</p>
              )}
            </fieldset>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={planReview} onChange={(e) => setPlanReview(e.target.checked)} /> Pause for plan review before generating
            </label>
            <button disabled={!canStart} onClick={start} className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
              {busy ? "Starting…" : "Start autonomous run"}
            </button>
          </section>

          {/* Runs */}
          <section className="rounded-lg border bg-white p-4 space-y-2">
            <h2 className="text-base font-semibold text-slate-800">Recent runs</h2>
            {runs.length === 0 && <p className="text-sm text-slate-500">No autonomous runs for this project yet.</p>}
            {runs.map((r) => (
              <button key={r.id} onClick={() => navigate(`/operator/qe/${r.id}`)}
                className={`w-full rounded-md border px-3 py-2 text-left ${r.id === runId ? "border-blue-500 ring-1 ring-blue-500" : "hover:bg-slate-50"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-slate-800">{r.objective?.replace(/^Autonomous QE \([a-z_]+\): /, "") ?? r.id}</span>
                  <Badge value={r.status} />
                </div>
                <div className="mt-1.5 flex items-center gap-1">
                  {r.stages.map((s) => <span key={s.stage} title={`${STAGE_LABELS[s.stage]}: ${s.outcome}`} className={`h-1.5 flex-1 rounded ${DOT[s.outcome ?? "pending"]}`} />)}
                </div>
                <div className="mt-1 text-xs text-slate-500">{INPUT_LABELS[r.inputKind]} · {new Date(r.createdAt).toLocaleString()}</div>
              </button>
            ))}
          </section>
        </div>

        <div className="xl:col-span-2">
          {detail ? (
            <RunDetailView detail={detail} onControl={control} onApproval={resolveApproval} apiFetch={apiFetch} onRefresh={loadDetail} />
          ) : (
            <div className="rounded-lg border border-dashed bg-white p-10 text-center text-sm text-slate-500">Select a run, or start one, to follow it stage by stage.</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function RunDetailView({ detail, onControl, onApproval, apiFetch, onRefresh }: {
  detail: RunDetail;
  onControl: (a: "pause" | "resume" | "cancel") => void;
  onApproval: (id: string, d: "approve" | "deny") => void;
  apiFetch: ReturnType<typeof useApi>["apiFetch"];
  onRefresh?: () => void;
}) {
  const { run, stages, testRuns, approvals } = detail;
  const qe = run.context?.qe ?? {};
  const terminal = TERMINAL.has(run.status);
  const pending = approvals.filter((a) => a.status === "pending");
  const [open, setOpen] = useState<string | null>(null);
  const active = stages.find((s) => s.outcome === "running" || s.outcome === "awaitingApproval");
  const expanded = open ?? active?.stage ?? null;

  return (
    <section className="rounded-lg border bg-white p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-900">Run status</h2>
            <Badge value={run.status} />
          </div>
          <div className="mt-1 font-mono text-xs text-slate-500">#{run.id}</div>
          <div className="mt-1 text-sm text-slate-700">
            {INPUT_LABELS[qe.inputKind as InputKind] ?? qe.inputKind}: <span className="break-all">{qe.inputKind === "user_story" ? (qe.baseUrl ?? "") : qe.input}</span>
            {qe.planReview && <span className="ml-2 text-xs text-slate-500">(plan review on)</span>}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">Started {fmtTime(run.startedAt)}{run.finishedAt ? ` · Finished ${fmtTime(run.finishedAt)}` : ""}{run.context?.checkpointSavedAt ? ` · Last checkpoint ${fmtTime(run.context.checkpointSavedAt)}` : ""}</div>
        </div>
        <div className="flex gap-2">
          {(run.status === "running" || run.status === "queued") && <button onClick={() => onControl("pause")} className="rounded-md border px-3 py-1.5 text-sm">Pause</button>}
          {run.status === "paused" && <button onClick={() => onControl("resume")} className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white">{run.hold === "plan_review" ? "Approve plan & continue" : "Resume"}</button>}
          {!terminal && <button onClick={() => onControl("cancel")} className="rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700">Cancel</button>}
        </div>
      </div>

      {qe.inputKind === "user_story" && (
        <details className="rounded-md border bg-slate-50 p-2 text-sm"><summary className="cursor-pointer text-slate-700">User story</summary><pre className="mt-1 whitespace-pre-wrap text-xs text-slate-700">{qe.input}</pre></details>
      )}
      {run.hold === "plan_review" && run.status === "paused" && (
        <div className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-800">Held for plan review. Review the plan below, then continue to generate and execute the tests.</div>
      )}
      {terminal && run.status !== "succeeded" && run.error && (
        <div className={`rounded-md border px-3 py-2 text-sm ${run.status === "failed" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>{run.error}</div>
      )}
      {pending.map((a) => (
        <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-violet-200 bg-violet-50 px-3 py-2">
          <div className="text-sm text-violet-900"><b>Approval required</b> ({a.actionType.replace(/_/g, " ")}): {a.prompt}</div>
          <div className="flex gap-2">
            <button onClick={() => onApproval(a.id, "approve")} className="rounded bg-violet-600 px-2 py-1 text-xs text-white">Approve</button>
            <button onClick={() => onApproval(a.id, "deny")} className="rounded border border-violet-300 px-2 py-1 text-xs text-violet-800">Deny</button>
          </div>
        </div>
      ))}

      {/* Stage timeline */}
      <ol className="space-y-2">
        {stages.map((s) => (
          <li key={s.id} className="rounded-md border">
            <button onClick={() => setOpen(expanded === s.stage ? "__none__" : s.stage)} className="flex w-full items-center gap-3 px-3 py-2 text-left">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[s.outcome ?? "pending"]} ${s.outcome === "running" ? "animate-pulse" : ""}`} />
              <span className="w-24 shrink-0 text-sm font-semibold text-slate-800">{STAGE_LABELS[s.stage] ?? s.stage}</span>
              <Badge value={s.outcome} />
              <span className="min-w-0 flex-1 truncate text-xs text-slate-600">{s.reason ?? ""}</span>
              <span className="shrink-0 text-xs text-slate-400">{s.finishedAt ? fmtTime(s.finishedAt) : s.startedAt ? fmtTime(s.startedAt) : ""}</span>
            </button>
            {expanded === s.stage && <StageBody stage={s} runId={run.id} testRuns={testRuns} apiFetch={apiFetch} onRefresh={onRefresh} repairStage={stages.find((x) => x.stage === "repair")} />}
          </li>
        ))}
      </ol>
    </section>
  );
}

const ACCESS_TONE: Record<string, string> = { public: "succeeded", login_page: "running", auth_required: "blocked", unreachable: "failed", redirected: "unverified" };
const KIND_LABEL: Record<string, string> = {
  investigate_failure: "investigate failure", cover_story_criterion: "acceptance criterion", cover_page: "uncovered page",
  cover_api: "uncovered API", needs_credentials: "needs credentials", inaccessible_page: "not reachable signed-out", unverifiable_criterion: "no evidence", verify_missing_page: "page missing",
};

const RISK_TONE: Record<string, string> = { safe: "succeeded", sensitive: "partial", destructive: "failed" };
const STATUS_LABEL: Record<string, string> = { ready: "ready", blocked_auth: "blocked: auth", blocked_unverifiable: "blocked: no evidence" };
const MODE_LABEL: Record<string, string> = { generated_now: "runs now", to_generate: "to generate", not_executable: "not executable" };

function ScenarioPlan({ plan }: { plan: any }) {
  const [category, setCategory] = useState<string>("all");
  const s = plan.summary;
  const rows: any[] = (plan.scenarios ?? []).filter((x: any) => category === "all" || x.category === category);
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase text-slate-500">
        Risk-prioritized plan · {s.total} scenario(s) · {s.tiers.P1} P1 · {s.coverage.missing} missing / {s.coverage.existing} existing coverage
        {s.needsApproval > 0 && <span className="ml-2 normal-case text-rose-700">{s.needsApproval} executable test(s) need approval (side effects)</span>}
      </div>
      <div className="flex flex-wrap gap-1 text-xs">
        {["all", "positive", "negative", "boundary", "integration", "security", "workflow"].map((c) => (
          <button key={c} onClick={() => setCategory(c)} className={`rounded border px-2 py-0.5 ${category === c ? "border-blue-500 bg-blue-50" : ""}`}>
            {c}{c !== "all" ? ` (${s.byCategory[c] ?? 0})` : ""}
          </button>
        ))}
      </div>
      <div className="max-h-96 overflow-auto rounded border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
            <tr><th className="px-2 py-1">Pri</th><th className="px-2 py-1">Scenario &amp; objective</th><th className="px-2 py-1">Coverage</th><th className="px-2 py-1">Side effects</th><th className="px-2 py-1">Status</th></tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.id} className="border-t align-top">
                <td className="px-2 py-1 font-semibold" title={Object.entries(x.priority.breakdown).map(([k, v]) => `${k} +${v}`).join(", ")}>{x.priority.tier}<div className="font-normal text-slate-400">{x.priority.score}</div></td>
                <td className="px-2 py-1">
                  <div className="font-medium text-slate-800">{x.title} <span className="font-normal text-slate-400">· {x.category} · {x.route}</span></div>
                  <div className="text-slate-600">{x.objective}</div>
                  <div className="mt-0.5 text-slate-400">{x.evidence.map((e: any) => `${e.source}: ${e.detail}`).join(" | ")}</div>
                  {x.blockedReason && <div className="mt-0.5 text-amber-700">{x.blockedReason}</div>}
                </td>
                <td className="px-2 py-1">{x.coverage === "existing" ? <span className="text-slate-500" title={x.existingTests.join("\n")}>existing</span> : <Badge value="partial" />}</td>
                <td className="px-2 py-1"><Badge value={RISK_TONE[x.risk.level]} /><div className="text-slate-500">{x.risk.level}</div>{x.risk.reasons.length > 0 && <div className="text-slate-400">{x.risk.reasons[0]}</div>}</td>
                <td className="px-2 py-1"><div>{STATUS_LABEL[x.status] ?? x.status}</div><div className="text-slate-400">{MODE_LABEL[x.execution.mode]}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const CATEGORY_TONE: Record<string, string> = { product_defect: "failed", test_defect: "partial", environment: "blocked", blocked_inconclusive: "unverified" };
const CATEGORY_LABEL: Record<string, string> = { product_defect: "suspected product defect", test_defect: "test defect", environment: "environment", blocked_inconclusive: "inconclusive" };
const ACTION_LABEL: Record<string, string> = { auto_repair: "auto-repairing selector", escalate: "escalated for human review", hold: "held - not auto-repaired" };

const PROPOSAL_TONE: Record<string, string> = { verified: "succeeded", unverified: "unverified", failed: "failed", rejected: "failed", awaiting_approval: "awaitingApproval", in_progress: "running" };

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded border bg-slate-950 p-2 font-mono text-[11px] leading-4 text-slate-200">
      {diff.split("\n").map((l, i) => (
        <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "text-emerald-300" : l.startsWith("-") && !l.startsWith("---") ? "text-rose-300" : l.startsWith("@@") ? "text-sky-300" : ""}>{l || " "}</div>
      ))}
    </pre>
  );
}

function CodeFixProposal({ meta, proposal }: { meta: any; proposal: any }) {
  const p = proposal;
  return (
    <div className="space-y-2 rounded-md border border-indigo-200 bg-indigo-50/40 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold uppercase text-slate-600">Code-fix proposal</span>
        {p ? <Badge value={PROPOSAL_TONE[p.status] ?? "pending"} /> : <Badge value="pending" />}
        <span className="font-medium text-slate-700">{p?.status?.replace("_", " ") ?? "pending"}</span>
        <span className="text-slate-500">· {meta.targetRepo}{p?.workBranch ? ` · branch ${p.workBranch}` : ""} · never applied automatically</span>
        <a className="ml-auto text-blue-600 hover:underline" href="/dev-agent" target="_blank" rel="noreferrer">Dev Agent run {String(meta.devAgentRunId).slice(-8)} →</a>
      </div>
      {p && <div className="text-slate-700">{p.explanation}</div>}
      <div className="text-slate-600"><b>Defect:</b> {meta.testTitle} - {meta.explanation}</div>
      {meta.objective && <div className="text-slate-600"><b>Objective (unchanged):</b> {meta.objective}</div>}
      {p && (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded border bg-white p-2"><div className="mb-0.5 font-semibold text-slate-500">Before the change</div>{p.baseline ? <><Badge value={p.baseline.passed ? "succeeded" : "failed"} /> <span className="text-slate-500">{p.baseline.passed ? "regression test passed" : "regression test failed (defect reproduced)"}</span></> : <span className="text-slate-400">no baseline run</span>}</div>
            <div className="rounded border bg-white p-2"><div className="mb-0.5 font-semibold text-slate-500">After the change</div>{p.after ? <><Badge value={p.after.passed ? "succeeded" : "failed"} /> <span className="text-slate-500">{p.after.passed ? "regression test passed" : "regression test still fails"}{p.after.objective ? ` · objective ${p.after.objective.aligned ? "verified" : "NOT verified"}` : ""}</span></> : <span className="text-slate-400">not executed yet</span>}</div>
          </div>
          {p.risks?.length > 0 && <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900"><b>Risks:</b> {p.risks.join("; ")}{p.requiresApprovalToApply ? " - explicit approval required before applying or publishing" : ""}</div>}
          {p.reasoning && <details><summary className="cursor-pointer text-slate-500">Agent reasoning</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border bg-white p-2">{p.reasoning}</pre></details>}
          {p.files?.length > 0 && <div className="text-slate-600"><b>Files:</b> {p.files.map((f: any) => `${f.path} (+${f.additions}/-${f.deletions})`).join(", ")}</div>}
          {p.diff ? <DiffView diff={p.diff} /> : <div className="text-slate-400">No diff available{p.status === "failed" ? " (the attempt failed and its worktree was cleaned up)" : ""}.</div>}
          {p.diffTruncated && <div className="text-slate-400">Diff truncated.</div>}
        </>
      )}
    </div>
  );
}

// B7: reviewable PR proposals. Publishing always needs an explicit approval bound to the exact
// repository, branches, commit and diff; PRs are drafts and are never merged by TestMind.
const PR_KIND_LABEL: Record<string, string> = { test_suite: "Generated tests", test_repair: "Repaired tests", app_fix: "Application fix" };
const PR_STATUS_TONE: Record<string, string> = {
  awaiting_approval: "awaitingApproval", approved: "running", publishing: "running", published: "succeeded", publish_failed: "failed",
  denied: "failed", expired: "unverified", stale: "unverified", canceled: "canceled", blocked: "blocked",
};
const VERIFICATION_TONE: Record<string, string> = { verified: "succeeded", passing: "succeeded", "partially passing": "partial", unverified: "unverified", failing: "failed", untested: "pending" };

function PrProposalsPanel({ runId, artifacts, codeFixes, apiFetch, onRefresh }: {
  runId: string; artifacts: Artifact[]; codeFixes: Artifact[]; apiFetch: ReturnType<typeof useApi>["apiFetch"]; onRefresh?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (key: string, path: string, body?: unknown) => {
    setBusy(key); setErr(null);
    try { await apiFetch(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(null); onRefresh?.(); }
  };
  const fixes = codeFixes.filter((a) => typeof a.meta?.devAgentRunId === "string");
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase text-slate-500">Pull request proposals · drafts only, never merged or deployed automatically</div>
      <div className="flex flex-wrap gap-2 text-xs">
        <button disabled={!!busy} onClick={() => act("p:test_suite", `/operator/qe/runs/${runId}/pr-proposals`, { kind: "test_suite" })} className="rounded border px-2 py-1 hover:bg-slate-50 disabled:opacity-50">Prepare generated-tests PR</button>
        <button disabled={!!busy} onClick={() => act("p:test_repair", `/operator/qe/runs/${runId}/pr-proposals`, { kind: "test_repair" })} className="rounded border px-2 py-1 hover:bg-slate-50 disabled:opacity-50">Prepare repaired-tests PR</button>
        {fixes.map((a) => (
          <button key={a.id} disabled={!!busy || a.proposal?.status !== "verified"} title={a.proposal?.status ? `Code-fix status: ${a.proposal.status}` : undefined}
            onClick={() => act(`p:${a.id}`, `/operator/qe/runs/${runId}/pr-proposals`, { kind: "app_fix", devAgentRunId: a.meta.devAgentRunId })}
            className="rounded border border-indigo-300 px-2 py-1 text-indigo-800 hover:bg-indigo-50 disabled:opacity-50">
            Prepare application-fix PR ({String(a.meta.testTitle ?? a.meta.devAgentRunId).slice(0, 40)}{a.proposal?.status ? ` · ${a.proposal.status}` : ""})
          </button>
        ))}
      </div>
      {err && <div className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-800">{err}</div>}
      {artifacts.length === 0 && <p className="text-xs text-slate-500">No PR proposals yet. Preparing one does not publish anything.</p>}
      {artifacts.map((a) => <PrProposalCard key={a.id} pr={a.pr} busy={busy} act={act} />)}
    </div>
  );
}

function PrProposalCard({ pr, busy, act }: { pr: any; busy: string | null; act: (key: string, path: string) => void }) {
  if (!pr) return <div className="rounded border px-2 py-1 text-xs text-slate-500">Proposal details unavailable.</div>;
  const b = pr.binding ?? {};
  const pending = pr.approval?.status === "pending" && pr.status === "awaiting_approval";
  const canPublish = pr.status === "approved" || pr.status === "publish_failed";
  const closed = ["published", "canceled"].includes(pr.status);
  return (
    <div className="space-y-2 rounded-md border border-sky-200 bg-sky-50/40 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold uppercase text-slate-600">{PR_KIND_LABEL[pr.kind] ?? pr.kind}</span>
        <Badge value={PR_STATUS_TONE[pr.status] ?? "pending"} />
        <span className="font-medium text-slate-700">{String(pr.status).replace(/_/g, " ")}</span>
        {pr.verification && <><Badge value={VERIFICATION_TONE[pr.verification.label] ?? "pending"} /><span className="text-slate-600">{pr.verification.label.toUpperCase()} - {pr.verification.detail}</span></>}
      </div>
      <div className="font-medium text-slate-800">{pr.title}</div>
      <div className="grid grid-cols-1 gap-1 rounded border bg-white p-2 font-mono text-[11px] text-slate-600 sm:grid-cols-2">
        <div>repository: {b.repo ?? "(no GitHub integration)"}</div>
        <div>branches: {b.headBranch} → {b.baseBranch}</div>
        <div>commit: {b.commitSha ? b.commitSha.slice(0, 12) : "files only"}</div>
        <div>diff: {String(b.diffHash ?? "").slice(0, 12)} · {b.fileCount} file(s)</div>
        <div className="sm:col-span-2">approval fingerprint: {String(pr.fingerprint ?? "").slice(0, 16)} · approval {pr.approval?.status ?? "none"}{pr.approval?.expiresAt ? ` (expires ${new Date(pr.approval.expiresAt).toLocaleString()})` : ""}</div>
      </div>
      {pr.blockedReason && <div className="rounded border border-orange-200 bg-orange-50 px-2 py-1 text-orange-900"><b>Cannot be published:</b> {pr.blockedReason}</div>}
      {pr.changesSinceApproval?.length > 0 && <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900"><b>Changed since approval:</b> {pr.changesSinceApproval.join("; ")} - refresh to request a new approval.</div>}
      {pr.prUrl && <div className="text-emerald-800">Draft PR opened: <a className="text-blue-600 hover:underline" href={pr.prUrl} target="_blank" rel="noreferrer">{pr.prUrl}</a> (not merged)</div>}
      {pr.error && <div className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-rose-800"><b>GitHub error:</b> {pr.error}</div>}
      {pr.objectives?.length > 0 && <div className="text-slate-600"><b>Objectives:</b><ul className="ml-4 list-disc">{pr.objectives.map((o: string, i: number) => <li key={i}>{o}</li>)}</ul></div>}
      {pr.evidence?.length > 0 && <div className="text-slate-600"><b>Evidence:</b><ul className="ml-4 list-disc">{pr.evidence.map((o: string, i: number) => <li key={i}>{o}</li>)}</ul></div>}
      <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900"><b>Remaining risks:</b> {pr.risks?.length ? pr.risks.join("; ") : "none identified - human review still required"}</div>
      {pr.files?.length > 0 && <div className="text-slate-600"><b>Files ({pr.files.length}):</b> {pr.files.map((f: any) => `${f.path} (${f.status})`).join(", ")}</div>}
      {pr.diff && <details><summary className="cursor-pointer text-slate-500">Diff</summary><DiffView diff={pr.diff} /></details>}
      <div className="flex flex-wrap gap-2">
        {pending && pr.approval?.id && <>
          <button disabled={!!busy} onClick={() => act(`a:${pr.id}`, `/operator/approvals/${pr.approval.id}/approve`)} className="rounded bg-violet-600 px-2 py-1 text-white disabled:opacity-50">Approve this exact change</button>
          <button disabled={!!busy} onClick={() => act(`d:${pr.id}`, `/operator/approvals/${pr.approval.id}/deny`)} className="rounded border border-violet-300 px-2 py-1 text-violet-800 disabled:opacity-50">Deny</button>
        </>}
        {canPublish && !pr.blockedReason && <button disabled={!!busy} onClick={() => act(`pub:${pr.id}`, `/operator/qe/pr-proposals/${pr.id}/publish`)} className="rounded bg-emerald-600 px-2 py-1 text-white disabled:opacity-50">{busy === `pub:${pr.id}` ? "Publishing…" : pr.status === "publish_failed" ? "Retry publishing draft PR" : "Publish draft PR"}</button>}
        {!closed && <button disabled={!!busy} onClick={() => act(`r:${pr.id}`, `/operator/qe/pr-proposals/${pr.id}/refresh`)} className="rounded border px-2 py-1 disabled:opacity-50">Refresh &amp; re-check</button>}
        {!closed && <button disabled={!!busy} onClick={() => act(`c:${pr.id}`, `/operator/qe/pr-proposals/${pr.id}/cancel`)} className="rounded border border-rose-300 px-2 py-1 text-rose-700 disabled:opacity-50">Cancel proposal</button>}
      </div>
      {pr.history?.length > 0 && <details><summary className="cursor-pointer text-slate-500">History ({pr.history.length})</summary><ul className="mt-1 space-y-0.5">{pr.history.map((h: any, i: number) => <li key={i} className="text-slate-600">{fmtTime(h.at)} · {h.event}{h.detail ? ` - ${h.detail}` : ""}</li>)}</ul></details>}
    </div>
  );
}

function FailureIntelPanel({ meta }: { meta: any }) {
  const decisions = new Map<string, any>((meta.decisions ?? []).map((d: any) => [d.testResultId, d]));
  return (
    <div className="space-y-2 text-xs">
      <div className="font-semibold uppercase text-slate-500">Failure intelligence <span className="font-normal normal-case text-slate-400">· {meta.summary}</span></div>
      <ul className="space-y-1.5">
        {(meta.investigations ?? []).map((inv: any) => {
          const d = decisions.get(inv.testResultId);
          return (
            <li key={inv.testResultId} className="rounded border p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge value={CATEGORY_TONE[inv.category] ?? "pending"} />
                <span className="font-medium text-slate-700">{CATEGORY_LABEL[inv.category] ?? inv.category}</span>
                <span className="text-slate-400">· {inv.cause.replace(/_/g, " ")} · {inv.confidence} confidence</span>
                {d && <span className={`ml-auto rounded px-1.5 py-0.5 ${d.action === "escalate" ? "bg-rose-50 text-rose-700" : d.action === "auto_repair" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{ACTION_LABEL[d.action] ?? d.action}</span>}
              </div>
              <div className="mt-1 text-slate-800">{inv.testTitle}</div>
              <div className="mt-0.5 text-slate-600">{inv.explanation}</div>
              {inv.objective && <div className="mt-0.5 text-slate-500">Objective (preserved): {inv.objective}</div>}
              <details className="mt-1"><summary className="cursor-pointer text-slate-400">Evidence ({inv.evidence.length})</summary>
                <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-slate-600">{inv.evidence.map((e: any, i: number) => <li key={i}>{e.kind}: {e.detail}</li>)}</ul>
                {meta.runId && <a className="mt-1 inline-block text-blue-600 hover:underline" href={`/test-runs/${meta.runId}`} target="_blank" rel="noreferrer">Open run - screenshots, traces, logs →</a>}
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function GenerationPanel({ meta }: { meta: any }) {
  return (
    <div className="space-y-2 text-xs">
      <div className="font-semibold uppercase text-slate-500">
        Scenario tests generated: {meta.tests?.length ?? 0} · not generated: {meta.notGenerated?.length ?? 0}
        <span className="ml-2 font-normal normal-case text-slate-400">{meta.hasCredentials ? "approved credentials referenced (values never stored)" : "no credentials - signed-in scenarios stay blocked"}</span>
      </div>
      <div className="max-h-56 overflow-auto rounded border">
        <table className="w-full"><tbody>
          {(meta.tests ?? []).map((t: any) => (
            <tr key={t.scenarioId} className="border-b last:border-0 align-top">
              <td className="px-2 py-1">{t.title}{t.criteria?.length ? <span className="ml-1 text-slate-400">({t.criteria.map((c: any) => c.criterionId).join(", ")})</span> : null}</td>
              <td className="px-2 py-1 font-mono text-slate-500">{t.file}</td>
              <td className="px-2 py-1 text-slate-500">{t.requiresAuth ? "signed-in" : "signed-out"}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      {meta.notGenerated?.length > 0 && (
        <details><summary className="cursor-pointer text-slate-500">Not generated - reported, never fabricated ({meta.notGenerated.length})</summary>
          <ul className="mt-1 space-y-0.5">{meta.notGenerated.map((n: any) => <li key={n.scenarioId}><span className="text-slate-700">{n.title}</span> - <span className="text-amber-700">{n.reason}</span></li>)}</ul>
        </details>
      )}
    </div>
  );
}

function ScenarioOutcomes({ meta }: { meta: any }) {
  const rows: any[] = meta.scenarioOutcomes ?? [];
  const tone = (st: string) => (st === "passed" ? "passed" : st === "not_run" ? "skipped" : st === "skipped" ? "skipped" : "failed");
  return (
    <div className="text-xs">
      <div className="mb-1 font-semibold uppercase text-slate-500">Scenario outcomes ({meta.phase === "full-suite-verification" ? "re-verification" : "initial run"})</div>
      <div className="max-h-56 overflow-auto rounded border">
        <table className="w-full"><tbody>
          {rows.map((r) => (
            <tr key={r.scenarioId} className="border-b last:border-0 align-top">
              <td className="px-2 py-1"><Badge value={tone(r.status)} /> <span className="text-slate-400">{r.status === "not_run" ? "not run" : ""}</span></td>
              <td className="px-2 py-1">{r.title}{r.message && r.status !== "passed" && <div className="mt-0.5 line-clamp-2 font-mono text-[11px] text-rose-700">{r.message}</div>}</td>
            </tr>
          ))}
          {(meta.blockedScenarios ?? []).map((b: any) => (
            <tr key={`b${b.scenarioId}`} className="border-b last:border-0 align-top"><td className="px-2 py-1"><Badge value="blocked" /></td><td className="px-2 py-1 text-slate-500">{b.title} - {b.reason}</td></tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}

function RecommendationList({ title, items, muted }: { title: string; items: any[]; muted?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase text-slate-500">{title}</div>
      <ul className={`space-y-1 text-xs ${muted ? "text-slate-500" : "text-slate-700"}`}>
        {items.map((r) => (
          <li key={r.id} className="rounded border px-2 py-1">
            <span className="mr-1 rounded bg-slate-100 px-1 py-0.5 text-[11px]">{!muted ? `P${r.priority} · ` : ""}{KIND_LABEL[r.kind] ?? r.kind}</span>
            <span className="font-mono">{r.target}</span> - {r.reason}
            {r.evidence?.[0]?.observedAt && <span className="ml-1 text-slate-400">({r.evidence[0].source}, {new Date(r.evidence[0].observedAt).toLocaleString()})</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function KnowledgePanel({ meta }: { meta: any }) {
  const pages: any[] = meta?.observed?.pages ?? [];
  const apis: any[] = meta?.observed?.apis ?? [];
  const story = meta?.story;
  const cov = meta?.coverage;
  return (
    <div className="space-y-3 rounded-md border border-blue-100 bg-blue-50/40 p-2">
      <div className="text-xs font-semibold uppercase text-slate-600">What the agent learned · observed {meta?.observedAt ? new Date(meta.observedAt).toLocaleString() : ""}</div>
      {cov && (
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div className="rounded border bg-white p-2"><div className="text-slate-500">Pages known</div><div className="font-semibold">{cov.pages.observed} · {cov.pages.covered} with tests</div></div>
          <div className="rounded border bg-white p-2"><div className="text-slate-500">Auth / redirected / unreachable</div><div className="font-semibold">{cov.pages.authRequired} / {cov.pages.redirected ?? 0} / {cov.pages.unreachable}</div></div>
          <div className="rounded border bg-white p-2"><div className="text-slate-500">APIs observed</div><div className="font-semibold">{cov.apis.observed} · {cov.apis.covered} with tests</div></div>
          <div className="rounded border bg-white p-2"><div className="text-slate-500">Failing tests (history)</div><div className="font-semibold">{cov.history.failingTests}</div></div>
        </div>
      )}
      <div>
        <div className="mb-1 text-xs font-semibold text-slate-600">Pages observed this run <span className="font-normal text-slate-400">(source: crawl)</span></div>
        <div className="max-h-56 overflow-auto rounded border bg-white">
          <table className="w-full text-xs"><tbody>
            {pages.map((p) => (
              <tr key={p.route} className="border-b align-top last:border-0">
                <td className="px-2 py-1 font-mono">{p.route}</td>
                <td className="px-2 py-1"><Badge value={ACCESS_TONE[p.access?.state] ?? "pending"} /> <span className="ml-1 text-slate-500">{p.access?.state?.replace("_", " ")}</span>{p.access?.finalRoute && <span className="text-slate-400"> → {p.access.finalRoute}</span>}</td>
                <td className="px-2 py-1 text-slate-600">{[...(p.headings ?? []).slice(0, 2), ...(p.actions ?? []).slice(0, 5)].join(" · ")}{p.fields?.length ? ` · fields: ${p.fields.join(", ")}` : ""}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      </div>
      <div>
        <div className="mb-1 text-xs font-semibold text-slate-600">API calls observed <span className="font-normal text-slate-400">(captured from the app's own traffic; bodies/headers never stored)</span></div>
        {apis.length === 0 ? <p className="text-xs text-slate-500">No first-party API calls observed on the crawled pages.</p> : (
          <ul className="space-y-0.5 text-xs">
            {apis.map((a) => <li key={a.key} className="font-mono">{a.key} <span className="text-slate-500">→ {(a.statuses ?? []).join("/")} on {(a.observedOnRoutes ?? []).join(", ")}</span></li>)}
          </ul>
        )}
        {meta?.observed?.thirdPartyHosts?.length > 0 && <p className="mt-1 text-xs text-slate-400">Third-party hosts contacted (not modeled): {meta.observed.thirdPartyHosts.join(", ")}</p>}
      </div>
      {story && (
        <div>
          <div className="mb-1 text-xs font-semibold text-slate-600">User story → observed evidence <span className="font-normal text-slate-400">(expected behavior; elements seen ≠ behavior verified)</span></div>
          <ul className="space-y-1 text-xs">
            {story.criteria.map((c: any) => (
              <li key={c.id} className="rounded border bg-white px-2 py-1">
                <Badge value={c.status === "elements_observed" ? "succeeded" : "unverified"} /> <span className="ml-1">{c.text}</span>
                <div className="mt-0.5 text-slate-500">{c.evidence?.length ? c.evidence.map((e: any) => `${e.routeHint}: ${e.matched.join(", ")}`).join(" | ") : "No matching element on any discovered page"}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RepositoryPanel({ meta }: { meta: any }) {
  return (
    <div className="rounded-md border bg-slate-50 p-2 text-xs text-slate-700">
      <div className="mb-1 font-semibold uppercase text-slate-500">Repository {meta?.repo} <span className="font-normal normal-case text-slate-400">(declared in source - not runtime observations)</span></div>
      <div>{meta?.uiRouteCount ?? 0} UI route(s) · {meta?.apiRouteCount ?? 0} API route(s) · {meta?.testFileCount ?? 0} existing test file(s){meta?.truncated ? " · inspection truncated" : ""}</div>
      <details className="mt-1"><summary className="cursor-pointer text-slate-500">Declared routes</summary>
        <div className="mt-1 max-h-48 overflow-auto font-mono">
          {(meta?.uiRoutes ?? []).map((r: any) => <div key={`ui${r.path}`}>UI {r.path} <span className="text-slate-400">{r.file}</span></div>)}
          {(meta?.apiRoutes ?? []).map((r: any) => <div key={`api${r.method}${r.path}`}>{r.method} {r.path} <span className="text-slate-400">{r.file}</span></div>)}
        </div>
      </details>
    </div>
  );
}

function StageBody({ stage, runId, testRuns, apiFetch, onRefresh, repairStage }: { stage: StageView; runId: string; testRuns: TestRunView[]; apiFetch: ReturnType<typeof useApi>["apiFetch"]; onRefresh?: () => void; repairStage?: StageView }) {
  const specs = stage.artifacts.filter((a) => a.type === "spec");
  const plan = stage.artifacts.find((a) => a.type === "plan");
  const discovery = stage.stage === "discovery" ? stage.artifacts.find((a) => a.type === "report" && !a.meta?.kind) : undefined;
  const knowledge = stage.stage === "discovery" ? stage.artifacts.find((a) => a.type === "report" && a.meta?.kind === "knowledge") : undefined;
  const repository = stage.stage === "discovery" ? stage.artifacts.find((a) => a.type === "report" && a.meta?.kind === "repository") : undefined;
  const generation = stage.stage === "generate" ? stage.artifacts.find((a) => a.type === "report" && a.meta?.kind === "qe-generation") : undefined;
  const intel = stage.stage === "repair" ? stage.artifacts.filter((a) => a.type === "report" && a.meta?.kind === "failure-intel") : [];
  const proposals = stage.stage === "repair" ? stage.artifacts.filter((a) => a.type === "pr_proposal" && a.meta?.kind !== "pr") : [];
  const prProposals = stage.stage === "review" ? stage.artifacts.filter((a) => a.type === "pr_proposal" && a.meta?.kind === "pr") : [];
  const codeFixes = stage.stage === "review" ? (repairStage?.artifacts ?? []).filter((a) => a.type === "pr_proposal" && a.meta?.kind !== "pr") : [];
  const execResults = stage.artifacts.filter((a) => a.type === "execution_result");
  const repairs = stage.artifacts.filter((a) => a.type === "repair_attempt");
  const review = stage.stage === "review" ? stage.artifacts.find((a) => a.type === "report") : undefined;
  const [specId, setSpecId] = useState<string | null>(null);
  const [specText, setSpecText] = useState<string>("");
  const stageRunIds = useMemo(() => new Set([...stage.tasks.map((t) => t.testRunId), ...execResults.map((a) => a.testRunId)].filter(Boolean) as string[]), [stage, execResults]);

  useEffect(() => {
    if (!specId) return;
    setSpecText("Loading…");
    apiFetch<string>(`/operator/qe/runs/${runId}/artifacts/${specId}/content`).then((t) => setSpecText(typeof t === "string" ? t : JSON.stringify(t, null, 2))).catch((e) => setSpecText(`Could not load spec: ${e}`));
  }, [specId, runId, apiFetch]);

  const empty = !specs.length && !plan && !discovery && !knowledge && !repository && !execResults.length && !repairs.length && !review && !stage.tasks.length;
  return (
    <div className="space-y-3 border-t px-3 py-3 text-sm">
      {stage.reason && <p className="text-slate-700">{stage.reason}</p>}
      {stage.checkpointSavedAt && <p className="text-xs text-slate-400">Checkpoint saved {fmtTime(stage.checkpointSavedAt)}</p>}
      {empty && !stage.reason && <p className="text-slate-500">Nothing recorded for this stage yet.</p>}

      {discovery && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Discovered routes</div>
          <div className="max-h-48 overflow-auto rounded border">
            <table className="w-full text-xs"><tbody>
              {(discovery.meta?.routes ?? []).map((r: any) => (
                <tr key={r.route} className="border-b last:border-0"><td className="px-2 py-1 font-mono">{r.route}</td><td className="px-2 py-1">{r.status}</td><td className="px-2 py-1">{r.reachable ? "reachable" : "unreachable"}</td><td className="px-2 py-1 text-slate-500">{(discovery.meta?.uncoveredRoutes ?? []).includes(r.route) ? "not yet covered" : ""}</td></tr>
              ))}
            </tbody></table>
          </div>
        </div>
      )}

      {repository && <RepositoryPanel meta={repository.meta} />}
      {generation && <GenerationPanel meta={generation.meta} />}
      {intel.map((a) => <FailureIntelPanel key={a.id} meta={a.meta} />)}
      {proposals.map((a) => <CodeFixProposal key={a.id} meta={a.meta} proposal={a.proposal} />)}
      {knowledge && <KnowledgePanel meta={knowledge.meta} />}

      {plan && (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-slate-500">
              Test plan · {plan.meta?.caseCount ?? 0} case(s) · {plan.meta?.pageCount ?? 0} page(s)
              {plan.meta?.newCaseCount != null && <> · {plan.meta.newCaseCount} new · {plan.meta.existingCaseCount} already exist</>}
            </div>
            <div className="max-h-64 overflow-auto rounded border">
              <table className="w-full text-xs"><tbody>
                {(plan.meta?.cases ?? []).map((c: any, i: number) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="px-2 py-1 font-mono text-slate-500">{c.page}</td>
                    <td className="px-2 py-1">{c.title}</td>
                    <td className="px-2 py-1 text-right">{c.existing === true ? <span className="text-slate-500">existing{c.lastResult ? ` · last ${c.lastResult}` : ""}</span> : c.existing === false ? <Badge value="succeeded" /> : null}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
            {(plan.meta?.caseCount ?? 0) > (plan.meta?.cases?.length ?? 0) && <p className="mt-1 text-xs text-slate-500">Showing first {plan.meta.cases.length}.</p>}
          </div>
          {plan.meta?.qePlan && <ScenarioPlan plan={plan.meta.qePlan} />}
          {plan.meta?.nextTests?.length > 0 && <RecommendationList title="What to test next (from observed facts and history)" items={plan.meta.nextTests} />}
          {plan.meta?.blocked?.length > 0 && <RecommendationList title="Blocked or unverifiable - not planned as tests" items={plan.meta.blocked} muted />}
        </div>
      )}

      {specs.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase text-slate-500">Generated specs ({specs.length}) - saved to the project's generated suite</div>
          <div className="flex flex-wrap gap-1">
            {specs.map((a) => (
              <button key={a.id} onClick={() => setSpecId(a.id)} className={`rounded border px-2 py-1 font-mono text-xs ${specId === a.id ? "border-blue-500 bg-blue-50" : "hover:bg-slate-50"}`}>
                {a.meta?.file ?? a.id}{a.meta?.writtenThisRun ? "" : " (existing)"}
              </button>
            ))}
          </div>
          {specId && (
            <div className="overflow-hidden rounded border">
              <Editor height="380px" language="typescript" theme="vs-dark" value={specText} beforeMount={configureSpecEditor}
                options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, wordWrap: "on" }} />
            </div>
          )}
        </div>
      )}

      {execResults.filter((a) => a.meta?.scenarioOutcomes?.length || a.meta?.blockedScenarios?.length).map((a) => <ScenarioOutcomes key={`so${a.id}`} meta={a.meta} />)}
      {execResults.map((a) => (
        <div key={a.id} className="rounded border bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
          <b>{a.meta?.phase === "full-suite-verification" ? "Full-suite re-verification" : "Initial execution"}</b>:{" "}
          {a.meta?.summary ? `${a.meta.summary.passed}/${a.meta.summary.total} passed, ${a.meta.summary.failed} failed, ${a.meta.summary.errors} errored, ${a.meta.summary.skipped} skipped` : "no summary"}
          {a.testRunId && <a className="ml-2 text-blue-600 hover:underline" href={`/test-runs/${a.testRunId}`} target="_blank" rel="noreferrer">Open run (screenshots, traces, logs) →</a>}
        </div>
      ))}

      {testRuns.filter((r) => stageRunIds.has(r.id)).map((r) => (
        <div key={r.id}>
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase text-slate-500">Per-test results <Badge value={r.status} /> <span className="font-mono normal-case text-slate-400">{r.id}</span></div>
          {r.results.length === 0 ? (
            <p className="text-xs text-slate-500">{r.status === "queued" || r.status === "running" ? "Running…" : `No per-test results recorded${r.error ? `: ${r.error}` : ""}.`}</p>
          ) : (
            <div className="max-h-64 overflow-auto rounded border">
              <table className="w-full text-xs"><tbody>
                {r.results.map((x) => (
                  <tr key={x.id} className="border-b align-top last:border-0">
                    <td className="px-2 py-1"><Badge value={x.status} /></td>
                    <td className="px-2 py-1">{x.title}{x.message && x.status !== "passed" && <div className="mt-0.5 line-clamp-3 font-mono text-[11px] text-rose-700">{x.message}</div>}</td>
                    <td className="px-2 py-1 text-right text-slate-400">{x.durationMs != null ? `${(x.durationMs / 1000).toFixed(1)}s` : ""}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}
        </div>
      ))}

      {repairs.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Repair attempts ({repairs.length})</div>
          <ul className="space-y-1 text-xs">
            {repairs.map((a) => {
              // A repair only counts as succeeded when its verification rerun passed.
              const repairFailed = a.meta?.output?.finalStatus === "repair_failed" || String(a.meta?.error ?? "").startsWith("repair_failed:");
              return (
                <li key={a.id} className="rounded border px-2 py-1">
                  {repairFailed ? <span className="inline-block rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-700">repair failed</span> : <Badge value={a.meta?.status === "succeeded" ? "succeeded" : a.meta?.status === "skipped" ? "skipped" : "failed"} />}
                  <span className="ml-1">{a.meta?.input?.testTitle ?? a.meta?.taskId}</span>
                  {repairFailed && <span className="ml-1 text-slate-500">- patch applied but the verification rerun did not pass</span>}
                  {a.meta?.error && <div className="mt-0.5 text-rose-700">{a.meta.error}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {review && (
        <div className="rounded border bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
          {review.meta?.testRuns?.length ?? 0} test run(s) · {review.meta?.repairAttempts ?? 0} repair attempt(s).
        </div>
      )}
      {stage.stage === "review" && <PrProposalsPanel runId={runId} artifacts={prProposals} codeFixes={codeFixes} apiFetch={apiFetch} onRefresh={onRefresh} />}

      {stage.tasks.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-500">Pipeline steps ({stage.tasks.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {stage.tasks.map((t) => (
              <li key={t.id} className="flex items-center gap-2"><Badge value={t.status} /> <span>{t.type}{t.phase ? ` · ${t.phase}` : ""}</span>{t.error && <span className="truncate text-rose-700">{t.error}</span>}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
