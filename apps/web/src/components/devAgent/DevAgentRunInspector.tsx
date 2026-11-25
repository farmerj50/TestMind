import { useEffect, useMemo, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { configureSpecEditor } from "../../lib/monaco-spec-config";

// Read-only inspector for a Dev Agent run: every iteration, every file the agent wrote
// (full content, and a diff against that file's previous revision), what each test
// actually asserts, whether that still matches the instruction, and the full execution
// output. All data comes from the run summary the page already loads - no extra calls.

type FileChange = { path: string; content?: string };
type Target = { text: string; negated: boolean };
export type InspectorIteration = {
  iterationNumber: number;
  phase: string;
  summary: string | null;
  filesChanged: unknown;
  testResult: {
    passed?: boolean;
    output?: string;
    objectiveTargets?: Target[];
    objective?: { aligned: boolean; reason: string };
    /** The actual test error extracted from the output (failed executions only). */
    failureSummary?: string;
    /** Individual test results of this execution. */
    tests?: Array<{ title: string; file: string | null; status: string }>;
    /** Where this iteration's generated tests were saved in Suites. */
    savedSpecs?: string[];
  } | null;
  costUsd: number;
  createdAt: string;
};

const asChanges = (value: unknown): FileChange[] =>
  Array.isArray(value) ? value.filter((f): f is FileChange => !!f && typeof f === "object" && typeof (f as any).path === "string") : [];

const languageFor = (p: string) => (/\.tsx?$/.test(p) ? "typescript" : /\.[cm]?jsx?$/.test(p) ? "javascript" : /\.json$/.test(p) ? "json" : /\.py$/.test(p) ? "python" : "plaintext");
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
const editorOptions = { readOnly: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, wordWrap: "on" as const };

function Badge({ tone, children }: { tone: "ok" | "bad" | "warn" | "muted"; children: React.ReactNode }) {
  const cls = {
    ok: "bg-emerald-100 text-emerald-800",
    bad: "bg-red-100 text-red-800",
    warn: "bg-amber-100 text-amber-800",
    muted: "bg-slate-200 text-slate-700",
  }[tone];
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${cls}`}>{children}</span>;
}

export default function DevAgentRunInspector({ iterations, runStatus, runError }: { iterations: InspectorIteration[]; runStatus: string; runError?: string | null }) {
  const [selectedIter, setSelectedIter] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  // Follow the newest iteration until the user picks one.
  const latest = iterations[iterations.length - 1]?.iterationNumber ?? null;
  const activeIterNum = selectedIter ?? latest;
  const active = iterations.find((it) => it.iterationNumber === activeIterNum) ?? null;
  const files = useMemo(() => asChanges(active?.filesChanged), [active]);

  useEffect(() => {
    if (!files.length) { setSelectedFile(null); return; }
    if (!selectedFile || !files.some((f) => f.path === selectedFile)) setSelectedFile(files[0].path);
  }, [files, selectedFile]);

  const file = files.find((f) => f.path === selectedFile) ?? null;
  // Previous revision = the same path in the most recent earlier iteration that touched it.
  const previous = useMemo(() => {
    if (!active || !file) return null;
    for (const it of [...iterations].reverse()) {
      if (it.iterationNumber >= active.iterationNumber) continue;
      const hit = asChanges(it.filesChanged).find((f) => f.path === file.path);
      if (hit) return { iterationNumber: it.iterationNumber, content: hit.content ?? "" };
    }
    return null;
  }, [iterations, active, file]);

  if (!iterations.length) {
    return <div className="text-sm opacity-70">No iterations yet - generated tests will appear here as the agent writes them.</div>;
  }

  const tr = active?.testResult ?? null;
  const output = tr?.output ? stripAnsi(tr.output) : "";
  const blocked = output.startsWith("Blocked by agent:");
  const notExecuted = output.startsWith("No test command configured");

  return (
    <div className="space-y-3">
      {runStatus === "unverified" && runError && (
        <div className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">{runError}</div>
      )}
      {runStatus === "partial" && runError && (
        <div className="whitespace-pre-wrap rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">{runError}</div>
      )}
      {runStatus === "failed" && runError && (
        <div className="whitespace-pre-wrap rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">{runError}</div>
      )}

      {/* Iteration timeline */}
      <div className="flex flex-wrap gap-2">
        {iterations.map((it) => {
          const r = it.testResult;
          const o = r?.output ?? "";
          const tone = o.startsWith("Blocked by agent:") ? "warn" : o.startsWith("No test command") ? "muted" : r?.passed ? (r.objective && !r.objective.aligned ? "warn" : "ok") : "bad";
          const label = o.startsWith("Blocked by agent:") ? "blocked" : o.startsWith("No test command") ? "not executed" : r?.passed ? (r.objective && !r.objective.aligned ? "passed, objective not met" : "passed") : "failed";
          return (
            <button
              key={it.iterationNumber}
              onClick={() => { setSelectedIter(it.iterationNumber); setShowDiff(false); }}
              className={`rounded border px-2 py-1 text-left text-xs ${it.iterationNumber === activeIterNum ? "border-[color:var(--tm-accent)] ring-1 ring-[color:var(--tm-accent)]" : ""}`}
            >
              <div className="font-semibold">Iteration {it.iterationNumber}</div>
              <Badge tone={tone as any}>{label}</Badge>
            </button>
          );
        })}
      </div>

      {active && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
          {/* Files + assertions + objective */}
          <div className="space-y-3 lg:col-span-1">
            <div>
              <div className="mb-1 text-xs font-semibold uppercase opacity-70">Files written</div>
              {files.length ? (
                <ul className="space-y-1">
                  {files.map((f) => (
                    <li key={f.path}>
                      <button
                        onClick={() => { setSelectedFile(f.path); setShowDiff(false); }}
                        className={`w-full break-all rounded px-1.5 py-1 text-left text-xs ${f.path === selectedFile ? "bg-[color:var(--tm-accent)]/15 font-semibold" : "hover:bg-slate-500/10"}`}
                      >
                        {f.path}{f.content === undefined && <span className="ml-1 opacity-60">(deleted)</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-xs opacity-70">{blocked ? "None - the agent reported the objective cannot be met." : "No files written in this iteration."}</div>
              )}
            </div>

            <div>
              <div className="mb-1 text-xs font-semibold uppercase opacity-70">What the tests assert</div>
              {tr?.objectiveTargets?.length ? (
                <ul className="space-y-1 text-xs">
                  {tr.objectiveTargets.map((t, i) => (
                    <li key={i}>{t.negated ? <Badge tone="warn">absent</Badge> : <Badge tone="muted">present</Badge>} <span className="font-mono">"{t.text}"</span></li>
                  ))}
                </ul>
              ) : (
                <div className="text-xs opacity-70">No text-based assertions detected.</div>
              )}
            </div>

            <div>
              <div className="mb-1 text-xs font-semibold uppercase opacity-70">Objective check</div>
              {tr?.objective ? (
                <div className="space-y-1 text-xs">
                  <Badge tone={tr.objective.aligned ? "ok" : "warn"}>{tr.objective.aligned ? "matches instruction" : "does not match instruction"}</Badge>
                  <div className="opacity-80">{tr.objective.reason}</div>
                </div>
              ) : (
                <div className="text-xs opacity-70">{tr?.passed === false ? "Checked only once tests pass." : notExecuted ? "Not checked - tests were never executed." : "Not recorded for this iteration."}</div>
              )}
            </div>

            <div className="text-xs opacity-70">Cost ${active.costUsd.toFixed(4)} · {new Date(active.createdAt).toLocaleString()}</div>
          </div>

          {/* Code */}
          <div className="space-y-2 lg:col-span-3">
            {file ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="break-all font-mono text-xs">{file.path}{previous ? <span className="ml-2 opacity-60">revised from iteration {previous.iterationNumber}</span> : <span className="ml-2 opacity-60">new in this iteration</span>}</div>
                  {previous && (
                    <button className="shrink-0 rounded border px-2 py-0.5 text-xs" onClick={() => setShowDiff((v) => !v)}>
                      {showDiff ? "Show file" : `Diff vs iteration ${previous.iterationNumber}`}
                    </button>
                  )}
                </div>
                <div className="overflow-hidden rounded border">
                  {showDiff && previous ? (
                    <DiffEditor key={`${activeIterNum}:${file.path}`} keepCurrentOriginalModel keepCurrentModifiedModel height="420px" language={languageFor(file.path)} theme="vs-dark" original={previous.content} modified={file.content ?? ""} beforeMount={configureSpecEditor} options={{ ...editorOptions, renderSideBySide: true }} />
                  ) : file.content === undefined ? (
                    <div className="p-3 text-sm opacity-70">This file was deleted in this iteration.</div>
                  ) : (
                    <Editor height="420px" language={languageFor(file.path)} theme="vs-dark" value={file.content} beforeMount={configureSpecEditor} options={editorOptions} />
                  )}
                </div>
              </>
            ) : null}

            {(tr?.tests?.length || tr?.savedSpecs?.length) ? (
              <div className="space-y-1 text-xs">
                {tr?.savedSpecs?.length ? <div className="opacity-80">Saved to Suites: {tr.savedSpecs.join(", ")}</div> : null}
                {tr?.tests?.map((t, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Badge tone={t.status === "passed" ? "ok" : t.status === "failed" ? "bad" : "muted"}>{t.status}</Badge>
                    <span>{t.file ? `${t.file} › ` : ""}{t.title}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {tr?.failureSummary && (
              <div>
                <div className="mb-1 text-xs font-semibold uppercase opacity-70">Test error</div>
                <pre className="overflow-auto whitespace-pre-wrap rounded border border-red-300 bg-red-50 p-2 text-xs text-red-900">{stripAnsi(tr.failureSummary)}</pre>
              </div>
            )}

            <div>
              <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase opacity-70">
                Execution output
                {!notExecuted && !blocked && tr && <Badge tone={tr.passed ? "ok" : "bad"}>{tr.passed ? "exit 0" : "failed"}</Badge>}
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border bg-black/80 p-2 text-xs text-slate-100">{output || "(no output recorded)"}</pre>
            </div>

            {active.summary && (
              <details className="text-xs">
                <summary className="cursor-pointer opacity-70">Agent response (raw)</summary>
                <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded border p-2">{active.summary}</pre>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
