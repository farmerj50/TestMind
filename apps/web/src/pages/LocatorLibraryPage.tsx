import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toast } from "sonner";

type LocatorBucket = "fields" | "buttons" | "links" | "locators";

type LocatorPage = {
  fields?: Record<string, string>;
  buttons?: Record<string, string>;
  links?: Record<string, string>;
  locators?: Record<string, string>;
};

type SharedSteps = {
  pages?: Record<string, LocatorPage>;
  locators?: Record<string, Record<string, string>>;
  nav?: Record<string, string>;
  navSuggestions?: Record<string, Array<{ selector: string; confidence?: number | null; updatedAt?: string }>>;
  locatorFallbacks?: Record<
    string,
    Partial<Record<LocatorBucket, Record<string, { metadata?: { urlPattern?: string; uniqueAnchor?: string } }>>>
  >;
  locatorMeta?: { updatedAt?: string; updatedBy?: string };
};

type Project = { id: string; name: string };
type WeakLocator = {
  pagePath: string;
  bucket: string;
  name: string;
  selector?: string;
  failCount: number;
  successCount: number;
  total: number;
  failRate: number;
  updatedAt?: string;
};

type NewEntry = {
  bucket: LocatorBucket;
  name: string;
  selector: string;
};

const buckets: LocatorBucket[] = ["fields", "buttons", "links", "locators"];
const GLOBAL_NAV_KEY = "__global_nav__";

function normalizeSharedSteps(sharedSteps: SharedSteps | null): Record<string, LocatorPage> {
  if (!sharedSteps) return {};
  if (sharedSteps.pages && typeof sharedSteps.pages === "object") {
    return sharedSteps.pages;
  }
  if (sharedSteps.locators && typeof sharedSteps.locators === "object") {
    return Object.entries(sharedSteps.locators).reduce<Record<string, LocatorPage>>(
      (acc, [page, locators]) => {
        acc[page] = { locators };
        return acc;
      },
      {}
    );
  }
  return {};
}

export default function LocatorLibraryPage() {
  const { apiFetch } = useApi();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(params.get("projectId"));
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingLocators, setLoadingLocators] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sharedSteps, setSharedSteps] = useState<SharedSteps | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [newEntries, setNewEntries] = useState<Record<string, NewEntry>>({});
  const [search, setSearch] = useState("");
  const [promotingNav, setPromotingNav] = useState<Record<string, boolean>>({});
  const [bulkPromotingNav, setBulkPromotingNav] = useState(false);
  const [bulkPromotingLocators, setBulkPromotingLocators] = useState(false);
  const [identityDrafts, setIdentityDrafts] = useState<
    Record<string, { urlPattern: string; uniqueAnchor: string; saving?: boolean }>
  >({});
  const [weakLocators, setWeakLocators] = useState<WeakLocator[]>([]);
  const [weakSelectorDrafts, setWeakSelectorDrafts] = useState<Record<string, string>>({});
  const [weakSaving, setWeakSaving] = useState<Record<string, boolean>>({});
  const [rerunning, setRerunning] = useState(false);
  const [expandedPages, setExpandedPages] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let active = true;
    setLoadingProjects(true);
    apiFetch<{ projects: Project[] }>("/projects")
      .then((data) => {
        if (!active) return;
        setProjects(data.projects ?? []);
        if (!projectId && data.projects?.length) {
          const firstId = data.projects[0].id;
          setProjectId(firstId);
          setParams((prev) => {
            prev.set("projectId", firstId);
            return prev;
          });
        }
      })
      .catch((err: any) => {
        if (!active) return;
        setError(err?.message ?? "Failed to load projects.");
      })
      .finally(() => {
        if (active) setLoadingProjects(false);
      });

    return () => {
      active = false;
    };
  }, [apiFetch, projectId, setParams]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setLoadingLocators(true);
    setError(null);
    apiFetch<{ sharedSteps: SharedSteps }>(`/projects/${projectId}/shared-locators`)
      .then((data) => {
        if (!active) return;
        setSharedSteps(data.sharedSteps ?? {});
        setDrafts({});
      })
      .catch((err: any) => {
        if (!active) return;
        setError(err?.message ?? "Failed to load shared locators.");
      })
      .finally(() => {
        if (active) setLoadingLocators(false);
      });
    return () => {
      active = false;
    };
  }, [apiFetch, projectId]);

  useEffect(() => {
    if (!projectId) {
      setWeakLocators([]);
      return;
    }
    let active = true;
    apiFetch<{ weakLocators?: WeakLocator[] }>(`/projects/${projectId}/locator-health/weak?limit=8`)
      .then((data) => {
        if (!active) return;
        setWeakLocators(data.weakLocators ?? []);
      })
      .catch(() => {
        if (!active) return;
        setWeakLocators([]);
      });
    return () => {
      active = false;
    };
  }, [apiFetch, projectId, sharedSteps?.locatorMeta?.updatedAt]);

  const pages = useMemo(
    () => normalizeSharedSteps(sharedSteps),
    [sharedSteps]
  );
  const globalNav = useMemo(() => sharedSteps?.nav ?? {}, [sharedSteps]);

  const filteredPages = useMemo(() => {
    const entries: Record<string, LocatorPage> = {
      [GLOBAL_NAV_KEY]: { locators: globalNav },
      ...pages,
    };
    if (!search.trim()) return entries;
    const needle = search.trim().toLowerCase();
    return Object.entries(entries).reduce<Record<string, LocatorPage>>((acc, [pagePath, page]) => {
      const label = pagePath === GLOBAL_NAV_KEY ? "Global nav" : pagePath;
      if (label.toLowerCase().includes(needle)) {
        acc[pagePath] = page;
        return acc;
      }
      const match = buckets.some((bucket) =>
        Object.entries(page[bucket] ?? {}).some(
          ([name, selector]) =>
            name.toLowerCase().includes(needle) || selector.toLowerCase().includes(needle)
        )
      );
      if (match) acc[pagePath] = page;
      return acc;
    }, {});
  }, [globalNav, pages, search]);

  const pageCount = Object.keys(filteredPages).length;
  const locatorUpdatedAt = sharedSteps?.locatorMeta?.updatedAt
    ? new Date(sharedSteps.locatorMeta.updatedAt).toLocaleString()
    : null;

  const handleProjectChange = (id: string) => {
    setProjectId(id);
    setParams((prev) => {
      prev.set("projectId", id);
      return prev;
    });
  };

  const locatorKey = (pagePath: string, bucket: LocatorBucket, name: string) =>
    `${pagePath}|${bucket}|${name}`;
  const weakLocatorKey = (item: WeakLocator) => `${item.pagePath}|${item.bucket}|${item.name}`;

  const getDraftValue = (pagePath: string, bucket: LocatorBucket, name: string, current: string) =>
    drafts[locatorKey(pagePath, bucket, name)] ?? current;

  const setDraftValue = (pagePath: string, bucket: LocatorBucket, name: string, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [locatorKey(pagePath, bucket, name)]: value,
    }));
  };

  const handleSave = async (
    pagePath: string,
    bucket: LocatorBucket,
    name: string,
    selector: string
  ) => {
    if (!projectId) return;
    if (pagePath === GLOBAL_NAV_KEY && !name.startsWith("nav.")) {
      setError("Global nav locators must be prefixed with nav.");
      return;
    }
    const key = locatorKey(pagePath, bucket, name);
    const trimmed = selector.trim();
    if (!trimmed) {
      setError("Selector is required.");
      return;
    }
    setSaving((prev) => ({ ...prev, [key]: true }));
    setError(null);
    try {
      await apiFetch(`/projects/${projectId}/shared-locators`, {
        method: "POST",
        body: JSON.stringify({ pagePath, bucket, name, selector: trimmed }),
      });
      setSharedSteps((prev) => {
        const next = { ...(prev ?? {}) } as SharedSteps;
        if (pagePath === GLOBAL_NAV_KEY) {
          const nav = { ...(next.nav ?? {}) };
          nav[name] = trimmed;
          next.nav = nav;
          return next;
        }
        const pagesNext = normalizeSharedSteps(next);
        const page = { ...(pagesNext[pagePath] ?? {}) } as LocatorPage;
        const map = { ...(page[bucket] ?? {}) } as Record<string, string>;
        map[name] = trimmed;
        page[bucket] = map;
        pagesNext[pagePath] = page;
        next.pages = pagesNext;
        return next;
      });
      setDrafts((prev) => {
        const copy = { ...prev };
        delete copy[key];
        return copy;
      });
    } catch (err: any) {
      setError(err?.message ?? "Failed to save locator.");
    } finally {
      setSaving((prev) => ({ ...prev, [key]: false }));
    }
  };

  const handleNewEntryChange = (pagePath: string, patch: Partial<NewEntry>) => {
    setNewEntries((prev) => ({
      ...prev,
      [pagePath]: {
        bucket: prev[pagePath]?.bucket ?? "locators",
        name: prev[pagePath]?.name ?? "",
        selector: prev[pagePath]?.selector ?? "",
        ...patch,
      },
    }));
  };

  const handleAddEntry = async (pagePath: string) => {
    const entry = newEntries[pagePath];
    if (!entry) return;
    await handleSave(pagePath, entry.bucket, entry.name, entry.selector);
    setNewEntries((prev) => ({ ...prev, [pagePath]: { bucket: entry.bucket, name: "", selector: "" } }));
  };

  const asLocatorBucket = (value: string): LocatorBucket | null => {
    return buckets.includes(value as LocatorBucket) ? (value as LocatorBucket) : null;
  };

  const handleFocusWeakLocator = (item: WeakLocator) => {
    setSearch(item.name);
    setExpandedPages((prev) => ({ ...prev, [item.pagePath]: true }));
    setTimeout(() => {
      const el = document.getElementById(`locator-page-${encodeURIComponent(item.pagePath)}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 30);
  };

  const handleSaveWeakFix = async (item: WeakLocator) => {
    if (!projectId) return;
    const bucket = asLocatorBucket(item.bucket);
    if (!bucket) {
      setError(`Unsupported locator bucket '${item.bucket}'.`);
      return;
    }
    const key = weakLocatorKey(item);
    const selector = (weakSelectorDrafts[key] ?? item.selector ?? "").trim();
    if (!selector) {
      setError("Selector is required.");
      return;
    }
    setWeakSaving((prev) => ({ ...prev, [key]: true }));
    setError(null);
    try {
      await apiFetch(`/projects/${projectId}/shared-locators`, {
        method: "POST",
        body: JSON.stringify({
          pagePath: item.pagePath,
          bucket,
          name: item.name,
          selector,
        }),
      });
      await apiFetch(`/projects/${projectId}/locator-health`, {
        method: "POST",
        body: JSON.stringify({
          pagePath: item.pagePath,
          bucket,
          name: item.name,
          selector,
          status: "passed",
          reason: "Manual fix from locator library",
        }),
      });
      setWeakSelectorDrafts((prev) => ({ ...prev, [key]: selector }));
      await refreshSharedLocators(projectId);
      toast.success(`Saved fix for ${item.name}.`);
    } catch (err: any) {
      setError(err?.message ?? "Failed to save weak locator fix.");
      toast.error(err?.message ?? "Failed to save weak locator fix.");
    } finally {
      setWeakSaving((prev) => ({ ...prev, [key]: false }));
    }
  };

  const handleRerunSuite = async () => {
    if (!projectId || rerunning) return;
    setRerunning(true);
    setError(null);
    try {
      const res = await apiFetch<{ id: string }>("/runner/run", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          mode: "regular",
        }),
      });
      if (res?.id) {
        toast.success("Rerun started.");
        navigate(`/test-runs/${res.id}`);
      } else {
        throw new Error("Run created without id.");
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to start rerun.");
      toast.error(err?.message ?? "Failed to start rerun.");
    } finally {
      setRerunning(false);
    }
  };

  const getIdentityDraft = (pagePath: string, page: LocatorPage) => {
    const existing = identityDrafts[pagePath];
    if (existing) return existing;
    const fallbackMeta = sharedSteps?.locatorFallbacks?.[pagePath]?.locators?.pageIdentity?.metadata;
    return {
      urlPattern: fallbackMeta?.urlPattern ?? pagePath,
      uniqueAnchor: fallbackMeta?.uniqueAnchor ?? (page.locators?.pageIdentity ?? ""),
    };
  };

  const setIdentityDraft = (
    pagePath: string,
    patch: Partial<{ urlPattern: string; uniqueAnchor: string; saving?: boolean }>
  ) => {
    setIdentityDrafts((prev) => {
      const curr = prev[pagePath] ?? { urlPattern: pagePath, uniqueAnchor: "" };
      return {
        ...prev,
        [pagePath]: {
          ...curr,
          ...patch,
        },
      };
    });
  };

  const handleSaveIdentity = async (pagePath: string, page: LocatorPage) => {
    if (!projectId || pagePath === GLOBAL_NAV_KEY) return;
    const draft = getIdentityDraft(pagePath, page);
    const urlPattern = draft.urlPattern.trim();
    const uniqueAnchor = draft.uniqueAnchor.trim();
    if (!urlPattern || !uniqueAnchor) {
      setError("Page identity requires both URL pattern and unique anchor.");
      return;
    }
    setError(null);
    setIdentityDraft(pagePath, { saving: true });
    try {
      const res = await apiFetch<{ sharedSteps?: SharedSteps }>("/locators", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          pagePath,
          urlPattern,
          bucket: "locators",
          elementName: "pageIdentity",
          primary: uniqueAnchor,
          fallbacks: [],
          metadata: {
            urlPattern,
            uniqueAnchor,
          },
        }),
      });
      if (res?.sharedSteps) {
        setSharedSteps(res.sharedSteps);
      } else {
        await refreshSharedLocators(projectId);
      }
      toast.success(`Saved page identity for ${pagePath}.`);
    } catch (err: any) {
      setError(err?.message ?? "Failed to save page identity.");
      toast.error(err?.message ?? "Failed to save page identity.");
    } finally {
      setIdentityDraft(pagePath, { saving: false });
    }
  };

  const navSuggestions = useMemo(() => {
    const raw = sharedSteps?.navSuggestions;
    if (!raw || typeof raw !== "object") return [] as Array<{ key: string; selector: string; confidence: number | null; updatedAt?: string }>;
    const rows: Array<{ key: string; selector: string; confidence: number | null; updatedAt?: string }> = [];
    for (const [key, candidates] of Object.entries(raw)) {
      if (!Array.isArray(candidates)) continue;
      for (const c of candidates) {
        if (!c || typeof c.selector !== "string" || !c.selector.trim()) continue;
        const confidence = typeof c.confidence === "number" ? c.confidence : null;
        rows.push({ key, selector: c.selector.trim(), confidence, updatedAt: c.updatedAt });
      }
    }
    return rows.sort((a, b) => {
      const scoreA = a.confidence ?? -1;
      const scoreB = b.confidence ?? -1;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
    });
  }, [sharedSteps]);

  const refreshSharedLocators = async (id: string) => {
    const data = await apiFetch<{ sharedSteps: SharedSteps }>(`/projects/${id}/shared-locators`);
    setSharedSteps(data.sharedSteps ?? {});
  };

  const handlePromoteNavSuggestion = async (key: string, selector: string) => {
    if (!projectId) return;
    const opKey = `${key}|${selector}`;
    setPromotingNav((prev) => ({ ...prev, [opKey]: true }));
    setError(null);
    try {
      await apiFetch(`/projects/${projectId}/nav-suggestions/promote`, {
        method: "POST",
        body: JSON.stringify({
          key,
          selector,
          removeAfterPromote: true,
        }),
      });
      await refreshSharedLocators(projectId);
      toast.success(`Promoted nav mapping for ${key}.`);
    } catch (err: any) {
      setError(err?.message ?? "Failed to promote nav suggestion.");
      toast.error(err?.message ?? "Failed to promote nav suggestion.");
    } finally {
      setPromotingNav((prev) => ({ ...prev, [opKey]: false }));
    }
  };

  const handlePromoteHighConfidenceNav = async () => {
    if (!projectId || bulkPromotingNav) return;
    setBulkPromotingNav(true);
    setError(null);
    try {
      const res = await apiFetch<{ promotedCount?: number }>(
        `/projects/${projectId}/nav-suggestions/promote-high-confidence`,
        {
          method: "POST",
          body: JSON.stringify({
            minConfidence: 75,
            removeAfterPromote: true,
            limit: 100,
          }),
        }
      );
      const promotedCount = typeof res?.promotedCount === "number" ? res.promotedCount : 0;
      if (promotedCount > 0) {
        toast.success(`Promoted ${promotedCount} high-confidence nav mapping${promotedCount === 1 ? "" : "s"}.`);
      } else {
        toast.message("No high-confidence nav suggestions were eligible.");
      }
      await refreshSharedLocators(projectId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to promote high-confidence nav suggestions.");
      toast.error(err?.message ?? "Failed to promote high-confidence nav suggestions.");
    } finally {
      setBulkPromotingNav(false);
    }
  };

  const handlePromoteHighConfidenceLocators = async () => {
    if (!projectId || bulkPromotingLocators) return;
    setBulkPromotingLocators(true);
    setError(null);
    try {
      const res = await apiFetch<{ promotedCount?: number }>(
        `/projects/${projectId}/locators/promote-high-confidence`,
        {
          method: "POST",
          body: JSON.stringify({
            minConfidence: 75,
            limit: 300,
            overwriteExisting: false,
          }),
        }
      );
      const promotedCount = typeof res?.promotedCount === "number" ? res.promotedCount : 0;
      if (promotedCount > 0) {
        toast.success(`Promoted ${promotedCount} high-confidence locator${promotedCount === 1 ? "" : "s"}.`);
      } else {
        toast.message("No high-confidence locators were eligible.");
      }
      await refreshSharedLocators(projectId);
    } catch (err: any) {
      setError(err?.message ?? "Failed to promote high-confidence locators.");
      toast.error(err?.message ?? "Failed to promote high-confidence locators.");
    } finally {
      setBulkPromotingLocators(false);
    }
  };

  return (
    <div className="px-6 py-6">
      <div className="max-w-6xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-slate-900">Locator Library</h1>
          <p className="mt-1 text-sm text-slate-600">
            Review and update shared locators saved from test runs. Use search to find a selector quickly.
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Global nav is shared across pages. Use nav.* keys there. Per-page groups should only include pageIdentity
            and page-specific actions.
          </p>
          {locatorUpdatedAt && (
            <p className="mt-1 text-xs text-slate-500">Last updated: {locatorUpdatedAt}</p>
          )}
        </header>

        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[220px]">
            <label className="text-xs text-slate-600">Project</label>
            <select
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
              value={projectId ?? ""}
              onChange={(event) => handleProjectChange(event.target.value)}
              disabled={loadingProjects}
            >
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <div className="min-w-[240px] flex-1">
            <label className="text-xs text-slate-600">Search</label>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by page, locator name, or selector"
              className="mt-1"
            />
          </div>
          <div className="flex items-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handlePromoteHighConfidenceLocators}
              disabled={!projectId || bulkPromotingLocators || loadingLocators}
            >
              {bulkPromotingLocators ? "Promoting locators..." : "Promote high-confidence locators"}
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        {weakLocators.length > 0 && (
          <section className="rounded-lg border border-rose-200 bg-rose-50/40 p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-rose-900">Weak locators</div>
              <Button size="sm" variant="outline" onClick={handleRerunSuite} disabled={rerunning || !projectId}>
                {rerunning ? "Starting rerun..." : "Rerun suite"}
              </Button>
            </div>
            <div className="space-y-1">
              {weakLocators.map((item) => (
                <div
                  key={`${item.pagePath}-${item.bucket}-${item.name}`}
                  className="grid gap-2 rounded-md border border-rose-100 bg-white px-3 py-2 text-xs md:grid-cols-[1fr_90px_120px_1fr_auto]"
                >
                  <div className="text-slate-700">
                    <span className="font-mono">{item.name}</span>{" "}
                    <span className="text-slate-500">({item.pagePath})</span>
                  </div>
                  <div className="text-rose-700">{Math.round(item.failRate * 100)}% fail</div>
                  <div className="text-slate-500">
                    {item.failCount} fail / {item.successCount} pass
                  </div>
                  <Input
                    value={weakSelectorDrafts[weakLocatorKey(item)] ?? item.selector ?? ""}
                    onChange={(event) =>
                      setWeakSelectorDrafts((prev) => ({
                        ...prev,
                        [weakLocatorKey(item)]: event.target.value,
                      }))
                    }
                    placeholder="Updated selector"
                  />
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => handleFocusWeakLocator(item)}>
                      Focus
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleSaveWeakFix(item)}
                      disabled={!!weakSaving[weakLocatorKey(item)]}
                    >
                      {weakSaving[weakLocatorKey(item)] ? "Saving..." : "Save fix"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {loadingLocators ? (
          <div className="text-sm text-slate-500">Loading locators.</div>
        ) : pageCount === 0 ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            No shared locators yet. Save locators from a test run to populate this library.
          </div>
        ) : (
          <div className="space-y-4">
            <section className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-slate-900">Nav suggestions</div>
                  <div className="text-xs text-slate-500">Run-derived candidates kept separate until promoted.</div>
                </div>
                <Button size="sm" variant="outline" onClick={handlePromoteHighConfidenceNav} disabled={bulkPromotingNav || !projectId}>
                  {bulkPromotingNav ? "Promoting..." : "Promote high-confidence"}
                </Button>
              </div>
              {navSuggestions.length === 0 ? (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                  No nav suggestions available.
                </div>
              ) : (
                <div className="space-y-2">
                  {navSuggestions.slice(0, 50).map((item) => {
                    const opKey = `${item.key}|${item.selector}`;
                    return (
                      <div key={opKey} className="grid gap-2 rounded-md border border-slate-200 p-3 md:grid-cols-[180px_1fr_100px_auto]">
                        <div className="text-sm font-medium text-slate-700">{item.key}</div>
                        <code className="text-xs text-slate-700">{item.selector}</code>
                        <div className="text-xs text-slate-500">{item.confidence == null ? "-" : `${Math.round(item.confidence)}%`}</div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handlePromoteNavSuggestion(item.key, item.selector)}
                          disabled={!!promotingNav[opKey] || bulkPromotingNav}
                        >
                          {promotingNav[opKey] ? "Promoting..." : "Promote"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {Object.entries(filteredPages)
              .sort(([a], [b]) => {
                if (a === GLOBAL_NAV_KEY) return -1;
                if (b === GLOBAL_NAV_KEY) return 1;
                return a.localeCompare(b);
              })
              .map(([pagePath, page]) => {
              const counts = buckets.reduce(
                (acc, bucket) => acc + Object.keys(page[bucket] ?? {}).length,
                0
              );
              return (
                <details
                  key={pagePath}
                  id={`locator-page-${encodeURIComponent(pagePath)}`}
                  className="rounded-lg border border-slate-200 bg-white p-4"
                  open={!!expandedPages[pagePath]}
                  onToggle={(event) => {
                    const isOpen = (event.currentTarget as HTMLDetailsElement).open;
                    setExpandedPages((prev) => ({ ...prev, [pagePath]: isOpen }));
                  }}
                >
                  <summary className="cursor-pointer list-none">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">
                          {pagePath === GLOBAL_NAV_KEY ? "Global nav" : pagePath}
                        </div>
                        {pagePath === GLOBAL_NAV_KEY && (
                          <div className="text-xs text-slate-500">
                            Use nav.* keys (e.g. nav.pricing) for navigation links.
                          </div>
                        )}
                        <div className="text-xs text-slate-500">{counts} locators</div>
                      </div>
                      <div className="text-xs text-slate-500">Click to expand</div>
                    </div>
                  </summary>

                  <div className="mt-4 space-y-5">
                    {pagePath !== GLOBAL_NAV_KEY && (
                      <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Page identity
                        </div>
                        <div className="grid gap-2 md:grid-cols-[220px_1fr_auto]">
                          <Input
                            placeholder="URL pattern (e.g. /select-plan)"
                            value={getIdentityDraft(pagePath, page).urlPattern}
                            onChange={(event) =>
                              setIdentityDraft(pagePath, { urlPattern: event.target.value })
                            }
                          />
                          <Input
                            placeholder="Unique anchor selector (e.g. [data-testid='page-title'])"
                            value={getIdentityDraft(pagePath, page).uniqueAnchor}
                            onChange={(event) =>
                              setIdentityDraft(pagePath, { uniqueAnchor: event.target.value })
                            }
                          />
                          <Button
                            onClick={() => handleSaveIdentity(pagePath, page)}
                            disabled={!!getIdentityDraft(pagePath, page).saving}
                          >
                            {getIdentityDraft(pagePath, page).saving ? "Saving..." : "Save identity"}
                          </Button>
                        </div>
                      </div>
                    )}

                    {buckets.map((bucket) => {
                      const entries = Object.entries(page[bucket] ?? {});
                      if (!entries.length) return null;
                      return (
                        <div key={bucket}>
                          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            {bucket}
                          </div>
                          <div className="space-y-3">
                            {entries.map(([name, selector]) => {
                              const key = locatorKey(pagePath, bucket, name);
                              const value = getDraftValue(pagePath, bucket, name, selector);
                              const isDirty = value.trim() !== selector.trim();
                              return (
                                <div key={key} className="grid gap-2 md:grid-cols-[220px_1fr_auto]">
                                  <div className="text-sm font-medium text-slate-700">{name}</div>
                                  <Input
                                    value={value}
                                    onChange={(event) =>
                                      setDraftValue(pagePath, bucket, name, event.target.value)
                                    }
                                  />
                                  {isDirty ? (
                                    <Button
                                      className="w-full md:w-auto"
                                      onClick={() => handleSave(pagePath, bucket, name, value)}
                                      disabled={saving[key]}
                                    >
                                      {saving[key] ? "Saving..." : "Save"}
                                    </Button>
                                  ) : (
                                    <span className="text-xs text-slate-500">Saved</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}

                    <div className="rounded-md border border-dashed border-slate-200 p-3">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Add locator
                      </div>
                      <div className="grid gap-2 md:grid-cols-[160px_180px_1fr_auto]">
                        <select
                          className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
                          value={newEntries[pagePath]?.bucket ?? "locators"}
                          onChange={(event) =>
                            handleNewEntryChange(pagePath, {
                              bucket: event.target.value as LocatorBucket,
                            })
                          }
                          disabled={pagePath === GLOBAL_NAV_KEY}
                        >
                          {buckets.map((bucket) => (
                            <option key={bucket} value={bucket}>
                              {bucket}
                            </option>
                          ))}
                        </select>
                        <Input
                          placeholder="Name"
                          value={newEntries[pagePath]?.name ?? ""}
                          onChange={(event) =>
                            handleNewEntryChange(pagePath, { name: event.target.value })
                          }
                        />
                        <Input
                          placeholder="Selector"
                          value={newEntries[pagePath]?.selector ?? ""}
                          onChange={(event) =>
                            handleNewEntryChange(pagePath, { selector: event.target.value })
                          }
                        />
                        <Button
                          onClick={() => handleAddEntry(pagePath)}
                          disabled={
                            !newEntries[pagePath]?.name?.trim() ||
                            !newEntries[pagePath]?.selector?.trim()
                          }
                        >
                          Add
                        </Button>
                      </div>
                    </div>
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
