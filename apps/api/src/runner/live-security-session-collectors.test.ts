import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "patchright";
import { collectSafeClickTargets, collectSafeSearchTargets } from "./live-security-session.js";

// Regression test for a real, confirmed production bug: these two collectors defined a nested
// named helper (`visible`, `labelFor`) inside their page.evaluate() callback. tsx's esbuild
// transform runs with keepNames: true, which wraps any such nested named function/const-arrow in
// a `__name(...)` call; that reference doesn't exist in the isolated browser realm the callback's
// source text gets re-run in, so every call threw "ReferenceError: __name is not defined" -
// silently swallowed by the collectors' own .catch(() => []), making a real automated site-walk
// look like "found no click/search targets" rather than surfacing the actual error. Confirmed via
// this exact evaluate shape against a real page before the fix, reproducing the throw; these
// tests prove the fix (inlining the helpers) actually finds targets on a real page.

async function withFixturePage(html: string, run: (session: any) => Promise<void>) {
  const server: Server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "domcontentloaded" });
    // Only `id` and `page` are read by collectSafeClickTargets/collectSafeSearchTargets - a
    // minimal fixture rather than constructing a full LiveSession (browser/context/cdp/sockets/
    // scope/etc, none of which these two functions touch).
    await run({ id: "test-session", page });
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("collectSafeClickTargets finds real buttons/links on a live page instead of silently erroring", async () => {
  await withFixturePage(
    `<!doctype html><html><body>
      <button>Save changes</button>
      <a href="/settings">Settings</a>
    </body></html>`,
    async (session) => {
      const targets = await collectSafeClickTargets(session);
      assert.ok(targets.length > 0, "must find real click targets, not silently return []");
      assert.ok(targets.some((t) => t.label === "Save changes"));
    }
  );
});

test("collectSafeClickTargets still excludes dangerous-labeled controls", async () => {
  await withFixturePage(
    `<!doctype html><html><body>
      <button>Delete account</button>
      <button>View profile</button>
    </body></html>`,
    async (session) => {
      const targets = await collectSafeClickTargets(session);
      assert.ok(!targets.some((t) => t.label === "Delete account"), "dangerous labels must still be filtered");
      assert.ok(targets.some((t) => t.label === "View profile"));
    }
  );
});

test("collectSafeSearchTargets finds a real search input on a live page instead of silently erroring", async () => {
  await withFixturePage(
    `<!doctype html><html><body>
      <input type="search" placeholder="Search products" />
    </body></html>`,
    async (session) => {
      const targets = await collectSafeSearchTargets(session);
      assert.ok(targets.length > 0, "must find real search targets, not silently return []");
      assert.equal(targets[0].label, "Search products");
    }
  );
});
