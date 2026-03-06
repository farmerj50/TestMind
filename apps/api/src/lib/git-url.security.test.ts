import test from "node:test";
import assert from "node:assert/strict";
import { validateAndNormalizeRepoUrl } from "./git-url.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("repo url rejects non-https protocols", () => {
  const res = validateAndNormalizeRepoUrl("http://github.com/org/repo");
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /https/i);
});

test("repo url rejects embedded credentials", () => {
  const res = validateAndNormalizeRepoUrl("https://token@github.com/org/repo");
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /credentials/i);
});

test("repo url rejects private hosts by default", () => {
  withEnv({ TM_ALLOW_PRIVATE_GIT_HOSTS: undefined, TM_GIT_ALLOWED_HOSTS: "localhost" }, () => {
    const res = validateAndNormalizeRepoUrl("https://localhost/org/repo");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /not allowed/i);
  });
});

test("repo url rejects link-local and loopback IPv6 hosts by default", () => {
  withEnv({ TM_ALLOW_PRIVATE_GIT_HOSTS: undefined, TM_GIT_ALLOWED_HOSTS: "169.254.169.254,::1" }, () => {
    const linkLocal = validateAndNormalizeRepoUrl("https://169.254.169.254/org/repo");
    assert.equal(linkLocal.ok, false);
    const loopbackV6 = validateAndNormalizeRepoUrl("https://[::1]/org/repo");
    assert.equal(loopbackV6.ok, false);
  });
});

test("repo url allows enterprise host from allowlist", () => {
  withEnv({ TM_GIT_ALLOWED_HOSTS: "github.enterprise.local" }, () => {
    const res = validateAndNormalizeRepoUrl("https://github.enterprise.local/org/repo");
    assert.equal(res.ok, true);
  });
});

test("repo url allows private host only with explicit opt-in and allowlist", () => {
  withEnv({ TM_ALLOW_PRIVATE_GIT_HOSTS: "true", TM_GIT_ALLOWED_HOSTS: "localhost" }, () => {
    const res = validateAndNormalizeRepoUrl("https://localhost/org/repo");
    assert.equal(res.ok, true);
  });
});

test("repo url normalization strips query/hash/trailing slash", () => {
  const res = validateAndNormalizeRepoUrl("https://github.com/org/repo/?ref=main#readme");
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.normalized, "https://github.com/org/repo");
});

test("repo url rejects non-allowlisted hosts", () => {
  withEnv({ TM_GIT_ALLOWED_HOSTS: undefined }, () => {
    const res = validateAndNormalizeRepoUrl("https://evil.example.org/org/repo");
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.reason, /not allowed/i);
  });
});
