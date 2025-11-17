// src/pages/ProjectSuite.tsx
import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { Separator } from "../components/ui/seperator";
import { ScrollArea } from "../components/ui/scroll-area";
import { FileText, FolderTree, ChevronDown, ChevronRight, GitBranch, Search, RefreshCw, Play } from "lucide-react";
import { cn } from "../lib/utils";
import { useNavigate, useParams } from "react-router-dom";
import { useApi } from "../lib/api";

type SpecFile = { path: string };
type CaseItem = { title: string; line: number };

type TreeNode = { name: string; children?: TreeNode[]; file?: SpecFile };
type ProjectOption = { id: string; name: string };
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

function TreeItem({
  node, depth = 0, onSelect,
}: { node: TreeNode; depth?: number; onSelect: (f: SpecFile) => void }) {
  const [open, setOpen] = useState(true);
  const isFile = !!node.file;
  return (
    <div>
      <div
        className={cn("flex items-center gap-2 py-1 px-2 rounded cursor-pointer hover:bg-accent/30")}
        style={{ paddingLeft: depth * 12 }}
        onClick={() => (isFile ? onSelect(node.file!) : setOpen((o) => !o))}
      >
        {isFile ? <FileText className="h-4 w-4 opacity-70" /> : open ? <ChevronDown className="h-4 w-4 opacity-70" /> : <ChevronRight className="h-4 w-4 opacity-70" />}
        <span className="text-sm">{node.name}</span>
      </div>
      {!isFile && open && node.children?.map((c) => (
        <TreeItem key={node.name + "/" + c.name} node={c} depth={depth + 1} onSelect={onSelect} />
      ))}
    </div>
  );
}

export default function ProjectSuite() {
  const { projectId } = useParams(); // route: /projects/:projectId/suite
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
  const [headful, setHeadful] = useState(false);
  const [reporter, setReporter] = useState<ReporterId>("json");

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
}, [pid]);

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


  const tree = useMemo(() => buildTree(specs), [specs]);
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
    <div className="h-full grid grid-cols-[300px_1fr]">
      {/* Left: tree */}
      <div className="border-r">
        <div className="p-3 flex items-center gap-2">
          <FolderTree className="h-4 w-4" />
          <span className="font-medium">Spec Tree</span>
        </div>
        <Separator />
        <ScrollArea className="h-[calc(100vh-64px)] p-2">
          {tree.map(n => <TreeItem key={n.name} node={n} onSelect={setActiveSpec} />)}
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
        {(runError || projectLoadErr) && (
          <div className="px-3 pb-2 text-xs text-rose-600">
            {runError || projectLoadErr}
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
  );
}
