import type { FastifyInstance } from "fastify";
//import fetch from "node-fetch";
import crypto from "node:crypto";
import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma.js";

const GH_AUTH = "https://github.com/login/oauth/authorize";
const GH_TOKEN = "https://github.com/login/oauth/access_token";
const GH_API   = "https://api.github.com";
// near top
const WEB_URL = process.env.WEB_URL ?? "http://localhost:5173";
const JSON_PARSE_FAIL = "JSON_PARSE_FAIL";

// Lightweight, signed OAuth state to bind callbacks to the user that initiated the flow.
const stateSecret =
  (() => {
    const raw = process.env.SECRET_KEY;
    if (raw) {
      try {
        const buf = Buffer.from(raw, "base64");
        if (buf.length >= 32) return buf;
      } catch {
        // fall through to fallback
      }
    }
    // Dev fallback so we always have a secret even if env is missing/misconfigured
    return Buffer.from("tm-dev-state-secret");
  })();

function buildState(userId: string, returnTo: string) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = JSON.stringify({ userId, nonce, ts: Date.now(), returnTo });
  const sig = crypto.createHmac("sha256", stateSecret).update(payload).digest("base64url");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

type ParsedState = { userId: string; ts: number; returnTo: string };

function parseState(state?: string | null): ParsedState | null {
  if (!state) return null;
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const [payload, sig] = decoded.split(".");
    if (!payload || !sig) return null;
    const expected = crypto.createHmac("sha256", stateSecret).update(payload).digest("base64url");
    const sigBuf = Buffer.from(sig, "base64url");
    const expBuf = Buffer.from(expected, "base64url");
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  const parsed = JSON.parse(payload) as { userId?: string; ts?: number; returnTo?: string };
    if (!parsed.userId || typeof parsed.userId !== "string") return null;
    // 10 minute expiry to avoid replay across users/sessions
  if (typeof parsed.ts !== "number" || Date.now() - parsed.ts > 10 * 60 * 1000) return null;
  if (!parsed.returnTo || typeof parsed.returnTo !== "string") return null;
  return { userId: parsed.userId, ts: parsed.ts, returnTo: parsed.returnTo };
  } catch {
    return null;
  }
}

export async function githubRoutes(app: FastifyInstance) {
  const CLIENT_ID = process.env.GITHUB_CLIENT_ID!;
  const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET!;
  const REDIRECT_URI = process.env.GITHUB_REDIRECT_URI!;

  async function getAccount(userId: string) {
    return prisma.gitAccount.findUnique({
      where: { provider_userId: { provider: "github", userId } },
    });
  }

function buildAuthUrl(state: string) {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "repo read:user",
      state,
      approval_prompt: "force",
    });
    return `${GH_AUTH}?${params.toString()}`;
  }

  async function parseJsonResponse(res: Response) {
    const text = await res.text();
    try {
      return { ok: true as const, data: JSON.parse(text) as any };
    } catch {
      return { ok: false as const, text };
    }
  }

  async function fetchGitHubUser(accessToken: string) {
    const r = await fetch(`${GH_API}/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "TestMindAI",
      },
    });
    const parsed = await parseJsonResponse(r);
    if (!r.ok || !parsed.ok) {
      const body = parsed.ok ? JSON.stringify(parsed.data) : parsed.text;
      throw Object.assign(
        new Error(`Failed to verify GitHub user (${r.status}): ${body || r.statusText}`),
        { code: JSON_PARSE_FAIL, body }
      );
    }
    return parsed.data as { id: number; login: string };
  }

  async function revokeGithubAuth(token: string) {
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const headers = {
      Authorization: `Basic ${basic}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "TestMindAI",
      "Content-Type": "application/json",
    };
    const body = JSON.stringify({ access_token: token });

    async function revoke(path: "token" | "grant") {
      const url = `https://api.github.com/applications/${CLIENT_ID}/${path}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers,
        body,
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        throw new Error(`GitHub revoke ${path} failed (${res.status}): ${text || res.statusText}`);
      }
      app.log.info({ path, status: res.status, text }, "GitHub revoke succeeded");
    }

    let tokenError: Error | null = null;
    try {
      await revoke("token");
    } catch (err: any) {
      tokenError = err instanceof Error ? err : new Error(String(err));
    }

    try {
      await revoke("grant");
    } catch (err: any) {
      const grantError = err instanceof Error ? err : new Error(String(err));
      if (tokenError) {
        throw new Error(`${tokenError.message}; ${grantError.message}`);
      }
      throw grantError;
    }

    if (tokenError) {
      throw tokenError;
    }
  }

  // 1) Kick off OAuth
  app.get("/auth/github/start", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    // Defensive: clear any existing token for this user before starting a new connect flow
    const returnTo = (req.query as any)?.returnTo ?? "/dashboard";
    const state = buildState(userId, returnTo); // unique, signed per-user state to prevent cross-user reuse
    // `prompt=login` forces GitHub to show the account chooser/login even if a previous
    // GitHub session is active in the browser. This prevents reusing an old GitHub token
    // when a different TestMind user connects.
    const url = buildAuthUrl(state);

    app.log.info({ userId }, "GitHub start -> redirect");
    return reply.redirect(url);
  });

  // Return the GitHub auth URL (for SPA to navigate with auth headers)
  app.get("/auth/github/start-url", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const returnTo = (req.query as any)?.returnTo ?? "/dashboard";
    const state = buildState(userId, returnTo);
    const url = buildAuthUrl(state);
    app.log.info({ userId }, "GitHub start-url -> redirect");
    return reply.send({ url });
  });

  // Debug helper: see what token is stored for the current user (sanitized)
  app.get("/auth/github/debug", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const account = await getAccount(userId);
    return {
      userId,
      account: account
        ? { id: account.id, provider: account.provider, githubUserId: account.githubUserId, githubLogin: account.githubLogin }
        : null,
    };
  });

  // Hard reset for current user (clears any stored GitHub token for this user)
  app.post("/auth/github/reset", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const removed = await prisma.gitAccount.deleteMany({ where: { provider: "github", userId } });
    app.log.info({ userId, removed }, "GitHub reset for user");
    return reply.send({ ok: true, removed });
  });

  // 2) Callback: exchange code for token and save
  app.get("/auth/github/callback", async (req, reply) => {
    const { code, state } = (req.query ?? {}) as { code?: string; state?: string };
    if (!code || !state) {
      app.log.error({ code, state }, "GitHub callback missing code/state");
      return reply.code(400).send("Missing code/state");
    }

    const parsedState = parseState(state);
    if (!parsedState) {
      app.log.error({ state }, "GitHub callback invalid/expired state");
      return reply.code(400).send("Invalid or expired state");
    }
    const userId = parsedState.userId;

    app.log.info({ userId, code, state }, "GitHub callback received");

    try {
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
      const parsedToken = await parseJsonResponse(r);
      if (!parsedToken.ok) {
        app.log.error(
          { raw: parsedToken.text, userId, status: r.status },
          "GitHub token exchange returned non-JSON"
        );
        return reply.code(500).send({ error: "GitHub token exchange failed: unexpected response format" });
      }
      const data = parsedToken.data as { access_token?: string; error?: string; error_description?: string };

      if (!data.access_token) {
        app.log.error({ data, userId, status: r.status }, "GitHub token exchange failed (no access_token)");
        return reply.code(500).send(data);
      }

      // Identify the GitHub account tied to this token so we can avoid cross-user reuse.
      const ghUser = await fetchGitHubUser(data.access_token);

      app.log.info(
        { userId, ghLogin: ghUser.login, ghId: ghUser.id, tokenPrefix: data.access_token.slice(0, 6) },
        "GitHub token fetched; writing to DB"
      );

      try {
        const saved = await prisma.gitAccount.upsert({
          where: { provider_userId: { provider: "github", userId } },
          update: {
            token: data.access_token,
            githubUserId: ghUser.id,
            githubLogin: ghUser.login,
          },
          create: {
            provider: "github",
            userId,
            token: data.access_token,
            githubUserId: ghUser.id,
            githubLogin: ghUser.login,
          },
        });
        app.log.info({ userId, saved }, "GitHub upsert completed");
      } catch (dbErr: any) {
        app.log.error(
          {
            userId,
            ghLogin: ghUser.login,
            ghId: ghUser.id,
            err: dbErr?.message || String(dbErr),
            stack: dbErr?.stack,
          },
          "GitHub upsert failed"
        );
        return reply.code(500).send({ error: "Failed to save GitHub account", message: dbErr?.message || String(dbErr) });
      }

      app.log.info(
        { userId, ghLogin: ghUser.login, returnTo: parsedState.returnTo },
        "GitHub linked; redirecting to callback success"
      );
      const target = `${WEB_URL}${parsedState.returnTo}?github=connected`;
      return reply.redirect(target);
    } catch (err: any) {
      app.log.error(
        { err: err?.message || String(err), stack: err?.stack, userId },
        "GitHub callback failed"
      );
      return reply
        .code(500)
        .send({ error: "GitHub auth failed", message: err?.message || String(err) });
    }
  });

  // 3) Is connected?
  app.get("/github/status", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ connected: false });

    app.log.info({ userId }, "github/status requested");

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
    if (!account) return reply.code(401).send({ error: "GitHub not connected" });

    const r = await fetch(`${GH_API}/user/repos?per_page=100&sort=updated`, {
      headers: { Authorization: `Bearer ${account.token}`, "User-Agent": "TestMindAI" },
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      app.log.error({ text }, "GitHub API error");
      // If token is stale/unauthorized, drop it so the user must reconnect
      if (r.status === 401 || r.status === 403) {
        await prisma.gitAccount.deleteMany({ where: { provider: "github", userId } });
        return reply.code(400).send({ error: "GitHub token expired. Please reconnect." });
      }
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

  // Dev helper: show all GitHub accounts for this user (sanitized)
  app.get("/auth/github/debug-all", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });
    const rows = await prisma.gitAccount.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return reply.send({
      userId,
      accounts: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        githubUserId: r.githubUserId,
        githubLogin: r.githubLogin,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        tokenPrefix: r.token.slice(0, 6),
      })),
    });
  });

  app.delete("/github/status", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const account = await getAccount(userId);
    if (account?.token) {
      try {
        await revokeGithubAuth(account.token);
      } catch (revErr: any) {
        app.log.warn(
          {
            err: revErr?.message || String(revErr),
            statusCode: revErr?.status,
            userId,
          },
          "GitHub revoke failed during disconnect"
        );
      }
    }

    const removed = await prisma.gitAccount.deleteMany({
      where: { provider: "github", userId },
    });
    return reply.send({ ok: true, removed });
  });
}
