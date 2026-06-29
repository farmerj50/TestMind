import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, ExternalLink, GitBranch, Loader2, Play, ShieldCheck, Trash2, XCircle } from "lucide-react";

import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Badge } from "../components/ui/badge";

type Project = {
  id: string;
  name: string;
  repoUrl?: string | null;
};

type Environment = {
  id: string;
  name: string;
  baseUrl: string;
  isProtected: boolean;
  requiresApproval: boolean;
};

type Suite = {
  id: string;
  name: string;
  type: string;
  projectId?: string;
};

type WorkflowType = "qa-execute" | "repair" | "discovery" | "security";
type TriggerType = "manual" | "jenkins" | "github" | "webhook";

type WorkflowRun = {
  id: string;
  status: string;
  operatorJobId?: string | null;
  testRunId?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
  operatorJob?: {
    id: string;
    status: string;
    error?: string | null;
    testRunId?: string | null;
  } | null;
};

type Workflow = {
  id: string;
  projectId: string;
  name: string;
  description?: string | null;
  workflowType: WorkflowType;
  triggerType: TriggerType;
  environmentId?: string | null;
  environment?: Environment | null;
  suiteId?: string | null;
  approvalRequired: boolean;
  notifyOnFailure: boolean;
  runs: WorkflowRun[];
  createdAt: string;
};

const WORKFLOW_CHOICES: Array<{ value: WorkflowType; label: string }> = [
  { value: "qa-execute", label: "QA execute" },
  { value: "repair", label: "Repair" },
  { value: "discovery", label: "Discovery" },
  { value: "security", label: "Security" },
];

const TRIGGER_CHOICES: Array<{ value: TriggerType; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "jenkins", label: "Jenkins" },
  { value: "github", label: "GitHub" },
  { value: "webhook", label: "Webhook" },
];

const initialForm = {
  name: "",
  description: "",
  workflowType: "qa-execute" as WorkflowType,
  triggerType: "manual" as TriggerType,
  environmentId: "",
  suiteId: "",
  baseUrl: "",
  cookieHeader: "",
  approvalRequired: false,
  notifyOnFailure: true,
};

function statusTone(status: string) {
  if (status === "succeeded") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "failed" || status === "canceled" || status === "denied") {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }
  if (status === "blocked" || status === "awaiting_approval") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-blue-200 bg-blue-50 text-blue-700";
}

function StatusIcon({ status }: { status: string }) {
  if (status === "succeeded") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === "failed" || status === "canceled" || status === "denied") return <XCircle className="h-3.5 w-3.5" />;
  if (status === "running" || status === "queued") return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  return <Clock className="h-3.5 w-3.5" />;
}

function formatDate(value?: string | null) {
  if (!value) return "pending";
  return new Date(value).toLocaleString();
}

function friendlyStatus(status: string) {
  return status.replace(/_/g, " ");
}

export default function WorkflowsPage() {
  const { apiFetch } = useApi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [suites, setSuites] = useState<Suite[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [form, setForm] = useState(initialForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projectSuites = useMemo(
    () => suites.filter((suite) => suite.type === "curated" && (!suite.projectId || suite.projectId === projectId)),
    [projectId, suites]
  );

  const hasActiveRuns = useMemo(
    () =>
      workflows.some((workflow) =>
        workflow.runs.some((run) => ["queued", "running", "blocked", "awaiting_approval"].includes(run.status))
      ),
    [workflows]
  );

  const loadProjects = useCallback(async () => {
    const res = await apiFetch<{ projects: Project[] }>("/projects");
    setProjects(res.projects ?? []);
    if (!projectId && res.projects?.length) setProjectId(res.projects[0].id);
  }, [apiFetch, projectId]);

  const loadSuites = useCallback(async () => {
    const res = await apiFetch<{ projects: Suite[] }>("/tm/suite/projects");
    setSuites(res.projects ?? []);
  }, [apiFetch]);

  const loadEnvironments = useCallback(
    async (pid: string) => {
      const res = await apiFetch<{ environments: Environment[] }>(`/environments?projectId=${pid}`);
      setEnvironments(res.environments ?? []);
    },
    [apiFetch]
  );

  const loadWorkflows = useCallback(
    async (pid: string) => {
      const res = await apiFetch<{ workflows: Workflow[] }>(`/workflows?projectId=${pid}`);
      setWorkflows(res.workflows ?? []);
    },
    [apiFetch]
  );

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    Promise.all([loadProjects(), loadSuites()])
      .catch((err: any) => {
        if (mounted) setError(err?.message ?? "Failed to load workflows");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [loadProjects, loadSuites]);

  useEffect(() => {
    if (!projectId) return;
    setError(null);
    setForm((prev) => ({ ...prev, environmentId: "", suiteId: "" }));
    Promise.all([loadEnvironments(projectId), loadWorkflows(projectId)]).catch((err: any) =>
      setError(err?.message ?? "Failed to load project workflow data")
    );
  }, [projectId, loadEnvironments, loadWorkflows]);

  useEffect(() => {
    if (!projectId || !hasActiveRuns) return;
    const timer = window.setInterval(() => {
      loadWorkflows(projectId).catch(() => {});
    }, 4000);
    return () => window.clearInterval(timer);
  }, [projectId, hasActiveRuns, loadWorkflows]);

  useEffect(() => {
    if (form.workflowType !== "qa-execute" && form.suiteId) {
      setForm((prev) => ({ ...prev, suiteId: "" }));
    }
    if (form.workflowType !== "discovery" && (form.baseUrl || form.cookieHeader)) {
      setForm((prev) => ({ ...prev, baseUrl: "", cookieHeader: "" }));
    }
  }, [form.workflowType, form.suiteId, form.baseUrl, form.cookieHeader]);

  async function createWorkflow() {
    if (!projectId) {
      setError("Select a project first.");
      return;
    }
    if (!form.name.trim()) {
      setError("Workflow name is required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const configPayload: Record<string, unknown> = {};
      if (form.workflowType === "discovery") {
        if (form.baseUrl.trim()) configPayload.baseUrl = form.baseUrl.trim();
        if (form.cookieHeader.trim()) configPayload.headers = { Cookie: form.cookieHeader.trim() };
      }

      await apiFetch("/workflows", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          workflowType: form.workflowType,
          triggerType: form.triggerType,
          environmentId: form.environmentId || undefined,
          suiteId: form.workflowType === "qa-execute" ? form.suiteId || undefined : undefined,
          approvalRequired: form.approvalRequired,
          notifyOnFailure: form.notifyOnFailure,
          config: Object.keys(configPayload).length ? configPayload : undefined,
        }),
      });
      setForm(initialForm);
      await loadWorkflows(projectId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to create workflow");
    } finally {
      setSaving(false);
    }
  }

  async function runWorkflow(workflowId: string) {
    setRunningId(workflowId);
    setError(null);
    try {
      await apiFetch(`/workflows/${workflowId}/run`, { method: "POST" });
      if (projectId) await loadWorkflows(projectId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to run workflow");
    } finally {
      setRunningId(null);
    }
  }

  async function resolveApproval(runId: string, decision: "approve" | "deny") {
    setApprovingId(runId);
    setError(null);
    try {
      await apiFetch(`/workflows/runs/${runId}/${decision}`, { method: "POST" });
      if (projectId) await loadWorkflows(projectId);
    } catch (err: any) {
      setError(err?.message ?? `Failed to ${decision} workflow run`);
    } finally {
      setApprovingId(null);
    }
  }

  async function deleteWorkflow(workflowId: string) {
    setDeletingId(workflowId);
    setError(null);
    try {
      await apiFetch(`/workflows/${workflowId}`, { method: "DELETE" });
      setWorkflows((prev) => prev.filter((workflow) => workflow.id !== workflowId));
    } catch (err: any) {
      setError(err?.message ?? "Failed to delete workflow");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Execution</p>
          <h1 className="text-2xl font-semibold text-slate-900">Workflows</h1>
          <p className="text-sm text-slate-600">
            Save repeatable QA, repair, discovery, and security runs for each project environment.
          </p>
        </div>
        <div className="w-full md:w-72">
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="bg-white">
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-slate-800">
            <GitBranch className="h-4 w-4 text-slate-500" />
            New workflow
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Name</label>
              <Input
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="Smoke tests before release"
                className="bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Description</label>
              <Input
                value={form.description}
                onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                placeholder="Optional note"
                className="bg-white"
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Workflow</label>
              <Select
                value={form.workflowType}
                onValueChange={(value) => setForm((prev) => ({ ...prev, workflowType: value as WorkflowType }))}
              >
                <SelectTrigger className="bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKFLOW_CHOICES.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Trigger</label>
              <Select
                value={form.triggerType}
                onValueChange={(value) => setForm((prev) => ({ ...prev, triggerType: value as TriggerType }))}
              >
                <SelectTrigger className="bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRIGGER_CHOICES.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Environment</label>
              <Select
                value={form.environmentId}
                onValueChange={(value) => setForm((prev) => ({ ...prev, environmentId: value }))}
              >
                <SelectTrigger className="bg-white">
                  <SelectValue placeholder={environments.length ? "Project default" : "No environment"} />
                </SelectTrigger>
                <SelectContent>
                  {environments.map((environment) => (
                    <SelectItem key={environment.id} value={environment.id}>
                      {environment.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Suite</label>
              <Select
                value={form.suiteId}
                onValueChange={(value) => setForm((prev) => ({ ...prev, suiteId: value }))}
              >
                <SelectTrigger className="bg-white" disabled={form.workflowType !== "qa-execute"}>
                  <SelectValue placeholder={projectSuites.length ? "All suites" : "No curated suite"} />
                </SelectTrigger>
                <SelectContent>
                  {projectSuites.map((suite) => (
                    <SelectItem key={suite.id} value={suite.id}>
                      {suite.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {form.workflowType === "discovery" && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">
                  Base URL <span className="text-rose-500">*</span>
                </label>
                <Input
                  value={form.baseUrl}
                  onChange={(event) => setForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
                  placeholder="https://app.example.com"
                  className="bg-white"
                  type="url"
                />
                <p className="text-xs text-slate-500">Starting URL for page discovery. Required when no environment URL is set.</p>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Cookie header <span className="text-slate-400 font-normal">(optional)</span></label>
                <Input
                  value={form.cookieHeader}
                  onChange={(event) => setForm((prev) => ({ ...prev, cookieHeader: event.target.value }))}
                  placeholder="session=abc123; token=xyz"
                  className="bg-white font-mono text-xs"
                />
                <p className="text-xs text-slate-500">Paste browser cookies to access authenticated pages.</p>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-5">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.approvalRequired}
                  onChange={(event) => setForm((prev) => ({ ...prev, approvalRequired: event.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 accent-blue-600"
                />
                Approval required
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.notifyOnFailure}
                  onChange={(event) => setForm((prev) => ({ ...prev, notifyOnFailure: event.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 accent-blue-600"
                />
                Notify on failure
              </label>
            </div>
            <Button onClick={createWorkflow} disabled={saving || !projectId} className="bg-[#2563eb] text-white hover:bg-[#1d4ed8]">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create workflow
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">
          Saved workflows {workflows.length > 0 && <span className="font-normal text-slate-400">({workflows.length})</span>}
        </h2>
        {hasActiveRuns && <span className="text-xs text-slate-500">Refreshing active runs</span>}
      </div>

      {loading ? (
        <Card>
          <CardContent className="pt-6 text-sm text-slate-500">Loading workflows...</CardContent>
        </Card>
      ) : workflows.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-slate-500">
            {projectId ? "No workflows yet. Create one above." : "Select a project to create workflows."}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {workflows.map((workflow) => {
            const latestRun = workflow.runs[0];
            const needsApproval = workflow.runs.find((run) => run.status === "awaiting_approval");
            return (
              <Card key={workflow.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-base text-slate-900">{workflow.name}</CardTitle>
                      {workflow.description && <p className="mt-1 line-clamp-2 text-sm text-slate-500">{workflow.description}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => runWorkflow(workflow.id)}
                        disabled={runningId === workflow.id}
                        className="bg-emerald-600 text-white hover:bg-emerald-700"
                      >
                        {runningId === workflow.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                        Run
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => deleteWorkflow(workflow.id)}
                        disabled={deletingId === workflow.id}
                        title="Delete workflow"
                      >
                        {deletingId === workflow.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <Badge className="border-blue-200 bg-blue-50 text-blue-700">{workflow.workflowType}</Badge>
                    <Badge>{workflow.triggerType}</Badge>
                    {workflow.environment ? (
                      <Badge className="border-slate-200 bg-slate-50 text-slate-700">{workflow.environment.name}</Badge>
                    ) : (
                      <Badge className="border-slate-200 bg-slate-50 text-slate-500">project default</Badge>
                    )}
                    {workflow.approvalRequired || workflow.environment?.requiresApproval ? (
                      <Badge className="border-amber-200 bg-amber-50 text-amber-700">
                        <ShieldCheck className="mr-1 h-3 w-3" />
                        approval
                      </Badge>
                    ) : null}
                  </div>

                  {needsApproval && (
                    <div className="flex flex-col gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="text-sm text-amber-800">Run awaiting approval from {formatDate(needsApproval.createdAt)}</div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => resolveApproval(needsApproval.id, "approve")}
                          disabled={approvingId === needsApproval.id}
                          className="bg-amber-600 text-white hover:bg-amber-700"
                        >
                          {approvingId === needsApproval.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => resolveApproval(needsApproval.id, "deny")}
                          disabled={approvingId === needsApproval.id}
                        >
                          Deny
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recent runs</div>
                    {workflow.runs.length === 0 ? (
                      <p className="text-sm text-slate-500">No runs yet.</p>
                    ) : (
                      <div className="divide-y rounded-md border border-slate-200">
                        {workflow.runs.map((run) => (
                          <div key={run.id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${statusTone(run.status)}`}>
                                <StatusIcon status={run.status} />
                                {friendlyStatus(run.status)}
                              </span>
                              <span className="truncate text-xs text-slate-500">{formatDate(run.createdAt)}</span>
                            </div>
                            <div className="flex shrink-0 items-center gap-2 text-xs">
                              {run.operatorJobId && (
                                <a href="/operator" className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                                  Operator <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                              {(run.testRunId || run.operatorJob?.testRunId) && (
                                <a
                                  href={`/test-runs/${run.testRunId || run.operatorJob?.testRunId}`}
                                  className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                                >
                                  Results <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {latestRun?.error && <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{latestRun.error}</p>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
