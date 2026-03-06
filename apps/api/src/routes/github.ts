import type { FastifyInstance } from "fastify";
//import fetch from "node-fetch";
import crypto from "node:crypto";
import { getAuth } from "@clerk/fastify";
import { prisma } from "../prisma.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";

const GH_AUTH = "https://github.com/login/oauth/authorize";
const GH_TOKEN = "https://github.com/login/oauth/access_token";
const GH_API   = "https://api.github.com";
const GITHUB_HTTP_TIMEOUT_MS = Number(process.env.GITHUB_HTTP_TIMEOUT_MS ?? "12000");
const GITHUB_HTTP_GET_RETRIES = Number(process.env.GITHUB_HTTP_GET_RETRIES ?? "1");
const GITHUB_HTTP_RETRY_BACKOFF_MS = Number(process.env.GITHUB_HTTP_RETRY_BACKOFF_MS ?? "300");
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

function sanitizeReturnTo(value?: string | null): string {
  const fallback = "/dashboard";
  const raw = (value ?? "").trim();
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (/[\r\n]/.test(raw)) return fallback;
  return raw;
}

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

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = GITHUB_HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`GitHub request timeout after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableStatus(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function fetchGithubGetWithRetry(
  url: string,
  init?: RequestInit,
  retries = GITHUB_HTTP_GET_RETRIES
): Promise<Response> {
  const maxRetries = Number.isFinite(retries) ? Math.max(0, Math.trunc(retries)) : 1;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { ...(init ?? {}), method: "GET" });
      if (!isRetryableStatus(res.status) || attempt === maxRetries) {
        return res;
      }
      await sleep(GITHUB_HTTP_RETRY_BACKOFF_MS * (attempt + 1));
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries) throw err;
      await sleep(GITHUB_HTTP_RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  throw (lastErr instanceof Error ? lastErr : new Error("GitHub GET request failed"));
}

function githubAccountWhereForUser(userId: string) {
  return { provider_userId: { provider: "github" as const, userId } };
}

export async function githubRoutes(app: FastifyInstance) {
  const CLIENT_ID = process.env.GITHUB_CLIENT_ID!;
  const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET!;
  const REDIRECT_URI = process.env.GITHUB_REDIRECT_URI!;

  async function getAccount(userId: string) {
    return prisma.gitAccount.findUnique({
      where: githubAccountWhereForUser(userId),
    });
  }

  function decodeGitToken(raw?: string | null): string | null {
    if (!raw) return null;
    try {
      return decryptSecret(raw);
    } catch {
      // Backward compatibility for legacy plaintext tokens already stored.
      return raw;
    }
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
    const r = await fetchGithubGetWithRetry(`${GH_API}/user`, {
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
      const res = await fetchWithTimeout(url, {
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
    const returnTo = sanitizeReturnTo((req.query as any)?.returnTo);
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

    const returnTo = sanitizeReturnTo((req.query as any)?.returnTo);
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
      app.log.error("GitHub callback missing code/state");
      return reply.code(400).send("Missing code/state");
    }

    const parsedState = parseState(state);
    if (!parsedState) {
      app.log.error("GitHub callback invalid/expired state");
      return reply.code(400).send("Invalid or expired state");
    }
    const { userId: activeUserId } = getAuth(req);
    if (activeUserId && activeUserId !== parsedState.userId) {
      app.log.warn({ activeUserId, stateUserId: parsedState.userId }, "GitHub callback user mismatch");
      return reply.code(403).send("OAuth callback user mismatch");
    }
    const userId = parsedState.userId;

    app.log.info({ userId }, "GitHub callback received");

    try {
      const r = await fetchWithTimeout(GH_TOKEN, {
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
      // Enterprise setup: the same GitHub identity (or bot account) may be linked by
      // multiple TestMind users who work on the same repository/org.

      app.log.info(
        { userId, ghLogin: ghUser.login, ghId: ghUser.id },
        "GitHub token fetched; writing to DB"
      );

      try {
        const saved = await prisma.gitAccount.upsert({
          where: { provider_userId: { provider: "github", userId } },
          update: {
            token: encryptSecret(data.access_token),
            githubUserId: ghUser.id,
            githubLogin: ghUser.login,
          },
          create: {
            provider: "github",
            userId,
            token: encryptSecret(data.access_token),
            githubUserId: ghUser.id,
            githubLogin: ghUser.login,
          },
        });
        app.log.info({ userId, accountId: saved.id }, "GitHub upsert completed");
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
      where: githubAccountWhereForUser(userId),
      select: { id: true },
    });

    return { connected: !!account };
  });

  // 4) List repos (for repo picker)
  app.get("/github/repos", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const account = await prisma.gitAccount.findUnique({
      where: githubAccountWhereForUser(userId),
    });
    if (!account) return reply.code(401).send({ error: "GitHub not connected" });
    const accessToken = decodeGitToken(account.token);
    if (!accessToken) return reply.code(401).send({ error: "GitHub token missing" });

    const r = await fetchGithubGetWithRetry(`${GH_API}/user/repos?per_page=100&sort=updated`, {
      headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "TestMindAI" },
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
      })),
    });
  });

  app.delete("/github/status", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const account = await getAccount(userId);
    const accessToken = decodeGitToken(account?.token);
    if (accessToken) {
      try {
        await revokeGithubAuth(accessToken);
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

export const __githubSecurityInternals = {
  buildState,
  parseState,
  sanitizeReturnTo,
  githubAccountWhereForUser,
};
