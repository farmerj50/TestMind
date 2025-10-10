import type { FastifyInstance } from "fastify";
//import fetch from "node-fetch";
import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma";

const GH_AUTH = "https://github.com/login/oauth/authorize";
const GH_TOKEN = "https://github.com/login/oauth/access_token";
const GH_API   = "https://api.github.com";
// near top
const WEB_URL = process.env.WEB_URL ?? "http://localhost:5173";
export async function githubRoutes(app: FastifyInstance) {
  const CLIENT_ID = process.env.GITHUB_CLIENT_ID!;
  const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET!;
  const REDIRECT_URI = process.env.GITHUB_REDIRECT_URI!;

  // 1) Kick off OAuth
  app.get("/auth/github/start", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const state = encodeURIComponent(userId); // simplest CSRF/user binding
    const url = `${GH_AUTH}?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
      REDIRECT_URI
    )}&scope=repo%20read:user&state=${state}`;

    reply.redirect(url);
  });

  // 2) Callback: exchange code for token and save
  app.get("/auth/github/callback", async (req, reply) => {
    const { code, state } = (req.query ?? {}) as { code?: string; state?: string };
    if (!code || !state) return reply.code(400).send("Missing code/state");

    // (optional) verify state === userId format
    const userId = decodeURIComponent(state);

    const r = await fetch(GH_TOKEN, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = (await r.json()) as { access_token?: string; error?: string; error_description?: string };

    if (!data.access_token) {
      app.log.error({ data }, "GitHub token exchange failed");
      return reply.code(500).send(data);
    }

    await prisma.gitAccount.upsert({
      where: { provider_userId: { provider: "github", userId } },
      update: { token: data.access_token },
      create: { provider: "github", userId, token: data.access_token },
    });

    // Redirect back to dashboard with a hint query you can read for a toast
    return reply.redirect(`${WEB_URL}/dashboard?github=connected`);
  });

  // 3) Is connected?
  app.get("/github/status", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ connected: false });

    const account = await prisma.gitAccount.findUnique({
      where: { provider_userId: { provider: "github", userId } },
      select: { id: true },
    });

    return { connected: !!account };
  });

  // 4) List repos (for repo picker)
  app.get("/github/repos", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const account = await prisma.gitAccount.findUnique({
      where: { provider_userId: { provider: "github", userId } },
    });
    if (!account) return reply.code(400).send({ error: "GitHub not connected" });

    const r = await fetch(`${GH_API}/user/repos?per_page=100&sort=updated`, {
      headers: { Authorization: `Bearer ${account.token}`, "User-Agent": "TestMindAI" },
    });
    if (!r.ok) {
      const text = await r.text();
      app.log.error({ text }, "GitHub API error");
      return reply.code(502).send({ error: "Failed to fetch repos" });
    }
    const repos = (await r.json()) as Array<{ html_url: string; full_name: string; private: boolean }>;
    return {
      repos: repos.map((x) => ({
        name: x.full_name,
        url: x.html_url,
        private: x.private,
      })),
    };
  });
}
