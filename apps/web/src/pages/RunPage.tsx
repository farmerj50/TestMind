// apps/web/src/pages/RunPage.tsx
import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useApi } from "@/lib/api";
import StatusBadge from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import RunResults from "@/components/RunResults";
import RunLogs from "@/components/RunLogs";

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
};

export default function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const { apiFetch } = useApi();

  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingIssue, setCreatingIssue] = useState(false);

  const done = useMemo(
    () => !!run && (run.status === "succeeded" || run.status === "failed"),
    [run]
  );

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
            <div>Summary: {run.summary || "—"}</div>
            <div>Error: {run.error || "—"}</div>
          </div>
          <hr className="my-4" />

          <div className="space-y-6">
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
