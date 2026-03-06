import test from "node:test";
import assert from "node:assert/strict";
import { safeFetch } from "./safe-fetch.js";

type MockFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function withMockFetch(mock: MockFetch, fn: () => Promise<void>) {
  const prev = globalThis.fetch;
  (globalThis as any).fetch = mock;
  return fn().finally(() => {
    (globalThis as any).fetch = prev;
  });
}

test("safeFetch blocks non-https by default", async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    return new Response("ok", { status: 200 });
  }, async () => {
    await assert.rejects(() => safeFetch("http://example.com/resource"), /protocol is not allowed/i);
    assert.equal(calls, 0);
  });
});

test("safeFetch allows http only when explicitly enabled", async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    return new Response("ok", { status: 200 });
  }, async () => {
    const res = await safeFetch("http://example.com/resource", undefined, {
      allowHttp: true,
      allowedHosts: ["example.com"],
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
  });
});

test("safeFetch blocks private/loopback hosts by default", async () => {
  await withMockFetch(async () => new Response("ok", { status: 200 }), async () => {
    await assert.rejects(() => safeFetch("https://127.0.0.1/health"), /host is not allowed/i);
    await assert.rejects(() => safeFetch("https://192.168.1.10/health"), /host is not allowed/i);
  });
});

test("safeFetch enforces host allowlist", async () => {
  await withMockFetch(async () => new Response("ok", { status: 200 }), async () => {
    await assert.rejects(
      () => safeFetch("https://api.other.com/data", undefined, { allowedHosts: ["example.com"] }),
      /not in allowlist/i
    );
  });
});

test("safeFetch re-validates redirect target and blocks redirect to private host", async () => {
  const calls: string[] = [];
  await withMockFetch(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/internal" },
      });
    }
    return new Response("unexpected second call", { status: 200 });
  }, async () => {
    await assert.rejects(
      () => safeFetch("https://example.com/start", undefined, { allowedHosts: ["example.com"] }),
      /host is not allowed/i
    );
    assert.equal(calls.length, 1);
  });
});

test("safeFetch follows allowed redirects within allowlisted domain", async () => {
  const calls: string[] = [];
  await withMockFetch(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://api.example.com/final" },
      });
    }
    return new Response("ok", { status: 200 });
  }, async () => {
    const res = await safeFetch("https://example.com/start", undefined, {
      allowedHosts: ["example.com"],
      maxRedirects: 2,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ["https://example.com/start", "https://api.example.com/final"]);
  });
});

