// apps/api/src/runner/api-test-worker.ts
// Standalone BullMQ worker for functional API test runs.
// Isolated from security-worker.ts — no shared queue, no shared phases.

import { Worker } from "bullmq";
import { request } from "undici";
import { createQueueRedisConnection } from "./redis.js";
import { prisma } from "../prisma.js";
import type { ApiTestRunPayload } from "./queue.js";

// ── Assertion types ──────────────────────────────────────────────────────────

type Assertion =
  | { type: "status_equals"; value: number }
  | { type: "response_time_under"; value: number }
  | { type: "json_path_exists"; path: string }
  | { type: "json_path_equals"; path: string; value: unknown }
  | { type: "json_path_contains"; path: string; value: string }
  | { type: "header_exists"; name: string }
  | { type: "schema_validates"; schema: Record<string, unknown> };

type AssertionResult = {
  type: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
  error?: string;
};

// ── JSON path resolver (minimal inline, no extra package) ────────────────────

function resolvePath(obj: unknown, rawPath: string): { found: boolean; value: unknown } {
  const path = rawPath.replace(/^\$\.?/, ""); // strip leading $. or $
  if (!path) return { found: true, value: obj };
  const parts = path.split(/[.\[\]]+/).filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

// ── Schema validation (structural check — no ajv dependency) ─────────────────

function validateSchema(data: unknown, schema: Record<string, unknown>): boolean {
  if (schema.type === "object" && (data === null || typeof data !== "object")) return false;
  if (schema.type === "array" && !Array.isArray(data)) return false;
  if (schema.type === "string" && typeof data !== "string") return false;
  if (schema.type === "number" && typeof data !== "number") return false;
  if (schema.type === "boolean" && typeof data !== "boolean") return false;
  if (Array.isArray(schema.required) && typeof data === "object" && data !== null) {
    for (const key of schema.required as string[]) {
      if (!(key in (data as Record<string, unknown>))) return false;
    }
  }
  return true;
}

// ── Assertion evaluator ──────────────────────────────────────────────────────

function evaluateAssertions(
  assertions: Assertion[],
  statusCode: number,
  durationMs: number,
  responseHeaders: Record<string, string>,
  body: unknown
): AssertionResult[] {
  return assertions.map((a): AssertionResult => {
    try {
      switch (a.type) {
        case "status_equals":
          return { type: a.type, passed: statusCode === a.value, expected: a.value, actual: statusCode };

        case "response_time_under":
          return { type: a.type, passed: durationMs < a.value, expected: `< ${a.value}ms`, actual: `${durationMs}ms` };

        case "json_path_exists": {
          const { found, value } = resolvePath(body, a.path);
          return { type: a.type, passed: found && value !== undefined, expected: "path exists", actual: found ? value : "not found" };
        }

        case "json_path_equals": {
          const { found, value } = resolvePath(body, a.path);
          const passed = found && JSON.stringify(value) === JSON.stringify(a.value);
          return { type: a.type, passed, expected: a.value, actual: value };
        }

        case "json_path_contains": {
          const { found, value } = resolvePath(body, a.path);
          const str = typeof value === "string" ? value : JSON.stringify(value ?? "");
          return { type: a.type, passed: found && str.includes(a.value), expected: `contains "${a.value}"`, actual: str };
        }

        case "header_exists": {
          const key = a.name.toLowerCase();
          const exists = key in responseHeaders;
          return { type: a.type, passed: exists, expected: `header "${a.name}" exists`, actual: exists ? "present" : "absent" };
        }

        case "schema_validates": {
          const passed = validateSchema(body, a.schema);
          return { type: a.type, passed, expected: "schema valid", actual: passed ? "valid" : "invalid" };
        }

        default:
          return { type: (a as any).type ?? "unknown", passed: false, error: "Unknown assertion type" };
      }
    } catch (err: any) {
      return { type: a.type, passed: false, error: err?.message ?? String(err) };
    }
  });
}

// ── Variable substitution ────────────────────────────────────────────────────

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function substituteObj(obj: Record<string, string>, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[substitute(k, vars)] = substitute(v, vars);
  }
  return out;
}

// ── Header redaction (never store auth material) ─────────────────────────────

const SENSITIVE_HEADERS = /^(authorization|cookie|set-cookie|proxy-authorization)$/i;

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.test(k) ? "[redacted]" : v;
  }
  return out;
}

// ── Worker ───────────────────────────────────────────────────────────────────

async function runApiTests(payload: ApiTestRunPayload): Promise<void> {
  const { runId, collectionId, testCaseIds } = payload;

  // 1. Load run, collection, and test cases
  const run = await prisma.apiTestRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`ApiTestRun ${runId} not found`);

  const collection = await prisma.apiCollection.findUnique({
    where: { id: collectionId },
    include: { environment: true },
  });
  if (!collection) throw new Error(`ApiCollection ${collectionId} not found`);

  const testCases = await prisma.apiTestCase.findMany({
    where: {
      collectionId,
      ...(testCaseIds?.length ? { id: { in: testCaseIds } } : {}),
    },
    orderBy: { order: "asc" },
  });

  // 2. Resolve environment variables
  const envVars: Record<string, string> = {};
  if (collection.environment?.variables) {
    const raw = collection.environment.variables as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") envVars[k] = v;
    }
  }

  const baseUrl = substitute(collection.baseUrl, envVars).replace(/\/$/, "");

  // 3. Mark running
  await prisma.apiTestRun.update({
    where: { id: runId },
    data: { status: "running", startedAt: new Date() },
  });

  const runStart = Date.now();
  let passed = 0;
  let failed = 0;
  let errors = 0;

  // 4. Execute each test case
  for (const tc of testCases) {
    const tcStart = Date.now();
    let tcStatus = "error";
    let statusCode: number | undefined;
    let durationMs = 0;
    let responseHeaders: Record<string, string> = {};
    let bodyPreview: string | null = null;
    let assertionResults: AssertionResult[] = [];
    let tcError: string | undefined;

    try {
      // Build URL
      const resolvedPath = substitute(tc.path, envVars);
      const fullUrl = baseUrl + (resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`);

      // Build headers (merge collection-level headers with case-level)
      const rawHeaders = (tc.headers as Record<string, string> | null) ?? {};
      const headers = substituteObj(rawHeaders, envVars);

      // Inject auth session bearer if set
      if (tc.authSessionId) {
        const session = await prisma.securityAuthSession.findUnique({
          where: { id: tc.authSessionId },
          select: { storagePath: true, status: true },
        });
        // Only inject if session is authenticated and has a storage path (token file)
        // We pass the session id as a label in headers — actual token retrieval
        // would require reading the storage file, which is project-specific.
        // For now, mark the test case as needing auth but don't fail the run.
        if (session?.status !== "authenticated") {
          tcError = `Auth session ${tc.authSessionId} is not in authenticated state`;
          tcStatus = "error";
          errors++;
          await prisma.apiTestResult.create({
            data: {
              runId,
              testCaseId: tc.id,
              status: tcStatus,
              error: tcError,
              durationMs: 0,
            },
          });
          continue;
        }
      }

      // Build query params
      const rawQuery = (tc.queryParams as Record<string, string> | null) ?? {};
      const qParams = substituteObj(rawQuery, envVars);
      let finalUrl = fullUrl;
      if (Object.keys(qParams).length > 0) {
        const u = new URL(finalUrl);
        for (const [k, v] of Object.entries(qParams)) {
          u.searchParams.set(k, v);
        }
        finalUrl = u.toString();
      }

      // Execute request
      const method = tc.method.toUpperCase();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), tc.timeoutMs ?? 8000);

      const response = await request(finalUrl, {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: tc.bodyJson ? substitute(tc.bodyJson, envVars) : undefined,
        signal: controller.signal as any,
      }).finally(() => clearTimeout(timer));

      durationMs = Date.now() - tcStart;
      statusCode = response.statusCode;

      // Read body
      const rawBody = await response.body.text().catch(() => "");
      bodyPreview = rawBody.slice(0, 2000);

      // Normalize response headers (redact sensitive values)
      const rawRespHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(response.headers)) {
        rawRespHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join("; ") : (v ?? "");
      }
      responseHeaders = redactHeaders(rawRespHeaders);

      // Parse body for assertions
      let parsedBody: unknown = rawBody;
      try { parsedBody = JSON.parse(rawBody); } catch { /* not JSON */ }

      // Evaluate assertions
      const assertions = Array.isArray(tc.assertions) ? (tc.assertions as Assertion[]) : [];
      // Always add implicit status check if expectedStatus is set and no explicit status assertion exists
      const hasStatusAssertion = assertions.some((a) => a.type === "status_equals");
      const allAssertions: Assertion[] = [
        ...assertions,
        ...(!hasStatusAssertion && tc.expectedStatus != null
          ? [{ type: "status_equals" as const, value: tc.expectedStatus }]
          : []),
      ];

      assertionResults = allAssertions.length > 0
        ? evaluateAssertions(allAssertions, statusCode, durationMs, responseHeaders, parsedBody)
        : [];

      const allPassed = assertionResults.every((r) => r.passed);
      tcStatus = allPassed ? "passed" : "failed";
      if (allPassed) passed++; else failed++;
    } catch (err: any) {
      durationMs = Date.now() - tcStart;
      tcError = err?.message ?? String(err);
      tcStatus = "error";
      errors++;
    }

    await prisma.apiTestResult.create({
      data: {
        runId,
        testCaseId: tc.id,
        status: tcStatus,
        statusCode: statusCode ?? null,
        durationMs,
        responseHeaders: Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined,
        bodyPreview,
        assertionResults: assertionResults.length > 0 ? (assertionResults as any) : undefined,
        error: tcError ?? null,
      },
    });
  }

  // 5. Finalize run
  const totalDurationMs = Date.now() - runStart;
  await prisma.apiTestRun.update({
    where: { id: runId },
    data: {
      status: "completed",
      finishedAt: new Date(),
      summary: {
        total: testCases.length,
        passed,
        failed,
        errors,
        durationMs: totalDurationMs,
      },
    },
  });
}

export const apiTestWorker = new Worker<ApiTestRunPayload>(
  "api-tests",
  async (job) => {
    try {
      await runApiTests(job.data);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.error("[api-test-worker] run failed", { runId: job.data.runId, error: msg });
      await prisma.apiTestRun
        .update({
          where: { id: job.data.runId },
          data: { status: "failed", finishedAt: new Date(), error: msg },
        })
        .catch(() => {});
      throw err;
    }
  },
  { connection: createQueueRedisConnection("api-tests") }
);
