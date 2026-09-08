import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { runLiveSecurityTests } from "./live-security-tests.js";
import type { SecurityHttpExchange } from "./http-exchange.js";
import type { ProbeScope } from "./http-client.js";

// Live Security Testing v1, Tickets LST.2/LST.3/LST.5: proves the sensitive-data circuit
// breaker actually halts active probing against a REAL local HTTP server (not a stub of
// runLiveSecurityTests itself) - this is the end-to-end proof the frozen contract requires,
// not just a unit test of the classifier in isolation.
//
// Server behavior: GET/HEAD on the baseline order id (100, 2+ digits so
// detectResourceIdCandidates/NUMERIC_ID_SHAPE picks it up) returns ordinary, non-sensitive
// data. Any OTHER numeric order id (an IDOR alternate-id mutation target) returns a
// credit-card-shaped value - simulating "the mutated ID exposed someone else's sensitive data."

function startServer(mutatedIdRequests: string[]) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = url.pathname.match(/^\/api\/orders\/(\d+)$/);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "null" });
      res.end();
      return;
    }
    if (!match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const id = match[1];
    if (id === "100") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orderId: id, item: "widget" }));
      return;
    }
    mutatedIdRequests.push(`${req.method} ${url.pathname}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ orderId: id, creditCard: "4111 1111 1111 1111" }));
  });
  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected a real listening port");
      resolve({ server, port: address.port });
    });
  });
}

function buildBaselineExchange(baseUrl: string): SecurityHttpExchange {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    timestamp: Date.now(),
    request: { method: "GET", url: `${baseUrl}/api/orders/100`, headers: {} },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: "100", item: "widget" }),
      durationMs: 5,
    },
  };
}

test.after(async () => {});

test("runLiveSecurityTests: the circuit breaker trips on the first mutated-ID probe that returns sensitive data, and no further active probes are sent", async () => {
  const mutatedIdRequests: string[] = [];
  const { server, port } = await startServer(mutatedIdRequests);
  const baseUrl = `http://127.0.0.1:${port}`;
  const scope: ProbeScope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };

  try {
    const exchange = buildBaselineExchange(baseUrl);
    const result = await runLiveSecurityTests(exchange, scope);

    assert.equal(result.sensitiveDataStopped, true, "the breaker must report it tripped");
    const stopCheck = result.checks.find((c) => c.id === "sensitive-data-stop");
    assert.ok(stopCheck, "a sensitive-data-stop check must be recorded");
    assert.equal(stopCheck!.status, "failed");
    assert.equal(stopCheck!.severity, "critical");

    // LST.5 minimum-necessary-proof: only ONE mutated-ID request should have gone out, even
    // though alternateIdValues(100) offers two candidates (99 and 101) - the moment the first
    // one proves the hypothesis (and the breaker trips on the sensitive content), the second is
    // never attempted, and nothing downstream sends a third.
    assert.equal(mutatedIdRequests.length, 1, `expected exactly one mutated-ID request, got: ${mutatedIdRequests.join(", ")}`);

    // The raw sensitive body must never be persisted in evidence - only the redacted/truncated
    // bodySnippet convention already used everywhere else in this file.
    const evidenceJson = JSON.stringify(stopCheck!.evidence);
    assert.ok(!evidenceJson.includes("4111 1111 1111 1111"), "the raw card number must never appear in stored evidence");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runLiveSecurityTests: ordinary, non-sensitive IDOR data does not trip the breaker - unchanged existing behavior", async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "null" });
      res.end();
      return;
    }
    const match = url.pathname.match(/^\/api\/orders\/(\d+)$/);
    if (!match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    // Every order id, mutated or not, returns the same ordinary shape - no sensitive content.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ orderId: match[1], item: "widget" }));
  });
  const { port } = await new Promise<{ port: number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected a real listening port");
      resolve({ port: address.port });
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const scope: ProbeScope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };

  try {
    const exchange = buildBaselineExchange(baseUrl);
    const result = await runLiveSecurityTests(exchange, scope);

    assert.equal(result.sensitiveDataStopped, false);
    assert.ok(!result.checks.some((c) => c.id === "sensitive-data-stop"));
    // The existing IDOR finding behavior must be unaffected by the breaker's presence.
    assert.ok(result.checks.some((c) => c.id === "idor-url-mutation" && c.status === "failed"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runLiveSecurityTests: sessionAlreadyStopped skips every active probe with zero outbound requests", async () => {
  const requestCount: string[] = [];
  const server = http.createServer((req, res) => {
    requestCount.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ orderId: "100", item: "widget" }));
  });
  const { port } = await new Promise<{ port: number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected a real listening port");
      resolve({ port: address.port });
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const scope: ProbeScope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };

  try {
    const exchange = buildBaselineExchange(baseUrl);
    const result = await runLiveSecurityTests(exchange, scope, { sessionAlreadyStopped: true });

    assert.equal(result.sensitiveDataStopped, true, "an already-stopped session must report itself as stopped");
    assert.ok(result.checks.some((c) => c.id === "active-probes-session-stopped"));
    assert.equal(requestCount.length, 0, "no active probe may be sent once the session already stopped");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
