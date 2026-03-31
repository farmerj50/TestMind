import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useUser } from "@clerk/clerk-react";
import {
  Activity,
  BarChart3,
  Bot,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileCode2,
  FolderKanban,
  Github,
  LayoutDashboard,
  Link2,
  Loader2,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { validateProject } from "../lib/validation";
import ConnectGitHubCard from "../components/ConnectGitHubCard";
import RunNowButton from "../components/RunNowButton";
import AdapterDropdown, { AdapterId } from "../components/AdapterDropdown";
import GenerateButton from "../components/GenerateButton";
import GeneratedTestsPanel from "../components/GeneratedTestsPanel";
import HowToHint from "../components/HowToHint";

type Project = {
  id: string;
  name: string;
  repoUrl?: string;
  ownerId: string;
  createdAt: string;
};

type Summary = {
  counts: {
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    total: number;
  };
  healedCount?: number;
  lastRun?: {
    id: string;
    status: "queued" | "running" | "succeeded" | "failed";
    createdAt: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    projectId: string;
    summary?: string | null;
    error?: string | null;
  } | null;
};

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

type ActivityEntry = {
  id: string;
  title: string;
  detail: string;
  at: string;
  tone: "emerald" | "rose" | "amber" | "blue" | "slate";
};

const EMPTY_COUNTS = {
  queued: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  total: 0,
};

const panelClass = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";

function formatDateTime(value?: string | null) {
  if (!value) return "No activity yet";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTime(value?: string | null) {
  if (!value) return "No runs yet";
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelative(value?: string | null) {
  if (!value) return "Just now";
  const diffMinutes = Math.round((new Date(value).getTime() - Date.now()) / 60000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, "minute");
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return formatter.format(diffHours, "hour");
  return formatter.format(Math.round(diffHours / 24), "day");
}

function percent(value: number, total: number) {
  if (!total) return 0;
  return Math.round((value / total) * 100);
}

function getDomainLabel(url?: string) {
  if (!url) return "No repo linked";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getProjectInitial(name: string) {
  return name.trim().charAt(0).toUpperCase() || "T";
}

function getStatusLabel(status: Run["status"] | NonNullable<Summary["lastRun"]>["status"]) {
  if (status === "succeeded") return "Passed";
  if (status === "failed") return "Failed";
  if (status === "running") return "Running";
  return "Queued";
}

function getStatusTone(status: Run["status"] | NonNullable<Summary["lastRun"]>["status"]) {
  if (status === "succeeded") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "failed") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "running") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function getStatusDot(status: Run["status"] | NonNullable<Summary["lastRun"]>["status"]) {
  if (status === "succeeded") return "bg-emerald-500";
  if (status === "failed") return "bg-rose-500";
  if (status === "running") return "bg-blue-500";
  return "bg-amber-500";
}

function clampWidth(value: number) {
  return Math.max(value, value === 0 ? 0 : 6);
}

function truncateText(value?: string | null, limit = 64) {
  if (!value) return null;
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 3)}...`;
}

function DashboardSection({
  eyebrow,
  title,
  actions,
  children,
}: {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={panelClass}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">{eyebrow}</p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">{title}</h2>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}) {
  return (
    <div className={`rounded-2xl border px-4 py-3 ${tone}`}>
      <div className="text-xs uppercase tracking-[0.14em] opacity-80">{label}</div>
      <div className="mt-2 text-3xl font-semibold">{value}</div>
    </div>
  );
}

export default function DashboardPage() {
  const [adapterId, setAdapterId] = useState<AdapterId>(
    (localStorage.getItem("tm-adapterId") as AdapterId) || "playwright-ts"
  );
  const location = useLocation();
  const { user } = useUser();
  const { apiFetch } = useApi();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [githubSuccess, setGithubSuccess] = useState<string | null>(null);
  const [dashboardSummary, setDashboardSummary] = useState<Summary | null>(null);
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);
  const [dashboardErr, setDashboardErr] = useState<string | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [projectSummaries, setProjectSummaries] = useState<Record<string, Summary | null>>({});
  const [runningAll, setRunningAll] = useState(false);
  const [maxSpecsLimit, setMaxSpecsLimit] = useState<number | undefined>(undefined);
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [formErrors, setFormErrors] = useState<{ name?: string; repoUrl?: string }>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [genRefresh, setGenRefresh] = useState(0);
  const telemetrySentRef = useRef(false);
  const workspaceSetupRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    localStorage.setItem("tm-adapterId", adapterId);
  }, [adapterId]);

  async function loadProjects() {
    setErr(null);
    setLoading(true);
    try {
      const data = await apiFetch<{ projects: Project[] }>("/projects");
      setProjects(data.projects);
    } catch (e: any) {
      setErr(e.message || "Failed to fetch projects");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!user?.id) return;
    loadProjects();
    apiFetch<{ plan: string | null }>("/billing/me")
      .then((data) => setPlan(data.plan))
      .catch(() => {});
  }, [user?.id, apiFetch]);

  useEffect(() => {
    if (!user?.id || telemetrySentRef.current) return;
    telemetrySentRef.current = true;
    apiFetch("/telemetry/events", {
      method: "POST",
      body: JSON.stringify({
        event: "page_view_dashboard",
        properties: { path: "/dashboard" },
      }),
    }).catch(() => {});
  }, [apiFetch, user?.id]);

  useEffect(() => {
    const userId = user?.id;
    if (!userId || loading || projects.length > 0) return;
    const key = `tm:github-cleaned:${userId}`;
    if (localStorage.getItem(key)) return;
    (async () => {
      try {
        await apiFetch("/auth/github/reset", { method: "POST", auth: "include" }).catch(() => {});
        await apiFetch("/github/status", { method: "DELETE", auth: "include" }).catch(() => {});
      } finally {
        localStorage.setItem(key, "1");
      }
    })();
  }, [user?.id, loading, projects.length, apiFetch]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("github") === "connected") {
      setGithubSuccess("GitHub connected successfully");
    }
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!githubSuccess) return;
    const timer = setTimeout(() => setGithubSuccess(null), 6000);
    return () => clearTimeout(timer);
  }, [githubSuccess]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    let timer: number | null = null;

    const loadSnapshot = async () => {
      try {
        const [summary, runs] = await Promise.all([
          apiFetch<Summary>("/reports/summary"),
          apiFetch<{ runs: Run[] }>("/reports/recent"),
        ]);
        if (cancelled) return;

        const nextRuns = runs.runs || [];
        const hasActive =
          summary.counts.running > 0 ||
          summary.counts.queued > 0 ||
          nextRuns.some((run) => run.status === "running" || run.status === "queued");

        setDashboardSummary(summary);
        setRecentRuns(nextRuns);
        setDashboardErr(null);
        setDashboardLoading(false);
        timer = window.setTimeout(loadSnapshot, hasActive ? 1500 : 10000);
      } catch (e: any) {
        if (cancelled) return;
        setDashboardErr(e.message || "Failed to load dashboard data");
        setDashboardLoading(false);
        timer = window.setTimeout(loadSnapshot, 10000);
      }
    };

    loadSnapshot();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [apiFetch, refreshKey, user?.id]);

  useEffect(() => {
    if (!user?.id || projects.length === 0) {
      setProjectSummaries({});
      return;
    }

    let cancelled = false;

    (async () => {
      const entries = await Promise.all(
        projects.map(async (project) => {
          try {
            const summary = await apiFetch<Summary>(
              `/reports/summary?projectId=${encodeURIComponent(project.id)}`
            );
            return [project.id, summary] as const;
          } catch {
            return [project.id, null] as const;
          }
        })
      );

      if (!cancelled) {
        setProjectSummaries(Object.fromEntries(entries));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiFetch, projects, refreshKey, user?.id]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const validation = validateProject({ name, repoUrl: repoUrl.trim() || undefined });
    if (!validation.ok) {
      setFormErrors(validation.errors);
      return;
    }
    setFormErrors({});
    try {
      await apiFetch<{ project: Project }>("/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          ...(repoUrl.trim() ? { repoUrl: repoUrl.trim() } : {}),
        }),
      });
      setName("");
      setRepoUrl("");
      await loadProjects();
    } catch (e: any) {
      setErr(e.message || "Failed to create project");
    }
  }

  async function deleteProject(id: string, projectName: string) {
    if (!confirm(`Delete "${projectName}"? This cannot be undone.`)) return;
    try {
      await apiFetch(`/projects/${id}`, { method: "DELETE" });
      setProjects((current) => current.filter((project) => project.id !== id));
    } catch (e: any) {
      setErr(e.message || "Failed to delete project");
    }
  }

  async function runAllTests() {
    if (!projects.length || runningAll) return;
    setRunningAll(true);
    setErr(null);
    try {
      for (const project of projects) {
        await apiFetch<{ id: string }>("/runner/run", {
          method: "POST",
          body: JSON.stringify({
            projectId: project.id,
            adapterId,
            runAll: true,
            ...(maxSpecsLimit ? { maxSpecs: maxSpecsLimit } : {}),
          }),
        });
      }
      setRefreshKey((value) => value + 1);
    } catch (e: any) {
      setErr(e.message || "Failed to queue all project runs");
    } finally {
      setRunningAll(false);
    }
  }

  const hasProjects = projects.length > 0;
  const counts = dashboardSummary?.counts ?? EMPTY_COUNTS;
  const healedCount = dashboardSummary?.healedCount ?? 0;
  const passRate = percent(counts.succeeded, counts.total);
  const linkedProjects = projects.filter((project) => Boolean(project.repoUrl?.trim())).length;

  const projectCards = useMemo(
    () =>
      projects.map((project) => {
        const summary = projectSummaries[project.id];
        const projectCounts = summary?.counts ?? EMPTY_COUNTS;
        return {
          project,
          summary,
          counts: projectCounts,
          passRate: percent(projectCounts.succeeded, projectCounts.total),
        };
      }),
    [projectSummaries, projects]
  );

  const projectsWithRuns = projectCards.filter((entry) => Boolean(entry.summary?.lastRun)).length;
  const lowestPassProject = [...projectCards]
    .filter((entry) => entry.counts.total > 0)
    .sort((left, right) => {
      if (right.counts.failed !== left.counts.failed) return right.counts.failed - left.counts.failed;
      return left.passRate - right.passRate;
    })[0];

  const coverageScore = hasProjects
    ? Math.round(
        (percent(linkedProjects, projects.length) +
          percent(projectsWithRuns, projects.length) +
          passRate) /
          3
      )
    : 0;

  const topIssues = useMemo(() => {
    const items: string[] = [];
    if (counts.failed > 0) items.push(`${counts.failed} tests failed in the latest run snapshot`);
    if (lowestPassProject && lowestPassProject.counts.failed > 0) {
      items.push(`${lowestPassProject.project.name} is the current failure hotspot`);
    }
    if (counts.running + counts.queued > 0) items.push(`${counts.running + counts.queued} runs are still active`);
    if (hasProjects && linkedProjects < projects.length) {
      items.push(`${projects.length - linkedProjects} projects still need a repo link`);
    }
    return items.slice(0, 3);
  }, [counts.failed, counts.queued, counts.running, hasProjects, linkedProjects, lowestPassProject, projects.length]);

  const failureHotspots = useMemo(
    () =>
      [...projectCards]
        .filter((entry) => entry.counts.failed > 0)
        .sort((left, right) => right.counts.failed - left.counts.failed)
        .slice(0, 3),
    [projectCards]
  );

  const workspaceHealth = useMemo(() => {
    if (passRate >= 85) {
      return {
        label: "Healthy",
        tone: "text-emerald-700",
        badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
        bar: "bg-emerald-500",
      };
    }
    if (passRate >= 50) {
      return {
        label: "Warning",
        tone: "text-amber-700",
        badge: "border-amber-200 bg-amber-50 text-amber-700",
        bar: "bg-amber-500",
      };
    }
    return {
      label: "Critical",
      tone: "text-rose-700",
      badge: "border-rose-200 bg-rose-50 text-rose-700",
      bar: "bg-rose-500",
    };
  }, [passRate]);

  const insights = useMemo(() => {
    const next: string[] = [];
    if (counts.failed > 0) {
      next.push(
        lowestPassProject
          ? `${lowestPassProject.project.name} is dragging down stability at ${lowestPassProject.passRate}% pass rate.`
          : `${counts.failed} failures still need review.`
      );
    } else {
      next.push("The latest workspace snapshot is clean, so this is a good moment to expand coverage.");
    }
    if (counts.running > 0 || counts.queued > 0) {
      next.push(`${counts.running + counts.queued} runs are active right now, so results will keep changing.`);
    } else {
      next.push("No active runs are blocking triage, so you can review failures or generate more tests.");
    }
    if (linkedProjects < projects.length) {
      next.push("Link the remaining repositories to unlock repo-aware scans and imports.");
    } else if (hasProjects) {
      next.push("All projects already have repo links, so the next leverage point is recorder and locator cleanup.");
    } else {
      next.push("Create the first project, then connect a repo to light up the rest of the dashboard.");
    }
    return next;
  }, [counts.failed, counts.queued, counts.running, hasProjects, linkedProjects, lowestPassProject, projects.length]);

  const projectNames = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.name])),
    [projects]
  );

  const activityFeed = useMemo(() => {
    const runItems: ActivityEntry[] = recentRuns.slice(0, 5).map((run) => ({
      id: `run-${run.id}`,
      title:
        run.status === "failed"
          ? `${projectNames[run.projectId] || "Project"} failed run`
          : run.status === "succeeded"
          ? `${projectNames[run.projectId] || "Project"} clean run`
          : run.status === "running"
          ? `${projectNames[run.projectId] || "Project"} running tests`
          : `${projectNames[run.projectId] || "Project"} queued run`,
      detail:
        run.status === "failed"
          ? `Run ${run.id.slice(0, 8)} - ${truncateText(run.summary) || "Open the report for details"}`
          : `Run ${run.id.slice(0, 8)} - ${truncateText(run.summary) || "Open the report for details"}`,
      at: run.createdAt,
      tone:
        run.status === "failed"
          ? "rose"
          : run.status === "succeeded"
          ? "emerald"
          : run.status === "running"
          ? "blue"
          : "amber",
    }));

    const projectItems: ActivityEntry[] = projects.slice(0, 5).map((project) => ({
      id: `project-${project.id}`,
      title: `Project created: ${project.name}`,
      detail: project.repoUrl ? `Repo linked: ${getDomainLabel(project.repoUrl)}` : "Repo link pending",
      at: project.createdAt,
      tone: "slate",
    }));

    return [...runItems, ...projectItems]
      .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
      .slice(0, 6);
  }, [projectNames, projects, recentRuns]);

  const primaryProjectId = projects[0]?.id;
  const primaryAttentionProjectId = lowestPassProject?.project.id || primaryProjectId;

  return (
    <>
      {githubSuccess ? (
        <div className="fixed right-4 top-4 z-50 flex w-full max-w-sm items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 shadow-lg">
          <span className="flex-1">{githubSuccess}</span>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setGithubSuccess(null)}
            className="rounded-full p-1 text-emerald-700 hover:text-emerald-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
          >
            x
          </button>
        </div>
      ) : null}

      <div className="space-y-6 px-4 pb-8">
        <header className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-slate-950 text-sm font-semibold text-white">
                  TM
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                    TestMind Dashboard
                  </p>
                  <h1 className="mt-2 text-3xl font-semibold text-slate-950">Workspace: TestMind AI</h1>
                  <p className="mt-2 text-sm text-slate-600">
                    Framework: {adapterId} {plan ? `- ${plan}` : ""}
                  </p>
                </div>
              </div>
              <p className="max-w-3xl text-sm text-slate-600">
                Keep the dashboard focused on problems first, actions second, and details third.
              </p>
            </div>

            <div className="flex max-w-xl flex-col gap-4 xl:items-end">
              <div className="flex flex-wrap items-center gap-3 xl:justify-end">
                <HowToHint
                  storageKey="tm-howto-dashboard"
                  title="How to use the Dashboard"
                  steps={[
                    "Create a project and link its repo URL to get started.",
                    "Use Generate to draft tests and Run to trigger a test run.",
                    "Review failures, scans, and locator issues from the priority cards.",
                    "Keep generated tests in preview mode here, then open the builder when you need the full view.",
                  ]}
                />
                <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                  Framework
                </span>
                <AdapterDropdown value={adapterId} onChange={setAdapterId} />
              </div>

              <div className="flex flex-wrap gap-3">
                <div className="flex items-center gap-2">
                  <Button
                    onClick={runAllTests}
                    disabled={!hasProjects || runningAll}
                    className="bg-slate-950 text-white hover:bg-slate-800"
                  >
                    {runningAll ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="mr-2 h-4 w-4" />
                    )}
                    {runningAll ? "Queueing runs..." : "Run All Tests"}
                  </Button>
                  <Select
                    value={maxSpecsLimit ? String(maxSpecsLimit) : "all"}
                    onValueChange={(v) => setMaxSpecsLimit(v === "all" ? undefined : Number(v))}
                  >
                    <SelectTrigger className="h-9 w-[110px] text-xs">
                      <SelectValue placeholder="Specs limit" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All specs</SelectItem>
                      <SelectItem value="10">10 specs</SelectItem>
                      <SelectItem value="25">25 specs</SelectItem>
                      <SelectItem value="50">50 specs</SelectItem>
                      <SelectItem value="100">100 specs</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button asChild variant="outline">
                  <Link to={primaryProjectId ? `/agent?projectId=${primaryProjectId}` : "/agent"}>
                    <Bot className="mr-2 h-4 w-4" />
                    Scan Site
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link to="/recorder">
                    <FileCode2 className="mr-2 h-4 w-4" />
                    Record Test
                  </Link>
                </Button>
              </div>

              <p className="text-xs text-slate-500">
                Last run: {formatTime(dashboardSummary?.lastRun?.createdAt)}
              </p>
            </div>
          </div>
        </header>

        {err ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {err}
          </div>
        ) : null}

        {dashboardErr ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {dashboardErr}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-2">
          <DashboardSection
            eyebrow="Run Status Overview"
            title="Instant health check"
            actions={
              <div className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
                {dashboardLoading ? "Syncing..." : `Last run ${formatTime(dashboardSummary?.lastRun?.createdAt)}`}
              </div>
            }
          >
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <MetricCard label="Total Tests" value={counts.total} tone="border-slate-200 bg-slate-50 text-slate-950" />
              <MetricCard label="Pass" value={counts.succeeded} tone="border-emerald-200 bg-emerald-50 text-emerald-700" />
              <MetricCard label="Fail" value={counts.failed} tone="border-rose-200 bg-rose-50 text-rose-700" />
              <MetricCard label="Running" value={counts.running} tone="border-blue-200 bg-blue-50 text-blue-700" />
              <MetricCard label="Queued" value={counts.queued} tone="border-amber-200 bg-amber-50 text-amber-700" />
            </div>

            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-slate-700">Workspace Health</div>
                  <div className={`mt-1 text-sm font-semibold ${workspaceHealth.tone}`}>
                    {workspaceHealth.label}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-semibold text-slate-950">{passRate}%</div>
                  <div className="text-sm text-slate-500">Passing</div>
                </div>
              </div>
              <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-200">
                <div
                  className={`h-full rounded-full ${workspaceHealth.bar}`}
                  style={{ width: `${clampWidth(passRate)}%` }}
                />
              </div>
              <div className="mt-3 text-sm text-slate-600">
                {counts.total
                  ? `${counts.succeeded} passing results out of ${counts.total} recent outcomes.`
                  : "Run a suite to start measuring pass rate."}
              </div>
              {healedCount > 0 && (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                  {healedCount} {healedCount === 1 ? "test" : "tests"} self-healed and passing
                </div>
              )}
            </div>
          </DashboardSection>

          <DashboardSection
            eyebrow="Workspace Alert"
            title={
              counts.failed > 0
                ? `${counts.failed} tests failing across projects`
                : "No critical failures right now"
            }
          >
            <div className="space-y-3">
              {lowestPassProject?.counts.failed ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  Largest failure cluster: {lowestPassProject.project.name} ({lowestPassProject.counts.failed} failures)
                </div>
              ) : null}
              {topIssues.length ? (
                topIssues.map((issue) => (
                  <div
                    key={issue}
                    className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700"
                  >
                    {issue}
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                  Everything looks healthy. This is a good moment to expand coverage or record new flows.
                </div>
              )}
            </div>

            {failureHotspots.length ? (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                  Failure Hotspots
                </div>
                <div className="mt-3 space-y-2">
                  {failureHotspots.map((entry) => (
                    <div
                      key={entry.project.id}
                      className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    >
                      <span className="font-medium text-slate-900">{entry.project.name}</span>
                      <span className="text-rose-700">{entry.counts.failed} failures</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap gap-3">
              <Button asChild className="bg-slate-950 text-white hover:bg-slate-800">
                <Link to="/reports">View Failures</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to={primaryAttentionProjectId ? `/locators?projectId=${primaryAttentionProjectId}` : "/locators"}>
                  Fix Locators
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/qa-agent">Run Self-Heal</Link>
              </Button>
            </div>
          </DashboardSection>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.3fr,0.7fr]">
          <DashboardSection
            eyebrow="Projects"
            title="Project health and actions"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link to="/projects">Open Projects</Link>
              </Button>
            }
          >
            <div className="space-y-4">
              {loading ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                  Loading projects...
                </div>
              ) : projectCards.length ? (
                projectCards.map(({ project, summary, counts: projectCounts, passRate: projectPassRate }) => (
                  <article key={project.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-start gap-4">
                          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-slate-950 text-sm font-semibold text-white">
                            {getProjectInitial(project.name)}
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Link
                                to={`/projects/${project.id}`}
                                className="truncate text-lg font-semibold text-slate-950 hover:underline"
                              >
                                {project.name}
                              </Link>
                              <span
                                className={`rounded-full border px-2.5 py-1 text-xs ${
                                  projectCounts.total
                                    ? projectPassRate >= 80
                                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                      : projectPassRate >= 50
                                      ? "border-amber-200 bg-amber-50 text-amber-700"
                                      : "border-rose-200 bg-rose-50 text-rose-700"
                                    : "border-slate-200 bg-white text-slate-600"
                                }`}
                              >
                                {projectCounts.total ? `Pass Rate ${projectPassRate}%` : "No runs yet"}
                              </span>
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-500">
                              <span className="inline-flex items-center gap-1.5">
                                <Github className="h-4 w-4" />
                                {getDomainLabel(project.repoUrl)}
                              </span>
                              <span className="inline-flex items-center gap-1.5">
                                <Clock3 className="h-4 w-4" />
                                Last run {summary?.lastRun ? formatRelative(summary.lastRun.createdAt) : "pending"}
                              </span>
                              <span className="inline-flex items-center gap-1.5">
                                <BarChart3 className="h-4 w-4" />
                                {projectCounts.failed} failed / {projectCounts.succeeded} passed
                              </span>
                            </div>
                            <div className="mt-2 text-sm text-slate-600">
                              {projectCounts.failed > 0 ? (
                                <span>
                                  Failure hotspot: {truncateText(summary?.lastRun?.summary, 58) || "Open reports for the root cause"}
                                </span>
                              ) : (
                                <span>Failure hotspot: none detected in the latest snapshot</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <RunNowButton
                          projectId={project.id}
                          adapterId={adapterId}
                          maxSpecs={maxSpecsLimit}
                          onDone={() => setRefreshKey((value) => value + 1)}
                          size="sm"
                        />
                        <Button asChild variant="outline" size="sm">
                          <Link to="/reports">Reports</Link>
                        </Button>
                        <Button asChild variant="outline" size="sm">
                          <Link to={`/agent?projectId=${project.id}`}>
                            <Bot className="mr-2 h-4 w-4" />
                            Scan
                          </Link>
                        </Button>
                        <Button asChild variant="outline" size="sm">
                          <Link to={`/projects/${project.id}`}>
                            <Pencil className="mr-2 h-4 w-4" />
                            View
                          </Link>
                        </Button>
                        <GenerateButton
                          projectId={project.id}
                          onDone={() => setGenRefresh((value) => value + 1)}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Delete project"
                          aria-label="Delete project"
                          onClick={() => deleteProject(project.id, project.name)}
                        >
                          <Trash2 className="h-4 w-4 text-rose-600" />
                        </Button>
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
                  <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white text-slate-700 shadow-sm">
                    <FolderKanban className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-slate-950">No projects yet</h3>
                  <p className="mt-2 text-sm text-slate-500">
                    Create a project in the setup panel to start generating tests and queueing runs.
                  </p>
                </div>
              )}
            </div>
          </DashboardSection>

          <div ref={workspaceSetupRef} className="space-y-6">
            <DashboardSection eyebrow="Workspace Setup" title="Create a project">
              <form onSubmit={createProject} className="space-y-4">
                <div>
                  <label className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                    Project Name
                  </label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. checkout-flow"
                    className="mt-2"
                  />
                  {formErrors.name ? (
                    <p className="mt-1 text-xs text-rose-600">{formErrors.name}</p>
                  ) : null}
                </div>

                <div>
                  <label className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                    Repository URL
                  </label>
                  <Input
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="https://github.com/acme/checkout"
                    className="mt-2"
                  />
                  {formErrors.repoUrl ? (
                    <p className="mt-1 text-xs text-rose-600">{formErrors.repoUrl}</p>
                  ) : null}
                </div>

                <Button type="submit" className="w-full bg-slate-950 text-white hover:bg-slate-800">
                  <Plus className="mr-2 h-4 w-4" />
                  Create Project
                </Button>
              </form>
            </DashboardSection>

            <ConnectGitHubCard onPickRepo={(url) => setRepoUrl(url)} />
          </div>
        </div>

        {hasProjects ? (
          <GeneratedTestsPanel compact key={`${adapterId}:${genRefresh}`} />
        ) : (
          <DashboardSection eyebrow="Generated Tests" title="Preview only">
            <p className="text-sm text-slate-500">
              Generate a suite from a project card and the compact preview will appear here.
            </p>
          </DashboardSection>
        )}

        <div className="grid gap-6 xl:grid-cols-2">
          <DashboardSection eyebrow="Quick Actions" title="Common workflows">
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                {
                  title: "Scan Website",
                  description: "Automatically generate test suggestions from an agent scan.",
                  to: primaryProjectId ? `/agent?projectId=${primaryProjectId}` : "/agent",
                  icon: Bot,
                  iconTone: "bg-blue-50 text-blue-700",
                },
                {
                  title: "Record Test",
                  description: "Open the recorder and save a new spec.",
                  to: "/recorder",
                  icon: FileCode2,
                  iconTone: "bg-rose-50 text-rose-700",
                },
                {
                  title: "Create Test Suite",
                  description: "Open the builder for a curated suite workflow.",
                  to: "/test-builder",
                  icon: LayoutDashboard,
                  iconTone: "bg-emerald-50 text-emerald-700",
                },
              ].map((item) => (
                <Link
                  key={item.title}
                  to={item.to}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:bg-white"
                >
                  <div className="flex items-center gap-3">
                    <div className={`grid h-10 w-10 place-items-center rounded-2xl ${item.iconTone}`}>
                      <item.icon className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="font-semibold text-slate-950">{item.title}</div>
                      <div className="mt-1 text-sm text-slate-500">{item.description}</div>
                    </div>
                  </div>
                </Link>
              ))}

              <button
                type="button"
                onClick={() => workspaceSetupRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-left transition hover:bg-white"
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-2xl bg-amber-50 text-amber-700">
                    <Link2 className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="font-semibold text-slate-950">Import GitHub Repo</div>
                    <div className="mt-1 text-sm text-slate-500">
                      Jump to the setup rail and connect a repository without leaving the dashboard.
                    </div>
                  </div>
                </div>
              </button>
            </div>
          </DashboardSection>

          <DashboardSection eyebrow="Workspace Health" title="Readiness and coverage">
            <div className="space-y-4">
              {[
                {
                  label: "Repositories linked",
                  value: percent(linkedProjects, projects.length || 1),
                  detail: `${linkedProjects} of ${projects.length || 0} projects connected`,
                  tone: "bg-blue-500",
                },
                {
                  label: "Projects with run history",
                  value: percent(projectsWithRuns, projects.length || 1),
                  detail: `${projectsWithRuns} of ${projects.length || 0} projects have recorded runs`,
                  tone: "bg-emerald-500",
                },
                {
                  label: "Workspace pass rate",
                  value: passRate,
                  detail: counts.total
                    ? `${counts.succeeded} passing results in the current snapshot`
                    : "No run data yet",
                  tone:
                    passRate >= 80
                      ? "bg-emerald-500"
                      : passRate >= 50
                      ? "bg-amber-500"
                      : "bg-rose-500",
                },
              ].map((item) => (
                <div key={item.label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex items-center justify-between text-sm font-medium text-slate-700">
                    <span>{item.label}</span>
                    <span>{item.value}%</span>
                  </div>
                  <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-200">
                    <div className={`h-full rounded-full ${item.tone}`} style={{ width: `${clampWidth(item.value)}%` }} />
                  </div>
                  <p className="mt-3 text-sm text-slate-500">{item.detail}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-4">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                Coverage Score
              </div>
              <div className="mt-2 text-3xl font-semibold text-slate-950">{coverageScore}%</div>
            </div>
          </DashboardSection>
        </div>

        <DashboardSection
          eyebrow="Activity Feed"
          title="Recent project and run activity"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link to="/reports">
                Open Reports
                <ExternalLink className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          }
        >
          <div className="space-y-3">
            {activityFeed.length ? (
              activityFeed.map((item) => {
                const toneClass =
                  item.tone === "emerald"
                    ? "bg-emerald-500"
                    : item.tone === "rose"
                    ? "bg-rose-500"
                    : item.tone === "amber"
                    ? "bg-amber-500"
                    : item.tone === "blue"
                    ? "bg-blue-500"
                    : "bg-slate-400";

                const icon =
                  item.tone === "emerald" ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : item.tone === "rose" ? (
                    <XCircle className="h-4 w-4 text-rose-600" />
                  ) : item.tone === "amber" ? (
                    <TriangleAlert className="h-4 w-4 text-amber-600" />
                  ) : item.tone === "blue" ? (
                    <Activity className="h-4 w-4 text-blue-600" />
                  ) : (
                    <Clock3 className="h-4 w-4 text-slate-500" />
                  );

                return (
                  <div
                    key={item.id}
                    className="flex items-start justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${toneClass}`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium text-slate-950">
                          {icon}
                          <span className={`truncate ${item.tone === "rose" ? "text-rose-700" : "text-slate-950"}`}>
                            {item.title}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-slate-500">{item.detail}</p>
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-slate-500">{formatRelative(item.at)}</span>
                  </div>
                );
              })
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                No activity yet. Project creation and runs will start filling this feed automatically.
              </div>
            )}
          </div>
        </DashboardSection>

        {hasProjects ? (
          <Button
            onClick={runAllTests}
            disabled={runningAll}
            className="fixed bottom-6 right-6 z-40 rounded-full bg-slate-950 px-5 py-6 text-white shadow-lg hover:bg-slate-800"
          >
            {runningAll ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {runningAll ? "Running..." : "Run Tests"}
          </Button>
        ) : null}
      </div>
    </>
  );
}
