import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";
import { autonomousPipeline } from "../lib/autonomous-routing.js";

// Execute the real route services with in-memory persistence/queue boundaries. Importing
// the production queue would open Redis connections; this loader deliberately forbids it.
function services(options: { repoAvailable?: boolean; owner?: boolean } = {}) {
  const jobs: any[] = [], runs: any[] = [], queued: string[] = [], accesses: string[] = [];
  const project = { id: "p", ownerId: options.owner === false ? "another-user" : "u", sharedSteps: { baseUrl: "https://app.example" }, repoUrl: null };
  const prisma = {
    project: { findUnique: async () => project },
    environment: { findFirst: async () => null, findMany: async () => [] },
    operatorJob: { create: async ({ data }: any) => { const job = { id: `job-${jobs.length}`, status: "queued", ...data }; jobs.push(job); return job; } },
    devAgentRun: { create: async ({ data }: any) => { const run = { id: `dev-${runs.length}`, status: "queued", ...data }; runs.push(run); return run; }, update: async () => ({}) },
    devAgentMessage: { create: async () => ({}) },
  };
  const native = createRequire(import.meta.url);
  const cache = new Map<string, any>();
  const load = (name: string): any => {
    if (cache.has(name)) return cache.get(name);
    const exports: any = {}; cache.set(name, exports);
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), name + ".ts");
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const require = (id: string): any => {
      if (id === "zod" || id.startsWith("node:")) return native(id);
      if (id === "./devAgent.js") return load("devAgent");
      if (id === "./operatorQe.js") return load("operatorQe");
      if (id.endsWith("/autonomous-routing.js")) return { autonomousPipeline };
      if (id.endsWith("/prisma.js")) return { prisma };
      if (id.endsWith("/project-access.js")) return { isProjectOwner: async () => options.owner !== false };
      if (id.endsWith("/queue.js")) return { enqueueOperatorJob: async (id: string) => queued.push(id) };
      if (id.endsWith("/env.js")) return { validatedEnv: { TM_AUTONOMOUS_QA_ENABLED: true } };
      if (id.endsWith("/safe-fetch.js")) return { validateUrl: async (url: string) => { assert.equal(new URL(url).hostname, "app.example"); } };
      if (id.endsWith("/git-url.js")) return { isLikelyGitRepoUrl: (url: string) => /github/.test(url) };
      if (id.endsWith("/dev-agent-worktree.js")) return { localTestmindRepoPath: () => null, NO_LOCAL_TESTMIND_REPO_MESSAGE: "No local repository" };
      if (id.endsWith("/dev-agent-self-improvement.js")) return { buildInstructionText: async (_mode: string, _project: string, instruction: string) => instruction };
      if (id.endsWith("/qe-orchestrator.js")) return { QE_INPUT_KINDS: ["app_url", "page", "user_story", "repository"] };
      if (id.endsWith("/qe-credentials.js")) return { credentialRefExists: async () => true };
      if (id.endsWith("/qe-run-access.js")) return {
        parseGitHubRepo: (url: string) => url.includes("org/repo") ? { repo: "org/repo" } : null,
        authorizeRunRepository: async (_project: string, url: string) => { accesses.push(url); return options.repoAvailable === false ? { ok: false, reason: "Repository unavailable" } : { ok: true, access: { url, branch: "main", repo: "org/repo" } }; },
        storeRunCredentials: async () => ({ ref: { emailKey: "temporary-email", passwordKey: "temporary-password" }, keys: ["temporary-email", "temporary-password"] }),
      };
      return {};
    };
    new Function("require", "exports", "module", code)(require, exports, { exports });
    return exports;
  };
  const invoke = async (service: "dev" | "qe", body: any) => {
    const reply = { status: 200, body: undefined as any, code(value: number) { this.status = value; return this; }, send(value: any) { this.body = value; return this; } };
    await (service === "dev" ? load("devAgent").createDevAgentRun : load("operatorQe").createQeRun)(body, "u", reply);
    return reply;
  };
  return { jobs, runs, queued, accesses, invoke };
}

test("Dev URL entry point reaches QE without a local repository and preserves the run response", async () => {
  const s = services();
  const reply = await s.invoke("dev", { projectId: "p", instructionText: "Generate full application tests", baseUrl: "https://app.example" });
  assert.equal(reply.status, 201);
  assert.equal(reply.body.pipeline, "qe");
  assert.equal(s.runs.length, 0);
  assert.equal(s.jobs[0].contextJson.qe.inputKind, "app_url");
  assert.equal(s.queued[0], reply.body.run.id);
});

test("combined URL and repository retain both authorized inputs", async () => {
  const s = services();
  await s.invoke("dev", { projectId: "p", targetRepo: "org/repo", confirmExternalRepo: true, instructionText: "Generate website tests", baseUrl: "https://app.example" });
  assert.equal(s.jobs[0].contextJson.baseUrl, "https://app.example");
  assert.equal(s.jobs[0].contextJson.qe.repository.url, "org/repo");
  assert.equal(s.accesses.length, 1);
});

test("optional repository authorization failure still queues URL testing and disables code fixes", async () => {
  const s = services({ repoAvailable: false });
  const result = await s.invoke("qe", { projectId: "p", inputKind: "app_url", input: "https://app.example", repository: { url: "org/repo" }, codeFix: { targetRepo: "org/repo", confirmExternalRepo: true } });
  assert.equal(result.status, 201);
  assert.equal(s.queued.length, 1);
  assert.match(s.jobs[0].contextJson.qe.repositoryWarning, /unavailable/);
  assert.equal(s.jobs[0].contextJson.qe.codeFix, undefined);
});

test("repository-only QE request reaches Dev without a live application URL", async () => {
  const s = services();
  const result = await s.invoke("qe", { projectId: "p", inputKind: "repository", input: "org/repo", confirmExternalRepo: true });
  assert.equal(result.status, 202);
  assert.equal(result.body.pipeline, "dev");
  assert.equal(s.jobs[0].type, "autonomousDev");
  assert.equal(s.runs[0].baseUrl, undefined);
});

test("ownership, external repository approval and project URL authorization still fail closed", async () => {
  assert.equal((await services({ owner: false }).invoke("dev", { projectId: "p", baseUrl: "https://app.example" })).status, 403);
  assert.equal((await services().invoke("qe", { projectId: "p", inputKind: "repository", input: "org/repo" })).status, 400);
  assert.equal((await services().invoke("dev", { projectId: "p", baseUrl: "https://unrelated.example" })).status, 400);
  const s = services();
  await s.invoke("dev", { projectId: "p", baseUrl: "https://app.example", targetRepo: "org/repo" });
  assert.equal(s.accesses.length, 0, "unconfirmed optional repository is never accessed");
});

test("run credentials are passed to the worker only by reference", async () => {
  const s = services();
  await s.invoke("qe", { projectId: "p", inputKind: "page", input: "https://app.example", runCredentials: { email: "test@example.test", password: "fixture-password" } });
  assert.equal(s.jobs[0].contextJson.qe.credentialRef.passwordKey, "temporary-password");
  assert.ok(!JSON.stringify(s.jobs).includes("fixture-password"));
  assert.equal((await s.invoke("qe", { projectId: "p", inputKind: "page", input: "https://app.example", credentials: { emailKey: "email", passwordKey: "password", loginPath: "//another.example" } })).status, 400);
});
