import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useApi, API_BASE } from "../lib/api";
import { Loader2, RefreshCw, Trash2, Copy, ChevronDown, ChevronUp } from "lucide-react";

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
  config?: Record<string, any> | null;
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
  const [notifyErr, setNotifyErr] = useState<string | null>(null);
  const [notifyBusy, setNotifyBusy] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<ProjectSecret[]>([]);
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [secretsErr, setSecretsErr] = useState<string | null>(null);
  const [secretForm, setSecretForm] = useState({ name: "", key: "", value: "" });
  const [secretSaving, setSecretSaving] = useState(false);
  const [secretDeleting, setSecretDeleting] = useState<string | null>(null);
  const [slackForm, setSlackForm] = useState({
    webhookUrl: "",
    notifyOn: "failures",
    enabled: true,
  });
  const [emailForm, setEmailForm] = useState({
    recipients: "",
    notifyOn: "failures",
    enabled: true,
  });
  const slackTouched = useRef(false);
  const emailTouched = useRef(false);
  const [jenkinsBusy, setJenkinsBusy] = useState(false);
  const [jenkinsErr, setJenkinsErr] = useState<string | null>(null);
  const [newJenkinsToken, setNewJenkinsToken] = useState<string | null>(null);
  const [showJenkinsfile, setShowJenkinsfile] = useState(false);
  const [jenkinsCopied, setJenkinsCopied] = useState(false);
  const [jenkinsBaseUrl, setJenkinsBaseUrl] = useState("");
  const [editingJenkinsUrl, setEditingJenkinsUrl] = useState(false);
  const [jenkinsSavingUrl, setJenkinsSavingUrl] = useState(false);
  const [jenkinsEnvironments, setJenkinsEnvironments] = useState<Array<{ id: string; name: string; baseUrl: string }>>([]);

  // Jenkins build-trigger config (server URL, job name, trigger token)
  const [jkServerUrl, setJkServerUrl] = useState("");
  const [jkJobName, setJkJobName] = useState("");
  const [jkTriggerToken, setJkTriggerToken] = useState("");
  const [jkTriggerSaving, setJkTriggerSaving] = useState(false);

  // Jenkins pipeline creation (admin credentials — ephemeral, never stored)
  const [jkAdminUser, setJkAdminUser] = useState("");
  const [jkAdminToken, setJkAdminToken] = useState("");
  const [jkCreatePipelineLoading, setJkCreatePipelineLoading] = useState(false);
  const [jkCreatePipelineResult, setJkCreatePipelineResult] = useState<{
    ok: boolean; jobUrl?: string; action?: string; error?: string;
  } | null>(null);

  // run-now state (triggers Jenkins build or direct TestMind run)
  const [triggerWorkflow, setTriggerWorkflow] = useState("qa-execute");
  const [triggerEnvName, setTriggerEnvName] = useState("");
  const [triggerLoading, setTriggerLoading] = useState(false);
  const [triggerResult, setTriggerResult] = useState<{
    jobId?: string;
    buildUrl?: string;
    buildError?: string;
    mode: "jenkins" | "direct";
    status: string;
    error?: string | null;
    testRunId?: string | null;
  } | null>(null);
  const triggerPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      setJenkinsEnvironments([]);
      return;
    }
    loadTmIntegrations(projectId);
    loadSecrets(projectId);
    apiFetch<{ environments: Array<{ id: string; name: string; baseUrl: string }> }>(
      `/environments?projectId=${projectId}`
    )
      .then((res) => {
        const envs = res.environments ?? [];
        setJenkinsEnvironments(envs);
        setTriggerEnvName((prev) => prev || envs[0]?.name || "");
      })
      .catch(() => setJenkinsEnvironments([]));
  }, [projectId, loadTmIntegrations, loadSecrets, apiFetch]);

  const slackIntegration = useMemo(
    () => tmIntegrations.find((i) => i.provider === "slack-webhook") ?? null,
    [tmIntegrations]
  );
  const emailIntegration = useMemo(
    () => tmIntegrations.find((i) => i.provider === "email-smtp") ?? null,
    [tmIntegrations]
  );
  const jenkinsIntegration = useMemo(
    () => tmIntegrations.find((i) => i.provider === "jenkins") ?? null,
    [tmIntegrations]
  );

  const jenkinsEnvChoices = useMemo(
    () =>
      jenkinsEnvironments.length
        ? jenkinsEnvironments.map((e) => `'${e.name}'`).join(", ")
        : "'qa', 'staging', 'prod'",
    [jenkinsEnvironments]
  );

  const jenkinsfileSample = useMemo(() => {
    // Helper tokens so the template below has no bare ${...} that TS would try to parse as expressions.
    // S  → \$   (Groovy GString escape for a shell $ without braces)
    // SE → \${  (Groovy GString escape for shell ${…} parameter expansion)
    // BS → \\   (Groovy GString escape for a literal backslash → shell line-continuation)
    const S  = String.raw`\$`;
    const SE = String.raw`\${`;
    const BS = String.raw`\\`;
    return `pipeline {
  agent any
  parameters {
    choice(name: 'ENVIRONMENT',
           choices: [${jenkinsEnvChoices}],
           description: 'Target environment (Settings → Environments)')
    choice(name: 'WORKFLOW',
           choices: ['qa-execute', 'repair', 'discovery', 'security'],
           description: 'TestMind workflow')
    string(name: 'BRANCH', defaultValue: 'main', description: 'Branch being tested')
  }
  stages {
    stage('Trigger TestMind') {
      steps {
        withCredentials([string(credentialsId: 'testmind-api-token', variable: 'TM_TOKEN')]) {
          sh """
            set -e
            RESPONSE=${S}(curl -s -o /tmp/tm_response.json -w "%{http_code}" ${BS}
              -X POST ${API_BASE}/jenkins/run ${BS}
              -H "Authorization: Bearer ${SE}TM_TOKEN}" ${BS}
              -H "Content-Type: application/json" ${BS}
              -H "X-Request-ID: jenkins-${SE}BUILD_NUMBER}" ${BS}
              -d '{"workflow":"${SE}WORKFLOW}","environment":"${SE}ENVIRONMENT}","branch":"${SE}BRANCH}"}')
            cat /tmp/tm_response.json; echo ""
            [ "${S}RESPONSE" = "202" ] || [ "${S}RESPONSE" = "409" ] || exit 1
            JOB_ID=${S}(grep -o '"jobId":"[^"]*"' /tmp/tm_response.json | cut -d'"' -f4)
            echo "TestMind job: ${S}JOB_ID"
            echo "${S}JOB_ID" > /tmp/tm_job_id.txt
          """
        }
      }
    }
    stage('Wait for Results') {
      steps {
        withCredentials([string(credentialsId: 'testmind-api-token', variable: 'TM_TOKEN')]) {
          sh """
            set -e
            JOB_ID=${S}(cat /tmp/tm_job_id.txt)
            MAX_WAIT=1200; WAITED=0; STATUS=queued
            while [ "${S}STATUS" = "queued" ] || [ "${S}STATUS" = "running" ] || [ "${S}STATUS" = "blocked" ]; do
              [ "${S}WAITED" -ge "${S}MAX_WAIT" ] && echo TIMEOUT && exit 1
              sleep 15; WAITED=${S}((WAITED + 15))
              STATUS_JSON=${S}(curl -s "${API_BASE}/jenkins/status/${SE}JOB_ID}" ${BS}
                -H "Authorization: Bearer ${SE}TM_TOKEN}")
              STATUS=${S}(echo "${S}STATUS_JSON" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
              PASSED=${S}(echo "${S}STATUS_JSON" | grep -o '"passed":[0-9]*' | cut -d':' -f2)
              FAILED=${S}(echo "${S}STATUS_JSON" | grep -o '"failed":[0-9]*' | cut -d':' -f2)
              echo "[${SE}WAITED}s] ${S}STATUS  passed=${SE}PASSED:-0}  failed=${SE}FAILED:-0}"
            done
            RUN_URL=${S}(echo "${S}STATUS_JSON" | grep -o '"runUrl":"[^"]*"' | head -1 | cut -d'"' -f4)
            [ -n "${S}RUN_URL" ] && echo "Results: ${S}RUN_URL"
            [ "${S}STATUS" = "succeeded" ] || { echo "Tests FAILED"; exit 1; }
          """
        }
      }
    }
  }
  post {
    success { echo 'TestMind QA passed' }
    failure { echo 'TestMind QA failed or timed out' }
  }
}`;
  }, [jenkinsEnvChoices]);

  useEffect(() => {
    if (slackIntegration && !slackTouched.current) {
      const notifyOn = String(slackIntegration.config?.notifyOn || "failures");
      setSlackForm((prev) => ({ ...prev, notifyOn, enabled: slackIntegration.enabled }));
    }
  }, [slackIntegration]);

  useEffect(() => {
    const cfg = (jenkinsIntegration?.config as any) ?? {};
    setJenkinsBaseUrl(cfg.baseUrl ?? "");
    setEditingJenkinsUrl(false);
    setJkServerUrl(cfg.jenkinsServerUrl ?? "");
    setJkJobName(cfg.jenkinsJobName ?? "");
    setJkTriggerToken(""); // write-only — never pre-filled
  }, [jenkinsIntegration]);

  useEffect(() => {
    if (emailIntegration && !emailTouched.current) {
      const notifyOn = String(emailIntegration.config?.notifyOn || "failures");
      const recipients = Array.isArray(emailIntegration.config?.recipients)
        ? (emailIntegration.config?.recipients as string[]).join(", ")
        : "";
      setEmailForm((prev) => ({
        ...prev,
        notifyOn,
        enabled: emailIntegration.enabled,
        recipients,
      }));
    }
  }, [emailIntegration]);

  async function handleJenkinsConnect() {
    if (!projectId) {
      setJenkinsErr("Select a project first.");
      return;
    }
    setJenkinsBusy(true);
    setJenkinsErr(null);
    setNewJenkinsToken(null);
    try {
      const res = await apiFetch<{ integration: IntegrationSummary; token?: string }>("/integrations", {
        method: "POST",
        body: JSON.stringify({ projectId, provider: "jenkins", config: { baseUrl: jenkinsBaseUrl }, enabled: true }),
      });
      if (res.token) setNewJenkinsToken(res.token);
      await loadTmIntegrations(projectId);
    } catch (err: any) {
      setJenkinsErr(err?.message ?? "Failed to connect Jenkins");
    } finally {
      setJenkinsBusy(false);
    }
  }

  async function handleJenkinsDisconnect(id: string) {
    if (!confirm("Remove Jenkins integration? The current token will be revoked.")) return;
    setJenkinsBusy(true);
    setJenkinsErr(null);
    setNewJenkinsToken(null);
    try {
      await apiFetch(`/integrations/${id}`, { method: "DELETE" });
      if (projectId) await loadTmIntegrations(projectId);
    } catch (err: any) {
      setJenkinsErr(err?.message ?? "Failed to disconnect Jenkins");
    } finally {
      setJenkinsBusy(false);
    }
  }

  async function handleSaveJenkinsUrl() {
    if (!jenkinsIntegration) return;
    setJenkinsSavingUrl(true);
    setJenkinsErr(null);
    try {
      await apiFetch(`/integrations/${jenkinsIntegration.id}/actions/set-base-url`, {
        method: "POST",
        body: JSON.stringify({ baseUrl: jenkinsBaseUrl }),
      });
      setEditingJenkinsUrl(false);
      if (projectId) await loadTmIntegrations(projectId);
    } catch (err: any) {
      setJenkinsErr(err?.message ?? "Failed to save URL");
    } finally {
      setJenkinsSavingUrl(false);
    }
  }

  async function handleSaveBuildTrigger() {
    if (!jenkinsIntegration) return;
    setJkTriggerSaving(true);
    try {
      await apiFetch(`/integrations/${jenkinsIntegration.id}/actions/setup-build-trigger`, {
        method: "POST",
        body: JSON.stringify({
          jenkinsServerUrl: jkServerUrl.trim(),
          jenkinsJobName: jkJobName.trim(),
          ...(jkTriggerToken.trim() ? { jenkinsTriggerToken: jkTriggerToken.trim() } : {}),
        }),
      });
      if (projectId) await loadTmIntegrations(projectId);
    } catch (err: any) {
      setJenkinsErr(err?.message ?? "Failed to save trigger config");
    } finally {
      setJkTriggerSaving(false);
    }
  }

  // True when we have enough to trigger a build: admin credentials (from Create Pipeline)
  // OR the legacy trigger token. Admin credentials are preferred — no Jenkins-side config needed.
  const jenkinsTriggered = Boolean(
    (jenkinsIntegration?.config as any)?.jenkinsServerUrl &&
    (jenkinsIntegration?.config as any)?.jenkinsJobName &&
    (
      (jenkinsIntegration?.config as any)?.jenkinsAdminUser ||
      (jenkinsIntegration?.config as any)?.jenkinsTriggerToken
    )
  );

  async function handleCreatePipeline() {
    if (!jenkinsIntegration) return;
    setJkCreatePipelineLoading(true);
    setJkCreatePipelineResult(null);
    const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;
    const jobName = jkJobName.trim() || `${projectName}-testmind`;
    try {
      const res = await apiFetch<{ ok: boolean; jobUrl: string; action: string }>(
        `/integrations/${jenkinsIntegration.id}/actions/create-pipeline`,
        {
          method: "POST",
          body: JSON.stringify({
            jenkinsAdminUser: jkAdminUser.trim(),
            jenkinsAdminToken: jkAdminToken.trim(),
            jobName,
            testmindApiUrl: API_BASE,
          }),
        }
      );
      if (projectId) await loadTmIntegrations(projectId);
      setJkCreatePipelineResult({ ok: true, jobUrl: res.jobUrl, action: res.action });
    } catch (err: any) {
      setJkCreatePipelineResult({ ok: false, error: err?.message ?? "Failed to create pipeline" });
    } finally {
      setJkCreatePipelineLoading(false);
    }
  }

  async function handleTriggerRun() {
    if (!projectId) return;
    setTriggerLoading(true);
    setTriggerResult(null);
    if (triggerPollRef.current) clearTimeout(triggerPollRef.current);

    // If Jenkins build trigger is fully configured, fire a real Jenkins build AND track via TestMind
    if (jenkinsTriggered) {
      let buildUrl: string | undefined;
      let buildError: string | undefined;
      try {
        const buildRes = await apiFetch<{ ok: boolean; buildUrl: string }>("/jenkins/build", {
          method: "POST",
          body: JSON.stringify({
            projectId,
            jobName: jkJobName.trim() || undefined,
            workflow: triggerWorkflow,
            environment: triggerEnvName || undefined,
          }),
        });
        buildUrl = buildRes.buildUrl;
      } catch (err: any) {
        buildError = err?.message ?? "Failed to trigger Jenkins build";
      }

      // Create a TestMind operator job for live UI tracking (runs tests directly)
      try {
        const res = await apiFetch<{ jobId: string; status: string }>("/jenkins/trigger", {
          method: "POST",
          body: JSON.stringify({
            projectId,
            workflow: triggerWorkflow,
            environment: triggerEnvName || undefined,
          }),
        });
        setTriggerResult({ mode: "jenkins", jobId: res.jobId, buildUrl, buildError, status: res.status });
        pollTriggerJob(res.jobId, { mode: "jenkins", buildUrl, buildError });
      } catch (err: any) {
        setTriggerResult({ mode: "jenkins", status: "failed", buildUrl, error: buildError ?? err?.message ?? "Failed to start test run" });
        setTriggerLoading(false);
      }
      return;
    }

    // Fallback: run directly in TestMind (no Jenkins configured)
    try {
      const res = await apiFetch<{ jobId: string; status: string }>("/jenkins/trigger", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          workflow: triggerWorkflow,
          environment: triggerEnvName || undefined,
        }),
      });
      setTriggerResult({ mode: "direct", jobId: res.jobId, status: res.status });
      pollTriggerJob(res.jobId, { mode: "direct" });
    } catch (err: any) {
      setTriggerResult({ mode: "direct", status: "failed", error: err?.message ?? "Failed to trigger run" });
      setTriggerLoading(false);
    }
  }

  function pollTriggerJob(jobId: string, extra: { mode: "jenkins" | "direct"; buildUrl?: string; buildError?: string } = { mode: "direct" }) {
    triggerPollRef.current = setTimeout(async () => {
      try {
        const res = await apiFetch<{ job: { status: string; error?: string | null; tasks?: Array<{ type: string; testRunId?: string | null }> } }>(`/operator/jobs/${jobId}`);
        const job = res.job;
        const execTask = job.tasks?.find((t) => t.type === "execute");
        setTriggerResult({ mode: extra.mode, buildUrl: extra.buildUrl, buildError: extra.buildError, jobId, status: job.status, error: job.error, testRunId: execTask?.testRunId });
        const done = job.status !== "queued" && job.status !== "running" && job.status !== "blocked";
        if (done) {
          setTriggerLoading(false);
        } else {
          pollTriggerJob(jobId, extra);
        }
      } catch {
        pollTriggerJob(jobId, extra);
      }
    }, 3000);
  }

  async function loadIntegrations() {
    const data = await apiFetch<{ integrations: JiraIntegration[] }>("/integrations/jira");
    setIntegrations(data.integrations);
    if (data.integrations.length && !activeId) {
      setActiveId(data.integrations[0].id);
    }
  }

  useEffect(() => {
    loadIntegrations().catch((err) => setError(err?.message ?? "Failed to load integrations"));
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

  async function saveSlackNotification(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      setNotifyErr("Select a project first.");
      return;
    }
    const webhookUrl = slackForm.webhookUrl.trim();
    if (!webhookUrl && !slackIntegration) {
      setNotifyErr("Slack webhook URL is required.");
      return;
    }
    setNotifyBusy("slack-webhook");
    setNotifyErr(null);
    try {
      await apiFetch("/integrations", {
        method: "POST",
        body: JSON.stringify({
          id: slackIntegration?.id,
          projectId,
          provider: "slack-webhook",
          name: "Slack webhook",
          enabled: slackForm.enabled,
          config: { notifyOn: slackForm.notifyOn },
          secrets: webhookUrl ? { webhookUrl } : undefined,
        }),
      });
      slackTouched.current = false;
      setSlackForm((prev) => ({ ...prev, webhookUrl: "" }));
      await loadTmIntegrations(projectId);
    } catch (err: any) {
      setNotifyErr(err?.message ?? "Failed to save Slack integration");
    } finally {
      setNotifyBusy(null);
    }
  }

  async function saveEmailNotification(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      setNotifyErr("Select a project first.");
      return;
    }
    const recipients = emailForm.recipients
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (!recipients.length) {
      setNotifyErr("Add at least one email recipient.");
      return;
    }
    setNotifyBusy("email-smtp");
    setNotifyErr(null);
    try {
      await apiFetch("/integrations", {
        method: "POST",
        body: JSON.stringify({
          id: emailIntegration?.id,
          projectId,
          provider: "email-smtp",
          name: "Email (SMTP)",
          enabled: emailForm.enabled,
          config: { notifyOn: emailForm.notifyOn, recipients },
        }),
      });
      emailTouched.current = false;
      await loadTmIntegrations(projectId);
    } catch (err: any) {
      setNotifyErr(err?.message ?? "Failed to save email integration");
    } finally {
      setNotifyBusy(null);
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
      let msg = err?.message ?? "Failed to save secret";
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.error?.fieldErrors) {
          const parts: string[] = [];
          Object.entries(parsed.error.fieldErrors as Record<string, string[]>).forEach(([k, v]) => {
            if (v?.length) parts.push(`${k}: ${v.join(", ")}`);
          });
          if (parts.length) msg = parts.join(" | ");
        }
      } catch {
        // keep original message
      }
      setSecretsErr(msg);
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
                    className="rounded-xl border border-slate-200 bg-[var(--tm-input-bg)] p-4 shadow-sm"
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
                          className="bg-blue-600 text-white hover:bg-blue-700"
                          disabled={busy}
                          onClick={() => handleProviderDisconnect(existing.id)}
                        >
                          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                          Disconnect
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          className="bg-blue-600 text-white hover:bg-blue-700"
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
          <CardTitle>Jenkins CI</CardTitle>
          <CardDescription>
            Let Jenkins pipelines trigger TestMind runs — QA, repair, discovery, or security scans
            — using a per-project bearer token.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <p className="text-sm text-slate-600">Select a project to configure the Jenkins webhook token.</p>
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

          {jenkinsErr && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {jenkinsErr}
            </div>
          )}

          {!projectId ? (
            <p className="text-sm text-slate-500">Select a project to manage the Jenkins integration.</p>
          ) : tmLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading...
            </div>
          ) : jenkinsIntegration ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-emerald-800">Jenkins connected</p>
                  <p className="text-xs text-emerald-700 mt-0.5">
                    Send <code className="rounded bg-emerald-100 px-1">POST {API_BASE}/jenkins/run</code> with your token.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={jenkinsBusy}
                    onClick={handleJenkinsConnect}
                    title="Regenerate token"
                  >
                    {jenkinsBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    <span className="ml-1">Rotate token</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={jenkinsBusy}
                    onClick={() => handleJenkinsDisconnect(jenkinsIntegration.id)}
                  >
                    <Trash2 className="h-4 w-4 text-rose-600" />
                  </Button>
                </div>
              </div>

              <div className="grid gap-2">
                <p className="text-xs font-medium text-slate-600">Trigger endpoint</p>
                <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <code className="flex-1 text-xs text-slate-700 break-all">{API_BASE}/jenkins/run</code>
                  <button
                    type="button"
                    className="shrink-0 text-slate-400 hover:text-slate-700"
                    onClick={() => navigator.clipboard.writeText(`${API_BASE}/jenkins/run`)}
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="grid gap-2">
                <p className="text-xs font-medium text-slate-600">Application URL</p>
                {editingJenkinsUrl ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="url"
                      value={jenkinsBaseUrl}
                      onChange={(e) => setJenkinsBaseUrl(e.target.value)}
                      placeholder="https://your-app.com"
                      className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <Button size="sm" onClick={handleSaveJenkinsUrl} disabled={jenkinsSavingUrl}>
                      {jenkinsSavingUrl ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setEditingJenkinsUrl(false); setJenkinsBaseUrl((jenkinsIntegration?.config as any)?.baseUrl ?? ""); }}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <code className="flex-1 text-xs text-slate-700 break-all">{jenkinsBaseUrl || <span className="text-slate-400 italic">not set — tests will fail without a URL</span>}</code>
                    <button
                      type="button"
                      className="shrink-0 text-xs text-blue-600 hover:text-blue-800"
                      onClick={() => setEditingJenkinsUrl(true)}
                    >
                      Edit
                    </button>
                  </div>
                )}
              </div>

              {newJenkinsToken && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
                  <p className="text-xs font-semibold text-amber-800">
                    Save this token now — it won't be shown again.
                  </p>
                  <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-white px-3 py-2">
                    <code className="flex-1 text-xs font-mono text-slate-800 break-all">{newJenkinsToken}</code>
                    <button
                      type="button"
                      className="shrink-0 text-slate-400 hover:text-slate-700"
                      onClick={() => navigator.clipboard.writeText(newJenkinsToken)}
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}

              <div className="grid gap-1">
                <p className="text-xs font-medium text-slate-600">Available environments</p>
                {jenkinsEnvironments.length > 0 ? (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {jenkinsEnvironments.map((env) => (
                        <span
                          key={env.id}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-700"
                        >
                          <code className="font-mono font-semibold">{env.name}</code>
                          <span className="text-slate-400 truncate max-w-[160px]">{env.baseUrl}</span>
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-slate-400">
                      Use these names in <code className="rounded bg-slate-100 px-0.5">"environment"</code> — TestMind resolves the URL automatically.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-slate-400">
                    No environments configured.{" "}
                    <a href="/environments" className="text-blue-600 hover:underline">
                      Add one in Settings → Environments
                    </a>{" "}
                    so Jenkins can target specific URLs by name.
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-3">
                <div>
                  <p className="text-xs font-medium text-slate-700">
                    Jenkins build trigger{" "}
                    <span className="text-slate-400 font-normal">(optional)</span>
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Let TestMind fire an actual Jenkins build. In Jenkins:{" "}
                    <strong className="text-slate-600">Configure pipeline → Build Triggers → ✓ Trigger builds remotely</strong>{" "}
                    and set an Authentication Token.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs text-slate-500">Jenkins server URL</label>
                    <input
                      type="url"
                      value={jkServerUrl}
                      onChange={(e) => setJkServerUrl(e.target.value)}
                      placeholder="https://jenkins.example.com"
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-slate-500">Pipeline job name</label>
                    <input
                      type="text"
                      value={jkJobName}
                      onChange={(e) => setJkJobName(e.target.value)}
                      placeholder="testmind-qa"
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-slate-500">
                    Authentication token{" "}
                    {(jenkinsIntegration?.config as any)?.jenkinsTriggerToken && (
                      <span className="text-emerald-600 font-medium">✓ saved</span>
                    )}
                  </label>
                  <input
                    type="password"
                    value={jkTriggerToken}
                    onChange={(e) => setJkTriggerToken(e.target.value)}
                    placeholder={
                      (jenkinsIntegration?.config as any)?.jenkinsTriggerToken
                        ? "leave blank to keep current token"
                        : "token from Jenkins pipeline config"
                    }
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <Button
                  size="sm"
                  className="h-7 px-3 text-xs bg-blue-600 text-white hover:bg-blue-700"
                  disabled={jkTriggerSaving || (!jkServerUrl.trim() && !jkJobName.trim() && !jkTriggerToken.trim())}
                  onClick={handleSaveBuildTrigger}
                >
                  {jkTriggerSaving ? (
                    <><Loader2 className="mr-1 h-3 w-3 animate-spin" />Saving…</>
                  ) : (
                    "Save trigger config"
                  )}
                </Button>
                {jenkinsTriggered && (
                  <p className="text-xs text-emerald-700 font-medium">
                    ✓ Build trigger configured — "Run now" will fire a real Jenkins build.
                  </p>
                )}

                <hr className="border-slate-100" />

                <div>
                  <p className="text-xs font-medium text-slate-700">Create pipeline in Jenkins</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Provide Jenkins admin credentials once — TestMind creates (or updates) the pipeline job with the correct Jenkinsfile automatically.
                    Credentials are used for this request only and are never stored.
                    The pipeline's <code className="rounded bg-slate-100 px-0.5">ENVIRONMENT</code> parameter maps to environments in Settings → Environments.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs text-slate-500">Jenkins admin username</label>
                    <input
                      type="text"
                      value={jkAdminUser}
                      onChange={(e) => setJkAdminUser(e.target.value)}
                      placeholder="admin"
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-slate-500">Jenkins admin API token</label>
                    <input
                      type="password"
                      value={jkAdminToken}
                      onChange={(e) => setJkAdminToken(e.target.value)}
                      placeholder="User → Configure → API Token"
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <Button
                  size="sm"
                  className="h-7 px-3 text-xs bg-indigo-600 text-white hover:bg-indigo-700"
                  disabled={jkCreatePipelineLoading || !jkAdminUser.trim() || !jkAdminToken.trim()}
                  onClick={handleCreatePipeline}
                >
                  {jkCreatePipelineLoading ? (
                    <><Loader2 className="mr-1 h-3 w-3 animate-spin" />Creating…</>
                  ) : (
                    "Create pipeline in Jenkins"
                  )}
                </Button>
                {jkCreatePipelineResult && (
                  <div className={`rounded-md px-3 py-2 text-xs flex items-start gap-2 ${
                    jkCreatePipelineResult.ok
                      ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                      : "bg-rose-50 border border-rose-200 text-rose-800"
                  }`}>
                    <span className="shrink-0 mt-0.5">{jkCreatePipelineResult.ok ? "✓" : "✗"}</span>
                    <div className="min-w-0">
                      {jkCreatePipelineResult.ok ? (
                        <>
                          <span className="font-medium capitalize">Pipeline {jkCreatePipelineResult.action} successfully</span>
                          {jkCreatePipelineResult.jobUrl && (
                            <a
                              href={jkCreatePipelineResult.jobUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="ml-2 underline font-medium"
                            >
                              View pipeline →
                            </a>
                          )}
                          <span className="ml-2 opacity-70">· Click "Run now" to trigger a build</span>
                        </>
                      ) : (
                        <span>{jkCreatePipelineResult.error}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-emerald-100 bg-white p-3 space-y-3">
                <p className="text-xs font-medium text-slate-700">Trigger a test run</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-xs text-slate-500">Environment</label>
                    <Select value={triggerEnvName} onValueChange={setTriggerEnvName}>
                      <SelectTrigger className="h-8 text-xs bg-white">
                        <SelectValue placeholder={jenkinsEnvironments.length ? "Select environment" : "No environments"} />
                      </SelectTrigger>
                      <SelectContent>
                        {jenkinsEnvironments.map((e) => (
                          <SelectItem key={e.id} value={e.name}>
                            {e.name} — {e.baseUrl}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-slate-500">Workflow</label>
                    <Select value={triggerWorkflow} onValueChange={setTriggerWorkflow}>
                      <SelectTrigger className="h-8 text-xs bg-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["qa-execute", "repair", "discovery", "security"].map((w) => (
                          <SelectItem key={w} value={w}>{w}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <Button
                  size="sm"
                  className="bg-emerald-600 text-white hover:bg-emerald-700 h-8 px-4 text-xs"
                  disabled={triggerLoading || (!jenkinsTriggered && !jenkinsEnvironments.length)}
                  onClick={handleTriggerRun}
                  title={!jenkinsTriggered && !jenkinsEnvironments.length ? "Add an environment first" : undefined}
                >
                  {triggerLoading ? <><Loader2 className="mr-1.5 h-3 w-3 animate-spin" />Running…</> : "Run now"}
                </Button>
                {triggerResult && (() => {
                  const isRunning = triggerResult.status === "queued" || triggerResult.status === "running" || triggerResult.status === "blocked";
                  const isSucceeded = triggerResult.status === "succeeded";
                  const isFailed = triggerResult.status === "failed";
                  return (
                    <div className={`rounded-md px-3 py-2 text-xs flex items-start gap-2 ${
                      isSucceeded ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                      : isFailed ? "bg-rose-50 border border-rose-200 text-rose-800"
                      : "bg-slate-50 border border-slate-200 text-slate-700"
                    }`}>
                      <span className="shrink-0 mt-0.5">
                        {isSucceeded ? "✓" : isFailed ? "✗" : <Loader2 className="h-3 w-3 animate-spin" />}
                      </span>
                      <div className="min-w-0 space-y-0.5">
                        <span className="font-medium">
                          {isSucceeded ? "All tests passed"
                            : isFailed ? (triggerResult.error ?? "Tests failed")
                            : triggerResult.mode === "jenkins" ? "Running tests…" : "Running…"}
                        </span>
                        {triggerResult.buildError && (
                          <p className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1">
                            Jenkins build trigger failed: {triggerResult.buildError}
                          </p>
                        )}
                        {!triggerResult.buildError && triggerResult.mode === "jenkins" && triggerResult.buildUrl && (
                          <a href={triggerResult.buildUrl} target="_blank" rel="noreferrer"
                            className="block underline opacity-70">
                            {isRunning ? "View Jenkins build →" : "View in Jenkins →"}
                          </a>
                        )}
                        {!isRunning && triggerResult.testRunId && (
                          <a href={`/test-runs/${triggerResult.testRunId}`}
                            className="block underline font-medium">
                            View results →
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>

              <div>
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
                  onClick={() => setShowJenkinsfile((v) => !v)}
                >
                  {showJenkinsfile ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  Sample Jenkinsfile
                </button>
                {showJenkinsfile && (
                  <div className="mt-2 rounded-lg bg-slate-900 overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700">
                      <span className="text-xs text-slate-400">Jenkinsfile</span>
                      <button
                        type="button"
                        className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors"
                        onClick={() => {
                          navigator.clipboard.writeText(jenkinsfileSample);
                          setJenkinsCopied(true);
                          setTimeout(() => setJenkinsCopied(false), 2000);
                        }}
                      >
                        <Copy className="h-3 w-3" />
                        {jenkinsCopied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                    <pre className="overflow-x-auto px-4 py-3 text-xs text-slate-100 leading-relaxed">{jenkinsfileSample}</pre>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-[var(--tm-input-bg)] p-4 space-y-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Not connected</h3>
                <p className="text-sm text-slate-600">
                  Connect Jenkins to generate a per-project API token. Paste it into Jenkins as a
                  credential to trigger runs from your pipeline.
                </p>
              </div>
              <div className="grid gap-1">
                <label className="text-xs font-medium text-slate-600">Application URL</label>
                <input
                  type="url"
                  value={jenkinsBaseUrl}
                  onChange={(e) => setJenkinsBaseUrl(e.target.value)}
                  placeholder="https://your-app.com"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-slate-400">Playwright will use this URL as the base for all tests</p>
              </div>
              <Button
                className="bg-blue-600 text-white hover:bg-blue-700"
                disabled={jenkinsBusy}
                onClick={handleJenkinsConnect}
              >
                {jenkinsBusy ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Connecting...
                  </>
                ) : (
                  "Connect Jenkins"
                )}
              </Button>

              {newJenkinsToken && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
                  <p className="text-xs font-semibold text-amber-800">
                    Save this token now — it won't be shown again.
                  </p>
                  <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-white px-3 py-2">
                    <code className="flex-1 text-xs font-mono text-slate-800 break-all">{newJenkinsToken}</code>
                    <button
                      type="button"
                      className="shrink-0 text-slate-400 hover:text-slate-700"
                      onClick={() => navigator.clipboard.writeText(newJenkinsToken)}
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>
            Send Slack and email alerts when test runs finish. Recipients are scoped per project.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <p className="text-sm text-slate-600">
              Choose a project to configure run notifications.
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
          {notifyErr && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {notifyErr}
            </div>
          )}
          {!projectId ? (
            <p className="text-sm text-slate-500">Select a project to enable notifications.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <form
                className="rounded-xl border border-slate-200 bg-[var(--tm-input-bg)] p-4 shadow-sm space-y-3"
                onSubmit={saveSlackNotification}
              >
                <div>
                  <h3 className="text-base font-semibold text-slate-900">Slack webhook</h3>
                  <p className="text-sm text-slate-600">
                    Send run summaries to a Slack channel using an incoming webhook.
                  </p>
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-slate-700">Webhook URL</label>
                  <Input
                    type="password"
                    placeholder="https://hooks.slack.com/services/..."
                    value={slackForm.webhookUrl}
                    onChange={(e) => {
                      slackTouched.current = true;
                      setSlackForm((prev) => ({ ...prev, webhookUrl: e.target.value }));
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-slate-700">Notify on</label>
                  <Select
                    value={slackForm.notifyOn}
                    onValueChange={(val) => {
                      slackTouched.current = true;
                      setSlackForm((prev) => ({ ...prev, notifyOn: val }));
                    }}
                  >
                    <SelectTrigger className="bg-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="failures">Failures only</SelectItem>
                      <SelectItem value="all">All runs</SelectItem>
                      <SelectItem value="success">Success only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={slackForm.enabled}
                    onChange={(e) => {
                      slackTouched.current = true;
                      setSlackForm((prev) => ({ ...prev, enabled: e.target.checked }));
                    }}
                  />
                  Enabled
                </label>
                <Button
                  type="submit"
                  className="bg-blue-600 text-white hover:bg-blue-700"
                  disabled={notifyBusy === "slack-webhook"}
                >
                  {notifyBusy === "slack-webhook" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...
                    </>
                  ) : (
                    "Save Slack settings"
                  )}
                </Button>
              </form>

              <form
                className="rounded-xl border border-slate-200 bg-[var(--tm-input-bg)] p-4 shadow-sm space-y-3"
                onSubmit={saveEmailNotification}
              >
                <div>
                  <h3 className="text-base font-semibold text-slate-900">Email (SMTP)</h3>
                  <p className="text-sm text-slate-600">
                    Send run summaries to a comma-separated list of recipients.
                  </p>
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-slate-700">Recipients</label>
                  <Input
                    placeholder="qa@company.com, eng@company.com"
                    value={emailForm.recipients}
                    onChange={(e) => {
                      emailTouched.current = true;
                      setEmailForm((prev) => ({ ...prev, recipients: e.target.value }));
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-medium text-slate-700">Notify on</label>
                  <Select
                    value={emailForm.notifyOn}
                    onValueChange={(val) => {
                      emailTouched.current = true;
                      setEmailForm((prev) => ({ ...prev, notifyOn: val }));
                    }}
                  >
                    <SelectTrigger className="bg-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="failures">Failures only</SelectItem>
                      <SelectItem value="all">All runs</SelectItem>
                      <SelectItem value="success">Success only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={emailForm.enabled}
                    onChange={(e) => {
                      emailTouched.current = true;
                      setEmailForm((prev) => ({ ...prev, enabled: e.target.checked }));
                    }}
                  />
                  Enabled
                </label>
                <div className="text-xs text-slate-500">
                  Requires SMTP env vars: <code className="rounded bg-slate-100 px-1">SMTP_HOST</code>{" "}
                  and <code className="rounded bg-slate-100 px-1">SMTP_FROM</code>.
                </div>
                <Button
                  type="submit"
                  className="bg-blue-600 text-white hover:bg-blue-700"
                  disabled={notifyBusy === "email-smtp"}
                >
                  {notifyBusy === "email-smtp" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...
                    </>
                  ) : (
                    "Save email settings"
                  )}
                </Button>
              </form>
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
              <Button
                type="submit"
                className="bg-blue-600 text-white hover:bg-blue-700"
                disabled={secretSaving || !projectId}
              >
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
              <Button
                type="submit"
                className="bg-blue-600 text-white hover:bg-blue-700"
                disabled={loading || !form.projectId}
              >
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
