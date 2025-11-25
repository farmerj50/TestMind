import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useApi } from "../lib/api";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";

type Project = { id: string; name: string };

type JiraIntegration = {
  id: string;
  projectId: string;
  projectName: string;
  siteUrl: string;
  email: string;
  projectKey: string;
  lastSyncedAt?: string | null;
  createdAt: string;
};

type JiraRequirement = {
  id: string;
  issueKey: string;
  summary: string;
  status: string;
  priority?: string | null;
  url?: string | null;
  syncedAt: string;
};

const emptyForm = {
  projectId: "",
  siteUrl: "",
  email: "",
  apiToken: "",
  projectKey: "",
};

type IntegrationSummary = {
  id: string;
  provider: string;
  name?: string | null;
  enabled: boolean;
};

type ProviderMeta = {
  key: string;
  name: string;
  description: string;
  docsUrl?: string;
};

type ProjectSecret = {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  updatedAt: string;
};

const PROVIDERS: ProviderMeta[] = [
  {
    key: "github-issues",
    name: "GitHub Issues",
    description:
      "Automatically file GitHub issues for failed runs with links to logs and artifacts.",
    docsUrl: "https://docs.github.com/issues",
  },
];

export default function IntegrationsPage() {
  const { apiFetch } = useApi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [integrations, setIntegrations] = useState<JiraIntegration[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<JiraRequirement[]>([]);
  const [loading, setLoading] = useState(false);
  const [reqLoading, setReqLoading] = useState(false);
  const [syncBusy, setSyncBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tmIntegrations, setTmIntegrations] = useState<IntegrationSummary[]>([]);
  const [tmLoading, setTmLoading] = useState(false);
  const [tmErr, setTmErr] = useState<string | null>(null);
  const [providerBusy, setProviderBusy] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<ProjectSecret[]>([]);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [secretsErr, setSecretsErr] = useState<string | null>(null);
  const [secretForm, setSecretForm] = useState({ name: "", key: "", value: "" });
  const [secretSaving, setSecretSaving] = useState(false);
  const [secretDeleting, setSecretDeleting] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<{ projects: Project[] }>("/projects");
        setProjects(data.projects);
        if (data.projects.length) {
          const firstId = data.projects[0].id;
          setProjectId((prev) => prev || firstId);
          setForm((prev) => ({ ...prev, projectId: prev.projectId || firstId }));
        }
      } catch (err: any) {
        setError(err?.message ?? "Failed to load projects");
      }
    })();
  }, [apiFetch]);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name)),
    [projects]
  );

  const loadTmIntegrations = useCallback(
    async (pid: string) => {
      setTmLoading(true);
      setTmErr(null);
      try {
        const qs = new URLSearchParams({ projectId: pid });
        const res = await apiFetch<{ integrations: IntegrationSummary[] }>(
          `/integrations?${qs.toString()}`
        );
        setTmIntegrations(res.integrations);
      } catch (err: any) {
        setTmErr(err?.message ?? "Failed to load integrations");
        setTmIntegrations([]);
      } finally {
        setTmLoading(false);
      }
    },
    [apiFetch]
  );

  const loadSecrets = useCallback(
    async (pid: string) => {
      setSecretsLoading(true);
      setSecretsErr(null);
      try {
        const res = await apiFetch<{ secrets: ProjectSecret[] }>(`/projects/${pid}/secrets`);
        setSecrets(res.secrets);
      } catch (err: any) {
        setSecretsErr(err?.message ?? "Failed to load secrets");
        setSecrets([]);
      } finally {
        setSecretsLoading(false);
      }
    },
    [apiFetch]
  );

  useEffect(() => {
    if (!projectId) {
      setTmIntegrations([]);
      setSecrets([]);
      return;
    }
    loadTmIntegrations(projectId);
    loadSecrets(projectId);
  }, [projectId, loadTmIntegrations, loadSecrets]);

  async function loadIntegrations() {
    const data = await apiFetch<{ integrations: JiraIntegration[] }>("/integrations/jira");
    setIntegrations(data.integrations);
    if (data.integrations.length && !activeId) {
      setActiveId(data.integrations[0].id);
    }
  }

  useEffect(() => {
    loadIntegrations().catch((err) => setError(err?.message ?? "Failed to load integrations"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeId) {
      setRequirements([]);
      return;
    }
    setReqLoading(true);
    apiFetch<{ requirements: JiraRequirement[] }>(`/integrations/jira/${activeId}/requirements`)
      .then((res) => setRequirements(res.requirements))
      .catch((err) => setError(err?.message ?? "Failed to load requirements"))
      .finally(() => setReqLoading(false));
  }, [activeId, apiFetch]);

  function updateField(key: keyof typeof emptyForm, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await apiFetch("/integrations/jira", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setForm((prev) => ({ ...prev, apiToken: "" }));
      await loadIntegrations();
    } catch (err: any) {
      setError(err?.message ?? "Failed to save integration");
    } finally {
      setLoading(false);
    }
  }

  async function handleProviderConnect(provider: ProviderMeta) {
    if (!projectId) {
      setTmErr("Select a project to connect.");
      return;
    }
    setProviderBusy(provider.key);
    setTmErr(null);
    try {
      await apiFetch("/integrations", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          provider: provider.key,
          name: provider.name,
          enabled: true,
        }),
      });
      await loadTmIntegrations(projectId);
    } catch (err: any) {
      setTmErr(err?.message ?? "Failed to connect integration");
    } finally {
      setProviderBusy(null);
    }
  }

  async function handleProviderDisconnect(id: string) {
    setProviderBusy(id);
    setTmErr(null);
    try {
      await apiFetch(`/integrations/${id}`, { method: "DELETE" });
      if (projectId) {
        await loadTmIntegrations(projectId);
      }
    } catch (err: any) {
      setTmErr(err?.message ?? "Failed to disconnect integration");
    } finally {
      setProviderBusy(null);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Remove this integration?")) return;
    try {
      await apiFetch(`/integrations/jira/${id}`, { method: "DELETE" });
      if (activeId === id) setActiveId(null);
      await loadIntegrations();
    } catch (err: any) {
      setError(err?.message ?? "Failed to delete integration");
    }
  }

  async function handleSync(id: string) {
    setSyncBusy(id);
    setError(null);
    try {
      await apiFetch(`/integrations/jira/${id}/sync`, { method: "POST" });
      if (activeId === id) {
        const res = await apiFetch<{ requirements: JiraRequirement[] }>(
          `/integrations/jira/${id}/requirements`
        );
        setRequirements(res.requirements);
      }
      await loadIntegrations();
    } catch (err: any) {
      setError(err?.message ?? "Failed to sync requirements");
    } finally {
      setSyncBusy(null);
    }
  }

  async function handleSecretSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      setSecretsErr("Select a project first.");
      return;
    }
    setSecretSaving(true);
    setSecretsErr(null);
    try {
      await apiFetch(`/projects/${projectId}/secrets`, {
        method: "POST",
        body: JSON.stringify(secretForm),
      });
      setSecretForm({ name: "", key: "", value: "" });
      await loadSecrets(projectId);
    } catch (err: any) {
      setSecretsErr(err?.message ?? "Failed to save secret");
    } finally {
      setSecretSaving(false);
    }
  }

  async function handleSecretDelete(id: string) {
    if (!confirm("Delete this secret?")) return;
    setSecretDeleting(id);
    setSecretsErr(null);
    try {
      await apiFetch(`/projects/${projectId}/secrets/${id}`, { method: "DELETE" });
      setSecrets((prev) => prev.filter((s) => s.id !== id));
    } catch (err: any) {
      setSecretsErr(err?.message ?? "Failed to delete secret");
    } finally {
      setSecretDeleting(null);
    }
  }

  return (
    <div className="px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Integrations</h1>
        <p className="text-sm text-slate-600">
          Connect your projects to GitHub, Jira, and other tools to automate QA workflows.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Automation & ticketing</CardTitle>
          <CardDescription>
            Enable GitHub issue filing (more providers soon). Select a project below to manage its
            connections.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <p className="text-sm text-slate-600">
              Pick a project to connect. Permissions are scoped per project owner.
            </p>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="w-60">
                <SelectValue placeholder="Choose project" />
              </SelectTrigger>
              <SelectContent>
                {sortedProjects.map((proj) => (
                  <SelectItem key={proj.id} value={proj.id}>
                    {proj.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {tmErr && <div className="text-sm text-rose-600">{tmErr}</div>}
          {!projectId ? (
            <p className="text-sm text-slate-500">Add a project to start configuring integrations.</p>
          ) : tmLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading connections...
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {PROVIDERS.map((provider) => {
                const existing = tmIntegrations.find(
                  (integration) => integration.provider === provider.key && integration.enabled
                );
                const busy =
                  providerBusy === provider.key || (existing && providerBusy === existing.id);
                return (
                  <div
                    key={provider.key}
                    className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                  >
                    <div className="space-y-1">
                      <h3 className="text-base font-semibold text-slate-900">{provider.name}</h3>
                      <p className="text-sm text-slate-600">{provider.description}</p>
                      {provider.docsUrl && (
                        <a
                          href={provider.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-slate-500 underline"
                        >
                          Documentation
                        </a>
                      )}
                    </div>
                    <div className="mt-4 flex items-center justify-between">
                      <span
                        className={`text-sm font-medium ${
                          existing ? "text-emerald-600" : "text-slate-500"
                        }`}
                      >
                        {existing ? "Connected" : "Not connected"}
                      </span>
                      {existing ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => handleProviderDisconnect(existing.id)}
                        >
                          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                          Disconnect
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => handleProviderConnect(provider)}
                        >
                          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                          Connect
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Secrets & Variables</CardTitle>
          <CardDescription>
            Store project-scoped secrets and expose them to test runs as environment variables.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <p className="text-sm text-slate-600">
              Secrets become <code className="rounded bg-slate-100 px-1">process.env.KEY</code> in
              tests. Values stay hidden after save.
            </p>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger className="w-60">
                <SelectValue placeholder="Choose project" />
              </SelectTrigger>
              <SelectContent>
                {sortedProjects.map((proj) => (
                  <SelectItem key={proj.id} value={proj.id}>
                    {proj.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {secretsErr && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {secretsErr}
            </div>
          )}

          <form className="grid gap-4 md:grid-cols-3" onSubmit={handleSecretSubmit}>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-slate-700">Name</label>
              <Input
                placeholder="Staging base URL"
                value={secretForm.name}
                onChange={(e) => setSecretForm((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-slate-700">Env key</label>
              <Input
                placeholder="BASE_URL"
                value={secretForm.key}
                onChange={(e) =>
                  setSecretForm((p) => ({ ...p, key: e.target.value.toUpperCase() }))
                }
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-slate-700">Value</label>
              <Input
                type="password"
                placeholder="•••••••"
                value={secretForm.value}
                onChange={(e) => setSecretForm((p) => ({ ...p, value: e.target.value }))}
              />
            </div>
            <div className="md:col-span-3">
              <Button type="submit" disabled={secretSaving || !projectId}>
                {secretSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...
                  </>
                ) : (
                  "Save secret"
                )}
              </Button>
            </div>
          </form>

          <div className="rounded-lg border border-slate-200">
            {secretsLoading ? (
              <div className="flex items-center gap-2 px-3 py-3 text-sm text-slate-600">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading secrets...
              </div>
            ) : secrets.length === 0 ? (
              <p className="px-3 py-3 text-sm text-slate-500">No secrets yet for this project.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Env key</th>
                      <th className="px-3 py-2">Updated</th>
                      <th className="px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {secrets.map((s) => (
                      <tr key={s.id}>
                        <td className="px-3 py-2">{s.name}</td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-700">{s.key}</td>
                        <td className="px-3 py-2 text-slate-500">
                          {new Date(s.updatedAt).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleSecretDelete(s.id)}
                            disabled={secretDeleting === s.id}
                          >
                            {secretDeleting === s.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4 text-rose-600" />
                            )}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connect Jira</CardTitle>
          <CardDescription>
            Provide the API token and project details to enable syncing requirements.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 md:grid-cols-2" onSubmit={handleSubmit}>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-slate-700">Project</label>
              <Select
                value={form.projectId}
                onValueChange={(val) => updateField("projectId", val)}
              >
                <SelectTrigger />
                <SelectContent>
                  {sortedProjects.map((proj) => (
                    <SelectItem key={proj.id} value={proj.id}>
                      {proj.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium text-slate-700">Site URL</label>
              <Input
                placeholder="https://your-domain.atlassian.net"
                value={form.siteUrl}
                onChange={(e) => updateField("siteUrl", e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium text-slate-700">Email</label>
              <Input
                placeholder="jira-account@example.com"
                value={form.email}
                onChange={(e) => updateField("email", e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <label className="text-sm font-medium text-slate-700">API token</label>
              <Input
                type="password"
                placeholder="Jira API token"
                value={form.apiToken}
                onChange={(e) => updateField("apiToken", e.target.value)}
              />
            </div>

            <div className="grid gap-2 md:col-span-2">
              <label className="text-sm font-medium text-slate-700">Project key</label>
              <Input
                placeholder="ENG"
                value={form.projectKey}
                onChange={(e) => updateField("projectKey", e.target.value)}
              />
            </div>

            <div className="md:col-span-2">
              <Button type="submit" disabled={loading || !form.projectId}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving�?�
                  </>
                ) : (
                  "Save integration"
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected Jira projects</CardTitle>
          <CardDescription>
            Select a connection to view its requirements or trigger a manual sync.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {integrations.length === 0 ? (
            <p className="text-sm text-slate-500">
              No Jira connections yet. Submit the form above to add one.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="px-2 py-2">Project</th>
                    <th className="px-2 py-2">Site</th>
                    <th className="px-2 py-2">Key</th>
                    <th className="px-2 py-2">Last sync</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {integrations.map((integration) => (
                    <tr
                      key={integration.id}
                      className={`cursor-pointer ${
                        activeId === integration.id ? "bg-slate-50" : ""
                      }`}
                      onClick={() => setActiveId(integration.id)}
                    >
                      <td className="px-2 py-2">{integration.projectName}</td>
                      <td className="px-2 py-2">{integration.siteUrl}</td>
                      <td className="px-2 py-2">{integration.projectKey}</td>
                      <td className="px-2 py-2">
                        {integration.lastSyncedAt
                          ? new Date(integration.lastSyncedAt).toLocaleString()
                          : "Never"}
                      </td>
                      <td className="px-2 py-2 text-right space-x-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSync(integration.id);
                          }}
                          disabled={syncBusy === integration.id}
                        >
                          {syncBusy === integration.id ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Syncing�?�
                            </>
                          ) : (
                            <>
                              <RefreshCw className="mr-2 h-4 w-4" /> Sync now
                            </>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(integration.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4 text-rose-600" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Requirements</CardTitle>
          <CardDescription>
            Requirements synced from Jira for the selected integration.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!activeId ? (
            <p className="text-sm text-slate-500">Select a connection to view its requirements.</p>
          ) : reqLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading requirements�?�
            </div>
          ) : requirements.length === 0 ? (
            <p className="text-sm text-slate-500">
              No requirements synced yet. Click "Sync now" to import issues.
            </p>
          ) : (
            <div className="space-y-3">
              {requirements.map((req) => (
                <div key={req.id} className="rounded-lg border px-3 py-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {req.issueKey} · {req.summary}
                      </p>
                      <p className="text-xs text-slate-500">
                        {req.status} · {req.priority || "Unprioritized"}
                      </p>
                    </div>
                    {req.url && (
                      <a
                        href={req.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-slate-600 underline"
                      >
                        View
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-slate-400">
                    Synced {new Date(req.syncedAt).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
