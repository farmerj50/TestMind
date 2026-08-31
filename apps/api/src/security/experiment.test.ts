import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runIdMutationExperiment, runReplayExperiment } from "./experiment.js";
import type { SecurityHttpExchange } from "./http-exchange.js";

// Regression tests for the four invariants documented in experiment.ts / the plan's Context
// section: no captured baseline -> no experiment; GET-only; every replay goes through
// probeScoped (proven indirectly here — nothing in experiment.ts imports undici/fetch
// directly); mutation can only target a server-detected candidate.

async function withLocalServer(run: (base: string, port: number, requestLog: string[]) => Promise<void>) {
  const requestLog: string[] = [];
  const server = http.createServer((req, res) => {
    requestLog.push(req.url ?? "");
    const match = req.url?.match(/^\/api\/orders\/(\w+)/);
    if (match) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: match[1], ownerId: match[1] === "8721" ? 413 : 900 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port as number;
  try {
    await run(`http://127.0.0.1:${port}`, port, requestLog);
  } finally {
    server.close();
  }
}

function makeExchange(overrides: Partial<SecurityHttpExchange> = {}): SecurityHttpExchange {
  return {
    id: "ex1",
    sessionId: "s1",
    timestamp: Date.now(),
    request: { method: "GET", url: "http://placeholder/api/orders/8721", headers: {} },
    response: { status: 200, headers: {}, body: '{"id":"8721","ownerId":413}', durationMs: 5 },
    ...overrides,
  };
}

test("runIdMutationExperiment succeeds for a valid GET baseline and a server-detected candidate", async () => {
  await withLocalServer(async (base, port) => {
    const exchange = makeExchange({ request: { method: "GET", url: `${base}/api/orders/8721`, headers: {} } });
    const scope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
    const result = await runIdMutationExperiment(
      exchange,
      { location: "path", paramName: "segment2", value: "8721" },
      "9999",
      scope
    );
    assert.equal(result.mutatedResult.status, 200);
    assert.equal(result.diff.statusMatch, true);
    // Baseline was {id:"8721",ownerId:413}; mutated request (id=9999) hits the server's
    // generic branch returning {id:"9999",ownerId:900} — both keys should show as changed.
    assert.deepEqual(result.diff.changedKeys.sort(), ["id", "ownerId"]);
  });
});

test("runReplayExperiment replays a captured GET baseline without changing the URL", async () => {
  await withLocalServer(async (base, port, requestLog) => {
    const exchange = makeExchange({ request: { method: "GET", url: `${base}/api/orders/8721`, headers: {} } });
    const scope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
    const result = await runReplayExperiment(exchange, scope);

    assert.equal(result.mutatedResult.status, 200);
    assert.equal(result.mutatedResult.url, `${base}/api/orders/8721`);
    assert.deepEqual(requestLog, ["/api/orders/8721"]);
  });
});

test("runIdMutationExperiment rejects a baseline with no captured response (invariant #1)", async () => {
  await withLocalServer(async (base, port) => {
    const exchange = makeExchange({ response: undefined });
    const scope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
    await assert.rejects(
      () =>
        runIdMutationExperiment(exchange, { location: "path", paramName: "segment2", value: "8721" }, "9999", scope),
      /captured baseline/
    );
  });
});

test("runIdMutationExperiment rejects a non-GET baseline (invariant #2)", async () => {
  await withLocalServer(async (base, port) => {
    const exchange = makeExchange({ request: { method: "POST", url: `${base}/api/orders/8721`, headers: {} } });
    const scope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
    await assert.rejects(
      () =>
        runIdMutationExperiment(exchange, { location: "path", paramName: "segment2", value: "8721" }, "9999", scope),
      /GET-only/
    );
  });
});

test("runIdMutationExperiment rejects a mutation target that isn't a server-detected candidate for this baseline, and never makes the request (invariant #4)", async () => {
  await withLocalServer(async (base, port, requestLog) => {
    const exchange = makeExchange({ request: { method: "GET", url: `${base}/api/orders/8721`, headers: {} } });
    const scope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
    // "fakeParam" was never returned by detectResourceIdCandidates for this URL.
    await assert.rejects(
      () => runIdMutationExperiment(exchange, { location: "query", paramName: "fakeParam", value: "x" }, "9999", scope),
      /server-detected candidate/
    );
    assert.equal(requestLog.length, 0, "no outbound request should have been made for a rejected candidate");
  });
});

test("runIdMutationExperiment clones the baseline's own headers onto the mutated request (identity preserved by construction)", async () => {
  await withLocalServer(async (base, port) => {
    let seenAuthHeader: string | undefined;
    const server2 = http.createServer((req, res) => {
      seenAuthHeader = req.headers["authorization"] as string | undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
    const port2 = (server2.address() as any).port as number;
    try {
      const exchange = makeExchange({
        request: { method: "GET", url: `http://127.0.0.1:${port2}/api/orders/8721`, headers: { Authorization: "Bearer captured-token" } },
      });
      const scope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port2] };
      await runIdMutationExperiment(exchange, { location: "path", paramName: "segment2", value: "8721" }, "9999", scope);
      assert.equal(seenAuthHeader, "Bearer captured-token");
    } finally {
      server2.close();
    }
  });
});
