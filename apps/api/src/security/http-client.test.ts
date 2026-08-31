import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { probeScoped } from "./http-client.js";

// Regression test for the redirect-scope-escape concern raised in review: probeScoped
// must re-validate isWithinScope on every redirect hop, not just the initial URL, or an
// in-scope target could 302 an attacker/self-controlled response to an out-of-scope
// (potentially internal) address and have it silently followed and requested.
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

test("probeScoped never requests an out-of-scope redirect target", async () => {
  await withLocalServer(
    (req, res) => {
      if (req.url === "/redirect-out-of-scope") {
        res.writeHead(302, { Location: "http://internal.example.invalid/secret" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    },
    async (base, port) => {
      const scope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
      const result = await probeScoped(scope, `${base}/redirect-out-of-scope`);
      assert.equal(result.status, undefined, "the out-of-scope redirect target must never be requested");
      assert.match(result.error ?? "", /outside allowed/);
    }
  );
});

test("probeScoped follows an in-scope redirect chain to completion", async () => {
  await withLocalServer(
    (req, res) => {
      if (req.url === "/redirect-in-scope") {
        res.writeHead(302, { Location: "/landed" });
        res.end();
        return;
      }
      if (req.url === "/landed") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("landed ok");
        return;
      }
      res.writeHead(404);
      res.end();
    },
    async (base, port) => {
      const scope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
      const result = await probeScoped(scope, `${base}/redirect-in-scope`);
      assert.equal(result.status, 200);
      assert.equal(result.body, "landed ok");
    }
  );
});

test("probeScoped with followRedirects: false returns the raw 3xx response without following it", async () => {
  await withLocalServer(
    (req, res) => {
      res.writeHead(302, { Location: "http://internal.example.invalid/secret" });
      res.end();
    },
    async (base, port) => {
      const scope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
      const result = await probeScoped(scope, base, { followRedirects: false });
      assert.equal(result.status, 302);
      assert.equal(result.headers.location, "http://internal.example.invalid/secret");
    }
  );
});

test("probeScoped rejects a redirect chain longer than the configured cap", async () => {
  await withLocalServer(
    (req, res) => {
      const n = Number(req.url?.replace("/hop", "") || "0");
      res.writeHead(302, { Location: `/hop${n + 1}` });
      res.end();
    },
    async (base, port) => {
      const scope = { allowedHosts: ["127.0.0.1"], allowedPorts: [port] };
      const result = await probeScoped(scope, `${base}/hop0`, { maxRedirects: 2 });
      assert.equal(result.status, undefined);
      assert.match(result.error ?? "", /Too many redirects/);
    }
  );
});

test("probeScoped rejects a URL outside scope before ever making a request", async () => {
  const scope = { allowedHosts: ["example.com"], allowedPorts: [] };
  const result = await probeScoped(scope, "http://127.0.0.1:1/should-not-be-requested");
  assert.equal(result.status, undefined);
  assert.match(result.error ?? "", /outside allowed/);
});
