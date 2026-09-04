// apps/api/src/lib/application-model.ts
//
// Project Memory foundation, Phase 1: a typed, versioned store of discovery-derived
// application-model facts (forms/fields per page), persisted separately from sharedSteps
// (locator resolution knowledge, a different concern with a different lifecycle - see the
// plan). Pure logic only, no Prisma import - I/O lives in callers, or (once there's more than
// one caller) in the sibling apps/api/src/lib/application-model-store.ts, following the same
// extraction pattern as lib/locator-promotion.ts.
//
// Application Brain v1 (Ticket AB.1) bumps this store to version 2, adding APIs, identities,
// resources, workflows, and testLinks alongside the existing pages. All additions are
// additive: normalizeApplicationModel upgrades any v1-shaped data it finds (the shape every
// Project row already has, written by the one existing caller) into the v2 shape by defaulting
// the new record types to {} - so nothing that currently reads/writes this column needs to
// change for this ticket to land safely.
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
  /**
   * Page-to-page navigation adjacency observed during crawl (same-origin links/control hrefs
   * discover.ts's RouteScan already collects). Last-observed-only: overwritten on every merge
   * that touches this page, not diffed/tracked over time the way forms are - a deliberate v1
   * simplification, not an oversight (see Application Brain v1's "observed relationships"
   * scope). Set via applyLinksTo, not computeApplicationModelUpdate's own incoming param, so
   * the existing pages-merge signature/call site is untouched by this addition.
   */
  linksTo?: string[];
};

export type ApplicationModelDiff = {
  newPages: string[];
  changedPages: string[];
  unchangedPages: string[];
  /** Previously known pages not observed this run. */
  missingPages: string[];
};

/** An API endpoint observed via a structured source (ApiSpec import) - never inferred by
 * crawling, since discover.ts has no reliable API-detection signal today. */
export type ApplicationModelApi = {
  method: string;
  path: string;
  /** sha1 of `${method} ${path}` - a v1-minimal identity; see computeApiUpdate. */
  signature: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  consecutiveMisses: number;
};

/** A role label observed from SecurityAuthSession.role - role labels only, never credentials,
 * scopes, or a real account roster (out of scope for v1). */
export type ApplicationModelIdentity = {
  role: string;
  signature: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  consecutiveMisses: number;
};

/** A named resource and which routes/APIs touch it - intentionally minimal, no ownership
 * graph, no FK (out of scope: "full dependency mapper"). */
export type ApplicationModelResource = {
  name: string;
  routeHints: string[];
  apiHints: string[];
  signature: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  consecutiveMisses: number;
};

/** Manually authored in v1 - never inferred. No staleness fields: a workflow doesn't get
 * "missed" the way an observed fact does: an author edits or deletes it. */
export type ApplicationModelWorkflow = {
  name: string;
  riskTags: string[];
  routeHints: string[];
  apiHints: string[];
};

/**
 * The Brain-owned link between a TestCase and the route it exercises, written once at case-
 * creation time by callers that already know both (operator-worker.ts's discovery-driven case
 * creation, url-inspector.ts's save flow - both Ticket AB.4). This is what lets "what has
 * already been tested" be answered without ever adding a column to TestCase or touching
 * persist-run-results.ts: once a row has a link, every later status update to that same
 * TestCase inherits it for free, keyed by testCaseId rather than reconstructed from free text.
 */
export type ApplicationModelTestLink = {
  testCaseId: string;
  routeHint: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type ApplicationModelStore = {
  version: 2;
  pages: Record<string, ApplicationModelPage>;
  apis: Record<string, ApplicationModelApi>;
  identities: Record<string, ApplicationModelIdentity>;
  resources: Record<string, ApplicationModelResource>;
  workflows: Record<string, ApplicationModelWorkflow>;
  testLinks: Record<string, ApplicationModelTestLink>;
};

const EMPTY_STORE: ApplicationModelStore = {
  version: 2,
  pages: {},
  apis: {},
  identities: {},
  resources: {},
  workflows: {},
  testLinks: {},
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Coerces whatever is in Project.applicationModel today into the current (v2) store shape.
 * Accepts the pre-Brain v1 shape (`{version: 1, pages: {...}}`, what every existing Project
 * row has) by defaulting every new record type to {} - callers never need to branch on which
 * version they got back, only ever the current type.
 */
export function normalizeApplicationModel(raw: unknown): ApplicationModelStore {
  const candidate = asRecord(raw);
  return {
    version: 2,
    pages: asRecord(candidate.pages) as Record<string, ApplicationModelPage>,
    apis: asRecord(candidate.apis) as Record<string, ApplicationModelApi>,
    identities: asRecord(candidate.identities) as Record<string, ApplicationModelIdentity>,
    resources: asRecord(candidate.resources) as Record<string, ApplicationModelResource>,
    workflows: asRecord(candidate.workflows) as Record<string, ApplicationModelWorkflow>,
    testLinks: asRecord(candidate.testLinks) as Record<string, ApplicationModelTestLink>,
  };
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

/**
 * Canonicalizes a route hint before it's used as a pages{} key, so URL noise
 * (trailing slash, query string, scheme+host) doesn't get misread as pages
 * appearing/disappearing. discover.ts's FormMeta.routeHint is not guaranteed to already be
 * normalized - callers should run every routeHint through this before grouping.
 */
export function normalizeRouteHint(raw: string): string {
  let value = raw.trim();
  try {
    // Strips scheme+host if present, keeps only pathname (drops query/hash).
    const url = new URL(value, "http://localhost");
    value = url.pathname || "/";
  } catch {
    // Not URL-parseable even with a base - fall back to stripping a query string manually.
    value = value.split("?")[0].split("#")[0];
  }
  if (!value.startsWith("/")) value = `/${value}`;
  if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
  return value;
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
 * missed, never removed. Signature/params unchanged from the pre-Brain version so the one
 * existing caller (operator-worker.ts's runDiscoveryJob) is untouched by this ticket - apis/
 * identities/resources/workflows/testLinks pass through from `current` unmodified.
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
      linksTo: prior.linksTo,
    };
    if (changed) diff.changedPages.push(routeHint);
    else diff.unchangedPages.push(routeHint);
  }

  for (const [routeHint, prior] of Object.entries(base.pages)) {
    if (observedRoutes.has(routeHint)) continue;
    nextPages[routeHint] = { ...prior, consecutiveMisses: prior.consecutiveMisses + 1 };
    diff.missingPages.push(routeHint);
  }

  return { next: { ...base, pages: nextPages }, diff };
}

/**
 * Sets a page's observed navigation-adjacency links. Last-observed-only (replaces, doesn't
 * merge, the prior linksTo) - see ApplicationModelPage.linksTo. A no-op if the page doesn't
 * exist yet in the store (links can't be attached to a page the store hasn't seen). Separate
 * from computeApplicationModelUpdate's own incoming param deliberately, so that function's
 * signature - and its one existing caller - stays untouched by this addition.
 */
export function applyLinksTo(store: ApplicationModelStore, routeHint: string, linksTo: string[]): ApplicationModelStore {
  const prior = store.pages[routeHint];
  if (!prior) return store;
  return { ...store, pages: { ...store.pages, [routeHint]: { ...prior, linksTo } } };
}

type StaleTrackedRecord = {
  signature: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  consecutiveMisses: number;
};

/**
 * Shared never-delete/consecutiveMisses merge, generalized from computeApplicationModelUpdate
 * for the new fact types (APIs/identities/resources), which all follow the identical
 * staleness-tracking shape but differ in what they store and how their signature is computed.
 * `incoming` is keyed by whatever stable key the caller uses (API: `${method} ${path}`,
 * identity: the role string itself, resource: its name).
 */
function mergeStaleTrackedRecords<TIncoming, TRecord extends StaleTrackedRecord>(
  base: Record<string, TRecord>,
  incoming: Record<string, TIncoming>,
  discoveredAt: string,
  buildSignature: (value: TIncoming) => string,
  buildRecord: (value: TIncoming, signature: string, prior: TRecord | undefined) => TRecord
): Record<string, TRecord> {
  const next: Record<string, TRecord> = { ...base };
  const observedKeys = new Set(Object.keys(incoming));

  for (const [key, value] of Object.entries(incoming)) {
    const signature = buildSignature(value);
    const prior = base[key];
    next[key] = buildRecord(value, signature, prior);
  }

  for (const [key, prior] of Object.entries(base)) {
    if (observedKeys.has(key)) continue;
    next[key] = { ...prior, consecutiveMisses: prior.consecutiveMisses + 1 };
  }

  return next;
}

function baseStaleFields(
  signature: string,
  discoveredAt: string,
  prior: StaleTrackedRecord | undefined
): Pick<StaleTrackedRecord, "signature" | "firstSeenAt" | "lastSeenAt" | "lastChangedAt" | "consecutiveMisses"> {
  if (!prior) {
    return { signature, firstSeenAt: discoveredAt, lastSeenAt: discoveredAt, lastChangedAt: discoveredAt, consecutiveMisses: 0 };
  }
  const changed = prior.signature !== signature;
  return {
    signature,
    firstSeenAt: prior.firstSeenAt,
    lastSeenAt: discoveredAt,
    lastChangedAt: changed ? discoveredAt : prior.lastChangedAt,
    consecutiveMisses: 0,
  };
}

/** Merges observed APIs (from an ApiSpec import - see Ticket AB.4) into the store. Keyed by
 * `${method} ${path}`. Signature is deliberately minimal (sha1 of the key itself) - v1 tracks
 * presence/absence of an endpoint, not its request/response shape (that would edge toward the
 * "code-understanding engine" this design stays out of). */
export function computeApiUpdate(
  store: ApplicationModelStore,
  incoming: Record<string, { method: string; path: string }>,
  discoveredAt: string
): ApplicationModelStore {
  const apis = mergeStaleTrackedRecords<{ method: string; path: string }, ApplicationModelApi>(
    store.apis,
    incoming,
    discoveredAt,
    (value) => sha1(`${value.method.toUpperCase()} ${value.path}`),
    (value, signature, prior) => ({ method: value.method, path: value.path, ...baseStaleFields(signature, discoveredAt, prior) })
  );
  return { ...store, apis };
}

/** Merges observed identity role labels (from SecurityAuthSession.role - see Ticket AB.4) into
 * the store. Keyed by the role string itself - role labels only, never credentials/scopes. */
export function computeIdentityUpdate(
  store: ApplicationModelStore,
  incoming: Record<string, { role: string }>,
  discoveredAt: string
): ApplicationModelStore {
  const identities = mergeStaleTrackedRecords<{ role: string }, ApplicationModelIdentity>(
    store.identities,
    incoming,
    discoveredAt,
    (value) => sha1(value.role),
    (value, signature, prior) => ({ role: value.role, ...baseStaleFields(signature, discoveredAt, prior) })
  );
  return { ...store, identities };
}

/** Merges named resources (a resource + which routes/APIs touch it - no ownership graph, no
 * FK) into the store. Keyed by resource name. */
export function computeResourceUpdate(
  store: ApplicationModelStore,
  incoming: Record<string, { name: string; routeHints: string[]; apiHints: string[] }>,
  discoveredAt: string
): ApplicationModelStore {
  const resources = mergeStaleTrackedRecords<{ name: string; routeHints: string[]; apiHints: string[] }, ApplicationModelResource>(
    store.resources,
    incoming,
    discoveredAt,
    (value) => sha1(JSON.stringify([[...value.routeHints].sort(), [...value.apiHints].sort()])),
    (value, signature, prior) => ({
      name: value.name,
      routeHints: value.routeHints,
      apiHints: value.apiHints,
      ...baseStaleFields(signature, discoveredAt, prior),
    })
  );
  return { ...store, resources };
}

/**
 * Creates or refreshes a testCaseId -> routeHint link (see ApplicationModelTestLink). Unlike
 * the other fact types, a link is never "missed" the way an observed page/API is - it's
 * created once when a TestCase is created and its lastSeenAt bumped whenever that same case is
 * re-observed by a producer; there's no consecutiveMisses concept for it and no signature (the
 * link itself doesn't have a "changed" state - a TestCase's route association doesn't drift).
 */
export function upsertTestLink(
  store: ApplicationModelStore,
  testCaseId: string,
  routeHint: string,
  seenAt: string
): ApplicationModelStore {
  const prior = store.testLinks[testCaseId];
  const link: ApplicationModelTestLink = {
    testCaseId,
    routeHint,
    firstSeenAt: prior?.firstSeenAt ?? seenAt,
    lastSeenAt: seenAt,
  };
  return { ...store, testLinks: { ...store.testLinks, [testCaseId]: link } };
}

/**
 * Ticket AB.3 - workflows are the one fact type authored by a human rather than passively
 * observed, so unlike the merge functions above there's no "incoming from a discovery cycle"
 * to diff against - a caller (the workflow CRUD route) creates/replaces a whole entry by key.
 * `key` is caller-supplied (the route slugifies the workflow's name); this function doesn't
 * care what convention the key follows, only that it's stable across edits to the same
 * workflow.
 */
export function setWorkflow(store: ApplicationModelStore, key: string, workflow: ApplicationModelWorkflow): ApplicationModelStore {
  return { ...store, workflows: { ...store.workflows, [key]: workflow } };
}

/** No-op if the key doesn't exist - deleting an already-deleted (or never-existing) workflow
 * is not an error, matching the idempotent-delete convention used elsewhere in this codebase. */
export function removeWorkflow(store: ApplicationModelStore, key: string): ApplicationModelStore {
  if (!(key in store.workflows)) return store;
  const next = { ...store.workflows };
  delete next[key];
  return { ...store, workflows: next };
}
