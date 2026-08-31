import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isLiveSecurityTestCandidate, runLiveSecurityTests } from "./live-security-tests.js";
import type { SecurityHttpExchange } from "./http-exchange.js";

const CONTACT_ID = "6693cefa-f65f-481b-aeb7-4b2fa0501617";

async function withLocalServer(
  handler: http.RequestListener,
  run: (base: string, port: number) => Promise<void>
) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port as number;
  try {
    await run(`http://127.0.0.1:${port}`, port);
  } finally {
    server.close();
  }
}

function makeExchange(base: string, overrides: Partial<SecurityHttpExchange> = {}): SecurityHttpExchange {
  const body = JSON.stringify([{ id: CONTACT_ID, name: "Case Manager" }]);
  return {
    id: "ex-live-1",
    sessionId: "s1",
    timestamp: Date.now(),
    request: { method: "GET", url: `${base}/api/contacts`, headers: { Authorization: "Bearer captured-token" } },
    response: { status: 200, headers: { "content-type": "application/json" }, body, durationMs: 5 },
    ...overrides,
  };
}

test("runLiveSecurityTests passes unauthenticated replay when auth removal is denied", async () => {
  await withLocalServer(
    (req, res) => {
      if (req.url === "/api/contacts" && req.headers.authorization === "Bearer captured-token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: CONTACT_ID, name: "Case Manager" }]));
        return;
      }
      res.writeHead(req.url === "/api/contacts" ? 401 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    },
    async (base, port) => {
      const result = await runLiveSecurityTests(makeExchange(base), {
        allowedHosts: ["127.0.0.1"],
        allowedPorts: [port],
      });

      const context = result.checks.find((check) => check.id === "route-context");
      assert.equal(context?.status, "info");
      assert.match(context?.title ?? "", /GET \/api\/contacts/);

      const directAccess = result.checks.find((check) => check.id === "unauthenticated-direct-access");
      assert.equal(directAccess?.status, "passed");
      assert.equal(directAccess?.title, "Unauthenticated /api/contacts returned 401");
    }
  );
});

test("runLiveSecurityTests flags unauthenticated API access that returns protected-looking data", async () => {
  await withLocalServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: CONTACT_ID, name: "Case Manager" }]));
    },
    async (base, port) => {
      const result = await runLiveSecurityTests(makeExchange(base), {
        allowedHosts: ["127.0.0.1"],
        allowedPorts: [port],
      });

      const directAccess = result.checks.find((check) => check.id === "unauthenticated-direct-access");
      assert.equal(directAccess?.status, "failed");
      assert.equal(directAccess?.severity, "high");
    }
  );
});

test("runLiveSecurityTests evaluates OPTIONS API responses with active CORS probing", async () => {
  await withLocalServer(
    (_req, res) => {
      res.writeHead(204, { "access-control-allow-origin": "https://app.example" });
      res.end();
    },
    async (base, port) => {
      const exchange = makeExchange(base, {
        request: { method: "OPTIONS", url: `${base}/api/auth/refresh`, headers: { Origin: "https://app.example" } },
        response: { status: 204, headers: { "access-control-allow-origin": "https://app.example" }, body: "", durationMs: 2 },
      });

      assert.equal(isLiveSecurityTestCandidate(exchange), true);
      const result = await runLiveSecurityTests(exchange, {
        allowedHosts: ["127.0.0.1"],
        allowedPorts: [port],
      });

      assert.ok(result.probes.some((probe) => probe.label === "cross-origin preflight probe"));
      assert.equal(result.checks.find((check) => check.id === "active-get-probes")?.status, "skipped");
      assert.equal(result.checks.find((check) => check.id === "active-cors-origin-probe")?.status, "passed");
    }
  );
});

test("runLiveSecurityTests treats a 401 API GET as an evaluated auth-control result", async () => {
  await withLocalServer(
    (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    },
    async (base, port) => {
      const exchange = makeExchange(base, {
        request: { method: "GET", url: `${base}/api/auth/me`, headers: { Cookie: "session=expired" } },
        response: { status: 401, headers: { "content-type": "application/json" }, body: '{"error":"unauthorized"}', durationMs: 2 },
      });

      const result = await runLiveSecurityTests(exchange, {
        allowedHosts: ["127.0.0.1"],
        allowedPorts: [port],
      });

      const directAccess = result.checks.find((check) => check.id === "unauthenticated-direct-access");
      assert.equal(directAccess?.status, "passed");
      assert.equal(directAccess?.title, "GET /api/auth/me returned 401");
    }
  );
});

test("runLiveSecurityTests rejects static asset baselines", async () => {
  const exchange = makeExchange("http://127.0.0.1", {
    request: { method: "GET", url: "http://127.0.0.1/assets/app.png", headers: {} },
    response: { status: 200, headers: { "content-type": "image/png" }, body: "", durationMs: 2 },
  });

  assert.equal(isLiveSecurityTestCandidate(exchange), false);
  await assert.rejects(
    () => runLiveSecurityTests(exchange, { allowedHosts: ["127.0.0.1"], allowedPorts: [] }),
    /API\/JSON baseline/
  );
});
