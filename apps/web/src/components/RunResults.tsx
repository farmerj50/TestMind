import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useApi } from "../lib/api";
import { CheckCircle2, XCircle, CircleAlert, RotateCcw } from "lucide-react";
import { Button } from "./ui/button";

type Result = {
  id: string;
  status: "passed" | "failed" | "skipped" | "error";
  durationMs: number | null;
  message: string | null;
  case: { id: string; title: string; key: string };
  steps?: string[];
  stdout?: string[];
  stderr?: string[];
};

export default function RunResults({
  runId,
  active,
  projectId,
  suiteId,
}: {
  runId: string;
  active: boolean;
  projectId?: string;
  suiteId?: string;
}) {
  const { apiFetch } = useApi();
  const navigate = useNavigate();
  const [results, setResults] = useState<Result[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  const [rerunLoadingId, setRerunLoadingId] = useState<string | null>(null);
  const [analyzeLoadingId, setAnalyzeLoadingId] = useState<string | null>(null);

  const escapeRegex = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const buildLooseGrep = (title: string) =>
    `(?:^|\\s)${escapeRegex(title)}(?:$|\\s)`;

  const stop = () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const load = async () => {
    try {
      const res = await apiFetch<{ results: Result[] }>(`/runner/test-runs/${runId}/results`);
      setResults(res.results);
      setErr(null);
      if (!active) stop();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load results");
    }
  };

  useEffect(() => {
    load();
    if (active && !pollRef.current) {
      pollRef.current = window.setInterval(load, 2000) as unknown as number;
    }
    return () => stop();
  }, [runId, active]);

  if (err) return <div className="text-sm text-rose-600">{err}</div>;
  if (!results.length) return <div className="text-sm text-slate-500">No results yet.</div>;

  const icon = (s: Result["status"]) =>
    s === "passed" ? (
      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
    ) : s === "failed" ? (
      <XCircle className="h-4 w-4 text-rose-600" />
    ) : (
      <CircleAlert className="h-4 w-4 text-amber-500" />
    );

  const handleRerun = async (specPath?: string | null, title?: string | null) => {
    if (!specPath) return;
    try {
      setRerunLoadingId(specPath);
      const testTitle = title ?? undefined;
      const grep = testTitle ? buildLooseGrep(testTitle) : undefined;
      await apiFetch(`/runner/test-runs/${runId}/rerun`, {
        method: "POST",
        body: JSON.stringify({ specFile: specPath, grep }),
      });
    } catch (e: any) {
      alert(e?.message ?? "Failed to trigger rerun");
    } finally {
      setRerunLoadingId(null);
    }
  };

    const handleAnalyze = async (specPath?: string | null, title?: string | null) => {
      try {
        setAnalyzeLoadingId(specPath || "run");
        const testTitle = title ?? undefined;
        const grep = testTitle ? buildLooseGrep(testTitle) : undefined;
        const res = await apiFetch<{ runId: string }>(`/runner/test-runs/${runId}/rerun`, {
          method: "POST",
          body: JSON.stringify({
          specFile: specPath ?? undefined,
          grep,
          testTitle,
          livePreview: true,
        }),
      });
      if (res?.runId) {
        navigate(`/test-runs/${res.runId}`);
      } else {
        alert("Rerun queued. Open the latest run to view analysis.");
      }
    } catch (e: any) {
      alert(e?.message ?? "Failed to trigger AI analyze rerun");
    } finally {
      setAnalyzeLoadingId(null);
    }
  };

  return (
    <div className="space-y-3">
      {results.map((r) => {
        const path = r.case.key?.split("#")[0]?.replace(/\\/g, "/");
        const hasValidPath = !!path && path !== "unknown";
        const fileName = path ? path.split("/").pop() : null;
        const rawTitle = r.case.title || "";
        const displayTitle = rawTitle.includes(" > ")
          ? rawTitle.split(" > ").pop() || rawTitle
          : rawTitle;
        const targetSuiteId =
          suiteId ||
          (projectId && projectId.startsWith("agent-") ? projectId : projectId ? `agent-${projectId}` : null);
        return (
          <div
            key={r.id}
            className="rounded-md border border-slate-200 bg-white shadow-sm p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium text-slate-800">{displayTitle}</div>
                {fileName && <div className="text-xs text-slate-500">{fileName}</div>}
              </div>
              <div className="flex items-center gap-2 text-sm">
                {icon(r.status)}
                <span className="capitalize text-slate-700">{r.status}</span>
                <span className="text-slate-500">
                  {r.durationMs != null ? `${r.durationMs} ms` : "-"}
                </span>
              </div>
            </div>

            <div className="mt-2 space-y-2 text-sm text-slate-700">
              {r.message && (
                <pre className="whitespace-pre-wrap text-xs text-slate-700">{r.message}</pre>
              )}
              {r.steps && r.steps.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-slate-600">Steps</div>
                  <ol className="list-decimal pl-4 text-xs text-slate-600 space-y-1">
                    {r.steps.map((step, idx) => (
                      <li key={idx}>{step}</li>
                    ))}
                  </ol>
                </div>
              )}
              {(r.stdout?.length || r.stderr?.length) ? (
                <div className="space-y-1">
                  {r.stdout && r.stdout.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-slate-600">Stdout</div>
                      <pre className="whitespace-pre-wrap text-xs text-slate-500">
                        {r.stdout.join("\n")}
                      </pre>
                    </div>
                  )}
                  {r.stderr && r.stderr.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-slate-600">Stderr</div>
                      <pre className="whitespace-pre-wrap text-xs text-slate-500">
                        {r.stderr.join("\n")}
                      </pre>
                    </div>
                  )}
                </div>
              ) : null}
              {!r.message && (!r.steps || r.steps.length === 0) && (!r.stdout?.length && !r.stderr?.length) && (
                <div className="text-xs text-slate-500">No additional details.</div>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link
                  to={
                    path && targetSuiteId
                      ? `/suite/${encodeURIComponent(
                          targetSuiteId
                        )}?project=${encodeURIComponent(
                          targetSuiteId
                        )}&spec=${encodeURIComponent(path)}&returnTo=${encodeURIComponent(`/test-runs/${runId}`)}`
                      : path
                        ? `/suites?spec=${encodeURIComponent(path)}&returnTo=${encodeURIComponent(`/test-runs/${runId}`)}`
                        : `/suites?returnTo=${encodeURIComponent(`/test-runs/${runId}`)}`
                  }
                >
                  Edit in suite
                </Link>
              </Button>
              {hasValidPath && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rerunLoadingId === path}
                  onClick={() => handleRerun(path, r.case.title)}
                >
                  <RotateCcw className="mr-1 h-4 w-4" />
                  {rerunLoadingId === path ? "Rerunning..." : "Rerun this spec"}
                </Button>
              )}
              {(r.status === "failed" || r.status === "error") && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={analyzeLoadingId === (path || "run")}
                  onClick={() => handleAnalyze(hasValidPath ? path : null, r.case.title)}
                >
                  {analyzeLoadingId === (path || "run") ? "Analyzing..." : "AI analyze"}
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
