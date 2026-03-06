import test from "node:test";
import assert from "node:assert/strict";
import { __githubSecurityInternals } from "./github.js";

test("github oauth state binds callback to initiating user", () => {
  const state = __githubSecurityInternals.buildState("user_a", "/dashboard");
  const parsed = __githubSecurityInternals.parseState(state);
  assert.ok(parsed);
  assert.equal(parsed?.userId, "user_a");
  assert.equal(parsed?.returnTo, "/dashboard");
  assert.notEqual(parsed?.userId, "user_b");
});

test("github oauth state rejects tampering", () => {
  const state = __githubSecurityInternals.buildState("user_a", "/dashboard");
  const decoded = Buffer.from(state, "base64url").toString("utf8");
  const tampered = decoded.replace("user_a", "user_b");
  const tamperedState = Buffer.from(tampered).toString("base64url");
  const parsed = __githubSecurityInternals.parseState(tamperedState);
  assert.equal(parsed, null);
});

test("github returnTo sanitization blocks unsafe redirects", () => {
  assert.equal(__githubSecurityInternals.sanitizeReturnTo("https://evil.com"), "/dashboard");
  assert.equal(__githubSecurityInternals.sanitizeReturnTo("//evil.com/path"), "/dashboard");
  assert.equal(__githubSecurityInternals.sanitizeReturnTo("/safe/path"), "/safe/path");
  assert.equal(__githubSecurityInternals.sanitizeReturnTo("/safe\r\nx: y"), "/dashboard");
});

test("github account lookup scope is provider+user only", () => {
  const userAWhere = __githubSecurityInternals.githubAccountWhereForUser("user_a");
  const userBWhere = __githubSecurityInternals.githubAccountWhereForUser("user_b");
  assert.deepEqual(userAWhere, {
    provider_userId: { provider: "github", userId: "user_a" },
  });
  assert.deepEqual(userBWhere, {
    provider_userId: { provider: "github", userId: "user_b" },
  });
  assert.notDeepEqual(userAWhere, userBWhere);
});

