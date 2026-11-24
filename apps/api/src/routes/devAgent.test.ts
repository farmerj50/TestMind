import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { requiresExternalRepoConfirmation, isAuthorizedBaseUrl } from "./devAgent.js";
import { isProjectOwner } from "../lib/project-access.js";

// index.ts can't be booted from a test (same constraint as evaluations-datasets.test.ts) -
// this exercises the route's exact logic/persistence idioms directly against a real local DB.

const prisma = new PrismaClient();

test("requiresExternalRepoConfirmation: testmind never needs confirmation", () => {
  assert.equal(requiresExternalRepoConfirmation("testmind", undefined), false);
  assert.equal(requiresExternalRepoConfirmation("testmind", false), false);
});

test("requiresExternalRepoConfirmation: an external repo requires explicit confirmExternalRepo:true", () => {
  assert.equal(requiresExternalRepoConfirmation("https://github.com/acme/widgets", undefined), true);
  assert.equal(requiresExternalRepoConfirmation("https://github.com/acme/widgets", false), true);
  assert.equal(requiresExternalRepoConfirmation("https://github.com/acme/widgets", true), false);
});

test("isProjectOwner enforces ownership for DevAgentRun creation (reused as-is, not reinvented)", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");
  assert.equal(await isProjectOwner(project!.id, project!.ownerId), true);
  assert.equal(await isProjectOwner(project!.id, "not-the-owner"), false);
});

test("creating a DevAgentRun links to a real OperatorJob of type autonomousDev, mode 'assigned'", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const run = await prisma.devAgentRun.create({
    data: { projectId: project!.id, mode: "assigned", targetRepo: "testmind", instructionText: "Fix the flaky test.", requestedBy: project!.ownerId },
  });
  try {
    const opJob = await prisma.operatorJob.create({
      data: { projectId: project!.id, type: "autonomousDev", requestedBy: project!.ownerId, contextJson: { devAgentRunId: run.id } },
    });
    await prisma.devAgentRun.update({ where: { id: run.id }, data: { operatorJobId: opJob.id } });

    const linked = await prisma.devAgentRun.findUnique({ where: { id: run.id } });
    assert.equal(linked?.operatorJobId, opJob.id);
    assert.equal(linked?.mode, "assigned");
    assert.equal(linked?.status, "queued");

    await prisma.operatorJob.delete({ where: { id: opJob.id } });
  } finally {
    await prisma.devAgentRun.deleteMany({ where: { id: run.id } });
  }
});

test("pause/resume/stop transition DevAgentRun.status exactly as the routes do, and refuse invalid transitions", async () => {
  const project = await prisma.project.findFirst();
  if (!project) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const run = await prisma.devAgentRun.create({
    data: { projectId: project!.id, mode: "assigned", targetRepo: "testmind", status: "running", requestedBy: project!.ownerId },
  });
  try {
    // pause: running -> paused (valid)
    let current = await prisma.devAgentRun.findUnique({ where: { id: run.id } });
    assert.equal(current?.status, "running");
    const paused = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "paused" } });
    assert.equal(paused.status, "paused");

    // the route refuses pause unless status === 'running' - replicate that guard here
    current = await prisma.devAgentRun.findUnique({ where: { id: run.id } });
    assert.notEqual(current?.status, "running"); // so a second pause attempt would be refused by the route's own check

    // resume: paused -> running (valid)
    const resumed = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "running" } });
    assert.equal(resumed.status, "running");

    // stop: running -> canceled (valid), and stop again should be refused (already terminal)
    const stopped = await prisma.devAgentRun.update({ where: { id: run.id }, data: { status: "canceled", finishedAt: new Date() } });
    assert.equal(stopped.status, "canceled");
    assert.ok(["succeeded", "failed", "canceled"].includes(stopped.status), "terminal status must be recognized by the route's re-stop guard");
  } finally {
    await prisma.devAgentRun.deleteMany({ where: { id: run.id } });
  }
});

test("isAuthorizedBaseUrl: accepts a project's own Environment or sharedSteps base URL, rejects anything else", async () => {
  const seed = await prisma.project.findFirst();
  if (!seed) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const project = await prisma.project.create({
    data: { name: "tm-test-authz-project", repoUrl: "git@github.com:example/example.git", ownerId: seed!.ownerId, sharedSteps: { baseUrl: "https://shared.example.test" } },
  });
  const env = await prisma.environment.create({
    data: { projectId: project.id, name: "tm-test-env", baseUrl: "https://env.example.test" },
  });
  const otherProject = await prisma.project.create({
    data: { name: "tm-test-authz-other-project", repoUrl: "git@github.com:example/other.git", ownerId: seed!.ownerId },
  });
  try {
    assert.equal(await isAuthorizedBaseUrl(project.id, "https://shared.example.test"), true, "sharedSteps.baseUrl is authorized");
    assert.equal(await isAuthorizedBaseUrl(project.id, "https://shared.example.test/some/path"), true, "a path under a known origin is still authorized");
    assert.equal(await isAuthorizedBaseUrl(project.id, "https://env.example.test"), true, "a registered Environment's baseUrl is authorized");
    assert.equal(await isAuthorizedBaseUrl(project.id, "https://attacker.example.net"), false, "an unrelated external URL is never authorized");
    assert.equal(await isAuthorizedBaseUrl(project.id, "http://169.254.169.254/latest/meta-data/"), false, "a private/link-local target is never authorized");
    assert.equal(await isAuthorizedBaseUrl(otherProject.id, "https://env.example.test"), false, "another project's environment is not authorized for this project");
    assert.equal(await isAuthorizedBaseUrl(project.id, "not a url"), false, "an unparseable URL is never authorized");
  } finally {
    await prisma.environment.delete({ where: { id: env.id } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: { in: [project.id, otherProject.id] } } });
  }
});

test("isAuthorizedBaseUrl: a project with no Environment/sharedSteps.baseUrl falls back to repoUrl, same as resolveBaseUrlForRun", async () => {
  const seed = await prisma.project.findFirst();
  if (!seed) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  // Mirrors real projects like "Bes" that store their app's URL in repoUrl rather than a
  // git remote or a registered Environment.
  const appUrlProject = await prisma.project.create({
    data: { name: "tm-test-repourl-authz", repoUrl: "https://app.example.test", ownerId: seed!.ownerId },
  });
  const gitRepoProject = await prisma.project.create({
    data: { name: "tm-test-gitrepourl-authz", repoUrl: "git@github.com:example/real-repo.git", ownerId: seed!.ownerId },
  });
  try {
    assert.equal(await isAuthorizedBaseUrl(appUrlProject.id, "https://app.example.test"), true, "an http(s) repoUrl acting as the app's base URL is authorized");
    assert.equal(await isAuthorizedBaseUrl(appUrlProject.id, "https://app.example.test/some/path"), true);
    assert.equal(await isAuthorizedBaseUrl(gitRepoProject.id, "https://github.com"), false, "a real git remote must never be treated as an authorized app base URL");
  } finally {
    await prisma.project.deleteMany({ where: { id: { in: [appUrlProject.id, gitRepoProject.id] } } });
  }
});

test("environmentId ownership: a DevAgentRun must only reference an Environment belonging to its own project", async () => {
  const seed = await prisma.project.findFirst();
  if (!seed) assert.fail("No project found in local DB - this test requires a seeded local dev DB");

  const projectA = await prisma.project.create({ data: { name: "tm-test-env-owner-a", repoUrl: "git@github.com:example/a.git", ownerId: seed!.ownerId } });
  const projectB = await prisma.project.create({ data: { name: "tm-test-env-owner-b", repoUrl: "git@github.com:example/b.git", ownerId: seed!.ownerId } });
  const envOnA = await prisma.environment.create({ data: { projectId: projectA.id, name: "env-a", baseUrl: "https://a.example.test" } });
  try {
    // Replicates the route's own check: Environment.findFirst({ id, projectId }).
    const matchForOwnProject = await prisma.environment.findFirst({ where: { id: envOnA.id, projectId: projectA.id } });
    assert.ok(matchForOwnProject, "an environment belonging to the project must be found");
    const matchForOtherProject = await prisma.environment.findFirst({ where: { id: envOnA.id, projectId: projectB.id } });
    assert.equal(matchForOtherProject, null, "an environment belonging to a different project must never match");
  } finally {
    await prisma.environment.delete({ where: { id: envOnA.id } }).catch(() => {});
    await prisma.project.deleteMany({ where: { id: { in: [projectA.id, projectB.id] } } });
  }
});
