import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma } from "../prisma.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { resolveCredentialEnv } from "./qe-credentials.js";
import { authorizeRunRepository, parseGitHubRepo, redactGitError, releaseRunCredentials, RUN_CREDENTIAL_KEY_PREFIX, storeRunCredentials, withRunCheckout } from "./qe-run-access.js";

test("repository input forms resolve to owner/repo; anything else is refused", () => {
  for (const s of ["acme/shop", "https://github.com/acme/shop", "https://github.com/acme/shop.git", "git@github.com:acme/shop.git", "https://www.github.com/acme/shop/"]) {
    assert.deepEqual(parseGitHubRepo(s), { owner: "acme", repo: "shop" }, s);
  }
  for (const s of ["https://gitlab.com/acme/shop", "acme", "file:///etc/passwd", "https://github.com/acme/shop/tree/main", "../../etc"]) {
    assert.equal(parseGitHubRepo(s), null, s);
  }
});

test("git errors never expose the integration token", () => {
  const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const header = Buffer.from(`x-access-token:${token}`).toString("base64");
  const msg = `Command failed with exit code 128: git -c http.https://github.com/.extraheader=Authorization: Basic ${header} clone --depth=1 https://github.com/acme/shop /tmp/x\nfatal: could not read ${token}`;
  const out = redactGitError(msg, token);
  assert.ok(!out.includes(token) && !out.includes(header), out);
  assert.match(out, /Authorization: \[redacted\]/);
});

test("credentials for one run are stored encrypted, resolvable by reference, and deleted when the run ends", async (t) => {
  const project = await prisma.project.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  assert.ok(project, "requires a project row");
  const { ref, keys } = await storeRunCredentials(project!.id, { email: "qa@example.test", password: "s3cret-pass", loginPath: "/login" });
  const job = await prisma.operatorJob.create({ data: { projectId: project!.id, type: "qa", status: "running", requestedBy: "test", contextJson: { qe: { runCredentialKeys: keys, credentialRef: ref } } } });
  t.after(async () => {
    await prisma.projectSecret.deleteMany({ where: { projectId: project!.id, key: { in: keys } } });
    await prisma.operatorJob.delete({ where: { id: job.id } });
  });
  assert.ok(keys.every((k) => k.startsWith(RUN_CREDENTIAL_KEY_PREFIX)));
  const rows = await prisma.projectSecret.findMany({ where: { projectId: project!.id, key: { in: keys } } });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => !r.value.includes("s3cret-pass") && !r.value.includes("qa@example.test")), "stored encrypted");
  assert.equal(decryptSecret(rows.find((r) => r.key === ref.passwordKey)!.value), "s3cret-pass");
  const env = await resolveCredentialEnv(project!.id, ref, { email: "E", password: "P", loginPath: "L" });
  assert.deepEqual(env, { E: "qa@example.test", P: "s3cret-pass", L: "/login" });
  assert.equal(JSON.stringify(job.contextJson).includes("s3cret-pass"), false, "the run context holds keys only");

  assert.equal(await releaseRunCredentials(job.id), 2);
  assert.equal(await prisma.projectSecret.count({ where: { projectId: project!.id, key: { in: keys } } }), 0);
  assert.equal(await releaseRunCredentials(job.id), 0, "idempotent");
});

test("only keys with the run-credential prefix can ever be released", async (t) => {
  const project = await prisma.project.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  const saved = await prisma.projectSecret.create({ data: { projectId: project!.id, name: "saved", key: `SAVED_TEST_${Date.now()}`, value: "x" } });
  const job = await prisma.operatorJob.create({ data: { projectId: project!.id, type: "qa", status: "running", requestedBy: "test", contextJson: { qe: { runCredentialKeys: [saved.key] } } } });
  t.after(async () => {
    await prisma.projectSecret.deleteMany({ where: { id: saved.id } });
    await prisma.operatorJob.delete({ where: { id: job.id } });
  });
  assert.equal(await releaseRunCredentials(job.id), 0);
  assert.equal(await prisma.projectSecret.count({ where: { id: saved.id } }), 1, "a saved project secret is never deleted");
});

async function tempOwnerProject(t: any, opts: { connectedToken?: string } = {}) {
  const userId = `test-gh-owner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.user.create({ data: { id: userId } });
  const project = await prisma.project.create({ data: { name: "repo-access test", repoUrl: "example.test", ownerId: userId } });
  if (opts.connectedToken) await prisma.gitAccount.create({ data: { provider: "github", userId, token: encryptSecret(opts.connectedToken), githubLogin: "tester" } });
  t.after(async () => {
    await prisma.gitAccount.deleteMany({ where: { userId } });
    await prisma.project.delete({ where: { id: project.id } });
    await prisma.user.delete({ where: { id: userId } });
  });
  return project;
}

test("without an integration or connected GitHub account, repository access is refused clearly", async (t) => {
  const project = await tempOwnerProject(t);
  const lookups: string[] = [];
  const lookup = async (o: string, r: string) => { lookups.push(`${o}/${r}`); return { status: 200, body: { full_name: `${o}/${r}` } }; };
  assert.equal((await authorizeRunRepository(project.id, "not a repo", undefined, { lookup })).ok, false);
  const r = await authorizeRunRepository(project.id, "farmerj50/justicepath", undefined, { lookup });
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /Connect GitHub/);
  assert.deepEqual(lookups, [], "GitHub is never called without a credential");
});

test("the project owner's connected GitHub account authorizes repositories GitHub confirms it can read", async (t) => {
  const token = "gho_connectedAccountTokenForTests0000000";
  const project = await tempOwnerProject(t, { connectedToken: token });
  const seen: Array<{ repo: string; token: string }> = [];
  const lookup = async (o: string, r: string, tok: string) => {
    seen.push({ repo: `${o}/${r}`, token: tok });
    if (r.toLowerCase() === "justicepath") return { status: 200, body: { full_name: "farmerj50/justicepath", default_branch: "develop", permissions: { pull: true } } };
    if (r === "expired") return { status: 401, body: null };
    return { status: 404, body: null };
  };
  const ok = await authorizeRunRepository(project.id, "https://github.com/FarmerJ50/JusticePath.git", undefined, { lookup });
  assert.equal(ok.ok, true);
  const access = (ok as { access: any }).access;
  assert.deepEqual({ url: access.url, owner: access.owner, repo: access.repo, branch: access.branch }, { url: "https://github.com/farmerj50/justicepath", owner: "farmerj50", repo: "justicepath", branch: "develop" }, "canonical name and default branch from GitHub");
  assert.equal(access.token, token, "the stored token is decrypted in memory only");
  assert.equal(seen[0].token, token);

  const withBranch = await authorizeRunRepository(project.id, "farmerj50/justicepath", "feature/x", { lookup });
  assert.equal((withBranch as { access: any }).access.branch, "feature/x");
  assert.equal((await authorizeRunRepository(project.id, "farmerj50/justicepath", "../etc", { lookup })).ok, false, "unsafe branch refused");

  const denied = await authorizeRunRepository(project.id, "someone-else/private-repo", undefined, { lookup });
  assert.equal(denied.ok, false);
  assert.match((denied as { reason: string }).reason, /cannot access someone-else\/private-repo/);
  const expired = await authorizeRunRepository(project.id, "farmerj50/expired", undefined, { lookup });
  assert.match((expired as { reason: string }).reason, /reconnect GitHub/);
});

test("a run checkout is temporary: available to the inspection, then always deleted (also on failure)", async (t) => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), "tm-run-repo-src-"));
  await fs.writeFile(path.join(src, "app.tsx"), "export const route = '/checkout';\n");
  const prev = process.env.TM_LOCAL_REPO_PATH;
  process.env.TM_LOCAL_REPO_PATH = src; // cloneRepo's existing local-snapshot override (no network)
  t.after(async () => { process.env.TM_LOCAL_REPO_PATH = prev; await fs.rm(src, { recursive: true, force: true }); });
  const access = { url: "https://github.com/acme/shop", owner: "acme", repo: "shop", branch: "main" };
  let seen = "";
  const root = await withRunCheckout("run-checkout-test", access, async (dir) => { seen = await fs.readFile(path.join(dir, "app.tsx"), "utf8"); return dir; });
  assert.match(seen, /checkout/);
  await assert.rejects(fs.stat(root), "removed after use");
  let failedRoot = "";
  await assert.rejects(withRunCheckout("run-checkout-test-2", access, async (dir) => { failedRoot = dir; throw new Error("inspection failed"); }), /inspection failed/);
  await assert.rejects(fs.stat(failedRoot), "removed after a failure too");
  await assert.rejects(withRunCheckout("../escape", access, async () => 1), /Invalid run id/);
});
