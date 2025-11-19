// src/pages/ProjectSuite.tsx
import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { Separator } from "../components/ui/seperator";
import { ScrollArea } from "../components/ui/scroll-area";
import { FileText, FolderTree, ChevronDown, ChevronRight, GitBranch, Search, RefreshCw, Play, Plus, Lock, Unlock } from "lucide-react";
import { cn } from "../lib/utils";
import { useNavigate, useParams } from "react-router-dom";
import { useApi } from "../lib/api";

type SpecFile = { path: string };
type CaseItem = { title: string; line: number };

type TreeNode = { name: string; children?: TreeNode[]; file?: SpecFile; suiteId?: string };
type ProjectOption = { id: string; name: string };
type SpecProjectOption = { id: string; name: string; type: "generated" | "curated"; locked?: string[] };
type ReporterId = "json" | "allure";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
}: {
  node: TreeNode;
  depth?: number;
  onSelect: (f: SpecFile) => void;
  onSelectSuite?: (suiteId: string) => void;
  activeSuiteId?: string;
}) {
  const isFile = !!node.file;
  const isSuite = !isFile && !!node.suiteId;
  const isActiveSuite = isSuite && node.suiteId === activeSuiteId;
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
          isActiveSuite && "bg-accent/40 font-medium"
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
        />
      ))}
    </div>
  );
}

export default function ProjectSuite() {
  const { projectId } = useParams(); // route: /suite/:projectId
  const pid = projectId ?? "playwright-ts";
  const navigate = useNavigate();
  const { apiFetch } = useApi();
  const [branch, setBranch] = useState("main");
  const [specs, setSpecs] = useState<SpecFile[]>([]);
  const [activeSpec, setActiveSpec] = useState<SpecFile | null>(null);
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [runProjectId, setRunProjectId] = useState<string | null>(() => localStorage.getItem("tm:lastProjectId"));
  const [projectLoadErr, setProjectLoadErr] = useState<string | null>(null);
  const [specProjects, setSpecProjects] = useState<SpecProjectOption[]>([]);
  const [specProjectErr, setSpecProjectErr] = useState<string | null>(null);
  const [creatingSuite, setCreatingSuite] = useState(false);
  const [copyingSpec, setCopyingSpec] = useState(false);
  const [lockingSpec, setLockingSpec] = useState(false);
  const [copySelectOpen, setCopySelectOpen] = useState(false);
  const [specReloadKey, setSpecReloadKey] = useState(0);
  const [renamingSuite, setRenamingSuite] = useState(false);
  const [deletingSuite, setDeletingSuite] = useState(false);
  const [headful, setHeadful] = useState(false);
  const [reporter, setReporter] = useState<ReporterId>("json");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorContent, setEditorContent] = useState("");
  const [editorPath, setEditorPath] = useState<string | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);

  // load available spec projects (generated + curated)
  useEffect(() => {
    let active = true;
    fetch("/tm/suite/projects")
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
  const activeSuite = specProjects.find((proj) => proj.id === pid);
  const isActiveCurated = activeSuite?.type === "curated";
  const activeSpecLocked = useMemo(() => {
    if (!activeSuite || !activeSpec || !isActiveCurated) return false;
    return (activeSuite.locked || []).includes(activeSpec.path);
  }, [activeSuite, activeSpec, isActiveCurated]);
  const specTree = useMemo(() => buildTree(specs), [specs]);
  const suiteTree = useMemo(() => {
    return specProjects.map((proj) => ({
      name: proj.type === "curated" ? `${proj.name} (curated)` : proj.name,
      suiteId: proj.id,
      children: proj.id === pid ? cloneNodes(specTree) : undefined,
    }));
  }, [specProjects, specTree, pid]);

  async function handleCreateSuite() {
    const proposed = window.prompt("New suite name?");
    if (!proposed) return;
    const name = proposed.trim();
    if (!name) return;
    setCreatingSuite(true);
    try {
      const res = await fetch("/tm/suite/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
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
    try {
      const res = await fetch(`/tm/suite/projects/${targetId}/specs`, {
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
      setCopySelectOpen(false);
    }
  }

  async function handleToggleLock(nextLocked: boolean) {
    if (!activeSpec || !isActiveCurated || !activeSuite) return;
    setLockingSpec(true);
    try {
      const res = await fetch(`/tm/suite/projects/${activeSuite.id}/specs`, {
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

  async function handleRenameSuite() {
    if (!isActiveCurated || !activeSuite) return;
    const proposed = window.prompt("New suite name?", activeSuite.name);
    if (!proposed) return;
    const name = proposed.trim();
    if (!name || name === activeSuite.name) return;
    setRenamingSuite(true);
    try {
      const res = await fetch(`/tm/suite/projects/${activeSuite.id}`, {
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
      const res = await fetch(`/tm/suite/projects/${activeSuite.id}`, { method: "DELETE" });
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
    if (!isActiveCurated || !activeSuite) {
      setSpecProjectErr("Copy the spec into a curated suite before editing.");
      return;
    }
    setEditorLoading(true);
    setEditorPath(activeSpec.path);
    try {
      const qs = new URLSearchParams({ projectId: activeSuite.id, path: activeSpec.path });
      const res = await fetch(`/tm/suite/spec-content?${qs.toString()}`);
      if (!res.ok) {
        const text = await res.text().catch(() => "Failed to load spec content");
        throw new Error(text);
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
      const res = await fetch("/tm/suite/spec-content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: activeSuite.id, path: editorPath, content: editorContent }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Failed to save spec");
        throw new Error(text);
      }
      setEditorOpen(false);
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
    const qs = new URLSearchParams({ projectId: pid });
    fetch(`/tm/suite/specs?${qs.toString()}`)
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
  }, [pid, specReloadKey]);

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

  // load cases when a spec is selected
  useEffect(() => {
  if (!activeSpec) return;
  const qs = new URLSearchParams({ projectId: pid, path: activeSpec.path });
  fetch(`/tm/suite/cases?${qs.toString()}`)
    .then(async (r) => {
      if (!r.ok) {
        const text = await r.text().catch(() => "Failed to load cases");
        throw new Error(text);
      }
      return r.json();
    })
    .then((rows: CaseItem[]) => {
      setCases(rows);
      setSelected({});
    })
    .catch((err) => {
      console.error(err);
      setRunError(err instanceof Error ? err.message : "Failed to load cases");
    });
}, [pid, activeSpec]);


  const filtered = useMemo(
    () => (query ? cases.filter(c => c.title.toLowerCase().includes(query.toLowerCase())) : cases),
    [cases, query]
  );

  const selectedTitles = useMemo(
    () => cases.filter((c) => selected[`case:${c.title}`]).map((c) => c.title),
    [cases, selected]
  );
  const anySelected = selectedTitles.length > 0;

  function toggle(id: string, checked: boolean) {
    setSelected(s => ({ ...s, [id]: checked }));
  }
  function selectAll(checked: boolean) {
    const next: Record<string, boolean> = {};
    for (const c of filtered) next[`case:${c.title}`] = checked;
    setSelected(s => ({ ...s, ...next }));
  }

  async function handleRunSelection() {
    if (!activeSpec) {
      setRunError("Select a spec before running.");
      return;
    }
    if (!selectedTitles.length) {
      setRunError("Pick at least one test case.");
      return;
    }
    if (!runProjectId) {
      setRunError("Select a project to run against.");
      return;
    }

    const fragments = selectedTitles.map(escapeRegex);
    const grep =
      fragments.length === 1
        ? `^${fragments[0]}$`
        : `^(?:${fragments.join("|")})$`;

    setRunning(true);
    setRunError(null);
    try {
      const res = await apiFetch<{ id: string }>("/runner/run", {
        method: "POST",
        body: JSON.stringify({
          projectId: runProjectId,
          file: activeSpec.path,
          grep,
          headful,
          reporter,
        }),
      });
      setSelected({});
      if (res?.id) navigate(`/test-runs/${res.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start run";
      setRunError(msg);
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
    <div className="h-full grid grid-cols-[300px_1fr]">
      {/* Left: tree */}
      <div className="border-r">
        <div className="p-3 flex items-center gap-2">
          <FolderTree className="h-4 w-4" />
          <span className="font-medium">Spec Tree</span>
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
              open={copySelectOpen}
              onOpenChange={setCopySelectOpen}
              disabled={!activeSpec || copyingSpec}
              onValueChange={(val) => {
                if (val) handleCopySpec(val);
              }}
            >
              <SelectTrigger className="w-full justify-center">
                <SelectValue placeholder={copyingSpec ? "Copying..." : "Copy spec to suite"} />
              </SelectTrigger>
              <SelectContent>
                {curatedSuites.map((suite) => (
                  <SelectItem key={suite.id} value={suite.id}>
                    <span className="flex items-center gap-1">
                      <FileText className="h-3 w-3 opacity-70" />
                      {suite.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {isActiveCurated && activeSpec && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-center"
                onClick={handleEditSpec}
                disabled={editorLoading}
              >
                <FileText className="h-4 w-4 mr-1" />
                {editorLoading ? "Opening..." : "Edit spec"}
              </Button>
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
          {suiteTree.map((node) => (
            <TreeItem
              key={node.suiteId || node.name}
              node={node}
              onSelect={setActiveSpec}
              onSelectSuite={(suiteId) => {
                if (suiteId !== pid) navigate(`/suite/${suiteId}`);
              }}
              activeSuiteId={pid}
            />
          ))}
        </ScrollArea>
      </div>

      {/* Right: cases */}
      <div className="flex flex-col">
        {/* top bar */}
        <div className="flex items-center gap-2 p-3 border-b">
          <Select
            value={runProjectId ?? undefined}
            onValueChange={(val) => {
              setRunProjectId(val);
              localStorage.setItem("tm:lastProjectId", val);
            }}
          >
            <SelectTrigger className="w-[220px]" disabled={!projects.length}>
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

          <GitBranch className="h-4 w-4" />
          <Select value={branch} onValueChange={setBranch}>
            <SelectTrigger className="w-[180px]"><SelectValue placeholder="Branch" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="main">main</SelectItem>
              <SelectItem value="develop">develop</SelectItem>
            </SelectContent>
          </Select>

          <label className="flex items-center gap-2 text-xs text-slate-600">
            <Checkbox
              checked={headful}
              onCheckedChange={(val) => setHeadful(Boolean(val))}
            />
            Headed (capture media)
          </label>

          <Select value={reporter} onValueChange={(val) => setReporter(val as ReporterId)}>
            <SelectTrigger className="w-[160px]"><SelectValue placeholder="Reporter" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON only</SelectItem>
              <SelectItem value="allure">JSON + Allure</SelectItem>
            </SelectContent>
          </Select>

          <div className="relative flex-1 max-w-[480px] ml-2">
            <Search className="h-4 w-4 absolute left-2 top-1/2 -translate-y-1/2 opacity-60" />
            <Input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Search test titles…" className="pl-8" />
          </div>

          <Button variant="outline" onClick={()=>setSelected({})}>
            <RefreshCw className="h-4 w-4 mr-1" /> Clear
          </Button>

          {/* NOTE: wiring the Run button in Step 2 */}
          <Button disabled={!anySelected || !activeSpec || running} onClick={handleRunSelection}>
            <Play className="h-4 w-4 mr-1" /> {running ? "Starting..." : "Run selection"}
          </Button>
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
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-muted-foreground">{activeSpec.path}</div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={()=>selectAll(true)}>Select page</Button>
                  <Button variant="ghost" onClick={()=>selectAll(false)}>Clear page</Button>
                </div>
              </div>
              <Separator className="mb-3" />
              <div className="grid gap-2">
                {filtered.map(c => (
                  <div key={`case:${c.title}`} className="flex items-start gap-3 p-3 rounded-xl border">
                    <Checkbox
                      checked={!!selected[`case:${c.title}`]}
                      onCheckedChange={(v)=>toggle(`case:${c.title}`, Boolean(v))}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="font-medium leading-tight">{c.title}</div>
                      <div className="text-xs text-muted-foreground">line {c.line}</div>
                    </div>
                  </div>
                ))}
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
