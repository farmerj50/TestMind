// apps/api/src/lib/application-model.ts
//
// Project Memory foundation, Phase 1: a typed, versioned store of discovery-derived
// application-model facts (forms/fields per page), persisted separately from sharedSteps
// (locator resolution knowledge, a different concern with a different lifecycle - see the
// plan). Pure logic only, no Prisma import - this module has exactly one call site
// (runDiscoveryJob), which already holds the Project row and already does one
// prisma.project.update in the same function body; a separate I/O wrapper would be
// premature abstraction for a single caller (see lib/locator-promotion.ts for the pattern
// this follows when a module DOES have multiple call sites).
import { createHash } from "node:crypto";

export type ApplicationModelFieldMeta = {
  name: string;
  type?: string;
  required?: boolean;
  pattern?: string;
  label?: string;
};

export type ApplicationModelForm = {
  selector: string;
  action?: string;
  fields: ApplicationModelFieldMeta[];
  /** Per-form identity. See computeFormSignature. */
  signature: string;
};

export type ApplicationModelPage = {
  routeHint: string;
  forms: ApplicationModelForm[];
  /**
   * Per-page identity, derived from the collection of form signatures (see
   * computePageSignature) - NOT a flattened hash of all fields across all forms. A field
   * moving from one form to another on the same page changes the page signature even when
   * the total field set and form count on the page are unchanged.
   */
  signature: string;
  /** ISO. Set once, on first observation. */
  firstSeenAt: string;
  /** ISO. Updated only when this page IS observed in a discovery run. */
  lastSeenAt: string;
  /** ISO. Updated only when signature changes. */
  lastChangedAt: string;
  /**
   * Incremented when a previously-known page is NOT observed in a discovery run, reset to 0
   * when it's observed again. Pages are never deleted from the store on a miss -
   * disappearance is represented as data (rising consecutiveMisses), not erasure, so a later
   * "is this route actually gone vs. transiently unreachable" decision (a future autonomous-
   * rediscovery phase) has real historical data to reason from.
   */
  consecutiveMisses: number;
};

export type ApplicationModelStore = {
  version: 1;
  pages: Record<string, ApplicationModelPage>;
};

export type ApplicationModelDiff = {
  newPages: string[];
  changedPages: string[];
  unchangedPages: string[];
  /** Previously known pages not observed this run. */
  missingPages: string[];
};

const EMPTY_STORE: ApplicationModelStore = { version: 1, pages: {} };

export function normalizeApplicationModel(raw: unknown): ApplicationModelStore {
  if (!raw || typeof raw !== "object") return { version: 1, pages: {} };
  const candidate = raw as Partial<ApplicationModelStore>;
  const pages = candidate.pages && typeof candidate.pages === "object" ? candidate.pages : {};
  return { version: 1, pages: pages as Record<string, ApplicationModelPage> };
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function stableFieldKey(f: ApplicationModelFieldMeta): string {
  return JSON.stringify([f.name, f.type ?? "", f.required ?? false, f.pattern ?? "", f.label ?? ""]);
}

/**
 * Per-form identity: sha1 over fields sorted by name, keyed on
 * {name,type,required,pattern,label}. Deliberately excludes selector/action - those are
 * volatile (dynamic ids, virtualization) and would make every page look "changed" even when
 * the form's actual field contract is stable.
 */
export function computeFormSignature(fields: ApplicationModelFieldMeta[]): string {
  const sorted = [...fields].sort((a, b) => a.name.localeCompare(b.name));
  return sha1(sorted.map(stableFieldKey).join("|"));
}

/**
 * Per-page identity: sha1 over each form's own signature, keyed by its POSITION in `forms`
 * (DOM/scan order) - deliberately NOT sorted. Sorting the per-form signatures before hashing
 * would discard which form has which fields (a swap between two forms on the same page
 * would leave the same *multiset* of form signatures, so a sorted hash can't tell them
 * apart - this was caught by review before shipping). Keying by position instead of by the
 * volatile `selector` still avoids selector/DOM-id churn causing false "changed" signals,
 * while actually detecting "a field moved from the login form to the newsletter form" even
 * when the page's total field collection and form count are unchanged.
 *
 * Trade-off, accepted deliberately: if discoverSite ever returns the same page's forms in a
 * different array order between scans with no real structural change, this reads as a
 * change. Forms are extracted in document order, which is expected to be stable for a given
 * static page far more often than selector/DOM-id values are - the same reasoning that
 * already justifies excluding selector/action from form identity.
 */
export function computePageSignature(forms: ApplicationModelForm[]): string {
  return sha1(forms.map((f, i) => `${i}:${f.signature}`).join("|"));
}

function buildForm(raw: { selector: string; action?: string; fields: ApplicationModelFieldMeta[] }): ApplicationModelForm {
  return {
    selector: raw.selector,
    action: raw.action,
    fields: raw.fields,
    signature: computeFormSignature(raw.fields),
  };
}

/**
 * Given the current store and this discovery cycle's forms (grouped by routeHint), returns
 * the next store plus a diff. Pure - no I/O. Pages absent from `incoming` are treated as
 * missed, never removed.
 */
export function computeApplicationModelUpdate(
  current: ApplicationModelStore,
  incoming: Record<string, Array<{ selector: string; action?: string; fields: ApplicationModelFieldMeta[] }>>,
  discoveredAt: string
): { next: ApplicationModelStore; diff: ApplicationModelDiff } {
  const base = normalizeApplicationModel(current ?? EMPTY_STORE);
  const nextPages: Record<string, ApplicationModelPage> = { ...base.pages };
  const diff: ApplicationModelDiff = { newPages: [], changedPages: [], unchangedPages: [], missingPages: [] };

  const observedRoutes = new Set(Object.keys(incoming));

  for (const [routeHint, rawForms] of Object.entries(incoming)) {
    const forms = rawForms.map(buildForm);
    const signature = computePageSignature(forms);
    const prior = base.pages[routeHint];

    if (!prior) {
      nextPages[routeHint] = {
        routeHint,
        forms,
        signature,
        firstSeenAt: discoveredAt,
        lastSeenAt: discoveredAt,
        lastChangedAt: discoveredAt,
        consecutiveMisses: 0,
      };
      diff.newPages.push(routeHint);
      continue;
    }

    const changed = prior.signature !== signature;
    nextPages[routeHint] = {
      routeHint,
      forms,
      signature,
      firstSeenAt: prior.firstSeenAt,
      lastSeenAt: discoveredAt,
      lastChangedAt: changed ? discoveredAt : prior.lastChangedAt,
      consecutiveMisses: 0,
    };
    if (changed) diff.changedPages.push(routeHint);
    else diff.unchangedPages.push(routeHint);
  }

  for (const [routeHint, prior] of Object.entries(base.pages)) {
    if (observedRoutes.has(routeHint)) continue;
    nextPages[routeHint] = { ...prior, consecutiveMisses: prior.consecutiveMisses + 1 };
    diff.missingPages.push(routeHint);
  }

  return { next: { version: 1, pages: nextPages }, diff };
}
