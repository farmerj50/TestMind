import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Checkbox } from "../components/ui/checkbox";
import HowToHint from "../components/HowToHint";

type Run = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  projectId?: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  summary?: string | null;
  error?: string | null;
  artifactsJson?: Record<string, string> | null;
};

type Project = { id: string; name: string };

const STATUS_COLORS: Record<string, string> = {
  succeeded: "#10b981",
  failed: "#ef4444",
  running: "#3b82f6",
  queued: "#e2e8f0",
};

const formatReason = (raw?: string | null) => {
  if (!raw) return "Unknown";
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj.message) return String(obj.message);
      if (obj.error) return String(obj.error);
      const firstKey = Object.keys(obj)[0];
      if (firstKey) return `${firstKey}: ${String(obj[firstKey])}`.slice(0, 160);
    } catch {
      // ignore parse issues
    }
  }
  return trimmed.slice(0, 160);
};

function Pie({
  segments,
  size = 180,
  label,
}: {
  segments: Array<{ value: number; color: string; label?: string }>;
  size?: number;
  label?: string;
}) {
  const total = segments.reduce((s, x) => s + (x.value || 0), 0) || 1;
  let offset = 0;
  const rings = segments.map((seg, idx) => {
    const pct = (seg.value / total) * 100;
    const dash = `${pct} ${100 - pct}`;
    const circle = (
      <circle
        key={idx}
        r={15.91549430918954}
        cx={22}
        cy={22}
        fill="transparent"
        stroke={seg.color}
        strokeWidth={6}
        strokeDasharray={dash}
        strokeDashoffset={100 - offset}
        strokeLinecap="butt"
      />
    );
    offset += pct;
    return circle;
  });
  let angleAcc = 0;
  // segment labels removed per request
  return (
    <div className="flex items-center justify-center">
      <svg width={size} height={size} viewBox="0 0 46 46" className="shrink-0">
        {rings}
        <text x="22" y="22" textAnchor="middle" dominantBaseline="middle" fontSize="7" fill="#0f172a">
          {total}
        </text>
        {label && (
          <text x="22" y="28" textAnchor="middle" fontSize="3.5" fill="#94a3b8">
            {label}
          </text>
        )}
      </svg>
    </div>
  );
}

function BarChart({ data }: { data: Array<{ label: string; value: number; color: string }> }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="flex items-end gap-2">
      {data.map((d) => (
        <div key={d.label} className="flex-1">
          <div
            className="w-full rounded-t-md"
            style={{ height: `${(d.value / max) * 120 || 6}px`, background: d.color }}
          />
          <div className="mt-1 text-center text-xs text-slate-500">{d.label}</div>
        </div>
      ))}
    </div>
  );
}

type Range = "all" | "7d" | "30d";

export default function ReportsPage() {
  const { apiFetch } = useApi();
  const [runs, setRuns] = useState<Run[]>([]);
  const [specHints, setSpecHints] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [range, setRange] = useState<Range>("all");
  const [statusFilter, setStatusFilter] = useState<Array<Run["status"]>>(["succeeded", "failed", "running", "queued"]);
  const [showHealth, setShowHealth] = useState(true);
  const [showExit, setShowExit] = useState(true);
  const [showTimeline, setShowTimeline] = useState(true);
  const [showFeed, setShowFeed] = useState(true);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);

  const refreshRuns = useCallback(async () => {
    try {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      const res = await apiFetch<Run[]>(`/runner/test-runs${qs}`);
      setRuns(res || []);
    } catch {
      setRuns([]);
    }
  }, [apiFetch, projectId]);

  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch<{ projects: Project[] }>("/projects");
        setProjects(res.projects || []);
      } catch {
        setProjects([]);
      }
    })();
  }, [apiFetch]);

  const stopRun = useCallback(
    async (runId: string) => {
      setStoppingRunId(runId);
      try {
        await apiFetch(`/runner/test-runs/${runId}/stop`, { method: "POST" });
        await refreshRuns();
      } catch {
        // keep silent; status will refresh via next poll
      } finally {
        setStoppingRunId((prev) => (prev === runId ? null : prev));
      }
    },
    [apiFetch, refreshRuns]
  );

  const filteredRuns = useMemo(() => {
    if (range === "all") return runs;
    const now = Date.now();
    const cutoff = range === "7d" ? now - 7 * 24 * 3600 * 1000 : now - 30 * 24 * 3600 * 1000;
    return runs.filter(
      (r) =>
        new Date(r.createdAt).getTime() >= cutoff &&
        statusFilter.includes(r.status)
    );
  }, [runs, range, statusFilter]);

  const stats = useMemo(() => {
    const counts = { queued: 0, running: 0, succeeded: 0, failed: 0 };
    let totalDuration = 0;
    let finished = 0;
    const daily: Record<string, number> = {};
    for (const r of filteredRuns) {
      counts[r.status] = (counts as any)[r.status] + 1;
      const day = new Date(r.createdAt).toISOString().slice(0, 10);
      daily[day] = (daily[day] || 0) + 1;
      if (r.startedAt && r.finishedAt) {
        const d = new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime();
        if (d > 0) {
          totalDuration += d;
          finished += 1;
        }
      }
    }
    const avg = finished ? Math.round(totalDuration / finished / 1000) : 0;
    const timeline = Object.entries(daily)
      .sort(([a], [b]) => (a > b ? 1 : -1))
      .map(([k, v]) => ({ label: k.slice(5), value: v, color: "#3b82f6" }));
    return { counts, avgSeconds: avg, timeline };
  }, [filteredRuns]);

  const csvExport = () => {
    const rows = [
      ["id", "status", "createdAt", "startedAt", "finishedAt"],
      ...filteredRuns.map((r) => [r.id, r.status, r.createdAt, r.startedAt || "", r.finishedAt || ""]),
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `run-report${projectId ? `-${projectId}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const statuses = [
    { label: "Succeeded", value: stats.counts.succeeded, color: STATUS_COLORS.succeeded },
    { label: "Failed", value: stats.counts.failed, color: STATUS_COLORS.failed },
    { label: "Running", value: stats.counts.running, color: STATUS_COLORS.running },
    { label: "Queued", value: stats.counts.queued, color: STATUS_COLORS.queued },
  ];

  const failureRate = filteredRuns.length
    ? Math.round((stats.counts.failed / filteredRuns.length) * 100)
    : 0;

  const failureReasons = useMemo(() => {
    const reasons: Record<string, number> = {};
    filteredRuns
      .filter((r) => r.status === "failed")
      .forEach((r) => {
        const reason = formatReason(r.error || r.summary);
        reasons[reason] = (reasons[reason] || 0) + 1;
      });
    return Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([label, count], idx) => ({ label, count, rank: idx + 1 }));
  }, [filteredRuns]);

  const resolveAllureHref = (run: Run) => {
    const artifacts = run.artifactsJson || {};
    const p = artifacts["allure-report"] || artifacts["allure"];
    if (!p) return null;
    if (/^https?:\/\//i.test(p)) return p;
    const clean = p.replace(/^[\\/]+/, "").replace(/\\/g, "/");
    const withIndex = clean.endsWith("index.html") ? clean : `${clean.replace(/\/$/, "")}/index.html`;
    const apiBase =
      (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ||
      window.location.origin.replace(/\/$/, "");

    // If the artifact path is relative, prefix with /runner/ so it hits the API (which serves runner-logs).
    const needsPrefix = !withIndex.startsWith("runner-logs/") && !withIndex.startsWith("/runner-logs/");
    const pathWithPrefix = needsPrefix ? `/runner/${withIndex}` : `/${withIndex.replace(/^\//, "")}`;
    return `${apiBase}${pathWithPrefix}`;
  };

  const suiteHref = (projectId?: string) =>
    projectId ? `/suite/agent-${encodeURIComponent(projectId)}` : undefined;

  // Prefetch first spec path hint for visible runs (run feed slice)
  useEffect(() => {
    const visible = filteredRuns.slice(0, 8);
    const missing = visible.filter((r) => !specHints[r.id]).map((r) => r.id);
    if (!missing.length) return;

    missing.forEach(async (id) => {
      try {
        const res = await apiFetch<{ results?: Array<{ case?: { key?: string } }> }>(
          `/runner/test-runs/${id}/results`,
          { method: "GET", auth: "include" }
        );
        const first = res?.results?.[0]?.case?.key || "";
        const specPath = first.split("#")[0] || "";
        setSpecHints((prev) => (prev[id] ? prev : { ...prev, [id]: specPath || "spec unknown" }));
      } catch {
        // best effort; leave blank
      }
    });
  }, [filteredRuns, apiFetch, specHints]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Reports</p>
          <h1 className="text-2xl font-semibold text-slate-900">Quality insights</h1>
          <p className="text-sm text-slate-600">
            Track stability, failures, and throughput. Export and share with stakeholders.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <HowToHint
            storageKey="tm-howto-reports"
            title="How to use Reports"
            steps={[
              "Filter by project/range to focus on relevant runs.",
              "Use run id + spec name to open the suite editor and adjust tests.",
              "View Allure for detailed traces/screenshots.",
              "Export CSV to share summaries with your team.",
            ]}
          />
          <Select value={range} onValueChange={(val) => setRange(val as Range)}>
            <SelectTrigger className="w-28">
              <SelectValue placeholder="Range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All time</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
            </SelectContent>
          </Select>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={csvExport}>
            Export CSV
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <Checkbox
            checked={statusFilter.includes("succeeded")}
            onCheckedChange={(c) =>
              setStatusFilter((prev) =>
                c ? [...prev, "succeeded"] : prev.filter((v) => v !== "succeeded")
              )
            }
          />
          Succeeded
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <Checkbox
            checked={statusFilter.includes("failed")}
            onCheckedChange={(c) =>
              setStatusFilter((prev) =>
                c ? [...prev, "failed"] : prev.filter((v) => v !== "failed")
              )
            }
          />
          Failed
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <Checkbox
            checked={statusFilter.includes("running")}
            onCheckedChange={(c) =>
              setStatusFilter((prev) =>
                c ? [...prev, "running"] : prev.filter((v) => v !== "running")
              )
            }
          />
          Running
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <Checkbox
            checked={statusFilter.includes("queued")}
            onCheckedChange={(c) =>
              setStatusFilter((prev) =>
                c ? [...prev, "queued"] : prev.filter((v) => v !== "queued")
              )
            }
          />
          Queued
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <Checkbox checked={showHealth} onCheckedChange={(c) => setShowHealth(Boolean(c))} />
          Show health
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <Checkbox checked={showExit} onCheckedChange={(c) => setShowExit(Boolean(c))} />
          Show exit stats
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <Checkbox checked={showTimeline} onCheckedChange={(c) => setShowTimeline(Boolean(c))} />
          Show timeline
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <Checkbox checked={showFeed} onCheckedChange={(c) => setShowFeed(Boolean(c))} />
          Show run feed
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {showHealth && (
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-slate-800">Run health</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-[auto_1fr] items-center gap-6">
              <Pie segments={statuses} label="runs" />
              <div className="space-y-2 text-sm text-slate-700">
                {statuses.map((s) => (
                  <div key={s.label} className="flex items-center justify-between gap-3">
                    <span className="h-3 w-3 rounded-full" style={{ background: s.color }} />
                    <span className="w-24 truncate">{s.label}</span>
                    <span className="font-semibold tabular-nums">{s.value}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {showExit && (
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-slate-800">Exit statistics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-slate-700">
              <div className="flex items-center justify-between">
                <span>Failure rate</span>
                <span className="font-semibold text-rose-600">{failureRate}%</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Pass rate</span>
                <span className="font-semibold text-emerald-600">
                  {filteredRuns.length ? 100 - failureRate : 0}%
                </span>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
                {filteredRuns.length
                  ? "Rates computed over filtered runs."
                  : "No runs in this range."}
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-slate-800">Performance</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-700">
            <div className="flex items-center justify-between">
              <span>Average runtime</span>
              <span className="font-semibold">{stats.avgSeconds || 0}s</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Total runs</span>
              <span className="font-semibold">{filteredRuns.length}</span>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
              Throughput and runtime trends update with your filters.
            </div>
          </CardContent>
        </Card>

        {showTimeline && (
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="text-slate-800">Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              {stats.timeline.length > 0 ? (
                <BarChart data={stats.timeline} />
              ) : (
                <div className="text-xs text-slate-500">No activity in this range.</div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800">Top failure reasons</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-700">
            {failureReasons.length === 0 && (
              <div className="text-xs text-slate-500">No failures in this range.</div>
            )}
            {failureReasons.length > 0 && (
              <div className="rounded-md border border-slate-200 bg-white shadow-sm">
                <div className="grid grid-cols-3 bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700">
                  <div>Reason</div>
                  <div className="text-right">Count</div>
                  <div className="text-right">Rank</div>
                </div>
                <div className="divide-y">
                  {failureReasons.map((r) => (
                    <div
                      key={r.label}
                      className="grid grid-cols-3 px-3 py-2 text-xs text-slate-800 bg-white"
                    >
                      <div className="pr-2">{r.label}</div>
                      <div className="text-right font-semibold">{r.count}</div>
                      <div className="text-right">#{r.rank}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800">Recent failures</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-700">
            {filteredRuns.filter((r) => r.status === "failed").slice(0, 5).map((r) => (
              <div key={r.id} className="rounded-md border border-rose-100 bg-white p-3 shadow-sm">
                <div className="flex items-center justify-between text-xs text-rose-700">
                  <span className="font-mono text-slate-800">{r.id.slice(0, 10)}</span>
                  <span>{new Date(r.createdAt).toLocaleString()}</span>
                </div>
                {specHints[r.id] && (
                  <div className="text-[11px] text-slate-500">spec: {specHints[r.id]}</div>
                )}
                <div className="mt-1 text-xs text-rose-800">
                  {formatReason(r.error || r.summary) || "Failure summary unavailable."}
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                  {suiteHref(r.projectId) && (
                    <a
                      href={suiteHref(r.projectId)}
                      className="text-blue-600 underline"
                    >
                      Edit in suites
                    </a>
                  )}
                  {resolveAllureHref(r) && (
                    <a
                      href={resolveAllureHref(r) as string}
                      className="text-blue-600 underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      View Allure
                    </a>
                  )}
                </div>
              </div>
            ))}
            {filteredRuns.filter((r) => r.status === "failed").length === 0 && (
              <div className="text-xs text-slate-500">No recent failures.</div>
            )}
          </CardContent>
        </Card>

        {showFeed && (
        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800">Run feed</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-700">
            {filteredRuns.slice(0, 8).map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between rounded-md border border-slate-200 bg-white p-2 shadow-sm"
              >
                <div>
                  <div className="font-mono text-xs text-slate-700">
                    {r.id.slice(0, 10)}
                    {specHints[r.id] && (
                      <span className="ml-2 text-[11px] text-slate-500">
                        • {specHints[r.id].split("/").slice(-1)[0]}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">{new Date(r.createdAt).toLocaleString()}</div>
                {specHints[r.id] && (
                  <div className="text-[11px] text-slate-500">
                    {r.id.slice(0, 10)} • {specHints[r.id].split("/").slice(-1)[0]}
                  </div>
                )}
                  <div className="flex flex-wrap gap-2 text-[11px] mt-1">
                    {suiteHref(r.projectId) && (
                      <a
                        href={suiteHref(r.projectId)}
                        className="text-blue-600 underline"
                      >
                        Edit tests
                      </a>
                    )}
                    {resolveAllureHref(r) && (
                      <a
                        href={resolveAllureHref(r) as string}
                        className="text-blue-600 underline"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Allure report
                      </a>
                    )}
                    {(r.status === "running" || r.status === "queued") && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => stopRun(r.id)}
                        disabled={stoppingRunId === r.id}
                      >
                        {stoppingRunId === r.id ? "Stopping..." : "Stop run"}
                      </Button>
                    )}
                  </div>
                </div>
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-medium"
                  style={{ background: `${STATUS_COLORS[r.status]}22`, color: STATUS_COLORS[r.status] }}
                >
                  {r.status}
                </span>
              </div>
            ))}
            {filteredRuns.length === 0 && (
              <div className="text-xs text-slate-500">No runs in this range.</div>
            )}
          </CardContent>
        </Card>
        )}
      </div>
    </div>
  );
}
