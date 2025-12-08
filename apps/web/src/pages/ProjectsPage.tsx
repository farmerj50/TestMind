import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  FolderTree,
  ClipboardList,
  ListTree,
} from "lucide-react";

type Project = { id: string; name: string; repoUrl?: string; plan?: string };

export default function ProjectsPage() {
  const { apiFetch } = useApi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiFetch<{ projects: Project[] }>("/projects")
      .then((res) => {
        const list = (res.projects || []).sort((a, b) => a.name.localeCompare(b.name));
        setProjects(list);
        // open curated by default
        const init: Record<string, boolean> = {};
        list.forEach((p) => {
          if (p.name.toLowerCase().includes("curated")) init[p.id] = true;
        });
        setExpanded(init);
        setError(null);
      })
      .catch((err: any) => setError(err?.message ?? "Failed to load projects"))
      .finally(() => setLoading(false));
  }, [apiFetch]);

  const allExpanded = useMemo(
    () => projects.length > 0 && projects.every((p) => expanded[p.id]),
    [projects, expanded]
  );

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="p-6 space-y-4">
      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle className="text-slate-800">Projects (tree view)</CardTitle>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const all: Record<string, boolean> = {};
                projects.forEach((p) => (all[p.id] = true));
                setExpanded(all);
              }}
            >
              Expand all
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setExpanded({})}
              disabled={projects.length === 0}
            >
              Collapse all
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && <div className="text-sm text-slate-500">Loading…</div>}
          {error && <div className="text-sm text-rose-600">{error}</div>}
          {!loading && projects.length === 0 && (
            <div className="text-sm text-slate-500">No projects found.</div>
          )}
          {!loading && projects.length > 0 && (
            <div className="rounded border border-slate-200 bg-white">
              <ul className="divide-y">
                {projects.map((p) => {
                  const isOpen = expanded[p.id] ?? false;
                  return (
                    <li key={p.id} className="p-3">
                      <div className="flex items-start gap-3">
                        <button
                          className="mt-0.5 text-slate-700 hover:text-slate-900"
                          onClick={() => toggle(p.id)}
                          aria-label={isOpen ? "Collapse" : "Expand"}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                        <div className="flex items-center gap-2 text-slate-900 font-medium">
                          <Folder className="h-4 w-4 text-amber-500" />
                          <span>{p.name}</span>
                        </div>
                      </div>

                      {isOpen && (
                        <div className="mt-2 ml-7 space-y-2 text-sm text-slate-700">
                          <div className="flex items-center gap-2">
                            <FileText className="h-4 w-4 text-slate-500" />
                            <span className="text-xs uppercase text-slate-500">Repo</span>
                            {p.repoUrl ? (
                              <a
                                className="text-blue-700 underline inline-flex items-center gap-1"
                                href={p.repoUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {p.repoUrl}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : (
                              <span className="text-slate-500">—</span>
                            )}
                          </div>
                          <div className="pt-1 space-y-1">
                            <div className="flex items-center gap-2 text-slate-800">
                              <FolderTree className="h-4 w-4 text-amber-500" />
                              <span className="font-medium">Suites</span>
                            </div>
                            <div className="ml-6 flex flex-col gap-1 text-xs">
                              <Link
                                to={`/suite/${p.id}`}
                                className="text-blue-700 underline hover:text-blue-900"
                              >
                                Open suite (existing cases)
                              </Link>
                              <Link
                                to={`/projects/${p.id}`}
                                className="text-blue-700 underline hover:text-blue-900"
                              >
                                Edit project / cases
                              </Link>
                            </div>
                          </div>

                          <div className="pt-1 space-y-1">
                            <div className="flex items-center gap-2 text-slate-800">
                              <ListTree className="h-4 w-4 text-amber-500" />
                              <span className="font-medium">Existing test cases</span>
                            </div>
                            <div className="ml-6 flex flex-col gap-1 text-xs text-slate-700">
                              <span className="text-slate-600">
                                View and manage cases inside the suite (uses your current spec tree).
                              </span>
                              <span className="text-slate-500">
                                Examples: Login page loads, Empty email/password, Privacy policy link …
                              </span>
                            </div>
                          </div>

                          <div className="pt-1 space-y-1">
                            <div className="flex items-center gap-2 text-slate-800">
                              <ClipboardList className="h-4 w-4 text-amber-500" />
                              <span className="font-medium">Actions</span>
                            </div>
                            <div className="ml-6 flex flex-col gap-1 text-xs">
                              <span className="text-slate-600">Generate tests, link CI/CD, or run from QA agent.</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {!loading && projects.length > 0 && (
            <div className="text-xs text-slate-500">
              Showing {projects.length} projects. {allExpanded ? "All expanded." : "Expand a project to see details and actions."}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
