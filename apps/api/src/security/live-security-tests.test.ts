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
      assert.equal(directAccess?.validation?.status, "confirmed");
      assert.ok((directAccess?.validation?.successfulReproductions ?? 0) >= 2);
    }
  );
});

test("runLiveSecurityTests confirms cookie-backed CORS only after repeated readable GET probes", async () => {
  await withLocalServer(
    (req, res) => {
      if (req.method === "OPTIONS" && req.url === "/api/contacts") {
        res.writeHead(204, {
          "access-control-allow-origin": "https://attacker.invalid",
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET",
          "access-control-allow-headers": "authorization,content-type",
        });
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/api/contacts" && req.headers.cookie === "session=captured") {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (req.headers.origin === "https://attacker.invalid") {
          headers["access-control-allow-origin"] = "https://attacker.invalid";
          headers["access-control-allow-credentials"] = "true";
        }
        res.writeHead(200, headers);
        res.end(JSON.stringify([{ id: CONTACT_ID, name: "Case Manager" }]));
        return;
      }
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    },
    async (base, port) => {
      const result = await runLiveSecurityTests(
        makeExchange(base, {
          request: { method: "GET", url: `${base}/api/contacts`, headers: { Cookie: "session=captured" } },
        }),
        {
          allowedHosts: ["127.0.0.1"],
          allowedPorts: [port],
        }
      );

      const cors = result.checks.find((check) => check.id === "active-cors-origin-probe");
      assert.equal(cors?.status, "failed");
      assert.equal(cors?.validation?.status, "confirmed");
      assert.equal(cors?.validation?.proofLevel, "repeated");
      assert.ok(result.probes.some((probe) => probe.label === "credentialed CORS read reproduction"));
    }
  );
});

test("runLiveSecurityTests marks preflight-only CORS evidence as suspected for non-GET routes", async () => {
  await withLocalServer(
    (req, res) => {
      if (req.method === "OPTIONS" && req.url === "/api/contacts") {
        res.writeHead(204, {
          "access-control-allow-origin": "https://attacker.invalid",
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "POST",
          "access-control-allow-headers": "authorization,content-type",
        });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: CONTACT_ID, ok: true }));
    },
    async (base, port) => {
      const result = await runLiveSecurityTests(
        makeExchange(base, {
          request: { method: "POST", url: `${base}/api/contacts`, headers: { Cookie: "session=captured" }, postData: "{}" },
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: CONTACT_ID, ok: true }),
            durationMs: 4,
          },
        }),
        {
          allowedHosts: ["127.0.0.1"],
          allowedPorts: [port],
        }
      );

      const cors = result.checks.find((check) => check.id === "active-cors-origin-probe");
      assert.equal(cors?.status, "info");
      assert.equal(cors?.validation?.status, "suspected");
      assert.equal(cors?.validation?.successfulReproductions, 0);
    }
  );
});

test("runLiveSecurityTests marks wildcard credentialed CORS not exploitable when browser read is blocked", async () => {
  await withLocalServer(
    (req, res) => {
      if (req.method === "OPTIONS" && req.url === "/api/contacts") {
        res.writeHead(204, { "content-type": "application/json" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
      });
      res.end(JSON.stringify([{ id: CONTACT_ID, name: "Case Manager" }]));
    },
    async (base, port) => {
      const result = await runLiveSecurityTests(
        makeExchange(base, {
          request: { method: "GET", url: `${base}/api/contacts`, headers: { Cookie: "session=captured" } },
          response: {
            status: 200,
            headers: {
              "content-type": "application/json",
              "access-control-allow-origin": "*",
              "access-control-allow-credentials": "true",
            },
            body: JSON.stringify([{ id: CONTACT_ID, name: "Case Manager" }]),
            durationMs: 4,
          },
        }),
        {
          allowedHosts: ["127.0.0.1"],
          allowedPorts: [port],
        },
        {
          browserCorsRead: async (url) => ({
            method: "GET",
            url,
            body: "",
            bodyLength: 0,
            bodySnippet: "",
            headers: {},
            error: "Failed to fetch",
            browserReadable: false,
            browserBlocked: true,
            browserOrigin: "http://127.0.0.1:49000",
          }),
        }
      );

      const cors = result.checks.find((check) => check.id === "cors-wildcard-credentials");
      assert.equal(cors?.status, "info");
      assert.equal(cors?.severity, "info");
      assert.equal(cors?.validation?.status, "not_exploitable");
      assert.equal(cors?.validation?.requirements.find((requirement) => requirement.id === "browser_credentialed_read")?.passed, false);
      assert.ok(result.probes.some((probe) => probe.label === "browser credentialed CORS read proof"));
    }
  );
});

test("runLiveSecurityTests confirms CORS when browser credentialed read returns matching data repeatedly", async () => {
  await withLocalServer(
    (req, res) => {
      if (req.method === "OPTIONS" && req.url === "/api/contacts") {
        res.writeHead(204, {
          "access-control-allow-origin": "https://attacker.invalid",
          "access-control-allow-credentials": "true",
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
      });
      res.end(JSON.stringify([{ id: CONTACT_ID, name: "Case Manager" }]));
    },
    async (base, port) => {
      const body = JSON.stringify([{ id: CONTACT_ID, name: "Case Manager" }]);
      const result = await runLiveSecurityTests(
        makeExchange(base, {
          request: { method: "GET", url: `${base}/api/contacts`, headers: { Cookie: "session=captured" } },
          response: {
            status: 200,
            headers: {
              "content-type": "application/json",
              "access-control-allow-origin": "*",
              "access-control-allow-credentials": "true",
            },
            body,
            durationMs: 4,
          },
        }),
        {
          allowedHosts: ["127.0.0.1"],
          allowedPorts: [port],
        },
        {
          browserCorsRead: async (url) => ({
            method: "GET",
            url,
            status: 200,
            body,
            bodyLength: body.length,
            bodySnippet: body,
            headers: {},
            browserReadable: true,
            browserBlocked: false,
            browserOrigin: "http://127.0.0.1:49000",
          }),
        }
      );

      const cors = result.checks.find((check) => check.id === "cors-wildcard-credentials");
      assert.equal(cors?.status, "failed");
      assert.equal(cors?.validation?.status, "confirmed");
      assert.equal(cors?.validation?.proofLevel, "browser");
      assert.ok(result.probes.some((probe) => probe.label === "browser credentialed CORS read reproduction"));
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

test("runLiveSecurityTests reports explicit live-module skips for non-GET API responses", async () => {
  await withLocalServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: CONTACT_ID, ok: true }));
    },
    async (base, port) => {
      const result = await runLiveSecurityTests(
        makeExchange(base, {
          request: { method: "POST", url: `${base}/api/contacts`, headers: { Cookie: "session=captured" }, postData: "{}" },
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: CONTACT_ID, ok: true }),
            durationMs: 4,
          },
        }),
        {
          allowedHosts: ["127.0.0.1"],
          allowedPorts: [port],
        }
      );

      assert.equal(result.checks.find((check) => check.id === "method-tampering-head")?.status, "skipped");
      assert.equal(result.checks.find((check) => check.id === "xss-reflection-probe")?.status, "skipped");
      assert.equal(result.checks.find((check) => check.id === "injection-error-probe")?.status, "skipped");
      assert.equal(result.checks.find((check) => check.id === "idor-url-mutation")?.status, "skipped");
    }
  );
});

test("runLiveSecurityTests flags unencoded reflected markup in browser-rendered responses", async () => {
  await withLocalServer(
    (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const reflected = url.searchParams.get("tm_xss_probe") ?? "ok";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body>${reflected}</body></html>`);
    },
    async (base, port) => {
      const result = await runLiveSecurityTests(
        makeExchange(base, {
          request: { method: "GET", url: `${base}/api/search`, headers: { Cookie: "session=captured" } },
          response: { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<html><body>ok</body></html>", durationMs: 4 },
        }),
        {
          allowedHosts: ["127.0.0.1"],
          allowedPorts: [port],
        }
      );

      const xss = result.checks.find((check) => check.id === "xss-reflection-probe");
      assert.equal(xss?.status, "failed");
      assert.equal(xss?.vulnerabilityClass, "xss");
      assert.equal(xss?.validation?.status, "suspected");
      assert.ok(result.probes.some((probe) => probe.label === "XSS reflection marker probe"));
    }
  );
});

test("runLiveSecurityTests flags injection parser probes that produce server errors", async () => {
  await withLocalServer(
    (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.searchParams.has("tm_injection_probe")) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("PrismaClientKnownRequestError: sql syntax error");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
    async (base, port) => {
      const result = await runLiveSecurityTests(
        makeExchange(base, {
          request: { method: "GET", url: `${base}/api/search`, headers: { Cookie: "session=captured" } },
          response: { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }), durationMs: 4 },
        }),
        {
          allowedHosts: ["127.0.0.1"],
          allowedPorts: [port],
        }
      );

      const injection = result.checks.find((check) => check.id === "injection-error-probe");
      assert.equal(injection?.status, "failed");
      assert.equal(injection?.vulnerabilityClass, "injection");
      assert.equal(injection?.validation?.status, "suspected");
      assert.ok(result.probes.some((probe) => probe.label === "injection parser error probe"));
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
