import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useApi } from "@/lib/api";

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
};

export default function RunPage() {
  const { runId } = useParams<{ runId: string }>();
  const { apiFetch } = useApi();
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    (async () => {
      try {
        const r = await apiFetch<{ run: Run }>(`/test-runs/${runId}`);
        setRun(r.run);
      } catch (e: any) {
        setErr(e?.message || "Failed to load run");
      }
    })();
  }, [runId, apiFetch]);

  if (err) return <div className="p-6 text-rose-600">{err}</div>;
  if (!run) return <div className="p-6">Loading…</div>;

  return (
    <div className="p-6 space-y-3">
      <h1 className="text-xl font-semibold">Test run</h1>
      <div className="text-sm text-slate-600">
        Project:{" "}
        <Link to={`/projects/${run.project.id}`} className="underline">
          {run.project.name}
        </Link>
      </div>
      <div>Status: <b>{run.status}</b></div>
      <div>Summary: {run.summary || "—"}</div>
      <div>Error: {run.error || "—"}</div>
      <div>Created: {new Date(run.createdAt).toLocaleString()}</div>
      {run.startedAt && <div>Started: {new Date(run.startedAt).toLocaleString()}</div>}
      {run.finishedAt && <div>Finished: {new Date(run.finishedAt).toLocaleString()}</div>}
    </div>
  );
}
