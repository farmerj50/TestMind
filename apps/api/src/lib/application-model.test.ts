import test from "node:test";
import assert from "node:assert/strict";
import {
  computeFormSignature,
  computePageSignature,
  computeApplicationModelUpdate,
  computeApiUpdate,
  computeIdentityUpdate,
  computeResourceUpdate,
  upsertTestLink,
  applyLinksTo,
  setWorkflow,
  removeWorkflow,
  normalizeApplicationModel,
  normalizeRouteHint,
  type ApplicationModelForm,
  type ApplicationModelStore,
  type ApplicationModelWorkflow,
} from "./application-model.js";

const EMPTY_V2: ApplicationModelStore = {
  version: 2,
  pages: {},
  apis: {},
  identities: {},
  resources: {},
  workflows: {},
  testLinks: {},
};

test("normalizeRouteHint collapses trailing slash, query string, and scheme+host variants to the same key", () => {
  const variants = [
    "/checkout",
    "/checkout/",
    "/checkout?utm_source=x",
    "https://www.example.com/checkout",
    "checkout",
  ];
  const normalized = variants.map(normalizeRouteHint);
  for (const n of normalized) assert.equal(n, "/checkout");
});

test("normalizeRouteHint keeps root as / and is a no-op for an already-normal path", () => {
  assert.equal(normalizeRouteHint("/"), "/");
  assert.equal(normalizeRouteHint(""), "/");
  assert.equal(normalizeRouteHint("/settings"), "/settings");
});

test("computeFormSignature is stable regardless of field order", () => {
  const a = computeFormSignature([
    { name: "email", type: "email", required: true },
    { name: "password", type: "password", required: true },
  ]);
  const b = computeFormSignature([
    { name: "password", type: "password", required: true },
    { name: "email", type: "email", required: true },
  ]);
  assert.equal(a, b);
});

test("computeFormSignature ignores selector/action (not part of its input) and changes when field metadata changes", () => {
  const base = computeFormSignature([{ name: "email", type: "email", required: true }]);
  const sameFields = computeFormSignature([{ name: "email", type: "email", required: true }]);
  const changedRequired = computeFormSignature([{ name: "email", type: "email", required: false }]);
  assert.equal(base, sameFields);
  assert.notEqual(base, changedRequired);
});

function form(selector: string, fields: Array<{ name: string; type?: string; required?: boolean }>): ApplicationModelForm {
  return { selector, fields, signature: computeFormSignature(fields) };
}

test("computePageSignature changes when a field moves from one form to another on the same page, even though total fields and form count are unchanged", () => {
  const before = computePageSignature([
    form("#login", [{ name: "email" }, { name: "password" }]),
    form("#newsletter", [{ name: "email" }]),
  ]);
  const after = computePageSignature([
    form("#login", [{ name: "email" }]),
    form("#newsletter", [{ name: "email" }, { name: "password" }]),
  ]);
  assert.notEqual(before, after, "moving a field between forms must change the page signature");
});

test("computePageSignature is stable when selectors change but field contracts don't", () => {
  const before = computePageSignature([form("#login-v1", [{ name: "email" }])]);
  const after = computePageSignature([form("#login-v2-dynamic-id-482", [{ name: "email" }])]);
  assert.equal(before, after);
});

test("normalizeApplicationModel handles null/empty/malformed input safely, defaulting to the current (v2) empty store", () => {
  assert.deepEqual(normalizeApplicationModel(null), EMPTY_V2);
  assert.deepEqual(normalizeApplicationModel(undefined), EMPTY_V2);
  assert.deepEqual(normalizeApplicationModel({}), EMPTY_V2);
  assert.deepEqual(normalizeApplicationModel("not an object"), EMPTY_V2);
});

test("normalizeApplicationModel upgrades pre-Brain v1 data (pages only) to v2, preserving pages and defaulting new fact types to empty", () => {
  const v1Shaped = {
    version: 1,
    pages: {
      "/login": {
        routeHint: "/login",
        forms: [],
        signature: "abc",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        lastChangedAt: "2026-01-01T00:00:00.000Z",
        consecutiveMisses: 0,
      },
    },
  };
  const result = normalizeApplicationModel(v1Shaped);
  assert.equal(result.version, 2);
  assert.deepEqual(result.pages, v1Shaped.pages);
  assert.deepEqual(result.apis, {});
  assert.deepEqual(result.identities, {});
  assert.deepEqual(result.resources, {});
  assert.deepEqual(result.workflows, {});
  assert.deepEqual(result.testLinks, {});
});

test("normalizeApplicationModel round-trips an already-v2-shaped store unchanged", () => {
  const v2Shaped: ApplicationModelStore = {
    ...EMPTY_V2,
    apis: { "GET /api/x": { method: "GET", path: "/api/x", signature: "s", firstSeenAt: "t", lastSeenAt: "t", lastChangedAt: "t", consecutiveMisses: 0 } },
  };
  assert.deepEqual(normalizeApplicationModel(v2Shaped), v2Shaped);
});

test("computeApplicationModelUpdate classifies a page as new on first observation", () => {
  const { next, diff } = computeApplicationModelUpdate(
    EMPTY_V2,
    { "/login": [{ selector: "#login", fields: [{ name: "email" }] }] },
    "2026-01-01T00:00:00.000Z"
  );
  assert.deepEqual(diff, { newPages: ["/login"], changedPages: [], unchangedPages: [], missingPages: [] });
  const page = next.pages["/login"];
  assert.equal(page.firstSeenAt, "2026-01-01T00:00:00.000Z");
  assert.equal(page.lastSeenAt, "2026-01-01T00:00:00.000Z");
  assert.equal(page.lastChangedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(page.consecutiveMisses, 0);
  assert.equal(next.version, 2);
});

test("computeApplicationModelUpdate classifies unchanged vs changed on a second cycle", () => {
  const cycle1 = computeApplicationModelUpdate(
    EMPTY_V2,
    { "/login": [{ selector: "#login", fields: [{ name: "email" }] }] },
    "2026-01-01T00:00:00.000Z"
  );

  const cycle2Unchanged = computeApplicationModelUpdate(
    cycle1.next,
    { "/login": [{ selector: "#login-new-dom-id", fields: [{ name: "email" }] }] },
    "2026-01-02T00:00:00.000Z"
  );
  assert.deepEqual(cycle2Unchanged.diff, { newPages: [], changedPages: [], unchangedPages: ["/login"], missingPages: [] });
  assert.equal(cycle2Unchanged.next.pages["/login"].lastSeenAt, "2026-01-02T00:00:00.000Z");
  assert.equal(cycle2Unchanged.next.pages["/login"].lastChangedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(cycle2Unchanged.next.pages["/login"].firstSeenAt, "2026-01-01T00:00:00.000Z");

  const cycle2Changed = computeApplicationModelUpdate(
    cycle1.next,
    { "/login": [{ selector: "#login", fields: [{ name: "email" }, { name: "password", required: true }] }] },
    "2026-01-02T00:00:00.000Z"
  );
  assert.deepEqual(cycle2Changed.diff, { newPages: [], changedPages: ["/login"], unchangedPages: [], missingPages: [] });
  assert.equal(cycle2Changed.next.pages["/login"].lastChangedAt, "2026-01-02T00:00:00.000Z");
});

test("computeApplicationModelUpdate never deletes a page absent from this cycle - tracks consecutiveMisses instead", () => {
  const cycle1 = computeApplicationModelUpdate(
    EMPTY_V2,
    {
      "/checkout": [{ selector: "#checkout", fields: [{ name: "cardNumber" }] }],
      "/settings": [{ selector: "#settings", fields: [{ name: "displayName" }] }],
    },
    "2026-01-01T00:00:00.000Z"
  );

  // /settings not observed this cycle
  const cycle2 = computeApplicationModelUpdate(
    cycle1.next,
    { "/checkout": [{ selector: "#checkout", fields: [{ name: "cardNumber" }] }] },
    "2026-01-02T00:00:00.000Z"
  );
  assert.deepEqual(cycle2.diff.missingPages, ["/settings"]);
  assert.ok("/settings" in cycle2.next.pages, "/settings must still be present in the store, not deleted");
  assert.equal(cycle2.next.pages["/settings"].consecutiveMisses, 1);

  // still not observed a second time - miss count keeps rising
  const cycle3 = computeApplicationModelUpdate(
    cycle2.next,
    { "/checkout": [{ selector: "#checkout", fields: [{ name: "cardNumber" }] }] },
    "2026-01-03T00:00:00.000Z"
  );
  assert.equal(cycle3.next.pages["/settings"].consecutiveMisses, 2);

  // reappears - miss count resets to 0
  const cycle4 = computeApplicationModelUpdate(
    cycle3.next,
    {
      "/checkout": [{ selector: "#checkout", fields: [{ name: "cardNumber" }] }],
      "/settings": [{ selector: "#settings", fields: [{ name: "displayName" }] }],
    },
    "2026-01-04T00:00:00.000Z"
  );
  assert.equal(cycle4.next.pages["/settings"].consecutiveMisses, 0);
  assert.deepEqual(cycle4.diff.missingPages, []);
});

test("computeApplicationModelUpdate merge never clobbers unrelated pages", () => {
  const cycle1 = computeApplicationModelUpdate(
    EMPTY_V2,
    {
      "/a": [{ selector: "#a", fields: [{ name: "x" }] }],
      "/b": [{ selector: "#b", fields: [{ name: "y" }] }],
    },
    "2026-01-01T00:00:00.000Z"
  );
  const cycle2 = computeApplicationModelUpdate(
    cycle1.next,
    {
      "/a": [{ selector: "#a", fields: [{ name: "x" }, { name: "z" }] }],
      "/b": [{ selector: "#b", fields: [{ name: "y" }] }], // observed again, unchanged
    },
    "2026-01-02T00:00:00.000Z"
  );
  // /b untouched by /a's change (still observed, still unchanged -> lastSeenAt advances but
  // nothing else about it differs)
  assert.equal(cycle2.next.pages["/b"].signature, cycle1.next.pages["/b"].signature);
  assert.equal(cycle2.next.pages["/b"].lastChangedAt, cycle1.next.pages["/b"].lastChangedAt);
  assert.equal(cycle2.next.pages["/b"].consecutiveMisses, 0);
  assert.ok(!cycle2.diff.changedPages.includes("/b"));
});

test("computeApplicationModelUpdate bootstraps correctly from an empty/undefined store", () => {
  const { next, diff } = computeApplicationModelUpdate(
    normalizeApplicationModel(undefined),
    { "/home": [{ selector: "#search", fields: [{ name: "q" }] }] },
    "2026-01-01T00:00:00.000Z"
  );
  assert.equal(Object.keys(next.pages).length, 1);
  assert.deepEqual(diff.newPages, ["/home"]);
});

test("computeApplicationModelUpdate preserves apis/identities/resources/workflows/testLinks untouched (pages merge is additive, not a replace)", () => {
  const seeded: ApplicationModelStore = {
    ...EMPTY_V2,
    apis: { "GET /x": { method: "GET", path: "/x", signature: "s", firstSeenAt: "t", lastSeenAt: "t", lastChangedAt: "t", consecutiveMisses: 0 } },
    workflows: { checkout: { name: "checkout", riskTags: ["critical"], routeHints: ["/cart"], apiHints: [] } },
  };
  const { next } = computeApplicationModelUpdate(seeded, { "/login": [{ selector: "#login", fields: [] }] }, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(next.apis, seeded.apis);
  assert.deepEqual(next.workflows, seeded.workflows);
});

test("applyLinksTo sets a page's navigation adjacency, last-observed-only (replaces, not merges)", () => {
  const { next } = computeApplicationModelUpdate(EMPTY_V2, { "/home": [{ selector: "#s", fields: [] }] }, "2026-01-01T00:00:00.000Z");
  const withLinks = applyLinksTo(next, "/home", ["/about", "/contact"]);
  assert.deepEqual(withLinks.pages["/home"].linksTo, ["/about", "/contact"]);

  const replaced = applyLinksTo(withLinks, "/home", ["/pricing"]);
  assert.deepEqual(replaced.pages["/home"].linksTo, ["/pricing"], "linksTo replaces, it doesn't accumulate the prior links");
});

test("applyLinksTo is a no-op for a page the store hasn't seen yet", () => {
  const result = applyLinksTo(EMPTY_V2, "/unknown", ["/x"]);
  assert.deepEqual(result, EMPTY_V2);
});

test("computeApiUpdate tracks new/unchanged/missing APIs with the same never-delete semantics as pages", () => {
  const cycle1 = computeApiUpdate(EMPTY_V2, { "GET /api/orders": { method: "GET", path: "/api/orders" } }, "2026-01-01T00:00:00.000Z");
  assert.equal(cycle1.apis["GET /api/orders"].consecutiveMisses, 0);
  assert.equal(cycle1.apis["GET /api/orders"].firstSeenAt, "2026-01-01T00:00:00.000Z");

  const cycle2 = computeApiUpdate(cycle1, {}, "2026-01-02T00:00:00.000Z");
  assert.equal(cycle2.apis["GET /api/orders"].consecutiveMisses, 1, "missing APIs are tracked, not deleted");

  const cycle3 = computeApiUpdate(cycle2, { "GET /api/orders": { method: "GET", path: "/api/orders" } }, "2026-01-03T00:00:00.000Z");
  assert.equal(cycle3.apis["GET /api/orders"].consecutiveMisses, 0, "reappearing resets the miss count");
});

test("computeIdentityUpdate tracks observed role labels", () => {
  const result = computeIdentityUpdate(EMPTY_V2, { admin: { role: "admin" }, user: { role: "user" } }, "2026-01-01T00:00:00.000Z");
  assert.equal(Object.keys(result.identities).length, 2);
  assert.equal(result.identities.admin.role, "admin");
});

test("computeResourceUpdate tracks a resource's changed routeHints/apiHints as a signature change", () => {
  const cycle1 = computeResourceUpdate(
    EMPTY_V2,
    { order: { name: "order", routeHints: ["/orders"], apiHints: [] } },
    "2026-01-01T00:00:00.000Z"
  );
  const cycle2Unchanged = computeResourceUpdate(
    cycle1,
    { order: { name: "order", routeHints: ["/orders"], apiHints: [] } },
    "2026-01-02T00:00:00.000Z"
  );
  assert.equal(cycle2Unchanged.resources.order.lastChangedAt, "2026-01-01T00:00:00.000Z", "unchanged routeHints/apiHints shouldn't bump lastChangedAt");

  const cycle2Changed = computeResourceUpdate(
    cycle1,
    { order: { name: "order", routeHints: ["/orders", "/orders/:id"], apiHints: [] } },
    "2026-01-02T00:00:00.000Z"
  );
  assert.equal(cycle2Changed.resources.order.lastChangedAt, "2026-01-02T00:00:00.000Z");
});

test("upsertTestLink creates a link on first observation and preserves firstSeenAt while bumping lastSeenAt on re-observation", () => {
  const cycle1 = upsertTestLink(EMPTY_V2, "case-1", "/checkout", "2026-01-01T00:00:00.000Z");
  assert.deepEqual(cycle1.testLinks["case-1"], {
    testCaseId: "case-1",
    routeHint: "/checkout",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
  });

  const cycle2 = upsertTestLink(cycle1, "case-1", "/checkout", "2026-01-05T00:00:00.000Z");
  assert.equal(cycle2.testLinks["case-1"].firstSeenAt, "2026-01-01T00:00:00.000Z", "firstSeenAt must not change on re-observation");
  assert.equal(cycle2.testLinks["case-1"].lastSeenAt, "2026-01-05T00:00:00.000Z");
});

test("upsertTestLink never clobbers unrelated links", () => {
  const cycle1 = upsertTestLink(EMPTY_V2, "case-1", "/a", "2026-01-01T00:00:00.000Z");
  const cycle2 = upsertTestLink(cycle1, "case-2", "/b", "2026-01-02T00:00:00.000Z");
  assert.ok(cycle2.testLinks["case-1"]);
  assert.ok(cycle2.testLinks["case-2"]);
});

test("setWorkflow adds a workflow under the given key and never clobbers unrelated workflows", () => {
  const checkout: ApplicationModelWorkflow = { name: "Checkout", riskTags: ["critical"], routeHints: ["/cart", "/checkout"], apiHints: ["POST /api/orders"] };
  const cycle1 = setWorkflow(EMPTY_V2, "checkout", checkout);
  assert.deepEqual(cycle1.workflows.checkout, checkout);

  const signup: ApplicationModelWorkflow = { name: "Signup", riskTags: [], routeHints: ["/signup"], apiHints: [] };
  const cycle2 = setWorkflow(cycle1, "signup", signup);
  assert.deepEqual(cycle2.workflows.checkout, checkout, "adding a second workflow must not disturb the first");
  assert.deepEqual(cycle2.workflows.signup, signup);
});

test("setWorkflow replaces an existing entry at the same key (an edit, not an accumulation)", () => {
  const original: ApplicationModelWorkflow = { name: "Checkout", riskTags: [], routeHints: ["/cart"], apiHints: [] };
  const cycle1 = setWorkflow(EMPTY_V2, "checkout", original);
  const edited: ApplicationModelWorkflow = { name: "Checkout", riskTags: ["critical"], routeHints: ["/cart", "/checkout"], apiHints: [] };
  const cycle2 = setWorkflow(cycle1, "checkout", edited);
  assert.deepEqual(cycle2.workflows.checkout, edited);
});

test("removeWorkflow deletes the entry at the given key and never clobbers unrelated workflows", () => {
  const cycle1 = setWorkflow(EMPTY_V2, "checkout", { name: "Checkout", riskTags: [], routeHints: [], apiHints: [] });
  const cycle2 = setWorkflow(cycle1, "signup", { name: "Signup", riskTags: [], routeHints: [], apiHints: [] });
  const cycle3 = removeWorkflow(cycle2, "checkout");
  assert.ok(!("checkout" in cycle3.workflows));
  assert.ok("signup" in cycle3.workflows);
});

test("removeWorkflow is a no-op for a key that doesn't exist", () => {
  const result = removeWorkflow(EMPTY_V2, "does-not-exist");
  assert.deepEqual(result, EMPTY_V2);
});
