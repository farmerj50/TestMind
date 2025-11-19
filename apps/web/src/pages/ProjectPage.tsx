import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useApi } from "../lib/api";
import { Card, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toast } from "sonner";

type TestRunStatus = "queued" | "running" | "succeeded" | "failed";

export type TestRun = {
  id: string;
  projectId: string;
  status: TestRunStatus;
  summary?: string | null;
  error?: string | null;
  createdAt: string;      // ISO string from API
  startedAt?: string | null;
  finishedAt?: string | null;
};

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { apiFetch } = useApi();

  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [genBusy, setGenBusy] = useState(false);

// derive once per render
const hasActiveRun = runs.some(r => r.status === "queued" || r.status === "running");

// 1) Load project (run once per id)
useEffect(() => {
  if (!id) return;
  let alive = true;
  (async () => {
    try {
      const { project } = await apiFetch<{ project: { name: string; repoUrl: string } }>(
        `/projects/${id}`
      );
      if (!alive) return;
      setName(project.name);
      setRepoUrl(project.repoUrl);
    } catch (e: any) {
      toast.error(e.message || "Failed to load project");
    }
  })();
  return () => {
    alive = false;
  };
}, [id]); // <- removed apiFetch

// 2) Initial load of runs (run once per id)
useEffect(() => {
  if (!id) return;
  let alive = true;
  (async () => {
    try {
      const r = await apiFetch<{ runs: TestRun[] }>(`/projects/${id}/test-runs`);
      if (alive) setRuns(r.runs);
    } catch {
      // endpoint might not exist yet — ignore
    }
  })();
  return () => {
    alive = false;
  };
}, [id]); // <- removed apiFetch

// 3) Poll ONLY while there is an active run
useEffect(() => {
  if (!id || !hasActiveRun) return;
  const t = setInterval(async () => {
    try {
      const r = await apiFetch<{ runs: TestRun[] }>(`/projects/${id}/test-runs`);
      setRuns(r.runs);
    } catch {
      // ignore transient errors
    }
  }, 1500);
  return () => clearInterval(t);
}, [id, hasActiveRun]); // <- not [runs, apiFetch]


  // 5) Start a new test run
  async function generateTests() {
    if (!id) return;
    try {
      setGenBusy(true);
      const { run } = await apiFetch<{ run: TestRun }>(`/projects/${id}/test-runs`, {
        method: "POST",
      });
      setRuns((prev) => [run, ...prev]);
      toast("Test run started");
    } catch (e: any) {
      toast.error(e?.message || "Failed to start test run");
    } finally {
      setGenBusy(false);
    }
  }

  async function onSave() {
    if (!id) return;
    setSaving(true);
    try {
      await apiFetch(`/projects/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, repoUrl }),
      });
      toast.success("Saved");
      navigate("/dashboard");
    } catch (e: any) {
      toast.error(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!id) return;
    if (!confirm("Delete this project?")) return;
    setDeleting(true);
    try {
      await apiFetch(`/projects/${id}`, { method: "DELETE" });
      toast.success("Deleted");
      navigate("/dashboard");
    } catch (e: any) {
      toast.error(e.message || "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Edit project</CardTitle>
      </CardHeader>

      <div className="space-y-4 p-6">
        <div className="space-y-1">
          <label className="text-sm font-medium">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Repository URL</label>
          <Input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
        </div>

        <div className="flex gap-2">
          <Button onClick={onSave} disabled={saving || !name || !repoUrl}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button variant="outline" asChild>
            <Link to="/dashboard">Cancel</Link>
          </Button>
          <Button
            variant="destructive"
            onClick={onDelete}
            disabled={deleting}
            className="ml-auto"
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
          
        </div>
        {/* Tests section */}
<div className="mt-6 rounded-lg border p-4">
  <div className="mb-3 flex items-center justify-between">
    <h3 className="text-sm font-medium text-slate-800">Tests</h3>
    <Button onClick={generateTests} disabled={genBusy}>
      {genBusy ? "Starting…" : "Generate tests"}
    </Button>
  </div>

  {runs.length === 0 ? (
    <p className="text-sm text-slate-500">No test runs yet.</p>
  ) : (
    <ul className="divide-y">
      {runs.map((r) => (
        <li key={r.id} className="flex items-start justify-between gap-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={
                  "inline-flex items-center rounded-full px-2 py-0.5 text-xs " +
                  (r.status === "succeeded"
                    ? "bg-emerald-50 text-emerald-700"
                    : r.status === "failed"
                    ? "bg-rose-50 text-rose-700"
                    : "bg-slate-100 text-slate-700")
                }
              >
                {r.status}
              </span>
              <span className="truncate text-sm text-slate-700">
                {r.summary || r.error || "Run started"}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              {new Date(r.createdAt).toLocaleString()}
            </div>
          </div>
          <div className="shrink-0">
        <Link
          to={`/test-runs/${r.id}`}
          className="text-xs underline text-slate-600 hover:text-slate-900"
        >
          View
        </Link>
      </div>
        </li>
      ))}
    </ul>
  )}
</div>

      </div>
    </Card>
  );
}
