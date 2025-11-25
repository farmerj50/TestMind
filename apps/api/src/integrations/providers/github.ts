import { z } from "zod";
import { Octokit } from "@octokit/rest";
import { prisma } from "../../prisma";
import type { IntegrationProvider } from "../registry";

const ConfigSchema = z
  .object({
    autoCreateOnFailure: z.boolean().optional(),
    defaultLabels: z.array(z.string()).optional(),
  })
  .default({});

const ActionBody = z.object({
  runId: z.string().min(1),
  title: z.string().trim().min(1).optional(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

const githubIssuesProvider: IntegrationProvider = {
  key: "github-issues",
  displayName: "GitHub Issues",
  validateConfig(input) {
    const parsed = ConfigSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    return { config: parsed.data };
  },
  maskConfig(config) {
    if (!config || typeof config !== "object") return config;
    return config;
  },
  async performAction(action, ctx) {
    if (action !== "create-issue") {
      throw new Error(`Unsupported action ${action} for GitHub provider`);
    }
    const parsed = ActionBody.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new Error("Invalid payload for creating GitHub issue");
    }
    const { runId, title, body, labels } = parsed.data;
    const run = await prisma.testRun.findUnique({
      where: { id: runId },
      include: {
        project: {
          select: { id: true, name: true, ownerId: true, repoUrl: true },
        },
      },
    });
    if (!run) {
      throw new Error("Run not found");
    }
    if (run.projectId !== ctx.integration.projectId) {
      throw new Error("Integration and run project mismatch");
    }
    if (run.project.ownerId !== ctx.userId) {
      throw new Error("Forbidden");
    }
    if (!run.project.repoUrl) {
      throw new Error("Project repoUrl not configured");
    }
    if (run.status === "queued" || run.status === "running") {
      throw new Error("Run must be completed before filing an issue");
    }
    if (run.issueUrl) {
      return { url: run.issueUrl };
    }
    const match =
      /github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/#?]+)(?:\.git)?/i.exec(
        run.project.repoUrl
      );
    const owner = match?.groups?.owner;
    const repo = match?.groups?.repo;
    if (!owner || !repo) {
      throw new Error("Invalid GitHub repo URL");
    }
    const git = await prisma.gitAccount.findFirst({
      where: { userId: ctx.userId, provider: "github" },
    });
    if (!git?.token) {
      throw new Error("GitHub not connected");
    }
    const octokit = new Octokit({ auth: git.token });
    const defaultTitle = title ?? `Test run ${run.id.slice(0, 8)} ${run.status}`;
    const defaultBody =
      body ??
      [
        `**Run**: ${run.id}`,
        `**Status**: ${run.status}`,
        run.error ? `**Error**:\n\n${run.error}` : null,
        run.summary
          ? `**Summary**:\n\n\`\`\`json\n${run.summary}\n\`\`\``
          : null,
        `**Created**: ${run.createdAt.toISOString()}`,
        run.startedAt ? `**Started**: ${run.startedAt.toISOString()}` : null,
        run.finishedAt
          ? `**Finished**: ${run.finishedAt.toISOString()}`
          : null,
        `**Link**: ${
          process.env.APP_BASE_URL ?? "http://localhost:5173"
        }/test-runs/${run.id}`,
      ]
        .filter(Boolean)
        .join("\n\n");
    try {
      const { data } = await octokit.issues.create({
        owner,
        repo,
        title: defaultTitle,
        body: defaultBody,
        labels,
      });
      await prisma.testRun.update({
        where: { id: run.id },
        data: { issueUrl: data.html_url },
      });
      return { url: data.html_url, number: data.number };
    } catch (err: any) {
      const gh = err?.response?.data;
      throw new Error(
        gh?.message ?? err?.message ?? "Failed to create GitHub issue"
      );
    }
  },
};

export default githubIssuesProvider;
