import test from "node:test";
import assert from "node:assert/strict";
import { validateProductionConfig } from "./validateProductionConfig.js";

const COMPLETE_ENV = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://user:pass@host/db",
  REDIS_URL: "redis://host:6379",
  SECRET_KEY: Buffer.alloc(32, 1).toString("base64"),
  CLERK_PUBLISHABLE_KEY: "pk_test_x",
  CLERK_SECRET_KEY: "sk_test_x",
  CORS_ORIGINS: "https://example.com",
};

test("validateProductionConfig is a no-op outside production", () => {
  assert.doesNotThrow(() => validateProductionConfig({ NODE_ENV: "development" }));
  assert.doesNotThrow(() => validateProductionConfig({}));
});

test("validateProductionConfig passes a complete production env", () => {
  assert.doesNotThrow(() => validateProductionConfig(COMPLETE_ENV));
});

test("validateProductionConfig throws an itemized error for missing core vars", () => {
  const { DATABASE_URL, ...incomplete } = COMPLETE_ENV;
  assert.throws(() => validateProductionConfig(incomplete), /DATABASE_URL/);
});

test("validateProductionConfig rejects a malformed SECRET_KEY", () => {
  assert.throws(() => validateProductionConfig({ ...COMPLETE_ENV, SECRET_KEY: "not-32-bytes" }), /SECRET_KEY/);
});

test("validateProductionConfig requires both eval-service vars once either is set", () => {
  assert.throws(
    () => validateProductionConfig({ ...COMPLETE_ENV, TM_EVAL_SERVICE_URL: "https://eval.internal" }),
    /TM_EVAL_SERVICE_API_KEY/
  );
  assert.doesNotThrow(() =>
    validateProductionConfig({ ...COMPLETE_ENV, TM_EVAL_SERVICE_URL: "https://eval.internal", TM_EVAL_SERVICE_API_KEY: "key" })
  );
});

test("validateProductionConfig does not require eval-service vars when evaluation features are untouched", () => {
  assert.doesNotThrow(() => validateProductionConfig(COMPLETE_ENV));
});

test("validateProductionConfig requires CORS_ORIGINS or WEB_URL", () => {
  const { CORS_ORIGINS, ...rest } = COMPLETE_ENV;
  assert.throws(() => validateProductionConfig(rest), /CORS_ORIGINS or WEB_URL/);
  assert.doesNotThrow(() => validateProductionConfig({ ...rest, WEB_URL: "https://example.com" }));
});
