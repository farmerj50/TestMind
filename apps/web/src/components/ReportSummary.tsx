import { useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { Card, CardContent } from "../components/ui/card";

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
  const Pill = ({ label, value, color, bg }: { label: string; value: number; color?: string; bg?: string }) => (
    <div className={`rounded-lg border border-slate-400 px-3 py-2 ${bg || "bg-white"}`}>
      <div className="text-xs text-slate-800">{label}</div>
      <div className={`text-lg font-semibold ${color || "text-slate-900"}`}>{value}</div>
    </div>
  );

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 text-sm font-medium text-slate-900">Test Run Summary</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Pill label="Total" value={counts.total} bg="bg-[#ffeab0]" color="text-slate-900" />
          <Pill label="Pass" value={counts.succeeded} bg="bg-[#d6f5e6]" color="text-emerald-800" />
          <Pill label="Fail" value={counts.failed} bg="bg-[#ffe2e6]" color="text-rose-800" />
          <Pill label="Running" value={counts.running} bg="bg-[#ffe8c2]" color="text-amber-800" />
          <Pill label="Queued" value={counts.queued} bg="bg-[#d6e7ff]" color="text-blue-900" />
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
