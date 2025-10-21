import { useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/api";
import { CheckCircle2, XCircle, CircleAlert } from "lucide-react";

type Result = {
  id: string;
  status: "passed" | "failed" | "skipped" | "error";
  durationMs: number | null;
  message: string | null;
  case: { id: string; title: string; key: string };
};

export default function RunResults({ runId, active }: { runId: string; active: boolean }) {
  const { apiFetch } = useApi();
  const [results, setResults] = useState<Result[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-slate-500">
          <tr>
            <th className="px-2 py-2">Case</th>
            <th className="px-2 py-2">Status</th>
            <th className="px-2 py-2">Duration</th>
            <th className="px-2 py-2">Message</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {results.map((r) => (
            <tr key={r.id}>
              <td className="px-2 py-2">
                <div className="font-medium">{r.case.title}</div>
                <div className="text-xs text-slate-500 font-mono">{r.case.key}</div>
              </td>
              <td className="px-2 py-2 capitalize flex items-center gap-1">
                {icon(r.status)}
                {r.status}
              </td>
              <td className="px-2 py-2">{r.durationMs ?? "—"} ms</td>
              <td className="px-2 py-2 break-words">{r.message ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
