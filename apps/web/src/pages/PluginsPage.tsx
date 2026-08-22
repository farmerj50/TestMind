import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { FrameworkId } from "@testmind/core/framework";
import { DEFAULT_FRAMEWORK_ID } from "@testmind/core/framework";
import {
  getFrameworkDefinition,
  matchFrameworkIdFromValue,
} from "@testmind/core/framework-registry";
import {
  BrainCircuit,
  CheckCircle2,
  Circle,
  CircleDot,
  Container,
  ExternalLink,
  Github,
  GitBranch,
  Loader2,
  PencilRuler,
  RefreshCw,
  Search,
  Server,
  Shield,
  Ticket,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { useApi } from "../lib/api";
import {
  PLUGIN_CATEGORIES,
  pluginCatalog,
  type PluginDefinition,
  type PluginIconKey,
  type PluginStatus,
} from "../lib/pluginCatalog";

type Project = { id: string; name: string };

type IntegrationSummary = {
  id: string;
  provider: string;
  name?: string | null;
  enabled: boolean;
  config?: Record<string, any> | null;
};

type JiraIntegration = {
  id: string;
  projectId: string;
  projectName?: string;
};

type ProjectSecret = {
  id: string;
  name: string;
  key: string;
};

type OpenAiStatus = {
  available: boolean;
  source: "project" | "app" | "missing";
  projectSecretKeys: string[];
};

type IconComponent = ComponentType<{ className?: string }>;

const FRAMEWORK_STORAGE_KEY = "tm-adapterId";

const iconByKey: Record<PluginIconKey, IconComponent> = {
  framework: PencilRuler,
  github: Github,
  git: GitBranch,
  jenkins: Server,
  jira: Ticket,
  docker: Container,
  ai: BrainCircuit,
  security: Shield,
};

const statusMeta: Record<
  PluginStatus,
  { label: string; className: string; icon: IconComponent }
> = {
  available: {
    label: "Available",
    className: "border-slate-200 bg-slate-50 text-slate-600",
    icon: Circle,
  },
  installed: {
    label: "Installed",
    className: "border-blue-200 bg-blue-50 text-blue-700",
    icon: CheckCircle2,
  },
  connected: {
    label: "Connected",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: CircleDot,
  },
  configured: {
    label: "Configured",
    className: "border-amber-200 bg-amber-50 text-amber-700",
    icon: CheckCircle2,
  },
};

function readStoredFramework(): FrameworkId {
  if (typeof window === "undefined") return DEFAULT_FRAMEWORK_ID;
  return matchFrameworkIdFromValue(window.localStorage.getItem(FRAMEWORK_STORAGE_KEY)) ?? DEFAULT_FRAMEWORK_ID;
}

function hasAnySecret(secretKeys: Set<string>, keys?: string[]) {
  return !!keys?.some((key) => secretKeys.has(key));
}

function hasConfiguredObject(value: unknown) {
  return !!value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0;
}

function StatusBadge({ status }: { status: PluginStatus }) {
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.className}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {meta.label}
    </span>
  );
}

export default function PluginsPage() {
  const { apiFetch } = useApi();
  const location = useLocation();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [integrations, setIntegrations] = useState<IntegrationSummary[]>([]);
  const [jiraIntegrations, setJiraIntegrations] = useState<JiraIntegration[]>([]);
  const [secrets, setSecrets] = useState<ProjectSecret[]>([]);
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);
  const [openAiStatus, setOpenAiStatus] = useState<OpenAiStatus | null>(null);
  const [activeFrameworkId, setActiveFrameworkId] = useState<FrameworkId>(readStoredFramework);
  const [search, setSearch] = useState("");
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [githubBusy, setGithubBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  const secretKeys = useMemo(
    () => new Set(secrets.map((secret) => secret.key)),
    [secrets]
  );

  const enabledIntegrations = useMemo(
    () => integrations.filter((integration) => integration.enabled),
    [integrations]
  );

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    setError(null);
    try {
      const res = await apiFetch<{ projects: Project[] }>("/projects");
      const sorted = [...(res.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name));
      setProjects(sorted);
      setSelectedProjectId((current) => {
        if (current && sorted.some((project) => project.id === current)) return current;
        return sorted[0]?.id ?? "";
      });
    } catch (err: any) {
      setError(err?.message ?? "Failed to load projects");
      setProjects([]);
      setSelectedProjectId("");
    } finally {
      setProjectsLoading(false);
    }
  }, [apiFetch]);

  const refreshGithubStatus = useCallback(async () => {
    try {
      const res = await apiFetch<{ connected: boolean }>("/github/status", { auth: "include" });
      setGithubConnected(Boolean(res.connected));
    } catch {
      setGithubConnected(false);
    }
  }, [apiFetch]);

  const loadProjectStatus = useCallback(
    async (projectId: string) => {
      setStatusLoading(true);
      setError(null);
      try {
        const [integrationRes, jiraRes, secretsRes, openAiRes] = await Promise.allSettled([
          apiFetch<{ integrations: IntegrationSummary[] }>(`/integrations?projectId=${projectId}`),
          apiFetch<{ integrations: JiraIntegration[] }>("/integrations/jira"),
          apiFetch<{ secrets: ProjectSecret[] }>(`/projects/${projectId}/secrets`),
          apiFetch<{ openAi: OpenAiStatus }>(`/tm/agent/projects/${projectId}/openai-status`),
        ]);

        if (integrationRes.status === "fulfilled") {
          setIntegrations(integrationRes.value.integrations ?? []);
        } else {
          setIntegrations([]);
        }

        if (jiraRes.status === "fulfilled") {
          setJiraIntegrations(jiraRes.value.integrations ?? []);
        } else {
          setJiraIntegrations([]);
        }

        if (secretsRes.status === "fulfilled") {
          setSecrets(secretsRes.value.secrets ?? []);
        } else {
          setSecrets([]);
        }

        if (openAiRes.status === "fulfilled") {
          setOpenAiStatus(openAiRes.value.openAi);
        } else {
          setOpenAiStatus(null);
        }

        const failed = [integrationRes, jiraRes, secretsRes, openAiRes].find(
          (result) => result.status === "rejected"
        );
        if (failed?.status === "rejected") {
          setError(failed.reason?.message ?? "Some plugin statuses could not be loaded");
        }
      } finally {
        setStatusLoading(false);
      }
    },
    [apiFetch]
  );

  useEffect(() => {
    loadProjects();
    refreshGithubStatus();
  }, [loadProjects, refreshGithubStatus]);

  useEffect(() => {
    if (!selectedProjectId) {
      setIntegrations([]);
      setJiraIntegrations([]);
      setSecrets([]);
      setOpenAiStatus(null);
      return;
    }
    loadProjectStatus(selectedProjectId);
  }, [selectedProjectId, loadProjectStatus]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("github") !== "connected") return;
    refreshGithubStatus().finally(() => {
      params.delete("github");
      navigate({ search: params.toString() }, { replace: true });
    });
  }, [location.search, navigate, refreshGithubStatus]);

  const resolveStatus = useCallback(
    (plugin: PluginDefinition): PluginStatus => {
      if (plugin.frameworkId) {
        return plugin.frameworkId === activeFrameworkId ? "installed" : "available";
      }

      if (plugin.id === "jira") {
        return jiraIntegrations.some((integration) => integration.projectId === selectedProjectId)
          ? "configured"
          : "available";
      }

      if (plugin.statusHint === "github-oauth") {
        const issueFilingEnabled = enabledIntegrations.some(
          (integration) => integration.provider === plugin.providerKey
        );
        return githubConnected || issueFilingEnabled ? "connected" : "available";
      }

      if (plugin.statusHint === "openai") {
        if (openAiStatus?.available) return "connected";
        if (hasAnySecret(secretKeys, plugin.secretKeys)) return "configured";
        return "available";
      }

      if (plugin.statusHint === "security") {
        const hasSetup = enabledIntegrations.some(
          (integration) => integration.provider === "security_test_setup"
        );
        const hasBaseline = enabledIntegrations.some(
          (integration) => integration.provider === "security_behavior_baseline"
        );
        return hasSetup || hasBaseline ? "configured" : "available";
      }

      if (plugin.providerKey) {
        const integration = enabledIntegrations.find(
          (item) => item.provider === plugin.providerKey
        );
        if (!integration) return "available";

        if (plugin.id === "jenkins") {
          const config = integration.config ?? {};
          const hasBuildTrigger = Boolean(config.jenkinsServerUrl && config.jenkinsJobName);
          const hasBaseUrl = Boolean(config.baseUrl);
          const hasToken = hasAnySecret(secretKeys, plugin.secretKeys);
          return hasBuildTrigger || hasBaseUrl || hasToken ? "configured" : "connected";
        }

        return hasConfiguredObject(integration.config) ? "configured" : "connected";
      }

      return "available";
    },
    [
      activeFrameworkId,
      enabledIntegrations,
      githubConnected,
      jiraIntegrations,
      openAiStatus,
      secretKeys,
      selectedProjectId,
    ]
  );

  const plugins = useMemo(
    () =>
      pluginCatalog.map((plugin) => ({
        ...plugin,
        status: resolveStatus(plugin),
      })),
    [resolveStatus]
  );

  const filteredPlugins = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return plugins;
    return plugins.filter((plugin) =>
      [plugin.name, plugin.description, plugin.category, plugin.status]
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  }, [plugins, search]);

  const groupedPlugins = useMemo(
    () =>
      PLUGIN_CATEGORIES.map((category) => ({
        category,
        plugins: filteredPlugins.filter((plugin) => plugin.category === category),
      })).filter((group) => group.plugins.length > 0),
    [filteredPlugins]
  );

  const counts = useMemo(
    () =>
      plugins.reduce(
        (acc, plugin) => {
          acc[plugin.status] += 1;
          return acc;
        },
        { available: 0, installed: 0, connected: 0, configured: 0 } satisfies Record<PluginStatus, number>
      ),
    [plugins]
  );

  function enableFramework(frameworkId: FrameworkId) {
    window.localStorage.setItem(FRAMEWORK_STORAGE_KEY, frameworkId);
    setActiveFrameworkId(frameworkId);
  }

  async function startGithubConnect() {
    setGithubBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ url: string }>("/auth/github/start-url?returnTo=/plugins");
      if (res.url) {
        window.location.href = res.url;
        return;
      }
      setError("GitHub did not return an authorization URL");
    } catch (err: any) {
      setError(err?.message ?? "Failed to start GitHub connection");
    } finally {
      setGithubBusy(false);
    }
  }

  async function refreshStatuses() {
    await Promise.all([
      refreshGithubStatus(),
      selectedProjectId ? loadProjectStatus(selectedProjectId) : Promise.resolve(),
    ]);
  }

  function renderAction(plugin: PluginDefinition & { status: PluginStatus }) {
    if (plugin.frameworkId && plugin.status !== "installed") {
      return (
        <Button size="sm" onClick={() => enableFramework(plugin.frameworkId!)}>
          Enable
        </Button>
      );
    }

    if (plugin.id === "github" && plugin.status === "available") {
      return (
        <Button size="sm" onClick={startGithubConnect} disabled={githubBusy}>
          {githubBusy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Connecting
            </>
          ) : (
            "Connect"
          )}
        </Button>
      );
    }

    const actionLabel =
      plugin.status === "available"
        ? plugin.actionVerb ?? "Configure"
        : plugin.status === "installed"
        ? "Open"
        : "Manage";

    return (
      <Button size="sm" variant={plugin.status === "available" ? "default" : "outline"} asChild>
        <Link to={plugin.route}>{actionLabel}</Link>
      </Button>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Settings</p>
          <h1 className="text-2xl font-semibold text-slate-900">Plugins</h1>
          <p className="max-w-3xl text-sm text-slate-600">
            Discover supported frameworks, integrations, and adapters, then jump into the existing setup screens.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
            <SelectTrigger className="w-64 bg-white" disabled={projectsLoading || projects.length === 0}>
              <SelectValue placeholder={projectsLoading ? "Loading projects" : "Select project"} />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={refreshStatuses} disabled={statusLoading}>
            {statusLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {error}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        {(["installed", "connected", "configured", "available"] as PluginStatus[]).map((status) => (
          <div key={status} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="text-2xl font-semibold text-slate-900">{counts[status]}</div>
            <div className="text-xs font-medium uppercase text-slate-500">{statusMeta[status].label}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search plugins..."
            className="bg-white pl-9"
          />
        </div>
        <div className="text-sm text-slate-600">
          {selectedProject ? selectedProject.name : "No project selected"} - Active framework:{" "}
          <span className="font-medium text-slate-800">
            {getFrameworkDefinition(activeFrameworkId).label}
          </span>
        </div>
      </div>

      {projects.length === 0 && !projectsLoading ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold text-slate-900">No projects yet</h2>
          <p className="mt-1 text-sm text-slate-600">
            Create a project first so plugins can show project-scoped connection and configuration state.
          </p>
          <Button className="mt-4" asChild>
            <Link to="/projects">Open projects</Link>
          </Button>
        </div>
      ) : groupedPlugins.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
          No plugins match your search.
        </div>
      ) : (
        <div className="space-y-8">
          {groupedPlugins.map((group) => (
            <section key={group.category} className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                  {group.category}
                </h2>
                <span className="text-xs text-slate-500">{group.plugins.length} plugins</span>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {group.plugins.map((plugin) => {
                  const Icon = iconByKey[plugin.icon];
                  return (
                    <Card key={plugin.id} className="rounded-lg border-slate-200 bg-white shadow-sm">
                      <CardContent className="flex h-full flex-col gap-4 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-3">
                            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-slate-200 bg-slate-50 text-slate-700">
                              <Icon className="h-5 w-5" />
                            </div>
                            <div className="min-w-0">
                              <h3 className="text-base font-semibold text-slate-900">{plugin.name}</h3>
                              <p className="mt-1 text-sm leading-5 text-slate-600">{plugin.description}</p>
                            </div>
                          </div>
                          <StatusBadge status={plugin.status} />
                        </div>

                        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            {plugin.frameworkId && (
                              <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
                                {plugin.frameworkId}
                              </span>
                            )}
                            {plugin.providerKey && (
                              <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
                                {plugin.providerKey}
                              </span>
                            )}
                            {plugin.docsUrl && (
                              <a
                                href={plugin.docsUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-slate-600 underline underline-offset-2 hover:text-slate-900"
                              >
                                Docs
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                          {renderAction(plugin)}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
