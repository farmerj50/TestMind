import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useApi } from "../lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";

type Scenario = {
  id: string;
  title: string;
  coverageType: string;
  status: string;
  specPath?: string | null;
  description?: string | null;
};

type Page = {
  id: string;
  path: string;
  url: string;
  status: string;
  summary?: string | null;
  coverage?: Record<string, number>;
  error?: string | null;
  instructions?: string | null;
  scenarios: Scenario[];
  session?: { id: string; projectId?: string | null };
};

export default function AgentPageDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { apiFetch } = useApi();
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [newScenario, setNewScenario] = useState({ title: "", coverageType: "", description: "" });
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  async function load() {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ page: Page }>(`/agent/pages/${id}`);
      setPage(res.page);
      setInstructions(res.page.instructions || "");
    } catch (err: any) {
      setError(err?.message ?? "Failed to load page");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  async function saveInstructions() {
    if (!id) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/agent/pages/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ instructions }),
      });
      await load();
    } catch (err: any) {
      setError(err?.message ?? "Failed to save instructions");
    } finally {
      setSaving(false);
    }
  }

  async function createScenario() {
    if (!id) return;
    if (!newScenario.title.trim() || !newScenario.coverageType.trim()) {
      setError("Title and coverage type are required");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await apiFetch(`/agent/pages/${id}/scenarios`, {
        method: "POST",
        body: JSON.stringify({
          title: newScenario.title.trim(),
          coverageType: newScenario.coverageType.trim(),
          description: newScenario.description.trim() || undefined,
        }),
      });
      setNewScenario({ title: "", coverageType: "", description: "" });
      await load();
    } catch (err: any) {
      setError(err?.message ?? "Failed to create scenario");
    } finally {
      setCreating(false);
    }
  }

  async function setScenarioStatus(scenarioId: string, status: string) {
    setError(null);
    try {
      await apiFetch(`/agent/scenarios/${scenarioId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await load();
    } catch (err: any) {
      setError(err?.message ?? "Failed to update scenario");
    }
  }

  return (
    <div className="px-4 py-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Page detail</h1>
          {page && (
            <>
              <div className="text-sm text-slate-600 break-all">{page.url}</div>
              <div className="text-xs text-slate-500">{page.path}</div>
            </>
          )}
        </div>
        {page?.session?.id && (
          <Link to={`/agent/sessions/${page.session.id}`} className="text-sm text-slate-600 underline">
            Back to session
          </Link>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : !page ? (
        <p className="text-sm text-slate-600">Page not found.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge className="border-slate-200 text-slate-800">{page.status}</Badge>
                {page.error && <span className="text-xs text-rose-600">{page.error}</span>}
              </div>
              {page.coverage && (
                <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                  {Object.entries(page.coverage).map(([k, v]) => (
                    <span key={k}>
                      {k}: <strong className="text-slate-800">{v as number}</strong>
                    </span>
                  ))}
                </div>
              )}
              {page.summary && <p className="text-sm text-slate-700">{page.summary}</p>}
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Instructions</label>
              <textarea
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                value={instructions}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInstructions(e.target.value)}
                rows={4}
                placeholder="Add hints for the agent..."
              />
                <Button size="sm" onClick={saveInstructions} disabled={saving}>
                  {saving ? "Saving…" : "Save instructions"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>New scenario</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Input
                placeholder="Title"
                value={newScenario.title}
                onChange={(e) => setNewScenario((s) => ({ ...s, title: e.target.value }))}
              />
              <Input
                placeholder="Coverage type (e.g., happy-path, edge, security)"
                value={newScenario.coverageType}
                onChange={(e) => setNewScenario((s) => ({ ...s, coverageType: e.target.value }))}
              />
              <textarea
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                placeholder="Description (optional)"
                rows={3}
                value={newScenario.description}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setNewScenario((s) => ({ ...s, description: e.target.value }))
                }
              />
              <Button size="sm" onClick={createScenario} disabled={creating}>
                {creating ? "Creating…" : "Add scenario"}
              </Button>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Scenarios</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {page.scenarios.length === 0 ? (
                <p className="text-sm text-slate-600">No scenarios yet.</p>
              ) : (
                page.scenarios.map((sc) => (
                  <div key={sc.id} className="rounded border border-slate-200 px-3 py-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-slate-900">{sc.title}</div>
                        <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-600">
                          <Badge className="border-slate-200 bg-slate-50 text-slate-800">
                            {sc.coverageType}
                          </Badge>
                          <Badge className="border-slate-200 text-slate-800">{sc.status}</Badge>
                          {sc.specPath && (
                            <a
                              href={`/#/suite?spec=${encodeURIComponent(sc.specPath)}`}
                              className="text-blue-600 hover:underline"
                            >
                              {sc.specPath}
                            </a>
                          )}
                        </div>
                        {sc.description && <p className="text-xs text-slate-600 mt-1">{sc.description}</p>}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => setScenarioStatus(sc.id, "accepted")}>
                          Accept
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setScenarioStatus(sc.id, "rejected")}>
                          Reject
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setScenarioStatus(sc.id, "completed")}>
                          Complete
                        </Button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
