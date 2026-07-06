/**
 * CI/CD integration routes.
 *
 * Allows GitHub Actions, GitLab CI, and any other CI system to trigger security scans
 * and poll for results via a project-scoped API key. The API key is stored as a
 * ProjectSecret with key "CI_API_KEY" and must be prefixed with the project ID:
 *
 *   <projectId>_<random-secret>
 *
 * This prefix lets the token be self-describing without a database round-trip to find
 * which project it belongs to.
 *
 * Routes:
 *   POST /ci/scans           — trigger a scan, returns { scanId, statusUrl }
 *   GET  /ci/scans/:id       — poll scan status and pass/fail result
 *   GET  /ci/templates/github  — download GitHub Actions YAML
 *   GET  /ci/templates/gitlab  — download GitLab CI YAML
 *   GET  /ci/templates/generic — download a generic shell script wrapper
 */

import { timingSafeEqual, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { decryptSecret } from "../lib/crypto.js";
import { enqueueSecurityScan } from "../runner/queue.js";

const WEB_URL = (process.env.WEB_URL ?? "http://localhost:5173").replace(/\/$/, "");
const API_URL = (process.env.API_URL ?? "http://localhost:3001").replace(/\/$/, "");

// ── Token auth ────────────────────────────────────────────────────────────────

async function verifyApiKey(token: string): Promise<{ projectId: string } | null> {
  const underscoreIdx = token.indexOf("_");
  const projectId = underscoreIdx > 0 ? token.slice(0, underscoreIdx) : null;
  if (!projectId) return null;

  const secret = await prisma.projectSecret.findUnique({
    where: { projectId_key: { projectId, key: "CI_API_KEY" } },
  });
  if (!secret) return null;

  const decrypted = decryptSecret(secret.value);
  if (decrypted.length !== token.length) return null;
  const same = timingSafeEqual(Buffer.from(decrypted), Buffer.from(token));
  return same ? { projectId } : null;
}

function extractBearer(req: any): string | null {
  const authHeader = req.headers.authorization ?? "";
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7).trim();
  if (req.headers["x-api-key"]) return String(req.headers["x-api-key"]).trim();
  return null;
}

// ── Pass/fail logic ───────────────────────────────────────────────────────────

type SeverityThreshold = "critical" | "high" | "medium" | "low";

function scanPassed(
  summary: any,
  failOn: SeverityThreshold,
): boolean {
  if (!summary?.counts) return true;
  const order: SeverityThreshold[] = ["critical", "high", "medium", "low"];
  const idx = order.indexOf(failOn);
  for (let i = 0; i <= idx; i++) {
    if ((summary.counts[order[i]] ?? 0) > 0) return false;
  }
  return true;
}

// ── YAML templates ────────────────────────────────────────────────────────────

function githubActionsTemplate(apiUrl: string): string {
  return `# TestMind Security Scan — GitHub Actions workflow
# Add this file to .github/workflows/testmind-security.yml
# Store your CI API key in GitHub Secrets as TESTMIND_CI_API_KEY
#
# Generate a key: POST /ci/api-keys with project credentials, or generate one via
# Project Settings > CI/CD Integration in the TestMind UI and save it as a project secret.

name: TestMind Security Scan

on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]
  schedule:
    - cron: '0 2 * * 1'   # Weekly Monday 02:00 UTC

jobs:
  security-scan:
    name: Security Scan
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Trigger TestMind security scan
        id: trigger
        run: |
          response=$(curl -s -w "\\n%{http_code}" -X POST \\
            -H "Authorization: Bearer \${{ secrets.TESTMIND_CI_API_KEY }}" \\
            -H "Content-Type: application/json" \\
            -d '{
              "baseUrl": "\${{ vars.TARGET_URL }}",
              "scanDepth": "standard",
              "failOn": "high",
              "maxDurationMinutes": 15
            }' \\
            "${apiUrl}/ci/scans")
          body=\$(echo "\$response" | head -n-1)
          status=\$(echo "\$response" | tail -n1)
          echo "body=\$body" >> \$GITHUB_OUTPUT
          echo "http_status=\$status" >> \$GITHUB_OUTPUT
          if [ "\$status" != "200" ] && [ "\$status" != "201" ]; then
            echo "::error::Failed to trigger scan: \$body"
            exit 1
          fi
          scan_id=\$(echo "\$body" | jq -r '.scanId')
          echo "scan_id=\$scan_id" >> \$GITHUB_OUTPUT
          echo "Scan started: \$scan_id"

      - name: Wait for scan completion
        id: poll
        run: |
          scan_id="\${{ steps.trigger.outputs.scan_id }}"
          max_wait=1200   # 20 minutes
          elapsed=0
          while [ \$elapsed -lt \$max_wait ]; do
            result=\$(curl -s \\
              -H "Authorization: Bearer \${{ secrets.TESTMIND_CI_API_KEY }}" \\
              "${apiUrl}/ci/scans/\$scan_id")
            status=\$(echo "\$result" | jq -r '.status')
            echo "[\$(date -u +%H:%M:%S)] Scan status: \$status"
            if [ "\$status" = "completed" ] || [ "\$status" = "failed" ]; then
              echo "result=\$result" >> \$GITHUB_OUTPUT
              echo "status=\$status" >> \$GITHUB_OUTPUT
              break
            fi
            sleep 20
            elapsed=\$((elapsed + 20))
          done
          if [ "\$status" != "completed" ]; then
            echo "::warning::Scan did not complete within \${max_wait}s"
          fi

      - name: Evaluate results
        run: |
          result='\${{ steps.poll.outputs.result }}'
          passed=\$(echo "\$result" | jq -r '.passed')
          counts=\$(echo "\$result" | jq -r '.counts // {}')
          report_url=\$(echo "\$result" | jq -r '.reportUrl // ""')
          echo "Findings: \$counts"
          echo "Report: \$report_url"
          if [ "\$passed" = "false" ]; then
            echo "::error::Security scan failed — findings at or above the configured threshold were found."
            echo "::error::View full report: \$report_url"
            exit 1
          fi
          echo "Security scan passed."
`;
}

function gitlabCiTemplate(apiUrl: string): string {
  return `# TestMind Security Scan — GitLab CI configuration
# Add this to your .gitlab-ci.yml (or include it as a component)
# Store your CI API key in GitLab Settings > CI/CD > Variables as TESTMIND_CI_API_KEY

testmind-security-scan:
  stage: test
  image: curlimages/curl:latest
  timeout: 30 minutes
  rules:
    - if: \$CI_PIPELINE_SOURCE == "push" && \$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH
    - if: \$CI_PIPELINE_SOURCE == "merge_request_event"
    - if: \$CI_PIPELINE_SOURCE == "schedule"
  variables:
    TARGET_URL: "\${TARGET_URL:-\$CI_ENVIRONMENT_URL}"
    FAIL_ON: "high"
    SCAN_DEPTH: "standard"
    MAX_DURATION: "15"
    TESTMIND_API: "${apiUrl}"
  script:
    - |
      echo "Triggering TestMind security scan..."
      RESPONSE=\$(curl -sf -w "\\n%{http_code}" -X POST \\
        -H "Authorization: Bearer \$TESTMIND_CI_API_KEY" \\
        -H "Content-Type: application/json" \\
        -d "{
          \\"baseUrl\\": \\"$TARGET_URL\\",
          \\"scanDepth\\": \\"$SCAN_DEPTH\\",
          \\"failOn\\": \\"$FAIL_ON\\",
          \\"maxDurationMinutes\\": $MAX_DURATION
        }" \\
        "\$TESTMIND_API/ci/scans")
      BODY=\$(echo "\$RESPONSE" | head -n-1)
      HTTP_STATUS=\$(echo "\$RESPONSE" | tail -n1)
      if [ "\$HTTP_STATUS" -lt 200 ] || [ "\$HTTP_STATUS" -ge 300 ]; then
        echo "ERROR: Failed to trigger scan (HTTP \$HTTP_STATUS): \$BODY"
        exit 1
      fi
      SCAN_ID=\$(echo "\$BODY" | grep -o '"scanId":"[^"]*"' | cut -d'"' -f4)
      echo "Scan started: \$SCAN_ID"
    - |
      echo "Waiting for scan completion..."
      MAX_WAIT=1200
      ELAPSED=0
      STATUS="queued"
      while [ "\$ELAPSED" -lt "\$MAX_WAIT" ]; do
        RESULT=\$(curl -sf \\
          -H "Authorization: Bearer \$TESTMIND_CI_API_KEY" \\
          "\$TESTMIND_API/ci/scans/\$SCAN_ID")
        STATUS=\$(echo "\$RESULT" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
        echo "[\$(date -u +%H:%M:%S)] Status: \$STATUS"
        if [ "\$STATUS" = "completed" ] || [ "\$STATUS" = "failed" ]; then
          break
        fi
        sleep 20
        ELAPSED=\$((ELAPSED + 20))
      done
    - |
      RESULT=\$(curl -sf \\
        -H "Authorization: Bearer \$TESTMIND_CI_API_KEY" \\
        "\$TESTMIND_API/ci/scans/\$SCAN_ID")
      PASSED=\$(echo "\$RESULT" | grep -o '"passed":[^,}]*' | cut -d: -f2 | tr -d ' ')
      REPORT=\$(echo "\$RESULT" | grep -o '"reportUrl":"[^"]*"' | cut -d'"' -f4)
      echo "Report: \$REPORT"
      if [ "\$PASSED" != "true" ]; then
        echo "FAIL: Security scan findings at or above threshold. Report: \$REPORT"
        exit 1
      fi
      echo "Security scan passed."
  artifacts:
    reports:
      dotenv: testmind-scan.env
    when: always
    expire_in: 30 days
`;
}

function genericShellScript(apiUrl: string): string {
  return `#!/usr/bin/env bash
# TestMind Security Scan — generic CI shell script
# Usage:
#   TESTMIND_CI_API_KEY=<key> TARGET_URL=https://app.example.com ./testmind-scan.sh
#
# Optional environment variables:
#   SCAN_DEPTH      baseline | standard | deep        (default: standard)
#   FAIL_ON         critical | high | medium | low    (default: high)
#   MAX_DURATION    max scan duration in minutes      (default: 15)
#   TESTMIND_API    TestMind API base URL             (default: ${apiUrl})

set -euo pipefail

API="\${TESTMIND_API:-${apiUrl}}"
TARGET="\${TARGET_URL:?TARGET_URL is required}"
DEPTH="\${SCAN_DEPTH:-standard}"
FAIL_ON="\${FAIL_ON:-high}"
MAX_MINS="\${MAX_DURATION:-15}"

echo "[testmind] Triggering \$DEPTH scan against \$TARGET (fail-on: \$FAIL_ON)"

BODY=\$(curl -sf -X POST \\
  -H "Authorization: Bearer \$TESTMIND_CI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{\"baseUrl\":\"\$TARGET\",\"scanDepth\":\"\$DEPTH\",\"failOn\":\"\$FAIL_ON\",\"maxDurationMinutes\":\$MAX_MINS}" \\
  "\$API/ci/scans")

SCAN_ID=\$(echo "\$BODY" | grep -oP '"scanId":"\K[^"]+')
echo "[testmind] Scan ID: \$SCAN_ID"

MAX_WAIT=\$((MAX_MINS * 60 + 120))
ELAPSED=0
while [ \$ELAPSED -lt \$MAX_WAIT ]; do
  RESULT=\$(curl -sf \\
    -H "Authorization: Bearer \$TESTMIND_CI_API_KEY" \\
    "\$API/ci/scans/\$SCAN_ID")
  STATUS=\$(echo "\$RESULT" | grep -oP '"status":"\K[^"]+')
  echo "[testmind] [\$(date -u +%H:%M:%S)] \$STATUS"
  [ "\$STATUS" = "completed" ] || [ "\$STATUS" = "failed" ] && break
  sleep 20
  ELAPSED=\$((ELAPSED + 20))
done

PASSED=\$(echo "\$RESULT" | grep -oP '"passed":\K[^,}]+' | tr -d ' ')
REPORT=\$(echo "\$RESULT" | grep -oP '"reportUrl":"\K[^"]+' || echo "")
echo "[testmind] Report: \$REPORT"
if [ "\$PASSED" != "true" ]; then
  echo "[testmind] FAIL — findings at or above '\$FAIL_ON' threshold detected."
  exit 1
fi
echo "[testmind] PASS"
`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

const triggerSchema = z.object({
  baseUrl: z.string().url(),
  scanDepth: z.enum(["baseline", "standard", "deep"]).optional().default("standard"),
  failOn: z.enum(["critical", "high", "medium", "low"]).optional().default("high"),
  maxDurationMinutes: z.number().int().min(1).max(120).optional().default(15),
  authSessionId: z.string().optional(),
  apiSpecId: z.string().optional(),
});

export default async function ciRoutes(app: FastifyInstance) {

  // POST /ci/scans — trigger a scan
  app.post("/ci/scans", async (req, reply) => {
    const token = extractBearer(req);
    if (!token) return reply.code(401).send({ error: "Missing API key" });
    const auth = await verifyApiKey(token);
    if (!auth) return reply.code(401).send({ error: "Invalid API key" });

    const parsed = triggerSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const body = parsed.data;

    const project = await prisma.project.findUnique({
      where: { id: auth.projectId },
      select: { id: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const job = await prisma.securityScanJob.create({
      data: {
        projectId: auth.projectId,
        status: "queued",
        config: {
          baseUrl: body.baseUrl,
          scanDepth: body.scanDepth,
          failOn: body.failOn,
          maxDurationMinutes: body.maxDurationMinutes,
          trigger: "ci",
        },
      },
    });

    await enqueueSecurityScan({
      jobId: job.id,
      projectId: auth.projectId,
      baseUrl: body.baseUrl,
      scanDepth: body.scanDepth,
      maxDurationMinutes: body.maxDurationMinutes,
      enableActive: body.scanDepth !== "baseline",
      allowedHosts: [],
      allowedPorts: [],
      authProfiles: [],
      apiFixtures: [],
      authSessionId: body.authSessionId,
      apiSpecId: body.apiSpecId,
    });

    return reply.code(201).send({
      scanId: job.id,
      status: "queued",
      statusUrl: `${API_URL}/ci/scans/${job.id}`,
      reportUrl: `${WEB_URL}/projects/${auth.projectId}/security/${job.id}`,
    });
  });

  // GET /ci/scans/:id — poll scan status
  app.get<{ Params: { id: string }; Querystring: { failOn?: string } }>(
    "/ci/scans/:id",
    async (req, reply) => {
      const token = extractBearer(req);
      if (!token) return reply.code(401).send({ error: "Missing API key" });
      const auth = await verifyApiKey(token);
      if (!auth) return reply.code(401).send({ error: "Invalid API key" });

      const job = await prisma.securityScanJob.findUnique({
        where: { id: req.params.id },
        select: { id: true, projectId: true, status: true, phase: true, summary: true, error: true, createdAt: true, finishedAt: true },
      });
      if (!job || job.projectId !== auth.projectId) return reply.code(404).send({ error: "Scan not found" });

      const failOn = (req.query.failOn ?? (job as any).config?.failOn ?? "high") as SeverityThreshold;
      const passed = job.status === "completed" ? scanPassed(job.summary, failOn) : null;
      const counts = (job.summary as any)?.counts ?? {};

      return reply.send({
        scanId: job.id,
        status: job.status,
        phase: job.phase,
        passed,
        failOn,
        counts,
        error: job.error ?? null,
        startedAt: job.createdAt,
        finishedAt: job.finishedAt,
        reportUrl: `${WEB_URL}/projects/${auth.projectId}/security/${job.id}`,
        complianceReportUrl: `${API_URL}/security/scans/${job.id}/compliance-report?format=html`,
      });
    }
  );

  // GET /ci/templates/github
  app.get("/ci/templates/github", async (_req, reply) => {
    reply
      .header("Content-Type", "text/yaml; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="testmind-security.yml"')
      .send(githubActionsTemplate(API_URL));
  });

  // GET /ci/templates/gitlab
  app.get("/ci/templates/gitlab", async (_req, reply) => {
    reply
      .header("Content-Type", "text/yaml; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename=".gitlab-ci-testmind.yml"')
      .send(gitlabCiTemplate(API_URL));
  });

  // GET /ci/templates/generic
  app.get("/ci/templates/generic", async (_req, reply) => {
    reply
      .header("Content-Type", "text/x-shellscript; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="testmind-scan.sh"')
      .send(genericShellScript(API_URL));
  });

  // POST /ci/api-keys — generate a new CI API key for a project (session auth)
  app.post<{ Body: { projectId: string } }>("/ci/api-keys", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const { projectId } = req.body ?? {};
    if (!projectId) return reply.code(400).send({ error: "projectId required" });

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });

    const secret = randomBytes(32).toString("hex");
    const apiKey = `${projectId}_${secret}`;

    const { encryptSecret } = await import("../lib/crypto.js");
    await prisma.projectSecret.upsert({
      where: { projectId_key: { projectId, key: "CI_API_KEY" } },
      update: { value: encryptSecret(apiKey), name: "CI API Key (auto-generated)" },
      create: { projectId, key: "CI_API_KEY", name: "CI API Key (auto-generated)", value: encryptSecret(apiKey) },
    });

    return reply.code(201).send({ apiKey });
  });
}
