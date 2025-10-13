import { useEffect, useState } from "react";
import { useApi } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";

type Summary = {
  counts: { queued: number; running: number; succeeded: number; failed: number; total: number };
  lastRun?: {
    id: string;
    status: "queued"|"running"|"succeeded"|"failed";
    createdAt: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    projectId: string;
    summary?: string | null;
    error?: string | null;
  } | null;
};

export default function ReportSummary({
  projectId,
  refreshKey,
}: { projectId?: string; refreshKey?: number }) {
  const { apiFetch } = useApi();
  const [data, setData] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
        const res = await apiFetch<Summary>(`/reports/summary${q}`);
        if (!cancelled) {
          setData(res);
          setErr(null);
        }
      } catch (e: any) {
        if (!cancelled) setErr(e.message ?? "Failed to load summary");
      }
    })();

    return () => { cancelled = true; };
    // IMPORTANT: intentionally DO NOT include apiFetch (stable enough),
    // and DO NOT set up any setInterval here
  }, [projectId, refreshKey]);

  if (err) return <div className="text-sm text-rose-600">{err}</div>;
  if (!data) return <div className="text-sm text-slate-500">Loading summary…</div>;

  const { counts, lastRun } = data;
  const Pill = ({ label, value }: { label: string; value: number }) => (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 text-sm font-medium text-slate-800">Test Run Summary</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Pill label="Total" value={counts.total} />
          <Pill label="Succeeded" value={counts.succeeded} />
          <Pill label="Failed" value={counts.failed} />
          <Pill label="Running" value={counts.running} />
          <Pill label="Queued" value={counts.queued} />
        </div>
        <div className="mt-4 text-xs text-slate-500">
          {lastRun ? (
            <>
              Last run <span className="font-mono">{lastRun.id.slice(0, 8)}</span> —{" "}
              <span className="font-medium">{lastRun.status}</span> at{" "}
              {new Date(lastRun.createdAt).toLocaleString()}
            </>
          ) : (
            "No runs yet."
          )}
        </div>
      </CardContent>
    </Card>
  );
}
