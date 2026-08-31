import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { ensureClient } from "../agent/openai.js";
import { safeFetch } from "../lib/safe-fetch.js";

const MODEL = process.env.AGENT_MODEL || "gpt-4o";
type Sev = "info" | "low" | "medium" | "high";
type Confidence = "low" | "medium" | "high";

// ── Types ─────────────────────────────────────────────────────────────────────

type AccountConfig = {
  label: string;
  authType: "bearer" | "cookie" | "basic";
  token?: string;
  cookieName?: string;
  cookieValue?: string;
  username?: string;
  password?: string;
  ownedResourceId?: string;
};

type AuthTestEvidence = {
  url: string;
  authPresent: boolean;
  status: number;
  bodyLength: number;
  bodySnippet: string;
};

type AuthTestResult = {
  testName: string;
  description: string;
  skipped: boolean;
  skippedReason?: string;
  finding?: {
    issue: string;
    severity: Sev;
    confidence: Confidence;
    evidenceA: AuthTestEvidence;
    evidenceB?: AuthTestEvidence;
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildAccountHeaders(account: AccountConfig): Record<string, string> {
  if (account.authType === "bearer" && account.token)
    return { Authorization: `Bearer ${account.token}` };
  if (account.authType === "cookie" && account.cookieValue)
    return { Cookie: `${account.cookieName || "session"}=${account.cookieValue}` };
  if (account.authType === "basic" && account.username && account.password)
    return { Authorization: `Basic ${Buffer.from(`${account.username}:${account.password}`).toString("base64")}` };
  return {};
}

function safeSnippet(body: string): string {
  // Never expose tokens or credentials — just show structural hint
  return body.slice(0, 100).replace(/["']?(token|password|secret|key|auth|bearer|cookie)["']?\s*:\s*["'][^"']{4,}["']/gi, '"[REDACTED]"');
}

function injectId(targetUrl: string, resourceId: string): string | null {
  try {
    const url = new URL(targetUrl);
    const segments = url.pathname.split("/");
    // Replace first numeric-looking or UUID-looking segment, or append if none
    for (let i = segments.length - 1; i >= 0; i--) {
      if (/^\d{1,15}$/.test(segments[i]) || /^[0-9a-f-]{8,}$/i.test(segments[i])) {
        segments[i] = resourceId;
        return `${url.origin}${segments.join("/")}${url.search}`;
      }
    }
    // No ID segment found — append to path
    return `${url.origin}${url.pathname.replace(/\/$/, "")}/${resourceId}${url.search}`;
  } catch {
    return null;
  }
}

function mutateId(resourceId: string): string[] {
  const num = parseInt(resourceId);
  if (!isNaN(num) && num > 0) {
    return [String(num + 1), String(num - 1), String(num + 100), "1"]
      .filter(id => id !== resourceId && parseInt(id) > 0)
      .slice(0, 4);
  }
  // Non-numeric: try simple variants
  return ["1", "2", "100"].filter(id => id !== resourceId).slice(0, 3);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testEndpointAuthGuard(
  targetUrl: string,
  authHeaders: Record<string, string>,
): Promise<AuthTestResult> {
  const base: Omit<AuthTestResult, "finding"> = {
    testName: "Endpoint Auth Guard",
    description: "Verifies the target endpoint requires authentication by comparing authenticated vs unauthenticated responses.",
    skipped: false,
  };

  if (Object.keys(authHeaders).length === 0) {
    return { ...base, skipped: true, skippedReason: "No credentials provided for Account A." };
  }

  try {
    const [unauthRes, authRes] = await Promise.all([
      safeFetch(targetUrl, { signal: AbortSignal.timeout(10000) }),
      safeFetch(targetUrl, { headers: authHeaders, signal: AbortSignal.timeout(10000) }),
    ]);

    const [unauthBody, authBody] = await Promise.all([unauthRes.text(), authRes.text()]);

    const evA: AuthTestEvidence = {
      url: targetUrl, authPresent: true,
      status: authRes.status, bodyLength: authBody.length, bodySnippet: safeSnippet(authBody),
    };
    const evB: AuthTestEvidence = {
      url: targetUrl, authPresent: false,
      status: unauthRes.status, bodyLength: unauthBody.length, bodySnippet: safeSnippet(unauthBody),
    };

    if (unauthRes.status === 200 && authRes.status === 200) {
      if (unauthBody === authBody) {
        return {
          ...base,
          finding: {
            issue: "Endpoint returns identical 200 response with and without credentials — authentication is not enforced.",
            severity: "high", confidence: "high",
            evidenceA: evA, evidenceB: evB,
          },
        };
      }
      return {
        ...base,
        finding: {
          issue: "Endpoint returns HTTP 200 without credentials but response differs from authenticated — partial enforcement, review carefully.",
          severity: "medium", confidence: "medium",
          evidenceA: evA, evidenceB: evB,
        },
      };
    }

    // No finding — auth appears enforced
    return { ...base };
  } catch {
    return { ...base, skipped: true, skippedReason: "Request failed or timed out." };
  }
}

async function testOwnedResourceIdor(
  targetUrl: string,
  authHeaders: Record<string, string>,
  ownedResourceId: string,
): Promise<AuthTestResult> {
  const base: Omit<AuthTestResult, "finding"> = {
    testName: "Owned Resource IDOR",
    description: `Mutates the resource ID in the URL (baseline: ${ownedResourceId}) and checks if other IDs return accessible, different data under the same credentials.`,
    skipped: false,
  };

  if (Object.keys(authHeaders).length === 0) {
    return { ...base, skipped: true, skippedReason: "No credentials provided." };
  }

  const baselineUrl = injectId(targetUrl, ownedResourceId);
  if (!baselineUrl) {
    return { ...base, skipped: true, skippedReason: "Could not construct a URL with the owned resource ID." };
  }

  let baselineStatus: number;
  let baselineBody: string;
  try {
    const res = await safeFetch(baselineUrl, { headers: authHeaders, signal: AbortSignal.timeout(10000) });
    baselineStatus = res.status;
    baselineBody = await res.text();
  } catch {
    return { ...base, skipped: true, skippedReason: "Baseline request failed." };
  }

  if (baselineStatus !== 200) {
    return { ...base, skipped: true, skippedReason: `Baseline returned HTTP ${baselineStatus} — cannot compare.` };
  }

  const candidates = mutateId(ownedResourceId);
  for (const candidateId of candidates) {
    const testUrl = injectId(baselineUrl, candidateId);
    if (!testUrl) continue;
    try {
      const res = await safeFetch(testUrl, { headers: authHeaders, signal: AbortSignal.timeout(10000) });
      if (res.status === 200) {
        const body = await res.text();
        if (body !== baselineBody && body.length > 50) {
          return {
            ...base,
            finding: {
              issue: `ID ${candidateId} returned a different 200 response under the same credentials — possible IDOR. Server served a different object without verifying ownership.`,
              severity: "high", confidence: "high",
              evidenceA: {
                url: baselineUrl, authPresent: true,
                status: baselineStatus, bodyLength: baselineBody.length, bodySnippet: safeSnippet(baselineBody),
              },
              evidenceB: {
                url: testUrl, authPresent: true,
                status: res.status, bodyLength: body.length, bodySnippet: safeSnippet(body),
              },
            },
          };
        }
      }
    } catch { /* skip candidate */ }
  }

  return { ...base };
}

async function testCrossAccountAccess(
  targetUrl: string,
  headersA: Record<string, string>,
  headersB: Record<string, string>,
  accountALabel: string,
  accountBLabel: string,
  accountAResourceId: string,
): Promise<AuthTestResult> {
  const base: Omit<AuthTestResult, "finding"> = {
    testName: "Cross-Account Resource Access",
    description: `${accountBLabel} attempts to access a resource owned by ${accountALabel} (ID: ${accountAResourceId}).`,
    skipped: false,
  };

  if (Object.keys(headersA).length === 0 || Object.keys(headersB).length === 0) {
    return { ...base, skipped: true, skippedReason: "Both accounts must have valid credentials." };
  }

  const resourceUrl = injectId(targetUrl, accountAResourceId);
  if (!resourceUrl) {
    return { ...base, skipped: true, skippedReason: `Could not build URL for ${accountALabel}'s resource ID.` };
  }

  let statusA: number, bodyA: string;
  try {
    const res = await safeFetch(resourceUrl, { headers: headersA, signal: AbortSignal.timeout(10000) });
    statusA = res.status;
    bodyA = await res.text();
  } catch {
    return { ...base, skipped: true, skippedReason: `${accountALabel} baseline request failed.` };
  }

  if (statusA !== 200) {
    return { ...base, skipped: true, skippedReason: `${accountALabel} returned HTTP ${statusA} — resource may not exist.` };
  }

  let statusB: number, bodyB: string;
  try {
    const res = await safeFetch(resourceUrl, { headers: headersB, signal: AbortSignal.timeout(10000) });
    statusB = res.status;
    bodyB = await res.text();
  } catch {
    return { ...base, skipped: true, skippedReason: `${accountBLabel} request failed.` };
  }

  const evA: AuthTestEvidence = {
    url: resourceUrl, authPresent: true,
    status: statusA, bodyLength: bodyA.length, bodySnippet: safeSnippet(bodyA),
  };
  const evB: AuthTestEvidence = {
    url: resourceUrl, authPresent: true,
    status: statusB, bodyLength: bodyB.length, bodySnippet: safeSnippet(bodyB),
  };

  if (statusB === 200) {
    const bodiesMatch = bodyA === bodyB;
    return {
      ...base,
      finding: {
        issue: bodiesMatch
          ? `${accountBLabel} received the exact same response as ${accountALabel} for ${accountALabel}'s resource — full cross-account IDOR.`
          : `${accountBLabel} received HTTP 200 for ${accountALabel}'s resource (responses differ in length by ${Math.abs(bodyA.length - bodyB.length)} bytes) — possible IDOR or information leak.`,
        severity: "high",
        confidence: bodiesMatch ? "high" : "medium",
        evidenceA: evA,
        evidenceB: evB,
      },
    };
  }

  return { ...base };
}

// ── GPT Analysis ──────────────────────────────────────────────────────────────

async function analyzeWithGpt(
  programName: string,
  programRules: string,
  targetUrl: string,
  featureOrFlow: string,
  notes: string,
  tests: AuthTestResult[],
): Promise<{ summary: string; findings: object[]; reportDraft: object }> {
  const openai = ensureClient();

  const findingsOnly = tests.filter(t => !t.skipped && t.finding);
  const skipped = tests.filter(t => t.skipped);

  const prompt = `
You are a security research assistant analyzing controlled broken authentication and IDOR test results.
These tests were run against researcher-owned test accounts on an authorized target — not a real attack.

Program: ${programName}
Rules: ${programRules}
Target URL: ${targetUrl}
Feature/Flow: ${featureOrFlow}
Notes: ${notes || "none"}

Test Results:
${JSON.stringify(tests, null, 2)}

Skipped tests: ${skipped.map(t => t.testName).join(", ") || "none"}

Based only on the evidence above, return a JSON object with:
{
  "summary": "2-3 sentence plain-English summary of what was found and severity",
  "findings": [
    {
      "testName": "...",
      "category": "broken_authentication | idor | access_control",
      "issue": "concise issue description",
      "severity": "info | low | medium | high",
      "confidence": "low | medium | high",
      "confidenceReason": "why this confidence level"
    }
  ],
  "reportDraft": {
    "title": "short bug report title",
    "impact": "business impact in 1-2 sentences",
    "stepsToReproduce": ["step 1", "step 2", "..."],
    "evidenceNeeded": ["what to capture for the report"]
  }
}

Only include findings from tests that actually produced a finding (not skipped or clean tests).
If no findings were produced, return an empty findings array and a summary noting no issues were detected.
`.trim();

  const completion = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a responsible security research assistant. Only analyze observed findings. Return only valid JSON." },
      { role: "user", content: prompt },
    ],
  });

  return JSON.parse(completion.choices[0].message.content ?? "{}");
}

// ── Route ─────────────────────────────────────────────────────────────────────

export default async function researchAuthTestRoutes(app: FastifyInstance) {
  app.post("/research-agent/auth-test", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.status(401).send({ error: "Unauthorized" });

    const body = req.body as {
      programName?: string;
      programRules?: string;
      targetUrl?: string;
      featureOrFlow?: string;
      notes?: string;
      accountA?: AccountConfig;
      accountB?: AccountConfig;
    };

    const { programName = "", programRules = "", targetUrl = "", featureOrFlow = "", notes = "", accountA, accountB } = body;

    if (!targetUrl || !accountA) {
      return reply.status(400).send({ error: "targetUrl and accountA are required" });
    }

    const headersA = buildAccountHeaders(accountA);
    const headersB = accountB ? buildAccountHeaders(accountB) : {};

    // Run tests — guard and cross-account are independent; IDOR needs baseline first
    const [guardResult, idorResult] = await Promise.all([
      testEndpointAuthGuard(targetUrl, headersA),
      accountA.ownedResourceId
        ? testOwnedResourceIdor(targetUrl, headersA, accountA.ownedResourceId)
        : Promise.resolve<AuthTestResult>({
            testName: "Owned Resource IDOR",
            description: "Mutates the resource ID to detect IDOR vulnerabilities.",
            skipped: true,
            skippedReason: "No owned resource ID provided for Account A.",
          }),
    ]);

    const crossResult = await (accountB && accountA.ownedResourceId
      ? testCrossAccountAccess(targetUrl, headersA, headersB, accountA.label || "Account A", accountB.label || "Account B", accountA.ownedResourceId)
      : Promise.resolve<AuthTestResult>({
          testName: "Cross-Account Resource Access",
          description: "Account B attempts to access Account A's resource.",
          skipped: true,
          skippedReason: accountB
            ? "Account A has no owned resource ID — cannot target a specific resource."
            : "Account B not provided — enable two-account mode to run this test.",
        }));

    const tests: AuthTestResult[] = [guardResult, idorResult, crossResult];

    try {
      const analysis = await analyzeWithGpt(programName, programRules, targetUrl, featureOrFlow, notes, tests);
      return reply.send({ tests, ...analysis });
    } catch {
      // GPT failed — return raw test results without AI analysis
      return reply.send({
        tests,
        summary: "AI analysis unavailable — review raw test results above.",
        findings: tests.filter(t => t.finding).map(t => ({
          testName: t.testName,
          issue: t.finding!.issue,
          severity: t.finding!.severity,
          confidence: t.finding!.confidence,
        })),
        reportDraft: { title: "", impact: "", stepsToReproduce: [], evidenceNeeded: [] },
      });
    }
  });
}
