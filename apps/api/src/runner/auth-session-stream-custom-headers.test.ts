import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "patchright";

// Proves the exact context.route() navigation-header-merge pattern startCapture uses in
// auth-session-stream.ts for user-supplied customHeaders (the `else if (hasCustomHeaders)`
// branch, for modes without the stealth-patch route already covering it) - navigation-only
// scoping, existing headers preserved, custom headers actually reach the server. startCapture
// itself isn't exported (it also launches a real Chromium context, sets up CDP screencast/idle
// timers/etc. well beyond header injection), so this exercises the isolated mechanism directly
// rather than the whole session lifecycle.
async function withFixtureServer(run: (baseUrl: string, received: () => IncomingMessage["headers"][]) => Promise<void>) {
  const receivedHeaders: IncomingMessage["headers"][] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    receivedHeaders.push(req.headers);
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><html><body>ok</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, () => receivedHeaders);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("customHeaders reach the server on navigation, existing headers preserved", async () => {
  await withFixtureServer(async (baseUrl, received) => {
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext();
      const customHeaders = { "X-Bypass-Secret": "abc123" };
      // Same shape as auth-session-stream.ts's `else if (hasCustomHeaders)` branch.
      await context.route("**/*", (route) => {
        const request = route.request();
        if (!request.isNavigationRequest()) return route.continue();
        return route.continue({ headers: { ...request.headers(), ...customHeaders } });
      });
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const [headers] = received();
      assert.equal(headers["x-bypass-secret"], "abc123");
      assert.ok(headers["user-agent"], "existing headers must still be sent, not replaced");
    } finally {
      await browser.close();
    }
  });
});

test("without customHeaders, navigation requests are unaffected (no route registered)", async () => {
  await withFixtureServer(async (baseUrl, received) => {
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const [headers] = received();
      assert.equal(headers["x-bypass-secret"], undefined);
    } finally {
      await browser.close();
    }
  });
});
