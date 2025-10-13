import { useEffect, useState } from "react";
import { useApi } from "@/lib/api";
import StatusBadge from "@/components/StatusBadge";

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

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
        const res = await apiFetch<{ runs: Run[] }>(`/reports/recent${q}`);
        if (!cancelled) setRuns(res.runs);
      } catch (e: any) {
        if (!cancelled) setErr(e.message ?? "Failed to load runs");
      }
    })();

    return () => { cancelled = true; };
    // NOTE: no setInterval here
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
