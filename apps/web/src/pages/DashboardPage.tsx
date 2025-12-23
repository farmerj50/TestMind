// apps/web/src/pages/DashboardPage.tsx
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useUser } from "@clerk/clerk-react";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Trash2, Pencil, Bot } from "lucide-react";
import { validateProject } from "../lib/validation";
import ConnectGitHubCard from "../components/ConnectGitHubCard";
import ReportSummary from "../components/ReportSummary";
import RecentRunsTable from "../components/RecentRunsTable";
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

export default function DashboardPage() {
  const [adapterId, setAdapterId] = useState<AdapterId>(
    (localStorage.getItem("tm-adapterId") as AdapterId) || "playwright-ts"
  );
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useUser();
  const { apiFetch } = useApi();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [githubSuccess, setGithubSuccess] = useState<string | null>(null);

  // form state
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [formErrors, setFormErrors] = useState<{ name?: string; repoUrl?: string }>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [genRefresh, setGenRefresh] = useState(0);
  useEffect(() => {
    localStorage.setItem("tm-adapterId", adapterId);
  }, [adapterId]);

  async function load() {
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
    load();
    apiFetch<{ plan: string }>("/billing/me")
      .then((d) => setPlan(d.plan))
      .catch(() => { });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("github") === "connected") {
      setGithubSuccess("GitHub connected successfully");
      params.delete("github");
      const search = params.toString();
      navigate(
        {
          pathname: location.pathname,
          search: search ? `?${search}` : "",
        },
        { replace: true }
      );
    }
  }, [location.pathname, location.search, navigate]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    const v = validateProject({ name, repoUrl: repoUrl.trim() || undefined });
    if (!v.ok) {
      setFormErrors(v.errors);
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
      await load();
    } catch (e: any) {
      setErr(e.message || "Failed to create project");
    }
  }

  async function deleteProject(id: string, projectName: string) {
    if (!confirm(`Delete “${projectName}”? This cannot be undone.`)) return;
    try {
      await apiFetch(`/projects/${id}`, { method: "DELETE" });
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (e: any) {
      setErr(e.message || "Failed to delete project");
    }
  }

  return (
    <div className="px-4">
      <header className="mb-6 flex items-center gap-3">
        <div className="grid h-8 w-8 place-items-center rounded bg-slate-900 font-semibold text-white">
          TM
        </div>
        <div className="text-slate-700">TestMind</div>
        {plan && (
          <span className="ml-2 rounded-full border px-2 py-0.5 text-xs text-slate-600 bg-white">
            {plan}
          </span>
        )}
        {/* push the framework selector to the far right */}
        <div className="ml-auto flex items-center gap-2">
          <HowToHint
            storageKey="tm-howto-dashboard"
            title="How to use the Dashboard"
            steps={[
              "Create a project and link its repo URL to get started.",
              "Use Generate to draft tests and Run to trigger a test run.",
              "View recent runs and summaries to monitor status.",
              "Scan with the agent for new scenarios when needed.",
            ]}
          />
          <span className="text-xs text-slate-500">Framework:</span>
          <AdapterDropdown value={adapterId} onChange={setAdapterId} />
        </div>
      </header>

      {githubSuccess && (
        <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {githubSuccess}
        </div>
      )}


      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-1 text-slate-600">
        Good morning{user?.firstName ? `, ${user.firstName}` : ""}! Create a project and link your
        repository to get started.
      </p>

      <div className="mt-6 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {/* New project */}
        <div className="rounded-lg border bg-white p-4">
          <h2 className="mb-3 text-sm font-medium text-slate-800">New project</h2>
          <form onSubmit={createProject} className="space-y-3">
            <div>
              <label className="text-xs text-slate-600">Project name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. checkout-flow"
              />
              {formErrors.name && (
                <p className="mt-1 text-xs text-rose-600">{formErrors.name}</p>
              )}
            </div>

            <div>
              <label className="text-xs text-slate-600">Repository URL (optional)</label>
              <Input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/acme/checkout"
              />
              {formErrors.repoUrl && (
                <p className="mt-1 text-xs text-rose-600">{formErrors.repoUrl}</p>
              )}
            </div>

            {err && (
              <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {err}
              </div>
            )}

            <Button type="submit">Create project</Button>
          </form>
        </div>

        {/* GitHub connect / repo picker */}
        <ConnectGitHubCard onPickRepo={(url) => setRepoUrl(url)} />

        {/* Reporting summary */}
        <div className="rounded-lg border border-slate-300 bg-white p-4 md:col-span-2 xl:col-span-1">
          <h2 className="mb-3 text-sm font-medium text-slate-800">Test run summary</h2>
          <ReportSummary refreshKey={refreshKey} />
        </div>

        {/* My projects */}
        <div className="rounded-lg border bg-white p-4 xl:col-span-1 md:col-span-2">
          <h2 className="mb-3 text-sm font-medium text-slate-800">Your projects</h2>

          {loading ? (
            <div className="text-sm text-slate-500">Loading…</div>
          ) : projects.length === 0 ? (
            <div className="text-sm text-slate-500">
              No projects yet. Create your first project on the left.
            </div>
          ) : (
            <ul className="divide-y">
              {projects.map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <Link
                      to={`/projects/${p.id}`}
                      className="block truncate font-medium text-slate-900 hover:underline"
                      title="Edit project"
                    >
                      {p.name}
                    </Link>
                    {p.repoUrl ? (
                      <a
                        href={p.repoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all text-xs text-slate-500 underline"
                      >
                        {p.repoUrl}
                      </a>
                    ) : (
                      <p className="text-xs text-slate-500">No repo linked</p>
                    )}
                  </div>

                  {/* Actions */}

                  <div className="flex shrink-0 items-center gap-1">
                    {/* Generate tests for this project */}
                    <GenerateButton
                      projectId={p.id}
                      onDone={() => setGenRefresh((k) => k + 1)}
                      
                    />
                    <RunNowButton
                      projectId={p.id}
                      onDone={() => setRefreshKey((k) => k + 1)}
                    />
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      title="Scan with agent"
                      aria-label="Scan with agent"
                    >
                      <Link to={`/agent?projectId=${p.id}`}>
                        <Bot className="h-4 w-4" />
                      </Link>
                    </Button>

                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      title="Edit"
                      aria-label="Edit project"
                    >
                      <Link to={`/projects/${p.id}`}>
                        <Pencil className="h-4 w-4" />
                      </Link>
                    </Button>

                    <Button
                      variant="ghost"
                      size="icon"
                      title="Delete"
                      aria-label="Delete project"
                      onClick={() => deleteProject(p.id, p.name)}
                    >
                      <Trash2 className="h-4 w-4 text-rose-600" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* Generated tests preview */}
        <GeneratedTestsPanel key={`${adapterId}:${genRefresh}`} />

        {/* Recent runs */}
        <div className="rounded-lg border bg-white p-4 md:col-span-2 xl:col-span-2">
          <h2 className="mb-3 text-sm font-medium text-slate-800">Recent runs</h2>
          <RecentRunsTable refreshKey={refreshKey} />
        </div>
      </div>
    </div>
  );
}
