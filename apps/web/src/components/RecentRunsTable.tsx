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

  // single timer handle so we never spawn multiple loops
  const pollRef = useRef<number | null>(null);

  // clear any pending timer on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        window.clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    // cancel any prior timer when deps change
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
        const hasActive = list.some(
          (r) => r.status === "queued" || r.status === "running"
        );
        // Always keep polling; fast when active, slow when idle
        const delay = hasActive ? 1500 : 10000;
        if (!cancelled) {
          pollRef.current = window.setTimeout(loop, delay);
        }
      } catch (e: any) {
        if (!cancelled) {
          setErr(e?.message ?? "Failed to load runs");
          // Back off a bit on error, but keep polling so it recovers
          pollRef.current = window.setTimeout(loop, 10000);
        }
      }
    };

    // initial kick
    loop();

    return () => {
      cancelled = true;
      controller.abort();
      if (pollRef.current) {
        window.clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [projectId, refreshKey]);

  if (err) return <div className="text-sm text-rose-600">{err}</div>;
  if (!runs?.length) return <div className="text-sm text-slate-500">No recent runs.</div>;

  const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString() : "—");

  return (
    <div className="overflow-x-auto">
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
                    href={`/tm/runs/${r.id}/tests`} // change to `/runs/${r.id}/tests` if no /tm prefix
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
    </div>
  );
}
