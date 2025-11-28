import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";

type AgentSession = {
  id: string;
  name?: string | null;
  baseUrl: string;
  status: string;
  projectId?: string | null;
  pageCount: number;
  updatedAt: string;
};

export default function AgentSessionsPage() {
  const { apiFetch } = useApi();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", baseUrl: "", instructions: "", projectId: "" });

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ sessions: AgentSession[] }>("/tm/agent/sessions");
      setSessions(res.sessions);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }

  async function loadProjects() {
    try {
      const res = await apiFetch<{ projects: Array<{ id: string; name: string }> }>("/projects");
      setProjects(res.projects);
      if (!form.projectId && res.projects.length) {
        setForm((f) => ({ ...f, projectId: res.projects[0].id }));
      }
    } catch (err: any) {
      console.error("Failed to load projects", err);
    }
  }

  useEffect(() => {
    load();
    loadProjects();
  }, []);

  async function createSession(e: React.FormEvent) {
    e.preventDefault();
    if (!form.baseUrl.trim()) {
      setError("Base URL is required");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await apiFetch("/tm/agent/sessions", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: form.baseUrl.trim(),
          name: form.name.trim() || undefined,
          instructions: form.instructions.trim() || undefined,
          projectId: form.projectId || undefined,
        }),
      });
      setForm((f) => ({ ...f, name: "", baseUrl: "", instructions: "" }));
      await load();
    } catch (err: any) {
      setError(err?.message ?? "Failed to create session");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Agent sessions</h1>
          <p className="text-sm text-slate-600">View and reopen recent agent scans.</p>
        </div>
        <Link to="/agent">
          <Button variant="outline">Scan a page</Button>
        </Link>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>New session</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 md:grid-cols-2" onSubmit={createSession}>
            <div className="md:col-span-1">
              <label className="text-sm font-medium text-slate-700">Name (optional)</label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Homepage crawl"
              />
            </div>
            <div className="md:col-span-1">
              <label className="text-sm font-medium text-slate-700">Project</label>
              <select
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                value={form.projectId}
                onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {projects.length === 0 && <option value="">No projects</option>}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="text-sm font-medium text-slate-700">Base URL</label>
              <Input
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder="https://app.yoursite.com"
              />
            </div>
            <div className="md:col-span-2">
              <label className="text-sm font-medium text-slate-700">Instructions (optional)</label>
              <textarea
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                rows={3}
                value={form.instructions}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setForm((f) => ({ ...f, instructions: e.target.value }))
                }
                placeholder="Highlight specific flows, risk areas, etc."
              />
            </div>
            <div className="md:col-span-2 flex gap-2">
              <Button type="submit" disabled={creating}>
                {creating ? "Creating..." : "Create session"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setForm({ name: "", baseUrl: "", instructions: "", projectId: form.projectId })}
              >
                Clear
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent sessions</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-slate-600">Loading…</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-slate-600">No sessions yet. Start a scan to create one.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {sessions.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-[220px]">
                    <Link to={`/agent/sessions/${s.id}`} className="text-slate-900 font-medium hover:underline">
                      {s.name || "Session"}
                    </Link>
                    <div className="text-xs text-slate-500 break-all">{s.baseUrl}</div>
                  </div>
                  <Badge
                    className={
                      s.status === "ready"
                        ? "border-emerald-200 text-emerald-700"
                        : s.status === "failed"
                        ? "border-rose-200 text-rose-700"
                        : "border-slate-200 text-slate-700"
                    }
                  >
                    {s.status}
                  </Badge>
                  <div className="text-xs text-slate-600">Pages: {s.pageCount}</div>
                  <div className="text-xs text-slate-500">Updated: {new Date(s.updatedAt).toLocaleString()}</div>
                  <div className="ml-auto flex gap-2">
                    <Link to={`/agent/sessions/${s.id}`}>
                      <Button size="sm" variant="outline">
                        View
                      </Button>
                    </Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        apiFetch(`/tm/agent/sessions/${s.id}/start`, { method: "POST" })
                          .then(load)
                          .catch((err: any) => setError(err?.message ?? "Failed to start"))
                      }
                    >
                      Start
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
