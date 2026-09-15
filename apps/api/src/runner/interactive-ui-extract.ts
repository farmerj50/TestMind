// Interactive UI Testing v1. DOM/state extraction for the observe step of the agent loop
// (interactive-ui-agent.ts). Adapts the page.evaluate() + data-testmind-auto-id tagging style
// already proven in live-security-session.ts's collectSafeClickTargets/collectSafeSearchTargets
// (same tagging trick: a guaranteed-unique attribute selector for the chosen action, never a
// guessed CSS path) - a new module rather than importing those directly because this loop needs
// richer per-element context (nearby/modal text, href) that the automated site-walk's collectors
// don't gather, since only THIS loop needs to build the combined action-effect danger signal
// (see isDangerousSignal in lib/safe-interaction-patterns.ts).
//
// IMPORTANT: every page.evaluate() callback below computes its per-node values as plain inline
// expressions (data bindings), never through a nested `const helper = (...) => {...}` /
// `function helper() {}` definition. tsx's esbuild transform runs with keepNames: true, which
// wraps every such nested named function value in a `__name(...)` call at the point it's
// defined; page.evaluate() extracts the callback's source text and re-runs it inside an isolated
// browser realm that has no `__name` global, so any nested named function throws
// "ReferenceError: __name is not defined" the moment it's ever called - silently, since these
// calls are always wrapped in a .catch() fallback. Confirmed via a minimal reproduction before
// writing this file this way; do not reintroduce a nested named function/arrow into any of these
// callbacks without re-verifying against a real page first.
import type { Page } from "patchright";
import { isDangerousSignal } from "../lib/safe-interaction-patterns.js";

const MAX_ELEMENTS_PER_TURN = 60;
const MAX_FORM_FIELDS_PER_TURN = 30;

export type InteractiveElementCandidate = {
  selector: string;
  fingerprint: string;
  tag: string;
  label: string;
  ariaLabel: string;
  title: string;
  href: string;
  // Text drawn from the element's immediate surroundings (parent's innerText, truncated) - not
  // the element's own label. Needed so a plain "Confirm" button inside a "Delete workspace
  // permanently" modal is still caught by the combined danger-signal check.
  nearbyText: string;
  // innerText of the nearest enclosing [role=dialog]/[role=alertdialog]/[aria-modal=true]/.modal
  // ancestor, empty string if the element isn't inside one.
  modalText: string;
};

export type FormFieldCandidate = {
  selector: string;
  fingerprint: string;
  label: string;
  type: string;
  required: boolean;
  value: string;
};

export type PageSummary = {
  url: string;
  title: string;
  headingText: string;
  bodyTextSnippet: string;
};

export type CompactPageState = {
  route: string;
  // Best-effort heuristic only (presence of a logout/sign-out-labeled control on the page) -
  // this is not an authoritative auth check, just enough signal to feed the decision prompt's
  // history/coverage context. Never used for any safety decision.
  authenticated: boolean;
  modal: string | null;
  visibleForm: string | null;
  selectedTab: string | null;
};

export async function collectInteractiveElements(page: Page): Promise<InteractiveElementCandidate[]> {
  const rawTargets = await page
    .evaluate(() => {
      const doc = (globalThis as any).document;
      const win = (globalThis as any).window;

      const nodes = Array.from(
        doc.querySelectorAll(
          [
            "a[href]",
            "button",
            "[role='button']",
            "[role='tab']",
            "[role='menuitem']",
            "[aria-controls]",
            "summary",
            "[data-testid]",
            "[data-test]",
          ].join(",")
        )
      );
      const targets: InteractiveElementCandidate[] = [];
      const seen = new Set<string>();
      nodes.forEach((node: any, index) => {
        if (targets.length >= 60) return;

        const rect = node.getBoundingClientRect?.();
        const style = win.getComputedStyle?.(node);
        const isVisible = Boolean(rect && rect.width > 4 && rect.height > 4 && style?.visibility !== "hidden" && style?.display !== "none");
        if (!isVisible) return;
        if (node.closest?.("[data-tm-ignore], [disabled], [aria-disabled='true']")) return;

        const tag = String(node.tagName || "").toLowerCase();
        const label = String(
          node.innerText ||
            node.getAttribute?.("aria-label") ||
            node.getAttribute?.("title") ||
            node.getAttribute?.("data-testid") ||
            node.id ||
            node.className ||
            ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);
        const ariaLabel = String(node.getAttribute?.("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 120);
        const title = String(node.getAttribute?.("title") || "").replace(/\s+/g, " ").trim().slice(0, 120);
        const href = String(node.getAttribute?.("href") || "");
        if (!label && !ariaLabel && !node.getAttribute?.("aria-controls") && !node.getAttribute?.("data-testid")) return;

        const fingerprint = `${win.location.pathname}|${tag}|${label}|${node.getAttribute?.("role") || ""}|${
          node.getAttribute?.("data-testid") || node.id || index
        }`;
        if (seen.has(fingerprint)) return;
        seen.add(fingerprint);

        const modalAncestor = node.closest?.('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal');
        const modalText = modalAncestor ? String(modalAncestor.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300) : "";
        const nearbyText = String(node.parentElement?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200);

        const id = `tm-auto-ui-${Date.now()}-${index}`;
        node.setAttribute("data-testmind-auto-id", id);
        targets.push({
          selector: `[data-testmind-auto-id="${id}"]`,
          fingerprint,
          tag,
          label: label || tag,
          ariaLabel,
          title,
          href,
          nearbyText,
          modalText,
        });
      });
      return targets;
    })
    .catch((err: any) => {
      console.warn(`[interactive-ui-extract] collectInteractiveElements failed:`, err?.message ?? err);
      return [] as InteractiveElementCandidate[];
    });

  return rawTargets.slice(0, MAX_ELEMENTS_PER_TURN);
}

export async function collectFormFields(page: Page): Promise<FormFieldCandidate[]> {
  const rawFields = await page
    .evaluate(() => {
      const doc = (globalThis as any).document;
      const win = (globalThis as any).window;

      const nodes = Array.from(doc.querySelectorAll("input, textarea, select, [role='textbox']"));
      const fields: FormFieldCandidate[] = [];
      nodes.forEach((node: any, index) => {
        if (fields.length >= 30) return;

        const rect = node.getBoundingClientRect?.();
        const style = win.getComputedStyle?.(node);
        const isVisible = Boolean(rect && rect.width > 20 && rect.height > 8 && style?.visibility !== "hidden" && style?.display !== "none");
        if (!isVisible) return;
        if (node.disabled || node.readOnly || node.closest?.("[disabled], [aria-disabled='true']")) return;

        const type = String(node.getAttribute?.("type") || node.tagName?.toLowerCase() || "text").toLowerCase();
        if (["hidden", "submit", "reset", "button", "image"].includes(type)) return;

        const label = String(
          node.getAttribute?.("placeholder") ||
            node.getAttribute?.("aria-label") ||
            node.getAttribute?.("name") ||
            node.id ||
            node.closest?.("label")?.innerText ||
            ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);

        const fingerprint = `${win.location.pathname}|field|${type}|${label}|${node.getAttribute?.("name") || node.id || index}`;
        const id = `tm-auto-ui-field-${Date.now()}-${index}`;
        node.setAttribute("data-testmind-auto-id", id);
        fields.push({
          selector: `[data-testmind-auto-id="${id}"]`,
          fingerprint,
          label: label || type,
          type,
          required: Boolean(node.required),
          value: String(node.value ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
        });
      });
      return fields;
    })
    .catch((err: any) => {
      console.warn(`[interactive-ui-extract] collectFormFields failed:`, err?.message ?? err);
      return [] as FormFieldCandidate[];
    });

  return rawFields.slice(0, MAX_FORM_FIELDS_PER_TURN);
}

export async function collectPageSummary(page: Page): Promise<PageSummary> {
  return page
    .evaluate(() => {
      const doc = (globalThis as any).document;
      const win = (globalThis as any).window;
      const heading = doc.querySelector("h1, h2, [role='heading']");
      return {
        url: String(win.location.href || ""),
        title: String(doc.title || "").replace(/\s+/g, " ").trim().slice(0, 200),
        headingText: String(heading?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 150),
        bodyTextSnippet: String(doc.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 500),
      };
    })
    .catch((err: any) => {
      console.warn(`[interactive-ui-extract] collectPageSummary failed:`, err?.message ?? err);
      return { url: page.url(), title: "", headingText: "", bodyTextSnippet: "" };
    });
}

export async function collectCompactState(page: Page): Promise<CompactPageState> {
  return page
    .evaluate(() => {
      const doc = (globalThis as any).document;
      const win = (globalThis as any).window;
      const modal = doc.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal');
      const visibleForm = doc.querySelector("form");
      const selectedTab = doc.querySelector("[role='tab'][aria-selected='true'], [role='tab'].active");
      const logoutLike = Array.from(doc.querySelectorAll("a, button")).some(
        (el: any) => /\b(log ?out|sign ?out)\b/i.test(el.innerText || el.getAttribute?.("aria-label") || "")
      );
      return {
        route: String(win.location.pathname || "/"),
        authenticated: logoutLike,
        modal: modal
          ? String(modal.getAttribute("aria-label") || modal.innerText || "modal").replace(/\s+/g, " ").trim().slice(0, 80)
          : null,
        visibleForm: visibleForm
          ? String(visibleForm.getAttribute("aria-label") || visibleForm.getAttribute("name") || "form")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 80)
          : null,
        selectedTab: selectedTab ? String(selectedTab.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60) : null,
      };
    })
    .catch((err: any) => {
      console.warn(`[interactive-ui-extract] collectCompactState failed:`, err?.message ?? err);
      return { route: "/", authenticated: false, modal: null, visibleForm: null, selectedTab: null };
    });
}

// Combines an element's own text with its surrounding context (nearby text, enclosing modal
// text, href) and the current route into one signal for the shared denylist check - a plain
// dangerous label on the element itself is not the only thing that must trip this; a "Confirm"
// button inside a "Delete workspace permanently" modal must too.
export function collectActionEffectContext(target: InteractiveElementCandidate, currentRoute: string): string {
  return [target.label, target.ariaLabel, target.title, target.href, target.nearbyText, target.modalText, currentRoute].join(" ");
}

export function isElementActionDangerous(target: InteractiveElementCandidate, currentRoute: string): boolean {
  return isDangerousSignal(collectActionEffectContext(target, currentRoute));
}
