import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { runLiveSecurityTests } from "./live-security-tests.js";
import type { SecurityHttpExchange } from "./http-exchange.js";
import type { ProbeScope } from "./http-client.js";

// Live Security Testing v1, Ticket LST.4: real-method, real-mutation active probing. Proves the
// IDOR/BOLA mutation probe genuinely preserves the captured method (and mutates a real JSON
// body field) when the state-changing tier is opted into - not just a GET approximation - and
// that the two-tier gate (allowMutatingActiveProbes, then allowDeleteActiveProbes on top of it)
// is enforced.

function startRecordingServer() {
  const received: Array<{ method: string; path: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-origin": "null" });
        res.end();
        return;
      }
      received.push({ method: req.method ?? "", path: url.pathname, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orderId: "100", item: "widget" }));
    });
  });
  return new Promise<{ server: http.Server; port: number; received: typeof received }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected a real listening port");
      resolve({ server, port: address.port, received });
    });
  });
}

function buildExchange(baseUrl: string, method: string, opts: { url?: string; postData?: string } = {}): SecurityHttpExchange {
  return {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    timestamp: Date.now(),
    request: {
      method,
      url: opts.url ?? `${baseUrl}/api/orders/100`,
      headers: { "content-type": "application/json" },
      postData: opts.postData,
    },
    response: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: "100", item: "widget" }),
      durationMs: 5,
    },
  };
}

test("runLiveSecurityTests: without the opt-in, a captured PUT baseline still gets zero active probes (unchanged existing behavior)", async () => {
  const { server, port, received } = await startRecordingServer();
  const scope: ProbeScope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
  try {
    const exchange = buildExchange(`http://127.0.0.1:${port}`, "PUT");
    const result = await runLiveSecurityTests(exchange, scope);
    assert.ok(result.checks.some((c) => c.id === "idor-url-mutation" && c.status === "skipped"));
    assert.equal(received.length, 0, "no request of any kind should reach the server without the opt-in");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runLiveSecurityTests: with allowMutatingActiveProbes, the IDOR mutation probe against a PUT baseline is actually sent as PUT, not GET", async () => {
  const { server, port, received } = await startRecordingServer();
  const scope: ProbeScope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
  try {
    const exchange = buildExchange(`http://127.0.0.1:${port}`, "PUT");
    await runLiveSecurityTests(exchange, scope, { allowMutatingActiveProbes: true });

    // Exclude the baseline path (100) - the method-tampering HEAD probe legitimately hits the
    // exact captured URL too, so only requests to a MUTATED id prove the IDOR probe's method.
    const orderRequests = received.filter((r) => /^\/api\/orders\/\d+$/.test(r.path) && r.path !== "/api/orders/100");
    assert.ok(orderRequests.length > 0, "expected at least one request to a mutated order id");
    for (const r of orderRequests) {
      assert.equal(r.method, "PUT", `expected the real captured method to be preserved, got ${r.method} for ${r.path}`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runLiveSecurityTests: allowDeleteActiveProbes alone (without allowMutatingActiveProbes) never enables DELETE active probing", async () => {
  const { server, port, received } = await startRecordingServer();
  const scope: ProbeScope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
  try {
    const exchange = buildExchange(`http://127.0.0.1:${port}`, "DELETE");
    const result = await runLiveSecurityTests(exchange, scope, { allowDeleteActiveProbes: true });
    assert.ok(result.checks.some((c) => c.id === "idor-url-mutation" && c.status === "skipped"));
    assert.equal(received.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runLiveSecurityTests: allowMutatingActiveProbes + allowDeleteActiveProbes together enable real DELETE probing", async () => {
  const { server, port, received } = await startRecordingServer();
  const scope: ProbeScope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
  try {
    const exchange = buildExchange(`http://127.0.0.1:${port}`, "DELETE");
    await runLiveSecurityTests(exchange, scope, { allowMutatingActiveProbes: true, allowDeleteActiveProbes: true });

    // Exclude the baseline path (100) - the method-tampering HEAD probe legitimately hits the
    // exact captured URL too, so only requests to a MUTATED id prove the IDOR probe's method.
    const orderRequests = received.filter((r) => /^\/api\/orders\/\d+$/.test(r.path) && r.path !== "/api/orders/100");
    assert.ok(orderRequests.length > 0);
    for (const r of orderRequests) {
      assert.equal(r.method, "DELETE");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("runLiveSecurityTests: with allowMutatingActiveProbes, a body-level id field is mutated and resent with the real method when the URL has no id to mutate", async () => {
  const { server, port, received } = await startRecordingServer();
  const scope: ProbeScope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
  try {
    const exchange = buildExchange(`http://127.0.0.1:${port}`, "POST", {
      url: `http://127.0.0.1:${port}/api/orders`,
      postData: JSON.stringify({ orderId: "100", note: "hello" }),
    });
    await runLiveSecurityTests(exchange, scope, { allowMutatingActiveProbes: true });

    const bodyMutated = received.find((r) => r.path === "/api/orders" && r.method === "POST" && r.body && r.body !== exchange.request.postData);
    assert.ok(bodyMutated, `expected a POST to /api/orders with a mutated body; got: ${JSON.stringify(received)}`);
    const parsedBody = JSON.parse(bodyMutated!.body);
    assert.notEqual(parsedBody.orderId, "100", "the body's orderId field must have been mutated to an alternate value");
    assert.equal(parsedBody.note, "hello", "unrelated body fields must be left untouched");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
