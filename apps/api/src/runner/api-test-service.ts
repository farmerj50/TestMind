// Shared functional API execution and assertions, used by the existing worker.

import { request } from "undici";

import { prisma } from "../prisma.js";
import { validateJsonSchema, redactWorkflowValue } from '@testmind/core/workflow';
import { workflowHttpRequest } from '../lib/workflow-http.js';
import { authorizedWorkflowContext, claimWorkflowChildRun, watchWorkflowExecution } from '../lib/workflow-execution-policy.js';
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
    if (current == null || typeof current !== "object" || !Object.hasOwn(current, part) || ['__proto__', 'prototype', 'constructor'].includes(part)) return { found: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

// ── Assertion evaluator ──────────────────────────────────────────────────────

export function evaluateAssertions(
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
          const passed = validateJsonSchema(a.schema, body);
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

const SENSITIVE_HEADERS = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|api-key)$/i;

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.test(k) ? "[redacted]" : v;
  }
  return out;
}

// ── Worker ───────────────────────────────────────────────────────────────────

export async function runApiTests(payload: ApiTestRunPayload): Promise<void> {
  const { runId, collectionId, testCaseIds } = payload;

  // 1. Load run, collection, and test cases
  const run = await prisma.apiTestRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`ApiTestRun ${runId} not found`);
  if (payload.workflowRunId && run.status !== 'queued') return;

  const collection = await prisma.apiCollection.findUnique({
    where: { id: collectionId },
    include: { environment: true },
  });
  if (!collection) throw new Error(`ApiCollection ${collectionId} not found`);
  if (collection.projectId !== payload.projectId || run.collectionId !== collectionId) throw new Error('API collection is outside the requested project');

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
  if (payload.workflowRunId) {
    if (!await claimWorkflowChildRun(prisma.apiTestRun, runId)) return;
  } else await prisma.apiTestRun.update({
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
    let workflowSecretValues: string[] = [];

    try {
      const workflowContext = payload.workflowRunId ? await authorizedWorkflowContext(payload.workflowRunId, payload.projectId) : null;
      // Build URL
      const resolvedPath = substitute(tc.path, envVars);
      const fullUrl = baseUrl + (resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`);

      // Build headers (merge collection-level headers with case-level)
      const rawHeaders = (tc.headers as Record<string, string> | null) ?? {};
      const headers = substituteObj(rawHeaders, envVars);
      workflowSecretValues = Object.entries(headers).filter(([key]) => SENSITIVE_HEADERS.test(key)).map(([, value]) => value);

      // Inject auth session bearer if set
      if (tc.authSessionId) {
        if (payload.workflowRunId) throw new Error('This API case requires an auth session that the API executor cannot inject; configure supported request authentication first');
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

      const watch = workflowContext ? watchWorkflowExecution(payload.workflowRunId!, payload.projectId) : null;
      const response = workflowContext ? await workflowHttpRequest(finalUrl, {
        method, headers, body: tc.bodyJson ? substitute(tc.bodyJson, envVars) : undefined,
        timeoutMs: Math.min(tc.timeoutMs ?? 8000, 120000), environment: workflowContext.environment, signal: watch!.signal,
      }).then(value => ({ statusCode: value.status, headers: value.headers, body: { text: async () => typeof value.body === 'string' ? value.body : JSON.stringify(value.body) } })).finally(() => { clearTimeout(timer); watch!.stop(); }) : await request(finalUrl, {
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

      const allPassed = assertionResults.length > 0 && assertionResults.every((r) => r.passed);
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
        responseHeaders: Object.keys(responseHeaders).length > 0 ? (payload.workflowRunId ? redactWorkflowValue(responseHeaders, workflowSecretValues) : responseHeaders) : undefined,
        bodyPreview: payload.workflowRunId && bodyPreview ? JSON.stringify(redactWorkflowValue((() => { try { return JSON.parse(bodyPreview); } catch { return bodyPreview; } })(), workflowSecretValues)).slice(0, 2000) : bodyPreview,
        assertionResults: assertionResults.length > 0 ? (payload.workflowRunId ? redactWorkflowValue(assertionResults, workflowSecretValues) : assertionResults) as any : undefined,
        error: tcError ? (payload.workflowRunId ? redactWorkflowValue(tcError, workflowSecretValues) : tcError) : null,
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
