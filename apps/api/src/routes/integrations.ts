// apps/api/src/routes/integrations.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "../prisma";
import { getAuth } from "@clerk/fastify";
import { Octokit } from "@octokit/rest";
import { z } from "zod";

const Body = z.object({
  runId: z.string().min(1),
  title: z.string().trim().min(1).optional(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(), // optional labels
});

export default async function integrationsRoutes(app: FastifyInstance) {
  // POST /integrations/github/create-issue
  app.post("/integrations/github/create-issue", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: parsed.error.flatten() });
    }
    const { runId, title, body, labels } = parsed.data;

    // Load run + project; verify ownership
    const run = await prisma.testRun.findUnique({
      where: { id: runId },
      include: { project: { select: { id: true, name: true, ownerId: true, repoUrl: true } } },
    });
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (run.project.ownerId !== userId) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    // Must be completed
    if (run.status === "queued" || run.status === "running") {
      return reply.code(409).send({ error: "Run must be completed before filing an issue" });
    }

    if (!run.project.repoUrl) {
      return reply.code(400).send({ error: "Project repoUrl not configured" });
    }

    // If we already created an issue for this run, re-use it
    if (run.issueUrl) {
      return reply.code(200).send({ url: run.issueUrl });
    }

    // Parse owner/repo from repoUrl (supports https and ssh forms)
    // e.g. https://github.com/org/repo(.git) or git@github.com:org/repo(.git)
    const match =
      /github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/#?]+)(?:\.git)?/i.exec(run.project.repoUrl);
    const owner = match?.groups?.owner;
    const repo = match?.groups?.repo;
    if (!owner || !repo) {
      return reply.code(400).send({ error: "Invalid GitHub repo URL" });
    }

    // Fetch user's GitHub token
    const git = await prisma.gitAccount.findFirst({
      where: { userId, provider: "github" },
    });
    if (!git?.token) return reply.code(400).send({ error: "GitHub not connected" });

    const octokit = new Octokit({ auth: git.token });

    const defaultTitle = title ?? `Test run ${run.id.slice(0, 8)} ${run.status}`;
    const defaultBody =
      body ??
      [
        `**Run**: ${run.id}`,
        `**Status**: ${run.status}`,
        run.error ? `**Error**:\n\n${run.error}` : null,
        run.summary ? `**Summary**:\n\n\`\`\`json\n${run.summary}\n\`\`\`` : null,
        `**Created**: ${run.createdAt.toISOString()}`,
        run.startedAt ? `**Started**: ${run.startedAt.toISOString()}` : null,
        run.finishedAt ? `**Finished**: ${run.finishedAt.toISOString()}` : null,
        `**Link**: ${(process.env.APP_BASE_URL ?? "http://localhost:5173")}/test-runs/${run.id}`,
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

      return reply.send({ url: data.html_url, number: data.number });
    } catch (err: any) {
      const gh = err?.response?.data;
      return reply.code(502).send({
        error: "GITHUB_ERROR",
        details: gh ?? err?.message ?? String(err),
      });
    }
  });
}
