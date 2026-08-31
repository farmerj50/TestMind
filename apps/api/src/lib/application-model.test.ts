import test from "node:test";
import assert from "node:assert/strict";
import {
  computeFormSignature,
  computePageSignature,
  computeApplicationModelUpdate,
  normalizeApplicationModel,
  normalizeRouteHint,
  type ApplicationModelForm,
} from "./application-model.js";

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

test("normalizeApplicationModel handles null/empty/malformed input safely", () => {
  assert.deepEqual(normalizeApplicationModel(null), { version: 1, pages: {} });
  assert.deepEqual(normalizeApplicationModel(undefined), { version: 1, pages: {} });
  assert.deepEqual(normalizeApplicationModel({}), { version: 1, pages: {} });
  assert.deepEqual(normalizeApplicationModel("not an object"), { version: 1, pages: {} });
});

test("computeApplicationModelUpdate classifies a page as new on first observation", () => {
  const { next, diff } = computeApplicationModelUpdate(
    { version: 1, pages: {} },
    { "/login": [{ selector: "#login", fields: [{ name: "email" }] }] },
    "2026-01-01T00:00:00.000Z"
  );
  assert.deepEqual(diff, { newPages: ["/login"], changedPages: [], unchangedPages: [], missingPages: [] });
  const page = next.pages["/login"];
  assert.equal(page.firstSeenAt, "2026-01-01T00:00:00.000Z");
  assert.equal(page.lastSeenAt, "2026-01-01T00:00:00.000Z");
  assert.equal(page.lastChangedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(page.consecutiveMisses, 0);
});

test("computeApplicationModelUpdate classifies unchanged vs changed on a second cycle", () => {
  const cycle1 = computeApplicationModelUpdate(
    { version: 1, pages: {} },
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
    { version: 1, pages: {} },
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
    { version: 1, pages: {} },
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
