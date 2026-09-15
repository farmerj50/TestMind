import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "patchright";
import {
  collectInteractiveElements,
  collectFormFields,
  collectPageSummary,
  collectCompactState,
  isElementActionDangerous,
} from "./interactive-ui-extract.js";

async function withFixturePage(html: string, run: (page: any) => Promise<void>) {
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
    await run(page);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

test("collectInteractiveElements finds visible buttons/links and tags them uniquely", async () => {
  await withFixturePage(
    `<!doctype html><html><body>
      <a href="/settings">Settings</a>
      <button>Save changes</button>
      <button style="display:none">Hidden button</button>
    </body></html>`,
    async (page) => {
      const elements = await collectInteractiveElements(page);
      const labels = elements.map((e) => e.label);
      assert.ok(labels.includes("Settings"));
      assert.ok(labels.includes("Save changes"));
      assert.ok(!labels.includes("Hidden button"), "hidden elements must not be collected");
      for (const el of elements) {
        assert.match(el.selector, /^\[data-testmind-auto-id="tm-auto-ui-\d+-\d+"\]$/);
      }
    }
  );
});

test("collectFormFields excludes disabled/readonly/hidden inputs and captures required", async () => {
  await withFixturePage(
    `<!doctype html><html><body>
      <form>
        <input name="email" placeholder="Email" required />
        <input name="disabled-field" placeholder="Disabled" disabled />
        <input name="hidden-field" type="hidden" value="secret" />
        <textarea name="notes" placeholder="Notes"></textarea>
      </form>
    </body></html>`,
    async (page) => {
      const fields = await collectFormFields(page);
      const byLabel = Object.fromEntries(fields.map((f) => [f.label, f]));
      assert.ok(byLabel["Email"]);
      assert.equal(byLabel["Email"].required, true);
      assert.ok(byLabel["Notes"]);
      assert.ok(!byLabel["Disabled"], "disabled fields must be excluded");
      assert.ok(!fields.some((f) => f.type === "hidden"), "hidden inputs must be excluded");
    }
  );
});

test("collectPageSummary reports title, heading, and a body snippet", async () => {
  await withFixturePage(
    `<!doctype html><html><head><title>Account Settings</title></head><body>
      <h1>Your Account</h1>
      <p>Manage your profile and preferences.</p>
    </body></html>`,
    async (page) => {
      const summary = await collectPageSummary(page);
      assert.equal(summary.title, "Account Settings");
      assert.equal(summary.headingText, "Your Account");
      assert.match(summary.bodyTextSnippet, /Manage your profile/);
    }
  );
});

test("collectCompactState detects an open modal and a logout-shaped authenticated signal", async () => {
  await withFixturePage(
    `<!doctype html><html><body>
      <a href="/logout">Log out</a>
      <div role="dialog" aria-label="Confirm delete">Are you sure?</div>
      <form name="profile-form"></form>
    </body></html>`,
    async (page) => {
      const state = await collectCompactState(page);
      assert.equal(state.authenticated, true);
      assert.equal(state.modal, "Confirm delete");
      assert.equal(state.visibleForm, "profile-form");
    }
  );
});

test("collectCompactState reports no modal/authenticated signal on a plain logged-out page", async () => {
  await withFixturePage(`<!doctype html><html><body><p>Welcome, please sign in.</p></body></html>`, async (page) => {
    const state = await collectCompactState(page);
    assert.equal(state.authenticated, false);
    assert.equal(state.modal, null);
  });
});

// Regression test for the exact false-negative scenario raised in review: a button whose own
// label is completely benign ("Confirm") sits inside a modal whose surrounding text is clearly
// destructive ("Delete workspace permanently"). Filtering on the element's own label/aria-label
// alone would miss this - the combined action-effect signal (which includes modalText) must not.
test("isElementActionDangerous catches a benign-labeled button inside a destructive-text modal", async () => {
  await withFixturePage(
    `<!doctype html><html><body>
      <div role="dialog" aria-label="Delete workspace">
        <p>This will delete workspace permanently. This cannot be undone.</p>
        <button>Confirm</button>
      </div>
    </body></html>`,
    async (page) => {
      const elements = await collectInteractiveElements(page);
      const confirmButton = elements.find((e) => e.label === "Confirm");
      assert.ok(confirmButton, "the Confirm button must be collected");
      assert.match(confirmButton!.modalText, /delete workspace permanently/i);
      assert.equal(isElementActionDangerous(confirmButton!, "/settings"), true);
    }
  );
});

test("isElementActionDangerous does not flag an ordinary, non-destructive control", async () => {
  await withFixturePage(
    `<!doctype html><html><body>
      <button>View profile</button>
    </body></html>`,
    async (page) => {
      const elements = await collectInteractiveElements(page);
      const viewButton = elements.find((e) => e.label === "View profile");
      assert.ok(viewButton);
      assert.equal(isElementActionDangerous(viewButton!, "/dashboard"), false);
    }
  );
});
