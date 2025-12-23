// src/pages/ProjectSuite.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { Separator } from "../components/ui/seperator";
import { ScrollArea } from "../components/ui/scroll-area";
import { FileText, FolderTree, ChevronDown, ChevronRight, GitBranch, Search, RefreshCw, Play, Plus, Lock, Unlock } from "lucide-react";
import { cn } from "../lib/utils";
import { useNavigate, useParams, Link, useLocation } from "react-router-dom";
import { useApi, apiUrl } from "../lib/api";
import HowToHint from "../components/HowToHint";

type SpecFile = { path: string };
type CaseItem = { title: string; line: number; specPath?: string };

type TreeNode = { name: string; children?: TreeNode[]; file?: SpecFile; suiteId?: string };
type ProjectOption = { id: string; name: string };
type SpecProjectOption = { id: string; name: string; type: "generated" | "curated"; locked?: string[] };
type ReporterId = "json" | "allure";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a grep that still matches when Playwright prepends describe titles.
function buildLooseGrep(titles: string[]) {
  if (!titles.length) return "";
  const escaped = titles.map(escapeRegex);
  const body = escaped.length === 1 ? escaped[0] : `(?:${escaped.join("|")})`;
  return `(?:^|\\s)${body}(?:$|\\s)`;
}

function friendlyError(text: string, fallback: string) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
    if (parsed?.error) return parsed.error;
    if (parsed?.message) return parsed.message;
  } catch {
    // ignore
  }
  return text?.trim() || fallback;
}

function buildTree(specs: SpecFile[]): TreeNode[] {
  const root: Record<string, any> = {};
  for (const s of specs) {
    const parts = s.path.split("/");
    let node = root;
    parts.forEach((part, idx) => {
      node.children ||= {};
      node.children[part] ||= { name: part, children: {} };
      if (idx === parts.length - 1) node.children[part].file = s;
      node = node.children[part];
    });
  }
  const toArray = (n: any): TreeNode[] => {
    if (!n.children) return [];
    const out: TreeNode[] = Object.values(n.children).map((c: any) => ({
      name: c.name,
      file: c.file,
      children: toArray(c),
    }));
    return out.sort((a, b) => {
      const af = !!a.file, bf = !!b.file;
      if (af !== bf) return af ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  };
  return toArray({ children: root.children });
}

function cloneNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? cloneNodes(node.children) : undefined,
  }));
}

function TreeItem({
  node,
  depth = 0,
  onSelect,
  onSelectSuite,
  activeSuiteId,
  activePath,
}: {
  node: TreeNode;
  depth?: number;
  onSelect: (f: SpecFile) => void;
  onSelectSuite?: (suiteId: string) => void;
  activeSuiteId?: string;
  activePath?: string | null;
}) {
  const isFile = !!node.file;
  const isSuite = !isFile && !!node.suiteId;
  const isActiveSuite = isSuite && node.suiteId === activeSuiteId;
  const isActiveFile = isFile && node.file?.path === activePath;
  const [open, setOpen] = useState(isSuite ? node.suiteId === activeSuiteId : true);

  useEffect(() => {
    if (isSuite) {
      setOpen(node.suiteId === activeSuiteId);
    }
  }, [activeSuiteId, isSuite, node.suiteId]);

  const handleClick = () => {
    if (isFile) {
      onSelect(node.file!);
    } else if (isSuite && node.suiteId && onSelectSuite) {
      onSelectSuite(node.suiteId);
      setOpen(true);
    } else {
      setOpen((o) => !o);
    }
  };

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-2 py-1 px-2 rounded cursor-pointer hover:bg-accent/30",
          isActiveSuite && "bg-accent/40 font-medium",
          isActiveFile && "bg-white/80 font-medium"
        )}
        style={{ paddingLeft: depth * 12 }}
        onClick={handleClick}
      >
        {isFile ? (
          <FileText className="h-4 w-4 opacity-70" />
        ) : open ? (
          <ChevronDown className="h-4 w-4 opacity-70" />
        ) : (
          <ChevronRight className="h-4 w-4 opacity-70" />
        )}
        <span className="text-sm">{node.name}</span>
      </div>
      {!isFile && open && node.children?.map((c) => (
        <TreeItem
          key={node.name + "/" + c.name}
          node={c}
          depth={depth + 1}
          onSelect={onSelect}
          onSelectSuite={onSelectSuite}
          activeSuiteId={activeSuiteId}
          activePath={activePath}
        />
      ))}
    </div>
  );
}

const COPY_PLACEHOLDER = "__copy_spec__";

export default function ProjectSuite() {
  const { projectId } = useParams(); // route: /suite/:projectId
  const pid = projectId ?? "playwright-ts";
  const navigate = useNavigate();
  const location = useLocation();
  const { apiFetch } = useApi();
  const [branch, setBranch] = useState("main");
  const [specs, setSpecs] = useState<SpecFile[]>([]);
  const [activeSpec, setActiveSpec] = useState<SpecFile | null>(null);
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [runningSuite, setRunningSuite] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [runProjectId, setRunProjectId] = useState<string | null>(() => localStorage.getItem("tm:lastProjectId"));
  const [projectLoadErr, setProjectLoadErr] = useState<string | null>(null);
  const [specProjects, setSpecProjects] = useState<SpecProjectOption[]>([]);
  const [specProjectErr, setSpecProjectErr] = useState<string | null>(null);
  const [creatingSuite, setCreatingSuite] = useState(false);
  const [copyingSpec, setCopyingSpec] = useState(false);
  const [lockingSpec, setLockingSpec] = useState(false);
  const [copySelectValue, setCopySelectValue] = useState(COPY_PLACEHOLDER);
  const [specReloadKey, setSpecReloadKey] = useState(0);
  const [renamingSuite, setRenamingSuite] = useState(false);
  const [syncingSuite, setSyncingSuite] = useState<false | "replaceSuite" | "overwriteMatches" | "addMissing">(false);
  const [deletingSpec, setDeletingSpec] = useState(false);
  const [deletingSuite, setDeletingSuite] = useState(false);
  const [baseUrl, setBaseUrl] = useState<string>(() => localStorage.getItem("tm:lastBaseUrl") || "");
  const [headful, setHeadful] = useState(false);
  const [reporter, setReporter] = useState<ReporterId>("json");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorContent, setEditorContent] = useState("");
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [suiteCases, setSuiteCases] = useState<CaseItem[]>([]);
  const [suiteSelected, setSuiteSelected] = useState(false);
  const specFromQuery = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get("spec");
    if (!raw) return null;
    try {
      const decoded = decodeURIComponent(raw);
      return decoded.replace(/^\/+/, "");
    } catch {
      return raw.replace(/^\/+/, "");
    }
  }, [location.search]);
  const placeholderApplied = useRef(false);
  const matchApplied = useRef(false);
  const lastQueryApplied = useRef<string | null>(null);
  const initialAutoOpenApplied = useRef(false);
  const returnTo = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get("returnTo");
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }, [location.search]);
  const projectParam = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get("project");
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }, [location.search]);

  useEffect(() => {
    setCopySelectValue(COPY_PLACEHOLDER);
  }, [activeSpec?.path]);

  // If a project is provided via query (?project=...), redirect to that suite once
  useEffect(() => {
    if (!projectParam || projectParam === pid) return;
    const params = new URLSearchParams(location.search);
    params.delete("project");
    const qs = params.toString();
    navigate(`/suite/${projectParam}${qs ? `?${qs}` : ""}`, { replace: true });
  }, [projectParam, pid, navigate, location.search]);

  // Reset auto-select flags when switching suites
  useEffect(() => {
    placeholderApplied.current = false;
    matchApplied.current = false;
    initialAutoOpenApplied.current = false;
  }, [pid]);
  // If query changes, reset flags for new selection
  useEffect(() => {
    if (specFromQuery !== lastQueryApplied.current) {
      placeholderApplied.current = false;
      matchApplied.current = false;
      lastQueryApplied.current = specFromQuery;
    }
  }, [specFromQuery]);

  // Apply placeholder selection immediately from query
  useEffect(() => {
    if (placeholderApplied.current) return;
    if (!specFromQuery) return;
    if (!activeSpec) {
      const normalizedQuery = specFromQuery.replace(/^\/+/, "");
      setActiveSpec({ path: normalizedQuery });
      placeholderApplied.current = true;
    }
  }, [specFromQuery, activeSpec]);
  // Once specs load, try to match the queried spec to the real list
  useEffect(() => {
    if (matchApplied.current) return;
    if (!specFromQuery) return;
    if (!specs.length) {
      // No specs available in this suite
      setSpecProjectErr("No specs in this suite. Try selecting the generated suite or copy specs in.");
      matchApplied.current = true;
      setActiveSpec(null);
      return;
    }
    const normalizedQuery = specFromQuery.replace(/^\/+/, "");
    const qBase = normalizedQuery.split("/").pop();
    const qBaseNoCheck = qBase?.replace(/-?check/i, "");

    const match =
      specs.find((s) => s.path === normalizedQuery) ||
      specs.find((s) => s.path.replace(/^\/+/, "") === normalizedQuery) ||
      specs.find((s) => s.path.replace(/^\/+/, "").endsWith(normalizedQuery)) ||
      (qBase ? specs.find((s) => s.path.split("/").pop() === qBase) : undefined) ||
      (qBase ? specs.find((s) => (s.path.split("/").pop() || "").includes(qBase)) : undefined) ||
      (qBaseNoCheck ? specs.find((s) => (s.path.split("/").pop() || "").includes(qBaseNoCheck)) : undefined);

    if (match) {
      setActiveSpec(match);
      setSpecProjectErr(null);
    } else {
      setSpecProjectErr("Spec not found in this suite. It may live in another suite (e.g., generated).");
      setActiveSpec(null);
      setSelected({});
    }
    matchApplied.current = true;
  }, [specFromQuery, specs]);
  useEffect(() => {
    if (specFromQuery) {
      setSuiteSelected(false);
    }
  }, [specFromQuery]);

  // load available spec projects (generated + curated)
  useEffect(() => {
    let active = true;
    fetch(apiUrl("/tm/suite/projects")
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "Failed to load spec projects");
          throw new Error(text);
        }
        return res.json();
      })
      .then((data: { projects?: SpecProjectOption[] }) => {
        if (!active) return;
        const items = data?.projects ?? [];
        setSpecProjects(items);
        if (items.length && !items.some((p) => p.id === pid)) {
          navigate(`/suite/${items[0].id}`, { replace: true });
        }
        setSpecProjectErr(null);
      })
      .catch((err) => {
        if (!active) return;
        console.error(err);
        setSpecProjectErr(err instanceof Error ? err.message : "Failed to load spec projects");
      });
    return () => {
      active = false;
    };
  }, [pid, navigate]);

  const curatedSuites = useMemo(
    () => specProjects.filter((proj) => proj.type === "curated"),
    [specProjects]
  );
  const generatedSuites = useMemo(
    () => specProjects.filter((proj) => proj.type === "generated"),
    [specProjects]
  );
  const activeSuite = specProjects.find((proj) => proj.id === pid);
  const isActiveCurated = activeSuite?.type === "curated";
  const activeSpecLocked = useMemo(() => {
    if (!activeSuite || !activeSpec || !isActiveCurated) return false;
    return (activeSuite.locked || []).includes(activeSpec.path);
  }, [activeSuite, activeSpec, isActiveCurated]);
  const specTree = useMemo(() => buildTree(specs), [specs]);
  const suiteTree = useMemo(() => {
    const toNode = (proj: SpecProjectOption) => ({
      name: proj.type === "curated" ? `${proj.name} (curated)` : proj.name,
      suiteId: proj.id,
      children: proj.id === pid ? cloneNodes(specTree) : undefined,
    });
    return {
      generated: generatedSuites.map(toNode),
      curated: curatedSuites.map(toNode),
    };
  }, [specProjects, specTree, pid, generatedSuites, curatedSuites]);
  const suiteOptions = useMemo(
    () => specProjects.map((p) => ({ value: p.id, label: p.name, type: p.type })),
    [specProjects]
  );

  async function handleCreateSuite() {
    const proposed = window.prompt("New suite name?");
    if (!proposed) return;
    const name = proposed.trim();
    if (!name) return;
    if (!runProjectId) {
      setSpecProjectErr("Select a project first (top bar).");
      return;
    }
    setCreatingSuite(true);
    try {
      const res = await fetch(apiUrl("/tm/suite/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, projectId: runProjectId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Failed to create suite");
        throw new Error(text);
      }
      const data = await res.json().catch(() => null);
      const project = data?.project as SpecProjectOption | undefined;
      if (project) {
        setSpecProjects((prev) => {
          const filtered = prev.filter((p) => p.id !== project.id);
          return [...filtered, project];
        });
        setSpecProjectErr(null);
        navigate(`/suite/${project.id}`);
      }
    } catch (err) {
      console.error(err);
      setSpecProjectErr(err instanceof Error ? err.message : "Failed to create suite");
    } finally {
      setCreatingSuite(false);
    }
  }

  async function handleCopySpec(targetId: string) {
    if (!activeSpec) return;
    if (!curatedSuites.length) {
      setSpecProjectErr("Create a curated suite first.");
      return;
    }
    setCopyingSpec(true);
    setSpecProjectErr(null);
    try {
      const res = await fetch(apiUrl(`/tm/suite/projects/${targetId}/specs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: activeSpec.path, sourceProjectId: pid }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Failed to copy spec");
        throw new Error(text);
      }
      if (targetId === pid) {
        setSpecReloadKey((k) => k + 1);
      }
      setSpecProjectErr(null);
    } catch (err) {
      console.error(err);
      setSpecProjectErr(err instanceof Error ? err.message : "Failed to copy spec");
    } finally {
      setCopyingSpec(false);
    }
  }

  async function handleToggleLock(nextLocked: boolean) {
    if (!activeSpec || !isActiveCurated || !activeSuite) return;
    setLockingSpec(true);
    try {
      const res = await fetch(apiUrl(`/tm/suite/projects/${activeSuite.id}/specs`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: activeSpec.path, locked: nextLocked }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Failed to update lock status");
        throw new Error(text);
      }
      const data = await res.json().catch(() => null);
      const lockedList = (data?.locked as string[]) || [];
      setSpecProjects((prev) =>
        prev.map((proj) =>
          proj.id === activeSuite.id
            ? { ...proj, locked: lockedList }
            : proj
        )
      );
      setSpecProjectErr(null);
    } catch (err) {
      console.error(err);
      setSpecProjectErr(err instanceof Error ? err.message : "Failed to update lock");
    } finally {
      setLockingSpec(false);
    }
  }

  async function handleDeleteSpec() {
    if (!activeSpec || !isActiveCurated || !activeSuite) return;
    setDeletingSpec(true);
    try {
      const res = await fetch(apiUrl(`/tm/suite/projects/${activeSuite.id}/specs?path=${encodeURIComponent(activeSpec.path)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "Failed to delete spec");
        throw new Error(text);
      }
      setSpecReloadKey((k) => k + 1);
      setSpecProjectErr(null);
      setActiveSpec(null);
    } catch (err) {
      console.error(err);
      setSpecProjectErr(err instanceof Error ? err.message : "Failed to delete spec");
    } finally {
      setDeletingSpec(false);
    }
  }

  async function handleSyncSuite(mode: "replaceSuite" | "overwriteMatches" | "addMissing") {
    if (!activeSuite || !isActiveCurated) return;
    setSyncingSuite(mode);
    try {
      const res = await fetch(apiUrl(`/tm/suite/projects/${activeSuite.id}/sync-from-generated`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adapterId: "playwright-ts", mode }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Failed to sync suite");
        throw new Error(text);
      }
      await res.json().catch(() => null);
      setSpecReloadKey((k) => k + 1);
      setSpecProjectErr(null);
    } catch (err) {
      console.error(err);
      setSpecProjectErr(err instanceof Error ? err.message : "Failed to sync suite");
    } finally {
      setSyncingSuite(false);
    }
  }

  async function handleRenameSuite() {
    if (!isActiveCurated || !activeSuite) return;
    const proposed = window.prompt("New suite name?", activeSuite.name);
    if (!proposed) return;
    const name = proposed.trim();
    if (!name || name === activeSuite.name) return;
    setRenamingSuite(true);
    try {
      const res = await fetch(apiUrl(`/tm/suite/projects/${activeSuite.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Failed to rename suite");
        throw new Error(text);
      }
      const data = await res.json().catch(() => null);
      const updated = data?.project as SpecProjectOption | undefined;
      if (updated) {
        setSpecProjects((prev) =>
          prev.map((proj) => (proj.id === updated.id ? { ...proj, name: updated.name } : proj))
        );
      }
      setSpecProjectErr(null);
    } catch (err) {
      console.error(err);
      setSpecProjectErr(err instanceof Error ? err.message : "Failed to rename suite");
    } finally {
      setRenamingSuite(false);
    }
  }

  async function handleDeleteSuite() {
    if (!isActiveCurated || !activeSuite) return;
    const confirmDelete = window.confirm(`Delete suite "${activeSuite.name}"? This cannot be undone.`);
    if (!confirmDelete) return;
    setDeletingSuite(true);
    try {
      const res = await fetch(apiUrl(`/tm/suite/projects/${activeSuite.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const text = await res.text().catch(() => "Failed to delete suite");
        throw new Error(text);
      }
      setSpecProjects((prev) => prev.filter((proj) => proj.id !== activeSuite.id));
      if (activeSuite.id === pid) {
        const fallback = specProjects.find((proj) => proj.id !== activeSuite.id)?.id || "playwright-ts";
        navigate(`/suite/${fallback}`);
      }
      setSpecProjectErr(null);
    } catch (err) {
      console.error(err);
      setSpecProjectErr(err instanceof Error ? err.message : "Failed to delete suite");
    } finally {
      setDeletingSuite(false);
    }
  }

  async function handleEditSpec() {
    if (!activeSpec) {
      setRunError("Select a spec before editing.");
      return;
    }
    if (!isActiveCurated) {
      setSpecProjectErr("Edit is only available for curated suites. Copy this spec into a curated suite first.");
      return;
    }
    if (activeSpec.path.startsWith("(")) {
      setSpecProjectErr("Pick a specific spec (not the suite aggregate) before editing.");
      return;
    }
    if (!activeSuite) {
      setSpecProjectErr("Select a suite before editing.");
      return;
    }
    setEditorLoading(true);
    setEditorPath(activeSpec.path);
    try {
      const qs = new URLSearchParams({ projectId: activeSuite.id, path: activeSpec.path });
      const res = await fetch(apiUrl(`/tm/suite/spec-content?${qs.toString()}`);
      if (!res.ok) {
        const text = await res.text().catch(() => "Failed to load spec content");
        throw new Error(friendlyError(text, "Failed to load spec"));
      }
      const data = await res.json().catch(() => null);
      setEditorContent(data?.content ?? "");
      setEditorOpen(true);
      setSpecProjectErr(null);
    } catch (err) {
      console.error(err);
      setSpecProjectErr(err instanceof Error ? err.message : "Failed to load spec");
      setEditorPath(null);
      setEditorOpen(false);
    } finally {
      setEditorLoading(false);
    }
  }

  async function handleSaveSpec() {
    if (!activeSuite || !editorPath) return;
    setEditorSaving(true);
    try {
      const res = await fetch(apiUrl("/tm/suite/spec-content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: activeSuite.id, path: editorPath, content: editorContent }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Failed to save spec");
        throw new Error(friendlyError(text, "Failed to save spec"));
      }
      setEditorOpen(false);
      if (returnTo) {
        navigate(returnTo, { replace: true });
        return;
      }
      setSpecProjectErr(null);
    } catch (err) {
      console.error(err);
      setSpecProjectErr(err instanceof Error ? err.message : "Failed to save spec");
    } finally {
      setEditorSaving(false);
    }
  }

  // load spec list
  useEffect(() => {
    if (!specProjects.length) {
      setSpecs([]);
      setActiveSpec(null);
      setSpecProjectErr("No suites available for this account.");
      return;
    }
    if (!specProjects.some((p) => p.id === pid)) {
      setSpecs([]);
      setActiveSpec(null);
      return;
    }
    const qs = new URLSearchParams({ projectId: pid });
    fetch(apiUrl(`/tm/suite/specs?${qs.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const text = await r.text().catch(() => "Failed to load specs");
          throw new Error(text);
        }
        return r.json();
      })
      .then((rows: SpecFile[]) => setSpecs(rows))
      .catch((err) => {
        console.error(err);
        setRunError(err instanceof Error ? err.message : "Failed to load specs");
      });
  }, [pid, specReloadKey, specProjects]);

  // If a spec path is provided via query (?spec=...), auto-select it once specs are loaded.
  useEffect(() => {
    if (matchApplied.current) return;
    if (!specFromQuery || !specs.length) return;
    const normalizedQuery = specFromQuery.replace(/^\/+/, "");
    const match =
      specs.find((s) => s.path === normalizedQuery) ||
      specs.find((s) => s.path.replace(/^\/+/, "") === normalizedQuery) ||
      specs.find((s) => s.path.replace(/^\/+/, "").endsWith(normalizedQuery));
    if (match) {
      setActiveSpec(match);
      matchApplied.current = true;
    }
  }, [specFromQuery, specs]);

  // If a spec is provided via query and it's a curated suite, auto-open the editor once.
  useEffect(() => {
    if (initialAutoOpenApplied.current) return;
    if (!specFromQuery || !specs.length) return;
    if (!activeSuite || activeSuite.type !== "curated") return;
    const normalizedQuery = specFromQuery.replace(/^\/+/, "");
    const match =
      specs.find((s) => s.path === normalizedQuery) ||
      specs.find((s) => s.path.replace(/^\/+/, "") === normalizedQuery) ||
      specs.find((s) => s.path.replace(/^\/+/, "").endsWith(normalizedQuery));
    if (!match) return;

    initialAutoOpenApplied.current = true;
    (async () => {
      setEditorLoading(true);
      setEditorPath(match.path);
      try {
        const qs = new URLSearchParams({ projectId: activeSuite.id, path: match.path });
        const res = await fetch(apiUrl(`/tm/suite/spec-content?${qs.toString()}`);
        if (!res.ok) {
          const text = await res.text().catch(() => "Failed to load spec content");
          throw new Error(text);
        }
        const data = await res.json().catch(() => null);
        setEditorContent(data?.content ?? "");
        setEditorOpen(true);
        setSpecProjectErr(null);
      } catch (err: any) {
        console.error(err);
        setSpecProjectErr(err instanceof Error ? err.message : "Failed to load spec content");
        setEditorOpen(false);
      } finally {
        setEditorLoading(false);
      }
    })();
  }, [specFromQuery, specs, activeSuite]);

  // fetch available projects for running
  useEffect(() => {
    let active = true;
    apiFetch<{ projects: ProjectOption[] }>("/projects", { method: "GET", auth: "include" })
      .then((res) => {
        if (!active) return;
        setProjects(res.projects);
        if (res.projects.length) {
          setProjectLoadErr(null);
          setRunProjectId((prev) => {
            if (prev && res.projects.some((p) => p.id === prev)) return prev;
            const next = res.projects[0].id;
            localStorage.setItem("tm:lastProjectId", next);
            return next;
          });
        }
      })
      .catch((err) => {
        if (!active) return;
        setProjectLoadErr(err instanceof Error ? err.message : "Failed to load projects");
      });
    return () => { active = false; };
  }, [apiFetch]);

  // load cases when a spec is selected (skip when viewing whole suite)
  useEffect(() => {
    if (!activeSpec || suiteSelected) return;
    const qs = new URLSearchParams({ projectId: pid, path: activeSpec.path });
    fetch(apiUrl(`/tm/suite/cases?${qs.toString()}`)
      .then(async (r) => {
        if (!r.ok) {
          const text = await r.text().catch(() => "Failed to load cases");
          throw new Error(text);
        }
        return r.json();
      })
      .then((rows: CaseItem[]) => {
        setCases(rows);
        const allSelected: Record<string, boolean> = {};
        rows.forEach((c) => {
          allSelected[`case:${activeSpec?.path || ""}:${c.title}`] = true;
        });
        setSelected(allSelected);
      })
      .catch((err) => {
        console.error(err);
        setRunError(err instanceof Error ? err.message : "Failed to load cases");
      });
  }, [pid, activeSpec, suiteSelected]);


  const filtered = useMemo(
    () => {
      const source = suiteSelected ? suiteCases : cases;
      return query ? source.filter(c => c.title.toLowerCase().includes(query.toLowerCase())) : source;
    },
    [cases, suiteCases, suiteSelected, query]
  );

  const selectedTitles = useMemo(
    () => {
      const source = suiteSelected ? suiteCases : cases;
      return source.filter((c) => selected[`case:${c.specPath || activeSpec?.path || ""}:${c.title}`]).map((c) => c.title);
    },
    [cases, suiteCases, suiteSelected, selected]
  );
  const selectedCases = useMemo(
    () => {
      const source = suiteSelected ? suiteCases : cases;
      return source.filter((c) => selected[`case:${c.specPath || activeSpec?.path || ""}:${c.title}`]);
    },
    [cases, suiteCases, suiteSelected, selected, activeSpec?.path]
  );
  const anySelected = selectedTitles.length > 0;

  function toggle(id: string, checked: boolean) {
    setSelected(s => ({ ...s, [id]: checked }));
  }
  function selectAll(checked: boolean) {
    const next: Record<string, boolean> = {};
    for (const c of filtered) {
      const key = `case:${c.specPath || activeSpec?.path || ""}:${c.title}`;
      next[key] = checked;
    }
    setSelected(s => ({ ...s, ...next }));
  }
  async function loadSuiteCases() {
    if (!specs.length) return;
    setRunError(null);
    try {
      const all: CaseItem[] = [];
      for (const spec of specs) {
        const qs = new URLSearchParams({ projectId: pid, path: spec.path });
        const res = await fetch(apiUrl(`/tm/suite/cases?${qs.toString()}`);
        if (!res.ok) continue;
        const rows: CaseItem[] = await res.json();
        rows.forEach((r) => all.push({ ...r, specPath: spec.path }));
      }
      const unique: Record<string, boolean> = {};
      all.forEach((c) => { unique[`case:${c.specPath || ""}:${c.title}`] = true; });
      setSuiteCases(all);
      setSelected(unique);
      setSuiteSelected(true);
      setActiveSpec({ path: "(suite: all specs)" });
    } catch (err) {
      console.error(err);
      setRunError(err instanceof Error ? err.message : "Failed to load suite cases");
    }
  }

  async function handleRunSelection() {
    if (!selectedCases.length) {
      setRunError("Pick at least one test case.");
      return;
    }
    if (!baseUrl.trim()) {
      setRunError("Enter a base URL before running.");
      return;
    }
    if (!runProjectId) {
      setRunError("Select a project to run against.");
      return;
    }
    localStorage.setItem("tm:lastBaseUrl", baseUrl.trim());

    setRunning(true);
    setRunError(null);
    try {
      if (suiteSelected) {
        const files = Array.from(
          new Set(
            selectedCases
              .map((c) => c.specPath)
              .filter((p): p is string => !!p)
          )
        );
        const grep = buildLooseGrep(selectedCases.map((c) => c.title));
        const res = await apiFetch<{ id: string }>("/runner/run", {
          method: "POST",
          body: JSON.stringify({
            projectId: runProjectId,
            suiteId: pid,
            files,
            grep,
            baseUrl: baseUrl.trim(),
            headful,
            reporter,
          }),
        });
        if (res?.id) navigate(`/test-runs/${res.id}`);
      } else {
        if (!activeSpec) {
          setRunError("Select a spec before running.");
          return;
        }
        const grep = buildLooseGrep(selectedTitles);
        const res = await apiFetch<{ id: string }>("/runner/run", {
          method: "POST",
          body: JSON.stringify({
            projectId: runProjectId,
            suiteId: pid,
            file: activeSpec.path,
            grep,
            baseUrl: baseUrl.trim(),
            headful,
            reporter,
          }),
        });
        if (res?.id) navigate(`/test-runs/${res.id}`);
      }
      setSelected({});
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start run";
      setRunError(msg);
    } finally {
      setRunning(false);
    }
  }

  async function handleRunSuite() {
    if (!specs.length) {
      setRunError("No specs in this suite.");
      return;
    }
    if (!baseUrl.trim()) {
      setRunError("Enter a base URL before running.");
      return;
    }
    if (!runProjectId) {
      setRunError("Select a project to run against.");
      return;
    }
    localStorage.setItem("tm:lastBaseUrl", baseUrl.trim());
    setRunningSuite(true);
    setRunError(null);
    try {
      const files = specs.map((s) => s.path);
      const res = await apiFetch<{ id: string }>("/runner/run", {
        method: "POST",
        body: JSON.stringify({
          projectId: runProjectId,
          suiteId: pid,
          files,
          baseUrl: baseUrl.trim(),
          headful,
          reporter,
        }),
      });
      if (res?.id) navigate(`/test-runs/${res.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to run suite";
      setRunError(msg);
    } finally {
      setRunningSuite(false);
    }
  }

  return (
    <>
    <div className="h-full grid grid-cols-[300px_1fr]">
      {/* Left: tree */}
      <div className="border-r border-slate-300 bg-[#8eb7ff] text-slate-900">
        <div className="p-3 flex items-center gap-2">
          <FolderTree className="h-4 w-4" />
          <span className="font-medium">Spec Tree</span>
          <div className="ml-auto">
            <HowToHint
              storageKey="tm-howto-suites"
              title="How to use Suites"
              steps={[
                "Pick a suite on the left and select a spec file.",
                "Click Edit spec to open the inline editor; you can edit even locked specs.",
                "Use Lock spec when you want to freeze the current saved version (locks are advisory).",
                "Saved changes are applied immediately; rerun to see new steps.",
                "Use Run selection to execute chosen tests.",
                "Copy specs into curated suites to safely customize generated tests.",
              ]}
            />
          </div>
        </div>
        <div className="px-3 pb-3 space-y-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-center"
            onClick={handleCreateSuite}
            disabled={creatingSuite}
          >
            <Plus className="h-4 w-4 mr-1" /> {creatingSuite ? "Creating..." : "New suite"}
          </Button>
          {curatedSuites.length > 0 && (
            <Select
              value={copySelectValue}
              onValueChange={async (val) => {
                if (!val || val === COPY_PLACEHOLDER) return;
                if (!activeSpec || copyingSpec) return;
                setCopySelectValue(val);
                await handleCopySpec(val);
                setCopySelectValue(COPY_PLACEHOLDER);
              }}
            >
              <SelectTrigger className="w-full justify-center">
                <SelectValue placeholder={copyingSpec ? "Copying..." : "Copy spec"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={COPY_PLACEHOLDER} disabled>
                  Copy spec
                </SelectItem>
                {curatedSuites.map((suite) => (
                  <SelectItem key={suite.id} value={suite.id}>
                    {suite.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {activeSpec && isActiveCurated && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-center"
                onClick={handleEditSpec}
                disabled={editorLoading || activeSpec?.path.startsWith("(")}
              >
                <FileText className="h-4 w-4 mr-1" />
                {editorLoading ? "Opening..." : "Edit spec"}
              </Button>
              {isActiveCurated && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => handleToggleLock(!activeSpecLocked)}
                  disabled={lockingSpec}
                >
                  {activeSpecLocked ? (
                    <>
                      <Unlock className="h-4 w-4 mr-1" /> {lockingSpec ? "Unlocking..." : "Unlock spec"}
                    </>
                  ) : (
                    <>
                      <Lock className="h-4 w-4 mr-1" /> {lockingSpec ? "Locking..." : "Lock spec"}
                    </>
                  )}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-center text-red-600 border-red-400 hover:bg-red-50"
                onClick={handleDeleteSpec}
                disabled={deletingSpec}
              >
                {deletingSpec ? "Deleting spec..." : "Delete spec"}
              </Button>
            </>
          )}
          {isActiveCurated && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-center"
                onClick={handleRenameSuite}
                disabled={renamingSuite}
              >
                <GitBranch className="h-4 w-4 mr-1" />
                {renamingSuite ? "Renaming..." : "Rename suite"}
              </Button>
              <div className="grid grid-cols-1 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => handleSyncSuite("replaceSuite")}
                  disabled={!!syncingSuite}
                >
                  {syncingSuite === "replaceSuite" ? "Replacing..." : "Replace suite (from generated)"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => handleSyncSuite("overwriteMatches")}
                  disabled={!!syncingSuite}
                >
                  {syncingSuite === "overwriteMatches" ? "Overwriting..." : "Overwrite matches only"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => handleSyncSuite("addMissing")}
                  disabled={!!syncingSuite}
                >
                  {syncingSuite === "addMissing" ? "Adding..." : "Add missing only"}
                </Button>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-center text-red-600 border-red-400 hover:bg-red-50"
                onClick={handleDeleteSuite}
                disabled={deletingSuite}
              >
                {deletingSuite ? "Deleting..." : "Delete suite"}
              </Button>
            </>
          )}
        </div>
        <Separator />
        <ScrollArea className="h-[calc(100vh-64px)] p-2 space-y-1">
          {!!suiteTree.generated.length && (
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-slate-700 px-2">Generated</div>
              {suiteTree.generated.map((node) => (
                <TreeItem
                  key={node.suiteId || node.name}
                  node={node}
                  onSelect={(spec) => {
                    setSuiteSelected(false);
                    setActiveSpec(spec);
                  }}
                  onSelectSuite={(suiteId) => {
                    if (suiteId !== pid) navigate(`/suite/${suiteId}`);
                    setSuiteSelected(false);
                  }}
                  activeSuiteId={pid}
                  activePath={activeSpec?.path || null}
                />
              ))}
            </div>
          )}
          {!!suiteTree.curated.length && (
            <div className="space-y-1 mt-2">
              <div className="text-[11px] uppercase tracking-wide text-slate-700 px-2">Curated</div>
              {suiteTree.curated.map((node) => (
                <TreeItem
                  key={node.suiteId || node.name}
                  node={node}
                  onSelect={(spec) => {
                    setSuiteSelected(false);
                    setActiveSpec(spec);
                  }}
                  onSelectSuite={(suiteId) => {
                    if (suiteId !== pid) navigate(`/suite/${suiteId}`);
                    setSuiteSelected(false);
                  }}
                  activeSuiteId={pid}
                  activePath={activeSpec?.path || null}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Right: cases */}
      <div className="flex flex-col">
                {/* top bar */}
        <div className="p-3 border-b border-slate-300 bg-[#8eb7ff] text-slate-900">
          <div className="flex flex-wrap items-center gap-2">
            {/* left nav */}
            <div className="flex items-center gap-2 mr-2 shrink-0">
              <Button asChild variant="ghost" size="sm">
                <Link to="/dashboard">Dashboard</Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link to="/integrations">Integrations</Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link to="/projects">Projects</Link>
              </Button>
            </div>

            {/* suite */}
            <div className="shrink-0 w-[220px]">
              <Select value={activeSuite?.id} onValueChange={(val) => navigate(`/suite/${val}`)}>
                <SelectTrigger className="w-full h-10" disabled={!suiteOptions.length}>
                  <SelectValue placeholder={suiteOptions.length ? "Select suite" : "No suites"} />
                </SelectTrigger>
                <SelectContent>
                  {suiteOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label} {opt.type === "generated" ? "(generated)" : "(curated)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* project */}
            <div className="shrink-0 w-[220px]">
              <Select
                value={runProjectId ?? undefined}
                onValueChange={(val) => {
                  setRunProjectId(val);
                  localStorage.setItem("tm:lastProjectId", val);
                }}
              >
                <SelectTrigger className="w-full h-10" disabled={!projects.length}>
                  <SelectValue placeholder={projects.length ? "Select project" : "No projects"} />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((proj) => (
                    <SelectItem key={proj.id} value={proj.id}>
                      {proj.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* branch */}
            <div className="flex items-center gap-2 shrink-0">
              <GitBranch className="h-4 w-4" />
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger className="w-[160px] h-10">
                  <SelectValue placeholder="Branch" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="main">main</SelectItem>
                  <SelectItem value="develop">develop</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* reporter */}
            <div className="shrink-0">
              <Select value={reporter} onValueChange={(val) => setReporter(val as ReporterId)}>
                <SelectTrigger className="w-[160px] h-10">
                  <SelectValue placeholder="Reporter" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="json">JSON only</SelectItem>
                  <SelectItem value="allure">JSON + Allure</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* headed */}
            <label className="flex items-center gap-2 text-xs text-slate-600 shrink-0">
              <Checkbox checked={headful} onCheckedChange={(val) => setHeadful(Boolean(val))} />
              Headed (capture media)
            </label>

            {/* base url */}
            <div className="flex items-center gap-2 shrink-0 w-[320px]">
              <span className="text-xs text-slate-600 whitespace-nowrap">Base URL</span>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://example.com"
                className="bg-white/80 h-10"
              />
            </div>

            {/* back to run */}
            {returnTo && (
              <Button asChild variant="outline" className="border-white/90 shrink-0 h-10">
                <Link to={returnTo}>Back to run</Link>
              </Button>
            )}

            {/* search grows */}
            <div className="relative flex-1 min-w-[240px] max-w-[480px]">
              <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 opacity-60" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search test titles…"
                className="pl-8 h-10"
              />
            </div>

            {/* actions */}
            <Button variant="outline" onClick={() => setSelected({})} className="shrink-0 h-10">
              <RefreshCw className="h-4 w-4 mr-1" /> Clear
            </Button>

            <Button
              disabled={!anySelected || running}
              onClick={handleRunSelection}
              className="border border-white/90 shrink-0 h-10"
            >
              <Play className="h-4 w-4 mr-1" /> {running ? "Starting..." : "Run selection"}
            </Button>
          </div>
        </div>

        {(runError || projectLoadErr || specProjectErr) && (
          <div className="px-3 pb-2 text-xs text-rose-600">
            {runError || projectLoadErr || specProjectErr}
          </div>
        )}

        {/* body */}
        <ScrollArea className="p-4">
          {!activeSpec ? (
            <div className="text-sm text-muted-foreground">Select a spec on the left.</div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3 px-1">
                <div className="text-sm text-muted-foreground">{activeSpec.path}</div>
                <div className="flex gap-2">
                  <Button
                    variant="default"
                    onClick={()=>selectAll(true)}
                    className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm border border-white/90"
                  >
                    Select page
                  </Button>
                  <Button
                    variant="default"
                    onClick={()=>selectAll(false)}
                    className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm border border-white/90"
                  >
                    Clear page
                  </Button>
                  <Button
                    variant="default"
                    onClick={loadSuiteCases}
                    disabled={suiteSelected && !runError}
                    className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm border border-white/90"
                  >
                    Load suite
                  </Button>
                  <Button
                    variant="default"
                    onClick={handleRunSuite}
                    disabled={runningSuite || running}
                    className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm border border-white/90"
                  >
                    {runningSuite ? "Running suite..." : "Run suite"}
                  </Button>
                </div>
              </div>
              <Separator className="mb-3" />
              <div className="grid gap-2">
                {filtered.map(c => {
                  const key = `case:${c.specPath || activeSpec?.path || ""}:${c.title}`;
                  return (
                  <div
                    key={key}
                    className="flex items-start gap-3 p-3 rounded-xl border border-slate-200 bg-white shadow-sm cursor-pointer"
                    onClick={() => {
                      if (c.specPath) {
                        setSuiteSelected(false);
                        setActiveSpec({ path: c.specPath });
                      }
                    }}
                  >
                    <Checkbox
                      checked={!!selected[key]}
                      onCheckedChange={(v)=>toggle(key, Boolean(v))}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="font-medium leading-tight">{c.title}</div>
                      <div className="text-xs text-muted-foreground">line {c.line}</div>
                      {c.specPath && <div className="text-[11px] text-slate-500">{c.specPath}</div>}
                    </div>
                  </div>
                  );
                })}
                {filtered.length === 0 && <div className="text-sm text-muted-foreground">No matches.</div>}
              </div>
            </>
          )}
        </ScrollArea>
      </div>
    </div>
      {editorOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6">
          <div className="bg-white rounded-lg shadow-2xl w-full max-w-5xl h-[80vh] flex flex-col">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{editorPath}</div>
                <div className="text-xs text-slate-500">Editing in {activeSuite?.name || pid}</div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={editorSaving}>
                  Cancel
                </Button>
                <Button onClick={handleSaveSpec} disabled={editorSaving}>
                  {editorSaving ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
            <div className="flex-1">
              <Editor
                height="100%"
                defaultLanguage="typescript"
                theme="vs-dark"
                value={editorContent}
                onChange={(value) => setEditorContent(value ?? "")}
                options={{ minimap: { enabled: false }, fontSize: 14 }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
