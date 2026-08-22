import test from "node:test";
import assert from "node:assert/strict";
import { resolveBaseUrl } from "./baseUrl.js";

test("each source resolves individually", () => {
  assert.equal(resolveBaseUrl({ override: "https://override.example.com" }), "https://override.example.com");
  assert.equal(
    resolveBaseUrl({ sharedStepsBaseUrl: "https://shared.example.com" }),
    "https://shared.example.com"
  );
  assert.equal(
    resolveBaseUrl({ environmentBaseUrl: "https://env-entity.example.com" }),
    "https://env-entity.example.com"
  );
  assert.equal(resolveBaseUrl({ repoUrl: "https://myapp.example.com" }), "https://myapp.example.com");
  assert.equal(resolveBaseUrl({ fallback: "http://localhost:5173" }), "http://localhost:5173");
});

test("default precedence order: override > sharedStepsBaseUrl > repoUrl > environmentBaseUrl > envVarNames > fallback", () => {
  const resolved = resolveBaseUrl({
    override: "https://a.example.com",
    sharedStepsBaseUrl: "https://b.example.com",
    repoUrl: "https://c.example.com",
    environmentBaseUrl: "https://d.example.com",
    fallback: "https://e.example.com",
  });
  assert.equal(resolved, "https://a.example.com");

  const withoutOverride = resolveBaseUrl({
    sharedStepsBaseUrl: "https://b.example.com",
    repoUrl: "https://c.example.com",
    environmentBaseUrl: "https://d.example.com",
    fallback: "https://e.example.com",
  });
  assert.equal(withoutOverride, "https://b.example.com");

  const onlyRepoAndEnv = resolveBaseUrl({
    repoUrl: "https://c.example.com",
    environmentBaseUrl: "https://d.example.com",
    fallback: "https://e.example.com",
  });
  assert.equal(onlyRepoAndEnv, "https://c.example.com");
});

test("git-shaped repoUrl is rejected, falls through to the next source", () => {
  const resolved = resolveBaseUrl({
    repoUrl: "https://github.com/acme/widgets",
    fallback: "http://localhost:5173",
  });
  assert.equal(resolved, "http://localhost:5173");

  const gitAt = resolveBaseUrl({
    repoUrl: "git@github.com:acme/widgets.git",
    fallback: "http://localhost:5173",
  });
  assert.equal(gitAt, "http://localhost:5173");
});

test("envVarNames are checked in the given order, first match wins", () => {
  const originalFirst = process.env.TM_TEST_BASE_URL_FIRST;
  const originalSecond = process.env.TM_TEST_BASE_URL_SECOND;
  try {
    delete process.env.TM_TEST_BASE_URL_FIRST;
    process.env.TM_TEST_BASE_URL_SECOND = "https://second.example.com";
    const resolved = resolveBaseUrl({
      envVarNames: ["TM_TEST_BASE_URL_FIRST", "TM_TEST_BASE_URL_SECOND"],
    });
    assert.equal(resolved, "https://second.example.com");
  } finally {
    if (originalFirst === undefined) delete process.env.TM_TEST_BASE_URL_FIRST;
    else process.env.TM_TEST_BASE_URL_FIRST = originalFirst;
    if (originalSecond === undefined) delete process.env.TM_TEST_BASE_URL_SECOND;
    else process.env.TM_TEST_BASE_URL_SECOND = originalSecond;
  }
});

test("custom order overrides the default", () => {
  const resolved = resolveBaseUrl(
    {
      sharedStepsBaseUrl: "https://shared.example.com",
      environmentBaseUrl: "https://env-entity.example.com",
    },
    { order: ["environmentBaseUrl", "sharedStepsBaseUrl"] }
  );
  assert.equal(resolved, "https://env-entity.example.com");
});

test("no matching source returns null", () => {
  assert.equal(resolveBaseUrl({}), null);
  assert.equal(resolveBaseUrl({ repoUrl: "git@github.com:acme/widgets.git" }), null);
});

test("bare host without protocol is coerced (http for localhost, https otherwise)", () => {
  assert.equal(resolveBaseUrl({ override: "localhost:5173" }), "http://localhost:5173");
  assert.equal(resolveBaseUrl({ override: "myapp.example.com" }), "https://myapp.example.com");
});
