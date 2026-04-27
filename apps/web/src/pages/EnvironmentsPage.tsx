import { useCallback, useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

type Project = { id: string; name: string };

type Environment = {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string;
  variables: Record<string, string> | null;
  isProtected: boolean;
  requiresApproval: boolean;
  createdAt: string;
  updatedAt: string;
};

const ENV_NAMES = ["dev", "qa", "stage", "uat", "prod"] as const;

const BADGE: Record<string, string> = {
  dev:   "bg-slate-100 text-slate-600",
  qa:    "bg-blue-100 text-blue-700",
  stage: "bg-amber-100 text-amber-700",
  uat:   "bg-purple-100 text-purple-700",
  prod:  "bg-rose-100 text-rose-700",
};

function EnvBadge({ name }: { name: string }) {
  const cls = BADGE[name] ?? "bg-slate-100 text-slate-600";
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium capitalize ${cls}`}>
      {name}
    </span>
  );
}

type FormState = {
  name: string;
  customName: string;
  baseUrl: string;
  isProtected: boolean;
  requiresApproval: boolean;
};

const emptyForm = (): FormState => ({
  name: "qa",
  customName: "",
  baseUrl: "",
  isProtected: false,
  requiresApproval: false,
});

export default function EnvironmentsPage() {
  const { apiFetch } = useApi();

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ projects: Project[] }>("/projects")
      .then((res) => {
        const ps = res.projects ?? [];
        setProjects(ps);
        if (ps.length) setProjectId(ps[0].id);
      })
      .catch(() => {});
  }, [apiFetch]);

  const loadEnvironments = useCallback(async (pid: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ environments: Environment[] }>(`/environments?projectId=${pid}`);
      setEnvironments(res.environments ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load environments");
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (projectId) loadEnvironments(projectId);
  }, [projectId, loadEnvironments]);

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setShowForm(true);
  }

  function startEdit(env: Environment) {
    setEditingId(env.id);
    setForm({
      name: ENV_NAMES.includes(env.name as any) ? env.name : "custom",
      customName: ENV_NAMES.includes(env.name as any) ? "" : env.name,
      baseUrl: env.baseUrl,
      isProtected: env.isProtected,
      requiresApproval: env.requiresApproval,
    });
    setShowForm(true);
  }

  function cancelForm() {
    setShowForm(false);
    setEditingId(null);
  }

  async function saveForm() {
    if (!projectId) return;
    const effectiveName = form.name === "custom" ? form.customName.trim() : form.name;
    if (!effectiveName || !form.baseUrl.trim()) {
      setError("Name and Base URL are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await apiFetch(`/environments/${editingId}`, {
          method: "PUT",
          body: JSON.stringify({
            name: effectiveName,
            baseUrl: form.baseUrl.trim(),
            isProtected: form.isProtected,
            requiresApproval: form.requiresApproval,
          }),
        });
      } else {
        await apiFetch("/environments", {
          method: "POST",
          body: JSON.stringify({
            projectId,
            name: effectiveName,
            baseUrl: form.baseUrl.trim(),
            isProtected: form.isProtected,
            requiresApproval: form.requiresApproval,
          }),
        });
      }
      setShowForm(false);
      setEditingId(null);
      await loadEnvironments(projectId);
    } catch (e: any) {
      setError(e?.message ?? "Failed to save environment");
    } finally {
      setSaving(false);
    }
  }

  async function deleteEnv(id: string) {
    if (!confirm("Delete this environment?")) return;
    setDeletingId(id);
    try {
      await apiFetch(`/environments/${id}`, { method: "DELETE" });
      setEnvironments((prev) => prev.filter((e) => e.id !== id));
    } catch (e: any) {
      setError(e?.message ?? "Failed to delete environment");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">Settings</p>
        <h1 className="text-2xl font-semibold text-slate-900">Environments</h1>
        <p className="text-sm text-slate-600">
          Define environments (dev, qa, stage, uat, prod) with base URLs for each project. Jenkins triggers and operator jobs will resolve the base URL automatically.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      <div className="flex items-center gap-4">
        <div className="w-64">
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="bg-white">
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          onClick={startCreate}
          disabled={!projectId}
          className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
        >
          Add environment
        </Button>
      </div>

      {showForm && (
        <Card className="border-blue-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-slate-800 text-base">
              {editingId ? "Edit environment" : "New environment"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Name</label>
                <Select value={form.name} onValueChange={(v) => setForm((f) => ({ ...f, name: v }))}>
                  <SelectTrigger className="bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENV_NAMES.map((n) => (
                      <SelectItem key={n} value={n}>{n}</SelectItem>
                    ))}
                    <SelectItem value="custom">custom…</SelectItem>
                  </SelectContent>
                </Select>
                {form.name === "custom" && (
                  <Input
                    value={form.customName}
                    onChange={(e) => setForm((f) => ({ ...f, customName: e.target.value }))}
                    placeholder="e.g. demo"
                    className="bg-white mt-1"
                  />
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Base URL</label>
                <Input
                  type="url"
                  value={form.baseUrl}
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                  placeholder="https://qa.example.com"
                  className="bg-white"
                />
              </div>
            </div>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.isProtected}
                  onChange={(e) => setForm((f) => ({ ...f, isProtected: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 accent-rose-600"
                />
                <span className="text-sm text-slate-700">Protected</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.requiresApproval}
                  onChange={(e) => setForm((f) => ({ ...f, requiresApproval: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 accent-rose-600"
                />
                <span className="text-sm text-slate-700">Requires approval before job runs</span>
              </label>
            </div>
            <div className="flex gap-2 pt-1">
              <Button
                onClick={saveForm}
                disabled={saving}
                className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm h-8 px-4 text-sm"
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="outline"
                onClick={cancelForm}
                disabled={saving}
                className="h-8 px-4 text-sm"
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-slate-800 text-base">
            Environments {environments.length > 0 && <span className="text-slate-400 font-normal">({environments.length})</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : environments.length === 0 ? (
            <p className="text-sm text-slate-500">
              No environments yet.{" "}
              {projectId ? "Click \"Add environment\" to create one." : "Select a project first."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-slate-500 uppercase tracking-wide">
                    <th className="text-left py-2 pr-4 font-medium">Name</th>
                    <th className="text-left py-2 pr-4 font-medium">Base URL</th>
                    <th className="text-left py-2 pr-4 font-medium">Protected</th>
                    <th className="text-left py-2 pr-4 font-medium">Needs approval</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {environments.map((env) => (
                    <tr key={env.id} className="hover:bg-slate-50">
                      <td className="py-2 pr-4">
                        <EnvBadge name={env.name} />
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-slate-700 max-w-xs truncate">
                        {env.baseUrl}
                      </td>
                      <td className="py-2 pr-4 text-center">
                        {env.isProtected ? (
                          <span className="text-rose-600 font-medium">Yes</span>
                        ) : (
                          <span className="text-slate-400">No</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-center">
                        {env.requiresApproval ? (
                          <span className="text-amber-600 font-medium">Yes</span>
                        ) : (
                          <span className="text-slate-400">No</span>
                        )}
                      </td>
                      <td className="py-2 flex items-center gap-2 justify-end">
                        <button
                          onClick={() => startEdit(env)}
                          className="text-xs text-slate-500 hover:text-slate-800 underline"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => deleteEnv(env.id)}
                          disabled={deletingId === env.id}
                          className="text-xs text-rose-500 hover:text-rose-700 underline"
                        >
                          {deletingId === env.id ? "…" : "Delete"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
