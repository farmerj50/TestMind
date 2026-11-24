// Autonomous Development Mode (Stage F). The message-bubble/input-box UX here is modeled on
// CopilotPanel.tsx's presentational pattern, not imported directly - CopilotPanel is tightly
// coupled to CopilotContext's in-memory, route-aware quick-action state, which doesn't fit a
// page backed by real persisted DevAgentMessage rows. Polling is modeled on
// AgentSessionDetailPage.tsx's existing 4s-interval approach.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import DevAgentRunInspector, { type InspectorIteration } from "../components/devAgent/DevAgentRunInspector";
import { useApi } from "../lib/api";

type Project = { id: string; name: string };

type DevAgentMode = "assigned" | "selfImprovement" | "both";

type DevAgentRun = {
  id: string;
  projectId: string;
  mode: DevAgentMode;
  targetRepo: string;
  instructionText: string | null;
  status: string;
  budgetUsd: number | null;
  spentUsd: number;
  maxIterations: number;
  testCommand: string | null;
  baseUrl: string | null;
  environmentId: string | null;
  scheduledStartAt: string | null;
  timezone: string | null;
  prUrl: string | null;
  error?: string | null;
  createdAt: string;
};

type Environment = { id: string; name: string; baseUrl: string };

type DevAgentMessage = { id: string; role: string; content: string; createdAt: string };

type DevAgentIterationSummary = InspectorIteration;

type DevAgentSummary = {
  status: string;
  iterationCount: number;
  filesChanged: string[];
  latestTestResult: { passed?: boolean; output?: string } | null;
  spentUsd: number;
  budgetUsd: number | null;
  prUrl: string | null;
  awaitingReview: boolean;
  iterations: DevAgentIterationSummary[];
};

const IN_FLIGHT_STATUSES = new Set(["queued", "running", "paused", "awaitingApproval"]);
const detectedTimezone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; }
})();

function Bubble({ message }: { message: DevAgentMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={
          "max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap " +
          (isUser ? "bg-[color:var(--tm-accent)] text-white" : "bg-slate-100 dark:bg-white/10")
        }
      >
        {message.content}
      </div>
    </div>
  );
}

export default function DevAgentPage() {
  const { apiFetch } = useApi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [runs, setRuns] = useState<DevAgentRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [run, setRun] = useState<DevAgentRun | null>(null);
  const [messages, setMessages] = useState<DevAgentMessage[]>([]);
  const [summary, setSummary] = useState<DevAgentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New-run form state
  const [mode, setMode] = useState<DevAgentMode>("assigned");
  const [targetRepo, setTargetRepo] = useState("testmind");
  const [confirmExternalRepo, setConfirmExternalRepo] = useState(false);
  const [instructionText, setInstructionText] = useState("");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [maxIterations, setMaxIterations] = useState("5");
  const [testCommand, setTestCommand] = useState("");
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [scheduledStartAt, setScheduledStartAt] = useState("");
  const [timezone, setTimezone] = useState(detectedTimezone);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    apiFetch<{ projects: Project[] }>("/projects")
      .then((d) => { setProjects(d.projects); if (d.projects[0]) setProjectId(d.projects[0].id); })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!projectId) return;
    apiFetch<{ environments: Environment[] }>(`/environments?projectId=${projectId}`)
      .then((res) => {
        setEnvironments(res.environments ?? []);
        setEnvironmentId("");
        setBaseUrl("");
      })
      .catch(() => {});
  }, [projectId]);

  function loadRuns(silent = false) {
    if (!projectId) return;
    apiFetch<{ runs: DevAgentRun[] }>(`/dev-agent/runs?projectId=${projectId}`)
      .then((d) => setRuns(d.runs))
      .catch((e) => { if (!silent) setError(String(e)); });
  }
  useEffect(() => { loadRuns(); setSelectedRunId(null); }, [projectId]);
  useEffect(() => {
    const t = setInterval(() => loadRuns(true), 4000);
    return () => clearInterval(t);
  }, [projectId]);

  function loadRunDetail(silent = false) {
    if (!selectedRunId) return;
    apiFetch<{ run: DevAgentRun }>(`/dev-agent/runs/${selectedRunId}`).then((d) => setRun(d.run)).catch((e) => { if (!silent) setError(String(e)); });
    apiFetch<{ messages: DevAgentMessage[] }>(`/dev-agent/runs/${selectedRunId}/messages`).then((d) => setMessages(d.messages)).catch(() => {});
    apiFetch<{ summary: DevAgentSummary }>(`/dev-agent/runs/${selectedRunId}/summary`).then((d) => setSummary(d.summary)).catch(() => {});
  }
  useEffect(() => { loadRunDetail(); }, [selectedRunId]);
  useEffect(() => {
    if (!selectedRunId || !run || !IN_FLIGHT_STATUSES.has(run.status)) return;
    const t = setInterval(() => loadRunDetail(true), 4000);
    return () => clearInterval(t);
  }, [selectedRunId, run?.status]);

  async function createRun() {
    setError(null);
    try {
      const body: Record<string, unknown> = {
        projectId, mode, targetRepo, confirmExternalRepo,
        instructionText: instructionText || undefined,
        budgetUsd: budgetUsd ? Number(budgetUsd) : undefined,
        maxIterations: maxIterations ? Number(maxIterations) : undefined,
        testCommand: testCommand || undefined,
        baseUrl: baseUrl.trim() || undefined,
        environmentId: environmentId || undefined,
        timezone: timezone || undefined,
      };
      if (scheduledStartAt) body.scheduledStartAt = new Date(scheduledStartAt).toISOString();
      const data = await apiFetch<{ run: DevAgentRun }>("/dev-agent/runs", { method: "POST", body: JSON.stringify(body) });
      setInstructionText("");
      loadRuns();
      setSelectedRunId(data.run.id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function sendMessage() {
    const content = textareaRef.current?.value.trim();
    if (!content || !selectedRunId) return;
    textareaRef.current!.value = "";
    try {
      await apiFetch(`/dev-agent/runs/${selectedRunId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
      loadRunDetail(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function control(action: "pause" | "resume" | "stop" | "emergency-stop") {
    if (!selectedRunId) return;
    try {
      await apiFetch(`/dev-agent/runs/${selectedRunId}/${action}`, { method: "POST" });
      loadRunDetail(true);
    } catch (e) {
      setError(String(e));
    }
  }

  async function publishPr() {
    if (!selectedRunId) return;
    try {
      const d = await apiFetch<{ prUrl: string }>(`/dev-agent/runs/${selectedRunId}/publish-pr`, { method: "POST" });
      setRun((r) => (r ? { ...r, prUrl: d.prUrl } : r));
    } catch (e) {
      setError(String(e));
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 p-4">
      <div className="lg:col-span-1 space-y-4">
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide tm-nav-section">Project</label>
          <select className="w-full border rounded-md px-2 py-1.5 text-sm" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <div className="border rounded-md p-3 space-y-2">
          <div className="text-sm font-semibold">New run</div>
          <div className="flex gap-3 text-sm">
            {(["assigned", "selfImprovement", "both"] as DevAgentMode[]).map((m) => (
              <label key={m} className="flex items-center gap-1">
                <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} /> {m}
              </label>
            ))}
          </div>
          <textarea
            className="w-full border rounded-md px-2 py-1.5 text-sm"
            rows={3}
            placeholder="What should TestMind build, fix, test, or improve?"
            value={instructionText}
            onChange={(e) => setInstructionText(e.target.value)}
          />
          <div className="flex items-center gap-2 text-sm">
            <input className="border rounded-md px-2 py-1 w-40" placeholder="testmind" value={targetRepo} onChange={(e) => setTargetRepo(e.target.value)} />
            {targetRepo !== "testmind" && (
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={confirmExternalRepo} onChange={(e) => setConfirmExternalRepo(e.target.checked)} /> I authorize access to this external repo
              </label>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <input className="border rounded-md px-2 py-1" placeholder="Budget (USD)" value={budgetUsd} onChange={(e) => setBudgetUsd(e.target.value)} />
            <input className="border rounded-md px-2 py-1" placeholder="Max iterations" value={maxIterations} onChange={(e) => setMaxIterations(e.target.value)} />
          </div>
          <input className="w-full border rounded-md px-2 py-1 text-sm" placeholder="Test command (e.g. npm test)" value={testCommand} onChange={(e) => setTestCommand(e.target.value)} />
          <div className="grid grid-cols-2 gap-2 text-sm">
            <select
              className="border rounded-md px-2 py-1"
              value={environmentId}
              onChange={(e) => {
                const id = e.target.value;
                setEnvironmentId(id);
                const env = environments.find((x) => x.id === id);
                if (env) setBaseUrl(env.baseUrl);
              }}
            >
              <option value="">No environment</option>
              {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <input
              className="border rounded-md px-2 py-1"
              placeholder="Base URL (optional, for site-aware runs)"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <input type="datetime-local" className="border rounded-md px-2 py-1" value={scheduledStartAt} onChange={(e) => setScheduledStartAt(e.target.value)} />
            <input className="border rounded-md px-2 py-1" placeholder="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </div>
          <button className="w-full rounded-md bg-[color:var(--tm-accent)] text-white py-1.5 text-sm" onClick={createRun} disabled={!projectId}>
            {scheduledStartAt ? "Schedule run" : "Start run"}
          </button>
        </div>

        <div className="border rounded-md p-3">
          <div className="text-sm font-semibold mb-2">Runs</div>
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {runs.map((r) => (
              <button
                key={r.id}
                className={"w-full text-left px-2 py-1.5 rounded-md text-sm " + (r.id === selectedRunId ? "bg-[color:var(--tm-accent-soft)]" : "hover:bg-slate-100 dark:hover:bg-white/10")}
                onClick={() => setSelectedRunId(r.id)}
              >
                <div className="flex justify-between"><span>{r.mode}</span><span className="text-xs opacity-70">{r.status}</span></div>
                <div className="text-xs opacity-70 truncate">{r.instructionText ?? "(self-improvement)"}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="lg:col-span-1 border rounded-md flex flex-col h-[70vh]">
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {messages.map((m) => <Bubble key={m.id} message={m} />)}
        </div>
        <div className="border-t p-2 flex gap-2">
          <textarea ref={textareaRef} className="flex-1 border rounded-md px-2 py-1.5 text-sm" rows={1} placeholder="Send a follow-up instruction..." onKeyDown={handleKeyDown} disabled={!selectedRunId} />
          <button className="rounded-md bg-[color:var(--tm-accent)] text-white px-3 text-sm" onClick={sendMessage} disabled={!selectedRunId}>Send</button>
        </div>
      </div>

      <div className="lg:col-span-1 space-y-3">
        {run && (
          <div className="border rounded-md p-3 space-y-2">
            <div className="flex justify-between items-center">
              <div className="text-sm font-semibold">
                Status: {run.status}
                {run.status === "unverified" && (
                  <span className="ml-2 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-xs font-normal text-amber-800">
                    {run.error ? "Not verified" : "No test command was run — results are unverified"}
                  </span>
                )}
                {run.status === "unverified" && run.error && (
                  <div className="mt-1 text-xs font-normal text-amber-800">{run.error}</div>
                )}
              </div>
              <div className="flex gap-1">
                {run.status === "running" && <button className="text-xs border rounded px-2 py-1" onClick={() => control("pause")}>Pause</button>}
                {run.status === "paused" && <button className="text-xs border rounded px-2 py-1" onClick={() => control("resume")}>Resume</button>}
                {IN_FLIGHT_STATUSES.has(run.status) && <button className="text-xs border rounded px-2 py-1" onClick={() => control("stop")}>Stop</button>}
                {IN_FLIGHT_STATUSES.has(run.status) && <button className="text-xs border rounded px-2 py-1 text-red-600" onClick={() => control("emergency-stop")}>Emergency Stop</button>}
              </div>
            </div>
            {summary && (
              <>
                <div className="text-sm">Iterations: {summary.iterationCount}</div>
                <div className="text-sm">Cost: ${summary.spentUsd.toFixed(2)}{summary.budgetUsd ? ` / $${summary.budgetUsd.toFixed(2)}` : ""}</div>
                <div className="text-sm">Files changed: {summary.filesChanged.length ? summary.filesChanged.join(", ") : "none yet"}</div>
                {summary.latestTestResult && (
                  <div className="text-sm">Latest test: {summary.latestTestResult.passed ? "passed" : "failed"}</div>
                )}
                {summary.prUrl ? (
                  <a className="text-sm underline text-[color:var(--tm-accent)]" href={summary.prUrl} target="_blank" rel="noreferrer">Review PR (never auto-merged)</a>
                ) : run.status === "succeeded" ? (
                  <button className="text-xs border rounded px-2 py-1" onClick={publishPr}>Publish PR for review</button>
                ) : null}
                <div className="text-xs opacity-70">Generated tests, revisions and execution output are in the inspector below.</div>
              </>
            )}
          </div>
        )}
        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>

      {run && summary && (
        <div className="lg:col-span-3 border rounded-md p-3">
          <div className="mb-2 text-sm font-semibold">Generated tests &amp; execution</div>
          <DevAgentRunInspector iterations={summary.iterations} runStatus={run.status} runError={run.error} />
        </div>
      )}
    </div>
  );
}
