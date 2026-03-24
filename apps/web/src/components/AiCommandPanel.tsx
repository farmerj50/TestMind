type Analysis = {
  summary: string;
  cause: string;
  suggestion: string;
  model?: string;
} | null;

type AiActionSnapshot = {
  framework?: string | null;
  specPath: string;
  testTitle?: string | null;
  failureMessage?: string | null;
  stdoutSnippet: string;
  stderrSnippet: string;
  specSnippet: string;
  artifactCount?: number;
  failureClasses?: string[];
} | null;

type RunAiAction = {
  actionId?: string | null;
  attemptId?: string | null;
  kind: "analyze" | "repair";
  mode: "analyze" | "repair";
  status: "allowed" | "blocked";
  allowed: boolean;
  reasons: string[];
  frameworkId?: string | null;
  targetScope: "run" | "spec" | "testcase";
  rerunIntent?: "ai-rerun" | null;
  snapshot: AiActionSnapshot;
  queueStatus?: "queued" | "blocked" | null;
  queueReason?: string | null;
  capabilities?: {
    canAutonomouslyRepair?: boolean;
    canUseStructuredPatch?: boolean;
    evidenceArtifactCount?: number;
  } | null;
  summary?: string | null;
  cause?: string | null;
  suggestion?: string | null;
  model?: string | null;
} | null;

type HealingAttempt = {
  id: string;
  testResultId?: string | null;
  testCaseId?: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  attempt?: number;
  summary?: string | null;
  error?: string | null;
  diff?: string | null;
  mode?: "structured" | "full-rewrite" | null;
  structuredFallbackReason?: string | null;
  operationCount?: number | null;
  operationTypes?: string[];
  fixType?: "fallback" | "rule_fixed" | "llm_patch_fixed" | "llm_rejected_policy" | "none" | null;
  fixDetails?: Record<string, unknown> | null;
};

type ChildRun = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
};

type TelemetryEntry = {
  id: string;
  label: string;
  detail: string;
  tone: "default" | "warn" | "error" | "success";
};

function badgeClass(status: string) {
  if (status === "succeeded" || status === "allowed" || status === "ready") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (status === "running" || status === "queued") {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (status === "failed" || status === "blocked") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function SummaryField({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string | null;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-medium text-slate-900">{value}</div>
      {detail ? <div className="mt-1 text-xs text-slate-500">{detail}</div> : null}
    </div>
  );
}

function InlineStatus({
  label,
  detail,
}: {
  label: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Status</div>
      <div className="mt-1 text-sm font-semibold text-slate-900">{label}</div>
      <div className="mt-1 text-xs text-slate-500">{detail}</div>
    </div>
  );
}

function SnippetBlock({ label, value }: { label: string; value?: string | null }) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">{label}</div>
      <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-slate-700">
{trimmed}
      </pre>
    </div>
  );
}

export default function AiCommandPanel({
  action,
  analysis,
  healingAttempts,
  reruns,
  livePreviewEnabled,
  liveFrameUrl,
  liveFrameCount,
  telemetryEventCount,
  telemetryEntries,
  selectedTarget,
}: {
  action: RunAiAction;
  analysis: Analysis;
  healingAttempts: HealingAttempt[];
  reruns: ChildRun[];
  livePreviewEnabled: boolean;
  liveFrameUrl: string | null;
  liveFrameCount: number;
  telemetryEventCount: number;
  telemetryEntries: TelemetryEntry[];
  selectedTarget?: {
    title: string;
    specPath: string | null;
    status: "passed" | "failed" | "skipped" | "error";
    message?: string | null;
    frameworkId?: string | null;
  } | null;
}) {
  const latestAttempt = healingAttempts.length > 0 ? healingAttempts[healingAttempts.length - 1] : null;
  const latestRerun = reruns.length > 0 ? reruns[reruns.length - 1] : null;
  const snapshot = action?.snapshot ?? null;
  const failureClasses = snapshot?.failureClasses ?? [];
  const targetTitle = selectedTarget?.title || snapshot?.testTitle || "Selected testcase";
  const targetSpecPath = selectedTarget?.specPath || snapshot?.specPath || null;
  const targetFailureMessage = selectedTarget?.message || snapshot?.failureMessage || null;
  const evidenceArtifactCount = action?.capabilities?.evidenceArtifactCount ?? snapshot?.artifactCount ?? 0;
  const latestDiff = latestAttempt?.diff?.trim() || "";
  const latestAttemptSummary =
    latestAttempt?.summary ||
    action?.summary ||
    analysis?.summary ||
    "AI is using the selected failure, artifacts, and rerun state to repair this test.";

  if (!selectedTarget || (!action && !analysis && !latestAttempt)) return null;

  const latestAttemptNumber = latestAttempt?.attempt ?? (healingAttempts.length > 0 ? healingAttempts.length : null);

  const repairStatus = (() => {
    if (latestRerun?.status === "succeeded") {
      return {
        phase: "validated",
        label: "Repair validated",
        detail: "Latest AI rerun passed with the current patch.",
      } as const;
    }
    if (latestRerun?.status === "running") {
      return {
        phase: "validating",
        label: "Validating repair",
        detail: "The AI rerun is currently executing this patched testcase.",
      } as const;
    }
    if (latestRerun?.status === "queued") {
      return {
        phase: "rerun_queued",
        label: "Validation queued",
        detail: "The AI rerun has been queued and is waiting to start.",
      } as const;
    }
    if (latestAttempt?.status === "running") {
      return {
        phase: "repairing",
        label: latestAttemptNumber ? `Attempting repair (${latestAttemptNumber})` : "Attempting repair",
        detail: "AI is patching the selected testcase and validating the next rerun.",
      } as const;
    }
    if (latestAttempt?.status === "queued" || action?.queueStatus === "queued") {
      return {
        phase: "preparing",
        label: latestAttemptNumber ? `Repair queued (${latestAttemptNumber})` : "Repair queued",
        detail: "The next repair attempt has been queued for this selected failure.",
      } as const;
    }
    if (latestAttempt?.status === "failed") {
      return {
        phase: "attempt_failed",
        label: latestAttemptNumber ? `Repair attempt failed (${latestAttemptNumber})` : "Repair attempt failed",
        detail: latestAttempt.error || "The last patch did not produce a passing rerun.",
      } as const;
    }
    if (action?.allowed === false) {
      return {
        phase: "blocked",
        label: "Repair blocked",
        detail: action.reasons.join(", ") || "Repair was blocked.",
      } as const;
    }
    if (latestRerun?.status === "failed") {
      return {
        phase: "needs_retry",
        label: "Preparing next attempt",
        detail: "The last validation rerun failed and AI is readying a new strategy for this selected testcase.",
      } as const;
    }
    return {
      phase: "idle",
      label: "Preparing repair",
      detail: "The selected failure is loaded, but no repair attempt is currently running.",
    } as const;
  })();

  const issueText =
    targetFailureMessage ||
    analysis?.cause ||
    action?.cause ||
    "The selected test is failing and AI has not captured a richer failure snapshot yet.";

  const rerunText =
    latestRerun?.status === "succeeded"
      ? "Passed. The patched testcase now validates successfully."
      : latestRerun?.status === "failed"
        ? "Failed. AI is evaluating the next repair strategy."
        : latestRerun?.status === "running"
          ? "Running. Validation is still executing."
          : latestRerun?.status === "queued"
            ? "Queued. Validation rerun has not started yet."
            : "No validation rerun recorded yet.";

  const repairActionText = (() => {
    if (repairStatus.phase === "validated") {
      return "AI completed the repair loop and the latest validation rerun passed.";
    }
    if (repairStatus.phase === "validating") {
      return "AI is validating the current patch on a live rerun of the selected testcase.";
    }
    if (repairStatus.phase === "rerun_queued") {
      return "AI has finished the current patch step and queued the validation rerun.";
    }
    if (repairStatus.phase === "repairing") {
      return [
        latestAttemptSummary,
        latestAttempt?.mode ? `Using ${latestAttempt.mode === "structured" ? "a structured patch" : "a full rewrite"} approach.` : null,
        latestAttempt?.fixType ? `Current fix type is ${latestAttempt.fixType}.` : null,
      ]
        .filter(Boolean)
        .join(" ");
    }
    if (repairStatus.phase === "preparing") {
      return "AI has accepted this selected failure and is preparing the next repair attempt.";
    }
    if (repairStatus.phase === "attempt_failed") {
      return latestAttemptSummary || "The last repair strategy failed and AI is waiting for the next step.";
    }
    if (repairStatus.phase === "needs_retry") {
      return "The last validation rerun failed. AI is evaluating the failure evidence for a new patch strategy.";
    }
    if (repairStatus.phase === "blocked") {
      return action?.reasons?.join(", ") || "Repair is currently blocked by policy or missing prerequisites.";
    }
    return "AI has the selected failure context loaded, but no active repair attempt is running yet.";
  })();

  const heroTitle =
    repairStatus.phase === "validated"
      ? `Fixed: ${targetTitle}`
      : repairStatus.phase === "repairing" ||
          repairStatus.phase === "validating" ||
          repairStatus.phase === "rerun_queued" ||
          repairStatus.phase === "needs_retry"
        ? `Fixing: ${targetTitle}`
        : targetTitle;
  const patchTitle = latestDiff ? "Patch applied" : "Patch strategy";
  const patchBody = latestDiff || repairActionText;
  const frameworkLabel =
    action?.frameworkId ??
    selectedTarget?.frameworkId ??
    snapshot?.framework ??
    "unknown framework";

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">AI repair</div>
          <h3 className="mt-1 text-xl font-semibold text-slate-900">{heroTitle}</h3>
          <div className="mt-2 text-sm text-slate-700">{issueText}</div>
          <div className="mt-2 text-sm text-slate-500">
            {frameworkLabel}
            {targetSpecPath ? <span className="ml-2 break-all">{targetSpecPath}</span> : null}
          </div>
        </div>
        <div className={`rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-[0.12em] ${badgeClass(repairStatus.label)}`}>
          {repairStatus.label}
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">{patchTitle}</div>
        {latestDiff ? (
          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-white p-3 font-mono text-xs text-slate-700">
{patchBody}
          </pre>
        ) : (
          <div className="mt-2 text-sm text-slate-800">{patchBody}</div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-3">
          <InlineStatus label={repairStatus.label} detail={repairStatus.detail} />
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">AI is doing</div>
            <div className="mt-2 text-sm text-slate-800">{repairActionText}</div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Failure</div>
            <div className="mt-2 text-sm text-slate-800">{issueText}</div>
            {failureClasses.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {failureClasses.map((item) => (
                  <span
                    key={item}
                    className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600"
                  >
                    {item}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Rerun</div>
            <div className="mt-2 text-sm text-slate-800">{rerunText}</div>
            {latestAttempt?.structuredFallbackReason ? (
              <div className="mt-2 text-xs text-slate-500">
                Fallback reason: {latestAttempt.structuredFallbackReason}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryField
          label="Target scope"
          value={action?.targetScope ?? "testcase"}
          detail={selectedTarget.status === "failed" || selectedTarget.status === "error" ? "Selected failed target" : "Selected target"}
        />
        <SummaryField
          label="Evidence"
          value={`${evidenceArtifactCount} artifact${evidenceArtifactCount === 1 ? "" : "s"}`}
          detail={`${liveFrameCount} live frame${liveFrameCount === 1 ? "" : "s"}, ${telemetryEventCount} telemetry event${telemetryEventCount === 1 ? "" : "s"}`}
        />
        <SummaryField
          label="Repair mode"
          value={latestAttempt?.mode === "structured" ? "Structured patch" : latestAttempt?.mode === "full-rewrite" ? "Full rewrite" : "Pending"}
          detail={latestAttempt?.fixType ? `Fix type: ${latestAttempt.fixType}` : "No fix type recorded"}
        />
        <SummaryField
          label="Attempt"
          value={latestAttemptNumber ? String(latestAttemptNumber) : "none"}
          detail={latestAttempt?.status ? `Latest attempt is ${latestAttempt.status}` : "No repair attempt recorded yet"}
        />
      </div>

      {(liveFrameUrl || telemetryEntries.length > 0) && (
        <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-[0.95fr_1.05fr]">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Live preview</div>
            <div className="mt-2 overflow-hidden rounded-md border border-slate-200 bg-white">
              {liveFrameUrl ? (
                <img src={liveFrameUrl} alt="Live preview" className="h-full w-full object-contain" />
              ) : (
                <div className="flex min-h-32 items-center justify-center text-sm text-slate-500">
                  {livePreviewEnabled ? "Waiting for live preview…" : "Live preview disabled for this run."}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Repair activity</div>
            {telemetryEntries.length > 0 ? (
              <div className="mt-2 space-y-2">
                {telemetryEntries.slice(-4).map((entry) => (
                  <div key={entry.id} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                    <div className="font-medium text-slate-900">{entry.label}</div>
                    {entry.detail ? <div className="mt-1 text-xs text-slate-500">{entry.detail}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500">
                No streamed repair activity yet.
              </div>
            )}
          </div>
        </div>
      )}

      {(snapshot?.stdoutSnippet || snapshot?.stderrSnippet || snapshot?.specSnippet) && (
        <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-3">
          <SnippetBlock label="stdout" value={snapshot?.stdoutSnippet} />
          <SnippetBlock label="stderr" value={snapshot?.stderrSnippet} />
          <SnippetBlock label="spec snippet" value={snapshot?.specSnippet} />
        </div>
      )}

      {analysis?.suggestion ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Analyst note</div>
          <div className="mt-2 text-sm text-slate-700">{analysis.suggestion}</div>
        </div>
      ) : null}
    </section>
  );
}
