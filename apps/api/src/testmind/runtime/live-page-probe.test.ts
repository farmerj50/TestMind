import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { probeSelectorCandidates, looksAuthGated } from "./live-page-probe.js";

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>
) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("looksAuthGated matches auth-shaped paths and full URLs", () => {
  assert.equal(looksAuthGated("/login"), true);
  assert.equal(looksAuthGated("/account/login"), true);
  assert.equal(looksAuthGated("https://example.com/sso/callback"), true);
  assert.equal(looksAuthGated("/forgot-password"), false);
  assert.equal(looksAuthGated("https://example.com/dashboard"), false);
});

test("probeSelectorCandidates resolves a real candidate against a live fixture page", async () => {
  await withServer(
    (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><html><body>
        <input name="forgot-email-input" placeholder="Email" />
        <button type="submit">Send reset link</button>
      </body></html>`);
    },
    async (baseUrl) => {
      const outcome = await probeSelectorCandidates(
        baseUrl,
        [
          {
            key: "fields.forgot-email-input",
            kind: "fill",
            candidates: ["#does-not-exist", "[name=\"forgot-email-input\"]", "input"],
          },
          {
            key: "buttons.submit",
            kind: "click",
            candidates: ["button[type=\"submit\"]"],
          },
        ],
        { allowPrivateHosts: true, allowHttp: true, navigationTimeoutMs: 5000, perCandidateTimeoutMs: 500, totalBudgetMs: 8000 }
      );

      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.results.length, 2);
      const field = outcome.results.find((r) => r.key === "fields.forgot-email-input");
      assert.equal(field?.selectedSelector, '[name="forgot-email-input"]');
      assert.equal(field?.matchCount, 1);
      // the non-matching candidate was tried first and recorded, even though it failed
      assert.deepEqual(field?.attemptedSelectors, ["#does-not-exist", '[name="forgot-email-input"]']);

      const button = outcome.results.find((r) => r.key === "buttons.submit");
      assert.equal(button?.selectedSelector, 'button[type="submit"]');
      assert.equal(button?.matchCount, 1);
    }
  );
});

test("probeSelectorCandidates reports matchCount > 1 for a non-unique candidate", async () => {
  await withServer(
    (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><html><body>
        <button>One</button>
        <button>Two</button>
        <button>Three</button>
      </body></html>`);
    },
    async (baseUrl) => {
      const outcome = await probeSelectorCandidates(
        baseUrl,
        [{ key: "buttons.generic", kind: "click", candidates: ["button"] }],
        { allowPrivateHosts: true, allowHttp: true, navigationTimeoutMs: 5000, perCandidateTimeoutMs: 500, totalBudgetMs: 8000 }
      );
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.results[0].selectedSelector, "button");
      assert.equal(outcome.results[0].matchCount, 3);
    }
  );
});

test("probeSelectorCandidates leaves a target unresolved when no candidate matches", async () => {
  await withServer(
    (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><html><body><p>Nothing here</p></body></html>`);
    },
    async (baseUrl) => {
      const outcome = await probeSelectorCandidates(
        baseUrl,
        [{ key: "fields.missing", kind: "fill", candidates: ["#nope", "[name=\"nope\"]"] }],
        { allowPrivateHosts: true, allowHttp: true, navigationTimeoutMs: 5000, perCandidateTimeoutMs: 300, totalBudgetMs: 8000 }
      );
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.results[0].selectedSelector, null);
      assert.equal(outcome.results[0].matchCount, null);
      assert.deepEqual(outcome.results[0].attemptedSelectors, ["#nope", '[name="nope"]']);
    }
  );
});

test("probeSelectorCandidates fails closed (authGated) when the target path looks auth-gated, before navigating", async () => {
  let hit = false;
  await withServer(
    (_req, res) => {
      hit = true;
      res.end("should never be reached");
    },
    async (baseUrl) => {
      const outcome = await probeSelectorCandidates(
        `${baseUrl}/login`,
        [{ key: "fields.x", kind: "fill", candidates: ["input"] }],
        { allowPrivateHosts: true, allowHttp: true }
      );
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.authGated, true);
    }
  );
  assert.equal(hit, false, "server should never have received a request for an auth-gated path");
});

test("probeSelectorCandidates fails closed (authGated) on a post-navigation redirect to a login-shaped path", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/dashboard") {
        res.statusCode = 302;
        res.setHeader("Location", "/login");
        res.end();
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><html><body><p>Please sign in</p></body></html>`);
    },
    async (baseUrl) => {
      const outcome = await probeSelectorCandidates(
        `${baseUrl}/dashboard`,
        [{ key: "fields.x", kind: "fill", candidates: ["input"] }],
        { allowPrivateHosts: true, allowHttp: true, navigationTimeoutMs: 5000 }
      );
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.authGated, true);
    }
  );
});

test("probeSelectorCandidates rejects loopback/private destinations by default (SSRF guard), before launching a browser", async () => {
  const outcome = await probeSelectorCandidates(
    "http://127.0.0.1:1/whatever",
    [{ key: "fields.x", kind: "fill", candidates: ["input"] }]
    // no allowPrivateHosts override -> production default applies
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.authGated, false);
  assert.match(outcome.reason, /Destination rejected/);
});

test("probeSelectorCandidates degrades to ok:false, never throws, on navigation timeout", async () => {
  await withServer(
    (_req, res) => {
      // Never respond -> triggers a navigation timeout.
      void _req;
      void res;
    },
    async (baseUrl) => {
      const outcome = await probeSelectorCandidates(
        baseUrl,
        [{ key: "fields.x", kind: "fill", candidates: ["input"] }],
        { allowPrivateHosts: true, allowHttp: true, navigationTimeoutMs: 500, totalBudgetMs: 3000 }
      );
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.authGated, false);
      assert.match(outcome.reason, /Navigation failed/);
    }
  );
});

test("probeSelectorCandidates is observational only: a real click-tracking button is never actually clicked", async () => {
  let clicked = false;
  await withServer(
    (req, res) => {
      if (req.url === "/clicked") {
        clicked = true;
        res.end("ok");
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><html><body>
        <button id="danger" onclick="fetch('/clicked')">Delete everything</button>
      </body></html>`);
    },
    async (baseUrl) => {
      const outcome = await probeSelectorCandidates(
        baseUrl,
        [{ key: "buttons.danger", kind: "click", candidates: ["#danger"] }],
        { allowPrivateHosts: true, allowHttp: true, navigationTimeoutMs: 5000, perCandidateTimeoutMs: 500, totalBudgetMs: 8000 }
      );
      assert.equal(outcome.ok, true);
      if (!outcome.ok) return;
      assert.equal(outcome.results[0].selectedSelector, "#danger");
    }
  );
  assert.equal(clicked, false, "probing must never trigger the button's click handler");
});
