import nodemailer from "nodemailer";
import { prisma } from "../prisma.js";

type NotifyOn = "all" | "failures" | "success";

type SummaryCounts = {
  parsedCount?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  baseUrl?: string;
  framework?: string;
};

function shouldNotify(status: string, notifyOn: NotifyOn) {
  if (notifyOn === "all") return true;
  if (notifyOn === "failures") return status === "failed";
  if (notifyOn === "success") return status === "succeeded";
  return false;
}

function parseSummary(summary?: string | null): SummaryCounts | null {
  if (!summary) return null;
  try {
    return JSON.parse(summary) as SummaryCounts;
  } catch {
    return null;
  }
}

function getWebBase() {
  return (
    process.env.APP_BASE_URL ||
    process.env.WEB_URL ||
    "http://localhost:5173"
  ).replace(/\/$/, "");
}

function getApiBase() {
  return (
    process.env.API_BASE_URL ||
    process.env.APP_BASE_URL ||
    process.env.WEB_URL ||
    "http://localhost:5173"
  ).replace(/\/$/, "");
}

function formatCounts(summary: SummaryCounts | null, resultCount?: number) {
  if (!summary) return resultCount ? `Parsed: ${resultCount}` : "No summary";
  const parsedCount = summary.parsedCount ?? resultCount ?? 0;
  const passed = summary.passed ?? 0;
  const failed = summary.failed ?? 0;
  const skipped = summary.skipped ?? 0;
  return `Parsed: ${parsedCount} • Passed: ${passed} • Failed: ${failed} • Skipped: ${skipped}`;
}

function buildSlackText(params: {
  projectName: string;
  runId: string;
  status: string;
  baseUrl?: string;
  summary?: SummaryCounts | null;
  resultCount?: number;
  error?: string | null;
  artifacts?: Record<string, string> | null;
}) {
  const webBase = getWebBase();
  const apiBase = getApiBase();
  const link = `${webBase}/test-runs/${params.runId}`;
  const counts = formatCounts(params.summary ?? null, params.resultCount);
  const artifacts = params.artifacts ?? {};
  const allurePath = artifacts["allure-report"];
  const jsonPath = artifacts["reportJson"];
  const allureLink = allurePath
    ? `${apiBase}/${String(allurePath).replace(/^[\\/]+/, "")}/index.html`
    : null;
  const jsonLink = jsonPath
    ? `${apiBase}/${String(jsonPath).replace(/^[\\/]+/, "")}`
    : null;
  const lines = [
    `*Test run* \`${params.runId.slice(0, 8)}\` for *${params.projectName}*`,
    `Status: *${params.status.toUpperCase()}*`,
    params.baseUrl ? `Base URL: ${params.baseUrl}` : null,
    counts,
    params.error ? `Error: ${params.error}` : null,
    `Report: ${link}`,
    allureLink ? `Allure: ${allureLink}` : null,
    jsonLink ? `JSON: ${jsonLink}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function buildEmail(params: {
  projectName: string;
  runId: string;
  status: string;
  baseUrl?: string;
  summary?: SummaryCounts | null;
  resultCount?: number;
  error?: string | null;
  artifacts?: Record<string, string> | null;
}) {
  const webBase = getWebBase();
  const apiBase = getApiBase();
  const link = `${webBase}/test-runs/${params.runId}`;
  const counts = formatCounts(params.summary ?? null, params.resultCount);
  const artifacts = params.artifacts ?? {};
  const allurePath = artifacts["allure-report"];
  const jsonPath = artifacts["reportJson"];
  const allureLink = allurePath
    ? `${apiBase}/${String(allurePath).replace(/^[\\/]+/, "")}/index.html`
    : null;
  const jsonLink = jsonPath
    ? `${apiBase}/${String(jsonPath).replace(/^[\\/]+/, "")}`
    : null;
  const subject = `TestMind run ${params.status} • ${params.projectName}`;
  const text = [
    `Project: ${params.projectName}`,
    `Run: ${params.runId}`,
    `Status: ${params.status}`,
    params.baseUrl ? `Base URL: ${params.baseUrl}` : null,
    counts,
    params.error ? `Error: ${params.error}` : null,
    `Report: ${link}`,
    allureLink ? `Allure: ${allureLink}` : null,
    jsonLink ? `JSON: ${jsonLink}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#0f172a">
      <h2 style="margin:0 0 12px">TestMind run ${params.status}</h2>
      <p style="margin:0 0 8px"><strong>Project:</strong> ${params.projectName}</p>
      <p style="margin:0 0 8px"><strong>Run:</strong> ${params.runId}</p>
      <p style="margin:0 0 8px"><strong>Status:</strong> ${params.status}</p>
      ${params.baseUrl ? `<p style="margin:0 0 8px"><strong>Base URL:</strong> ${params.baseUrl}</p>` : ""}
      <p style="margin:0 0 8px"><strong>${counts}</strong></p>
      ${params.error ? `<pre style="background:#f8fafc;border:1px solid #e2e8f0;padding:8px;border-radius:6px;white-space:pre-wrap">${params.error}</pre>` : ""}
      <p style="margin:12px 0 0"><a href="${link}">View report</a></p>
      ${allureLink ? `<p style="margin:4px 0 0"><a href="${allureLink}">Allure report</a></p>` : ""}
      ${jsonLink ? `<p style="margin:4px 0 0"><a href="${jsonLink}">Raw JSON</a></p>` : ""}
    </div>
  `.trim();
  return { subject, text, html };
}

async function sendSlack(webhookUrl: string, text: string) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Slack webhook failed (${res.status}): ${body}`.trim());
  }
}

async function sendEmail(recipients: string[], subject: string, text: string, html: string) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;
  if (!host || !from) {
    throw new Error("SMTP_HOST and SMTP_FROM must be set for email notifications");
  }
  const port = Number(process.env.SMTP_PORT ?? "587");
  const secure = (process.env.SMTP_SECURE ?? "0") === "1";
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
  });
  await transporter.sendMail({
    from,
    to: recipients,
    subject,
    text,
    html,
  });
}

export async function sendRunNotifications(runId: string) {
  const run = await prisma.testRun.findUnique({
    where: { id: runId },
    include: { project: { select: { id: true, name: true } } },
  });
  if (!run || run.status === "queued" || run.status === "running") return;

  const integrations = await prisma.integration.findMany({
    where: {
      projectId: run.projectId,
      enabled: true,
      provider: { in: ["slack-webhook", "email-smtp"] },
    },
  });
  if (!integrations.length) return;

  const summary = parseSummary(run.summary);
  const resultCount = await prisma.testResult.count({ where: { runId } });
  const baseUrl = summary?.baseUrl;
  const artifacts =
    run.artifactsJson && typeof run.artifactsJson === "object"
      ? (run.artifactsJson as Record<string, string>)
      : null;

  for (const integration of integrations) {
    const config = (integration.config ?? {}) as Record<string, any>;
    const secrets = (integration.secrets ?? {}) as Record<string, any>;
    const notifyOn = (config.notifyOn ?? "failures") as NotifyOn;
    if (!shouldNotify(run.status, notifyOn)) continue;

    try {
      if (integration.provider === "slack-webhook") {
        const webhookUrl = String(secrets.webhookUrl || config.webhookUrl || "").trim();
        if (!webhookUrl) continue;
        const text = buildSlackText({
          projectName: run.project.name,
          runId: run.id,
          status: run.status,
          baseUrl,
          summary,
          resultCount,
          error: run.error,
          artifacts,
        });
        await sendSlack(webhookUrl, text);
      }
      if (integration.provider === "email-smtp") {
        const recipients = Array.isArray(config.recipients)
          ? config.recipients
          : String(config.recipients || "")
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean);
        if (!recipients.length) continue;
        const email = buildEmail({
          projectName: run.project.name,
          runId: run.id,
          status: run.status,
          baseUrl,
          summary,
          resultCount,
          error: run.error,
          artifacts,
        });
        await sendEmail(recipients, email.subject, email.text, email.html);
      }
    } catch (err: any) {
      console.error(`[notifications] ${integration.provider} failed`, err?.message ?? err);
    }
  }
}
