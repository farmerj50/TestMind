import { useEffect, useRef, useState } from "react";
import { useApi } from "../lib/api";
import StatusBadge from "../components/StatusBadge";

type Run = {
  id: string;
  projectId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  summary?: string | null;
  error?: string | null;
};

export default function RecentRunsTable({
  projectId,
  refreshKey,
}: { projectId?: string; refreshKey?: number }) {
  const { apiFetch } = useApi();
  const [runs, setRuns] = useState<Run[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const friendlyError = (raw: any, fallback: string) => {
    if (!raw) return fallback;
    const text = typeof raw === "string" ? raw : raw?.message || fallback;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) return String(parsed.error);
      if (parsed?.message) return String(parsed.message);
      return text;
    } catch {
      return text;
    }
  };

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        window.clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (pollRef.current) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }

    let cancelled = false;
    const controller = new AbortController();

    const fetchOnce = async () => {
      const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      const res = await apiFetch<{ runs: Run[] }>(`/reports/recent${q}`, {
        signal: controller.signal as any,
      });
      if (!cancelled) setRuns(res.runs || []);
      return res.runs || [];
    };

    const loop = async () => {
      try {
        const list = await fetchOnce();
        const hasActive = list.some((r) => r.status === "queued" || r.status === "running");
        const delay = hasActive ? 1500 : 10000;
        if (!cancelled) {
          pollRef.current = window.setTimeout(loop, delay);
        }
      } catch (e: any) {
        if (!cancelled) {
          setErr(e?.message ?? "Failed to load runs");
          pollRef.current = window.setTimeout(loop, 10000);
        }
      }
    };

    loop();

    return () => {
      cancelled = true;
      controller.abort();
      if (pollRef.current) {
        window.clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [projectId, refreshKey, apiFetch]);

  const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString() : "—");

  const deleteRuns = async (mode: "all" | "older") => {
    const confirmMsg =
      mode === "all"
        ? "Delete all runs? This will remove run records and runner logs."
        : "Delete runs older than 7 days?";
    if (!window.confirm(confirmMsg)) return;
    try {
      const body: any = mode === "all" ? { all: true } : { olderThanDays: 7 };
      if (projectId) body.projectId = projectId;
      await apiFetch<{ deleted: number }>("/reports/runs/delete", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setRuns([]);
      setErr(null);
    } catch (e: any) {
      setErr(friendlyError(e?.message, "Failed to delete runs"));
    }
  };

  if (err) return <div className="text-sm text-rose-600">{err}</div>;

  return (
    <div className="overflow-x-auto space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <button
          className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50"
          onClick={() => deleteRuns("older")}
        >
          Delete older than 7 days
        </button>
        <button
          className="rounded border border-rose-300 px-2 py-1 text-rose-700 hover:bg-rose-50"
          onClick={() => deleteRuns("all")}
        >
          Delete all runs
        </button>
      </div>
      {!runs?.length ? (
        <div className="text-sm text-slate-500">No recent runs.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-slate-500">
            <tr>
              <th className="px-2 py-2">Run</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Created</th>
              <th className="px-2 py-2">Started</th>
              <th className="px-2 py-2">Finished</th>
              <th className="px-2 py-2">Report</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="px-2 py-2 font-mono">{r.id.slice(0, 8)}</td>
                <td className="px-2 py-2"><StatusBadge status={r.status} /></td>
                <td className="px-2 py-2">{fmt(r.createdAt)}</td>
                <td className="px-2 py-2">{fmt(r.startedAt)}</td>
                <td className="px-2 py-2">{fmt(r.finishedAt)}</td>
                <td className="px-2 py-2">
                  {r.status === "running" ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    <a
                      href={`/test-runs/${r.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      View tests
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
