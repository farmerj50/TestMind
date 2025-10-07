// apps/web/src/pages/DashboardPage.tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useUser } from "@clerk/clerk-react";
import { useApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2, Pencil } from "lucide-react";
import { validateProject } from "@/lib/validation";
import ConnectGitHubCard from "@/components/ConnectGitHubCard";


type Project = {
  id: string;
  name: string;
  repoUrl: string;
  ownerId: string;
  createdAt: string;
};

export default function DashboardPage() {
  const { user } = useUser();
  const { apiFetch } = useApi();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // form state
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [formErrors, setFormErrors] = useState<{ name?: string; repoUrl?: string }>({});

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);

    // client-side validation
    const v = validateProject({ name, repoUrl });
    if (!v.ok) {
      setFormErrors(v.errors);
      return; // stop if invalid
    }
    setFormErrors({}); // clear any previous errors

    try {
      await apiFetch<{ project: Project }>("/projects", {
        method: "POST",
        body: JSON.stringify({ name, repoUrl }),
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
      </header>

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
        <label className="text-xs text-slate-600">Repository URL</label>
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
              <a
                href={p.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="break-all text-xs text-slate-500 underline"
              >
                {p.repoUrl}
              </a>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Button asChild variant="ghost" size="icon" title="Edit">
                <Link to={`/projects/${p.id}`}>
                  <Pencil className="h-4 w-4" />
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Delete"
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
</div>

    </div>
  );
}
