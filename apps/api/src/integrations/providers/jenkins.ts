import { randomBytes } from "node:crypto";
import type { IntegrationProvider } from "../registry.js";
import { prisma } from "../../prisma.js";
import { encryptSecret } from "../../lib/crypto.js";

export function generateJenkinsfileScript(apiUrl: string): string {
  // Plain JS string — no template literal escaping needed.
  // Groovy sh '''...''' (triple-single-quoted) does NOT interpolate ${}, so
  // shell variables like ${TM_TOKEN} are written literally here.
  return (
    "pipeline {\n" +
    "  agent any\n" +
    "  triggers { githubPush() }\n" +
    "  parameters {\n" +
    "    choice(\n" +
    "      name: 'ENVIRONMENT',\n" +
    "      choices: ['qa', 'staging', 'prod', 'dev', 'uat'],\n" +
    "      description: 'Target environment (Settings -> Environments in TestMind)'\n" +
    "    )\n" +
    "    choice(\n" +
    "      name: 'WORKFLOW',\n" +
    "      choices: ['qa-execute', 'repair', 'discovery', 'security'],\n" +
    "      description: 'TestMind workflow to run'\n" +
    "    )\n" +
    "    string(name: 'BRANCH', defaultValue: 'main', description: 'Branch being tested')\n" +
    "  }\n" +
    "  stages {\n" +
    "    stage('Trigger TestMind QA') {\n" +
    "      steps {\n" +
    "        withCredentials([string(credentialsId: 'testmind-api-token', variable: 'TM_TOKEN')]) {\n" +
    "          sh '''\n" +
    "            set -e\n" +
    "            PAYLOAD=$(printf '{\"workflow\":\"%s\",\"environment\":\"%s\",\"branch\":\"%s\"}' \"$WORKFLOW\" \"$ENVIRONMENT\" \"$BRANCH\")\n" +
    "            RESPONSE=$(curl -s --connect-timeout 10 --max-time 60 \\\n" +
    "              -o /tmp/tm_response.json -w \"%{http_code}\" \\\n" +
    "              -X POST " + apiUrl + "/jenkins/run \\\n" +
    "              -H \"Authorization: Bearer ${TM_TOKEN}\" \\\n" +
    "              -H \"Content-Type: application/json\" \\\n" +
    "              -H \"X-Request-ID: jenkins-${BUILD_NUMBER}\" \\\n" +
    "              -d \"$PAYLOAD\")\n" +
    "            cat /tmp/tm_response.json; echo \"\"\n" +
    "            echo \"HTTP $RESPONSE\"\n" +
    "            [ \"$RESPONSE\" = \"202\" ] || [ \"$RESPONSE\" = \"409\" ] || exit 1\n" +
    "            JOB_ID=$(grep -o '\"jobId\":\"[^\"]*\"' /tmp/tm_response.json | cut -d'\"' -f4)\n" +
    "            echo \"TestMind job: $JOB_ID\"\n" +
    "            echo \"$JOB_ID\" > /tmp/tm_job_id.txt\n" +
    "          '''\n" +
    "        }\n" +
    "      }\n" +
    "    }\n" +
    "    stage('Wait for TestMind Results') {\n" +
    "      steps {\n" +
    "        withCredentials([string(credentialsId: 'testmind-api-token', variable: 'TM_TOKEN')]) {\n" +
    "          sh '''\n" +
    "            set -e\n" +
    "            JOB_ID=$(cat /tmp/tm_job_id.txt)\n" +
    "            MAX_WAIT=1200; WAITED=0; STATUS=queued\n" +
    "            echo \"Polling TestMind job $JOB_ID (environment: ${ENVIRONMENT}) ...\"\n" +
    "            while [ \"$STATUS\" = \"queued\" ] || [ \"$STATUS\" = \"running\" ] || [ \"$STATUS\" = \"blocked\" ]; do\n" +
    "              if [ \"$WAITED\" -ge \"$MAX_WAIT\" ]; then\n" +
    "                echo \"TIMEOUT: TestMind job did not complete within ${MAX_WAIT}s\"\n" +
    "                exit 1\n" +
    "              fi\n" +
    "              sleep 15; WAITED=$((WAITED + 15))\n" +
    "              STATUS_JSON=$(curl -s --connect-timeout 10 --max-time 30 \\\n" +
    "                \"" + apiUrl + "/jenkins/status/${JOB_ID}\" \\\n" +
    "                -H \"Authorization: Bearer ${TM_TOKEN}\")\n" +
    "              STATUS=$(echo \"$STATUS_JSON\" | grep -o '\"status\":\"[^\"]*\"' | head -1 | cut -d'\"' -f4)\n" +
    "              PASSED=$(echo \"$STATUS_JSON\" | grep -o '\"passed\":[0-9]*' | cut -d':' -f2)\n" +
    "              FAILED=$(echo \"$STATUS_JSON\" | grep -o '\"failed\":[0-9]*' | cut -d':' -f2)\n" +
    "              echo \"[${WAITED}s] status=${STATUS} passed=${PASSED:-0} failed=${FAILED:-0}\"\n" +
    "            done\n" +
    "            echo \"\"\n" +
    "            echo \"=== TestMind QA Results ===\"\n" +
    "            echo \"Environment : ${ENVIRONMENT}\"\n" +
    "            echo \"Workflow    : ${WORKFLOW}\"\n" +
    "            echo \"Status      : $STATUS\"\n" +
    "            PASSED=$(echo \"$STATUS_JSON\" | grep -o '\"passed\":[0-9]*' | cut -d':' -f2)\n" +
    "            FAILED=$(echo \"$STATUS_JSON\" | grep -o '\"failed\":[0-9]*' | cut -d':' -f2)\n" +
    "            TOTAL=$(echo \"$STATUS_JSON\" | grep -o '\"total\":[0-9]*' | cut -d':' -f2)\n" +
    "            RUN_URL=$(echo \"$STATUS_JSON\" | grep -o '\"runUrl\":\"[^\"]*\"' | head -1 | cut -d'\"' -f4)\n" +
    "            echo \"Passed      : ${PASSED:-0}\"\n" +
    "            echo \"Failed      : ${FAILED:-0}\"\n" +
    "            echo \"Total       : ${TOTAL:-0}\"\n" +
    "            [ -n \"$RUN_URL\" ] && echo \"Results     : $RUN_URL\"\n" +
    "            echo \"===========================\"\n" +
    "            if [ \"$STATUS\" = \"succeeded\" ]; then\n" +
    "              echo \"All tests passed!\"\n" +
    "              exit 0\n" +
    "            else\n" +
    "              JOB_ERR=$(echo \"$STATUS_JSON\" | grep -o '\"error\":\"[^\"]*\"' | head -1 | cut -d'\"' -f4)\n" +
    "              echo \"Tests FAILED: ${JOB_ERR}\"\n" +
    "              exit 1\n" +
    "            fi\n" +
    "          '''\n" +
    "        }\n" +
    "      }\n" +
    "    }\n" +
    "  }\n" +
    "  post {\n" +
    "    success { echo 'TestMind QA passed' }\n" +
    "    failure { echo 'TestMind QA failed or timed out' }\n" +
    "  }\n" +
    "}"
  );
}

export function buildJobXml(script: string): string {
  // Parameters are defined at the job config level so buildWithParameters works
  // on the very first API call (before any manual run).
  const template =
    "<?xml version='1.1' encoding='UTF-8'?>\n" +
    "<flow-definition plugin=\"workflow-job\">\n" +
    "  <description>TestMind QA pipeline — auto-generated by TestMind</description>\n" +
    "  <keepDependencies>false</keepDependencies>\n" +
    "  <properties>\n" +
    "    <hudson.model.ParametersDefinitionProperty>\n" +
    "      <parameterDefinitions>\n" +
    "        <hudson.model.ChoiceParameterDefinition>\n" +
    "          <name>ENVIRONMENT</name>\n" +
    "          <choices class=\"java.util.Arrays$ArrayList\">\n" +
    "            <a class=\"string-array\">\n" +
    "              <string>qa</string>\n" +
    "              <string>staging</string>\n" +
    "              <string>prod</string>\n" +
    "              <string>dev</string>\n" +
    "              <string>uat</string>\n" +
    "            </a>\n" +
    "          </choices>\n" +
    "          <description>Target environment (matches a name in TestMind Settings → Environments)</description>\n" +
    "        </hudson.model.ChoiceParameterDefinition>\n" +
    "        <hudson.model.ChoiceParameterDefinition>\n" +
    "          <name>WORKFLOW</name>\n" +
    "          <choices class=\"java.util.Arrays$ArrayList\">\n" +
    "            <a class=\"string-array\">\n" +
    "              <string>qa-execute</string>\n" +
    "              <string>repair</string>\n" +
    "              <string>discovery</string>\n" +
    "              <string>security</string>\n" +
    "            </a>\n" +
    "          </choices>\n" +
    "          <description>TestMind workflow to run</description>\n" +
    "        </hudson.model.ChoiceParameterDefinition>\n" +
    "        <hudson.model.StringParameterDefinition>\n" +
    "          <name>BRANCH</name>\n" +
    "          <defaultValue>main</defaultValue>\n" +
    "          <description>Branch being tested</description>\n" +
    "          <trim>true</trim>\n" +
    "        </hudson.model.StringParameterDefinition>\n" +
    "      </parameterDefinitions>\n" +
    "    </hudson.model.ParametersDefinitionProperty>\n" +
    "  </properties>\n" +
    "  <definition class=\"org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition\" plugin=\"workflow-cps\">\n" +
    "    <script><![CDATA[SCRIPT_PLACEHOLDER]]></script>\n" +
    "    <sandbox>true</sandbox>\n" +
    "  </definition>\n" +
    "  <triggers/>\n" +
    "  <disabled>false</disabled>\n" +
    "</flow-definition>";
  return template.replace("SCRIPT_PLACEHOLDER", script);
}

const jenkinsProvider: IntegrationProvider = {
  key: "jenkins",
  displayName: "Jenkins",
  description: "Allow Jenkins pipelines to trigger TestMind runs via a per-project API token.",
  allowMultiple: false,

  validateConfig(input: unknown) {
    const { _projectId, baseUrl } = (input ?? {}) as { _projectId?: string; baseUrl?: string };
    const secret = randomBytes(32).toString("hex");
    const rawToken = _projectId ? `${_projectId}_${secret}` : secret;
    return { config: { baseUrl: baseUrl ?? "" }, secrets: {}, _rawToken: rawToken } as any;
  },

  maskConfig(config) {
    return config;
  },

  async performAction(action: string, { integration, payload }: any) {
    if (action === "set-base-url") {
      const { baseUrl } = payload as { baseUrl?: string };
      await prisma.integration.update({
        where: { id: integration.id },
        data: { config: { ...(integration.config as any ?? {}), baseUrl: baseUrl ?? "" } },
      });
      return { ok: true, baseUrl: baseUrl ?? "" };
    }

    if (action === "setup-build-trigger") {
      const { jenkinsServerUrl, jenkinsJobName, jenkinsTriggerToken } = payload as {
        jenkinsServerUrl?: string;
        jenkinsJobName?: string;
        jenkinsTriggerToken?: string;
      };
      await prisma.integration.update({
        where: { id: integration.id },
        data: {
          config: {
            ...(integration.config as any ?? {}),
            ...(jenkinsServerUrl !== undefined ? { jenkinsServerUrl: jenkinsServerUrl.replace(/\/$/, "") } : {}),
            ...(jenkinsJobName !== undefined ? { jenkinsJobName } : {}),
            ...(jenkinsTriggerToken !== undefined ? { jenkinsTriggerToken } : {}),
          },
        },
      });
      return { ok: true };
    }

    if (action === "create-pipeline") {
      const { jenkinsAdminUser, jenkinsAdminToken, jobName, testmindApiUrl } = payload as {
        jenkinsAdminUser?: string;
        jenkinsAdminToken?: string;
        jobName?: string;
        testmindApiUrl?: string;
      };

      const cfg = (integration.config as any) ?? {};
      const rawServerUrl = cfg.jenkinsServerUrl as string | undefined;
      if (!rawServerUrl) throw new Error("Jenkins server URL not configured — save trigger config first");
      // On the server side, localhost resolves to ::1 (IPv6) on some hosts but Docker only listens on
      // 127.0.0.1 (IPv4). Substitute so the fetch reliably reaches the Jenkins container port binding.
      const serverUrl = rawServerUrl.replace(/\blocalhost\b/g, "127.0.0.1");
      if (!jenkinsAdminUser || !jenkinsAdminToken) throw new Error("Admin username and token required");
      if (!jobName) throw new Error("Job name required");

      const auth = Buffer.from(`${jenkinsAdminUser}:${jenkinsAdminToken}`).toString("base64");
      const authHeader = `Basic ${auth}`;

      // Reusable fetch with 10s timeout
      const fetchWithTimeout = async (url: string, init: RequestInit = {}): Promise<Response> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          return await fetch(url, { ...init, signal: controller.signal });
        } catch (err: any) {
          if (err?.name === "AbortError") throw new Error(`Request to Jenkins timed out after 10s`);
          throw err;
        } finally {
          clearTimeout(timer);
        }
      };

      // 1. Validate Jenkins is reachable with these credentials
      console.log(`[jenkins] pinging ${serverUrl}/api/json`);
      let pingRes: Response;
      try {
        pingRes = await fetchWithTimeout(`${serverUrl}/api/json`, {
          headers: { "Authorization": authHeader },
        });
      } catch (err: any) {
        throw new Error(`Cannot reach Jenkins server at ${serverUrl}: ${err?.message}`);
      }
      if (!pingRes.ok) {
        throw new Error(`Jenkins returned ${pingRes.status} — check server URL and admin credentials`);
      }

      // 2. Persist job name + admin user; store admin token encrypted for future CSRF-crumb auth
      await prisma.integration.update({
        where: { id: integration.id },
        data: {
          config: {
            ...cfg,
            ...(jobName !== cfg.jenkinsJobName ? { jenkinsJobName: jobName } : {}),
            jenkinsAdminUser: jenkinsAdminUser,
          },
        },
      });
      await prisma.projectSecret.upsert({
        where: { projectId_key: { projectId: (integration as any).projectId, key: "jenkins_admin_token" } },
        create: {
          projectId: (integration as any).projectId,
          key: "jenkins_admin_token",
          name: "Jenkins Admin Token",
          value: encryptSecret(jenkinsAdminToken),
        },
        update: { value: encryptSecret(jenkinsAdminToken) },
      });

      // 3. Build pipeline XML — replace localhost with host.docker.internal so Jenkins
      //    containers can reach the host-side TestMind API
      const rawApiUrl = testmindApiUrl || "http://localhost:8787";
      const dockerSafeApiUrl = rawApiUrl.replace(/\blocalhost\b/g, "host.docker.internal");
      const script = generateJenkinsfileScript(dockerSafeApiUrl);
      const jobXml = buildJobXml(script);
      const xmlHeaders = { "Authorization": authHeader, "Content-Type": "text/xml;charset=UTF-8" };

      // 4. Try to update an existing job first, then create
      console.log(`[jenkins] attempting update for job: ${jobName}`);
      const updateRes = await fetchWithTimeout(
        `${serverUrl}/job/${encodeURIComponent(jobName)}/config.xml`,
        { method: "POST", headers: xmlHeaders, body: jobXml }
      );
      if (updateRes.ok) {
        console.log(`[jenkins] updated pipeline: ${jobName}`);
        return { ok: true, jobUrl: `${serverUrl}/job/${encodeURIComponent(jobName)}/`, action: "updated" };
      }

      console.log(`[jenkins] update returned ${updateRes.status} — trying createItem`);
      const createRes = await fetchWithTimeout(
        `${serverUrl}/createItem?name=${encodeURIComponent(jobName)}`,
        { method: "POST", headers: xmlHeaders, body: jobXml }
      );
      if (!createRes.ok) {
        const body = await createRes.text().catch(() => "");
        throw new Error(`Jenkins createItem ${createRes.status}: ${body.slice(0, 300)}`);
      }

      console.log(`[jenkins] created pipeline: ${jobName}`);
      return { ok: true, jobUrl: `${serverUrl}/job/${encodeURIComponent(jobName)}/`, action: "created" };
    }

    throw new Error(`Unknown action: ${action}`);
  },
};

export default jenkinsProvider;
