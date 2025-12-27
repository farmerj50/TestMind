import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

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
};

type Project = { id: string; name: string };

type NewEntry = {
  bucket: LocatorBucket;
  name: string;
  selector: string;
};

const buckets: LocatorBucket[] = ["fields", "buttons", "links", "locators"];

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

  const pages = useMemo(
    () => normalizeSharedSteps(sharedSteps),
    [sharedSteps]
  );

  const filteredPages = useMemo(() => {
    if (!search.trim()) return pages;
    const needle = search.trim().toLowerCase();
    return Object.entries(pages).reduce<Record<string, LocatorPage>>((acc, [pagePath, page]) => {
      if (pagePath.toLowerCase().includes(needle)) {
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
  }, [pages, search]);

  const pageCount = Object.keys(filteredPages).length;

  const handleProjectChange = (id: string) => {
    setProjectId(id);
    setParams((prev) => {
      prev.set("projectId", id);
      return prev;
    });
  };

  const locatorKey = (pagePath: string, bucket: LocatorBucket, name: string) =>
    `${pagePath}|${bucket}|${name}`;

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

  return (
    <div className="px-6 py-6">
      <div className="max-w-6xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-slate-900">Locator Library</h1>
          <p className="mt-1 text-sm text-slate-600">
            Review and update shared locators saved from test runs. Use search to find a selector quickly.
          </p>
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
        </div>

        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        )}

        {loadingLocators ? (
          <div className="text-sm text-slate-500">Loading locators.</div>
        ) : pageCount === 0 ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            No shared locators yet. Save locators from a test run to populate this library.
          </div>
        ) : (
          <div className="space-y-4">
            {Object.entries(filteredPages).map(([pagePath, page]) => {
              const counts = buckets.reduce(
                (acc, bucket) => acc + Object.keys(page[bucket] ?? {}).length,
                0
              );
              return (
                <details
                  key={pagePath}
                  className="rounded-lg border border-slate-200 bg-white p-4"
                >
                  <summary className="cursor-pointer list-none">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-slate-900">{pagePath}</div>
                        <div className="text-xs text-slate-500">{counts} locators</div>
                      </div>
                      <div className="text-xs text-slate-500">Click to expand</div>
                    </div>
                  </summary>

                  <div className="mt-4 space-y-5">
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
                              return (
                                <div key={key} className="grid gap-2 md:grid-cols-[220px_1fr_auto]">
                                  <div className="text-sm font-medium text-slate-700">{name}</div>
                                  <Input
                                    value={value}
                                    onChange={(event) =>
                                      setDraftValue(pagePath, bucket, name, event.target.value)
                                    }
                                  />
                                  <Button
                                    className="w-full md:w-auto"
                                    onClick={() => handleSave(pagePath, bucket, name, value)}
                                    disabled={saving[key]}
                                  >
                                    {saving[key] ? "Saving..." : "Save"}
                                  </Button>
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
