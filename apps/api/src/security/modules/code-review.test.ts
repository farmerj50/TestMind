import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodeReviewRoot, runCodeReviewScan } from "./code-review.js";

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "testmind-code-review-"));
}

function writeFile(root: string, relativePath: string, content: string) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

test("resolveCodeReviewRoot walks from package directories to the workspace root", () => {
  const root = makeTempRepo();
  const apiDir = path.join(root, "apps", "api");
  fs.mkdirSync(apiDir, { recursive: true });
  writeFile(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
  writeFile(root, "apps/api/package.json", "{\"name\":\"api\"}");

  assert.equal(resolveCodeReviewRoot(apiDir), root);
});

test("runCodeReviewScan reports unauthenticated environment routes", () => {
  const root = makeTempRepo();
  writeFile(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
  writeFile(
    root,
    "apps/api/src/routes/environments.ts",
    `
export async function environmentRoutes(app: any) {
  app.get("/environments", async () => []);
  app.post("/environments", async () => ({}));
}
`
  );

  const findings = runCodeReviewScan({ root });
  assert.ok(findings.some((finding) => finding.title === "Unauthenticated environment management routes"));
});

test("runCodeReviewScan reports public artifact exposure and stored auth state", () => {
  const root = makeTempRepo();
  writeFile(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
  writeFile(
    root,
    "apps/api/src/index.ts",
    `
app.register(fastifyStatic, { root: RUNNER_LOGS_ROOT, prefix: "/_static/runner-logs/" });
app.get("/runner-logs/*", async () => ({}));
app.get("/assets/*", async () => ({}));
`
  );
  writeFile(root, "testmind-auth-sessions/session.json", "{\"cookies\":[],\"localStorage\":{}}");

  const titles = runCodeReviewScan({ root }).map((finding) => finding.title);
  assert.ok(titles.includes("Runner artifacts are exposed through public static routes"));
  assert.ok(titles.includes("Browser auth session state is stored under the repository"));
});
