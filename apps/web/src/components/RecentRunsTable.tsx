import { useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/api";
import StatusBadge from "@/components/StatusBadge";
const idleTriesRef = useRef(0);
type Run = {
  id: string;
  projectId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  summary?: string | null;
  error?: string | null;
  issueUrl?: string | null;
};

export default function RecentRunsTable({
  projectId,
  refreshKey,
}: { projectId?: string; refreshKey?: number }) {
  const { apiFetch } = useApi();
  const [runs, setRuns] = useState<Run[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // self-scheduling timeout poller
  const pollRef = useRef<number | null>(null);
  const clearPoll = () => {
    if (pollRef.current) { window.clearTimeout(pollRef.current); pollRef.current = null; }
  };
  const schedule = (ms = 2000) => {
    clearPoll();
    pollRef.current = window.setTimeout(load, ms) as unknown as number;
  };

  const load = async () => {
    try {
      const bust = `_=${Date.now()}`;
      const q = projectId ? `?projectId=${encodeURIComponent(projectId)}&${bust}` : `?${bust}`;
      const res = await apiFetch<{ runs: Run[] }>(`/reports/recent${q}`, { cache: "no-store" });

      setRuns(res.runs);
      setErr(null);

      const hasActive = res.runs.some(r => r.status === "queued" || r.status === "running");

      if (hasActive) {
        idleTriesRef.current = 0;         // reset while active
        schedule(2000);
      } else if (idleTriesRef.current < 3) {
        idleTriesRef.current += 1;        // a few idle polls to catch the flip
        schedule(2000);
      } else {
        clearPoll();
      }
    } catch (e: any) {
      setErr(e.message ?? "Failed to load runs");
      schedule(2000);                      // retry on transient error
    }
  };

  useEffect(() => {
    idleTriesRef.current = 0;
    load();
    return () => clearPoll();
  }, [projectId, refreshKey, apiFetch]);

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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
