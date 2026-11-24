import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { callEvalService, caseRequestsSemanticEval, isLowConfidence } from "./evaluation-service.js";

async function withFixtureServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>
) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("callEvalService returns the parsed JSON body on a 200 response, with the api key header set", async () => {
  await withFixtureServer(
    (req, res) => {
      assert.equal(req.headers["x-api-key"], "test-key");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ overall_gate_status: "pass" }));
    },
    async (baseUrl) => {
      const result = await callEvalService({ dataset_id: "d1" }, { baseUrl, apiKey: "test-key" });
      assert.equal(result.overall_gate_status, "pass");
    }
  );
});

test("callEvalService throws a clear error on 401", async () => {
  await withFixtureServer(
    (_req, res) => {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
    },
    async (baseUrl) => {
      await assert.rejects(
        () => callEvalService({ dataset_id: "d1" }, { baseUrl, apiKey: "wrong-key" }),
        /rejected the API key/
      );
    }
  );
});

test("callEvalService throws with a snippet of the body on a non-2xx status, not the full body", async () => {
  const longBody = "x".repeat(5_000);
  await withFixtureServer(
    (_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(longBody);
    },
    async (baseUrl) => {
      try {
        await callEvalService({ dataset_id: "d1" }, { baseUrl, apiKey: "test-key" });
        assert.fail("expected callEvalService to throw");
      } catch (err: any) {
        assert.match(err.message, /returned 500/);
        // Safe-logging correction: the error message must never carry the full 5000-char body
        // verbatim - it must be truncated via redaction.ts's snippet() convention.
        assert.ok(err.message.length < longBody.length);
      }
    }
  );
});

test("callEvalService throws a clear error when the response is not valid JSON", async () => {
  await withFixtureServer(
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not json");
    },
    async (baseUrl) => {
      await assert.rejects(
        () => callEvalService({ dataset_id: "d1" }, { baseUrl, apiKey: "test-key" }),
        /did not return valid JSON/
      );
    }
  );
});

test("callEvalService throws a clear error when base URL or API key is unset", async () => {
  // Explicit empty overrides, not {} - falling through to validatedEnv would make this test
  // depend on whatever the ambient .env happens to contain, not a controlled condition.
  await assert.rejects(
    () => callEvalService({ dataset_id: "d1" }, { baseUrl: "", apiKey: "" }),
    /not configured/
  );
});

// Phase 3: semantic-eval request detection - Phase 1/2 cases never set these fields.
test("caseRequestsSemanticEval is false for a plain Phase 1/2 case", () => {
  assert.equal(caseRequestsSemanticEval({ case_id: "c1", answer_text: "x", required_facts: ["x"] }), false);
});
test("caseRequestsSemanticEval is true when question, contexts, or ground_truth is present", () => {
  assert.equal(caseRequestsSemanticEval({ question: "q" }), true);
  assert.equal(caseRequestsSemanticEval({ contexts: ["a"] }), true);
  assert.equal(caseRequestsSemanticEval({ ground_truth: "g" }), true);
});
test("caseRequestsSemanticEval handles null/undefined safely", () => {
  assert.equal(caseRequestsSemanticEval(null), false);
  assert.equal(caseRequestsSemanticEval(undefined), false);
});

// Phase 3: human-review "low confidence" banding.
test("isLowConfidence uses the fixed mid-range band when no gate is configured for the metric", () => {
  assert.equal(isLowConfidence("faithfulness", 0.5, undefined), true);
  assert.equal(isLowConfidence("faithfulness", 0.95, undefined), false);
  assert.equal(isLowConfidence("faithfulness", 0.05, undefined), false);
});
test("isLowConfidence uses proximity to the configured gate threshold when one exists", () => {
  const gates = { faithfulness: { min: 0.8 } };
  assert.equal(isLowConfidence("faithfulness", 0.9, gates), true); // within 0.15 of 0.8
  assert.equal(isLowConfidence("faithfulness", 0.5, gates), false); // far from 0.8, outside the default band too
  assert.equal(isLowConfidence("faithfulness", 0.5, { faithfulness: { max: 0.5 } }), true); // uses max when min absent
});
