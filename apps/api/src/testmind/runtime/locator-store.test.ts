import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSharedSteps, resolveLocator, type LocatorStore } from "./locator-store.js";

test("resolveLocator exposes attempted selectors in deterministic order", () => {
  const store = normalizeSharedSteps({
    pages: {
      "/login": {
        buttons: {
          submit: "[data-testid='wrong-submit']",
        },
      },
    },
    locatorFallbacks: {
      "/login": {
        buttons: {
          submit: {
            primary: "[data-testid='submit-primary']",
            fallbacks: ["button[type='submit']", "button:has-text('Sign in')"],
            metadata: {
              urlPattern: "/login",
            },
          },
        },
      },
    },
  });

  const resolved = resolveLocator(store, "/login", "buttons", "submit");
  assert.equal(resolved.selector, "[data-testid='wrong-submit']");
  assert.deepEqual(resolved.attemptedSelectors, [
    "[data-testid='wrong-submit']",
    "[data-testid='submit-primary']",
    "button[type='submit']",
    "button:has-text('Sign in')",
  ]);
  assert.equal(resolved.identityMatched, true);
});

test("resolveLocator fails fast with IDENTITY mismatch when constrained metadata does not match", () => {
  const store: LocatorStore = normalizeSharedSteps({
    pages: {
      "/login": {
        locators: {
          pageIdentity: "[data-testid='login-page']",
        },
        buttons: {
          submit: "[data-testid='submit']",
        },
      },
    },
    locatorFallbacks: {
      "/login": {
        buttons: {
          submit: {
            primary: "[data-testid='submit']",
            fallbacks: ["button[type='submit']"],
            metadata: {
              urlPattern: "/checkout",
              uniqueAnchor: "[data-testid='checkout-page']",
            },
          },
        },
      },
    },
  });

  const resolved = resolveLocator(store, "/login", "buttons", "submit");
  assert.equal(resolved.selector, undefined);
  assert.equal(resolved.identityMatched, false);
  assert.deepEqual(resolved.attemptedSelectors, []);
  assert.deepEqual(resolved.expectedIdentity, {
    urlPattern: "/checkout",
    uniqueAnchor: "[data-testid='checkout-page']",
  });
  assert.equal(resolved.actualPath, "/login");
});

