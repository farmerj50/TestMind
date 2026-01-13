// src/pages/ProjectSuite.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { Separator } from "../components/ui/seperator";
import { ScrollArea } from "../components/ui/scroll-area";
import { FileText, FolderTree, ChevronDown, ChevronRight, GitBranch, Search, RefreshCw, Play, Plus } from "lucide-react";
import { cn } from "../lib/utils";
import { useNavigate, useParams, Link, useLocation } from "react-router-dom";
import { useAuth } from "@clerk/clerk-react";
import { toast } from "sonner";
import { useApi, apiUrl } from "../lib/api";
import HowToHint from "../components/HowToHint";
import GlobalActionsMenu from "../components/spec-tree/GlobalActionsMenu";
import SuiteActionsMenu from "../components/spec-tree/SuiteActionsMenu";
import SpecActionsMenu from "../components/spec-tree/SpecActionsMenu";
import FolderActionsMenu from "../components/spec-tree/FolderActionsMenu";
import SpecPickerModal, { NEW_FOLDER_VALUE } from "../components/spec-tree/SpecPickerModal";
import FolderDeleteModal from "../components/spec-tree/FolderDeleteModal";

type SpecFile = { path: string };
type CaseItem = { title: string; line: number; specPath?: string };

type TreeNode = { name: string; path?: string; children?: TreeNode[]; file?: SpecFile; suiteId?: string };
type ProjectOption = { id: string; name: string };
type SpecProjectOption = { id: string; name: string; type: "generated" | "curated"; locked?: string[] };
type ReporterId = "json" | "allure";
type SuiteFolderState = {
  folders: string[];
  folderIds: Record<string, string>;
  specFolders: Record<string, string>;
  specAliases: Record<string, string>;
  deletedSpecs: Record<string, boolean>;
};

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

function buildExactGrep(titles: string[]) {
  if (!titles.length) return "";
  const escaped = titles.map(escapeRegex);
  const body = escaped.length === 1 ? escaped[0] : `(?:${escaped.join("|")})`;
  return `^${body}$`;
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

function buildTree(
  specs: SpecFile[],
  getDisplayPath: (spec: SpecFile) => string,
  folders: string[]
): TreeNode[] {
  const root: Record<string, any> = {};
  const ensureFolder = (folderPath: string) => {
    const parts = folderPath.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part) => {
      node.children ||= {};
      node.children[part] ||= { name: part, children: {} };
      node = node.children[part];
    });
  };

  folders.forEach((folder) => {
    const normalized = normalizeFolderPath(folder);
    if (normalized) ensureFolder(normalized);
  });

  for (const s of specs) {
    const parts = getDisplayPath(s).split("/");
    let node = root;
    parts.forEach((part, idx) => {
      node.children ||= {};
      node.children[part] ||= { name: part, children: {} };
      if (idx === parts.length - 1) node.children[part].file = s;
      node = node.children[part];
    });
  }
  const toArray = (n: any, prefix = ""): TreeNode[] => {
    if (!n.children) return [];
    const out: TreeNode[] = Object.values(n.children).map((c: any) => ({
      name: c.name,
      path: prefix ? `${prefix}/${c.name}` : c.name,
      file: c.file,
      children: toArray(c, prefix ? `${prefix}/${c.name}` : c.name),
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
  renderActions,
}: {
  node: TreeNode;
  depth?: number;
  onSelect: (f: SpecFile) => void;
  onSelectSuite?: (suiteId: string) => void;
  activeSuiteId?: string;
  activePath?: string | null;
  renderActions?: (node: TreeNode, info: { isFile: boolean; isSuite: boolean; isActiveSuite: boolean; isActiveFile: boolean }) => React.ReactNode;
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
          "group relative flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer border-l-2 border-transparent transition-colors hover:bg-white/30",
          isActiveSuite && "bg-white/30 font-medium border-white/70",
          isActiveFile && "bg-white/90 font-medium border-white shadow-sm"
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
        {renderActions && (
          <div className="ml-auto flex h-7 w-7 items-center justify-center" onClick={(event) => event.stopPropagation()}>
            <div className="opacity-0 transition-opacity group-hover:opacity-100">
              {renderActions(node, { isFile, isSuite, isActiveSuite, isActiveFile })}
            </div>
          </div>
        )}
      </div>
      {!isFile && open && node.children?.map((c) => (
        <TreeItem
          key={c.path || `${node.name}/${c.name}`}
          node={c}
          depth={depth + 1}
          onSelect={onSelect}
          onSelectSuite={onSelectSuite}
          activeSuiteId={activeSuiteId}
          activePath={activePath}
          renderActions={renderActions}
        />
      ))}
    </div>
  );
}

const DEFAULT_FOLDER_STATE: SuiteFolderState = {
  folders: [],
  folderIds: {},
  specFolders: {},
  specAliases: {},
  deletedSpecs: {},
};

function normalizeFolderPath(value: string) {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
}

function createFolderId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeFolderStateWithChange(state: SuiteFolderState) {
  let changed = false;
  const folderIds = { ...(state.folderIds || {}) };
  const normalizedFolders = state.folders
    .map((folder) => normalizeFolderPath(folder))
    .filter(Boolean);
  const uniqueFolders = Array.from(new Set(normalizedFolders));
  uniqueFolders.forEach((folder) => {
    if (!folderIds[folder]) {
      folderIds[folder] = createFolderId();
      changed = true;
    }
  });
  if (uniqueFolders.length !== state.folders.length) {
    changed = true;
  }
  if (!changed) return { state, changed };
  return { state: { ...state, folders: uniqueFolders, folderIds }, changed };
}

function normalizeFolderState(state: SuiteFolderState) {
  return normalizeFolderStateWithChange(state).state;
}

function getFolderParent(path: string) {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return "";
  const parts = normalized.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function getFolderName(path: string) {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return "";
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function replaceFolderPrefix(path: string, fromPrefix: string, toPrefix: string) {
  if (!path) return path;
  if (path === fromPrefix) return toPrefix;
  const prefix = `${fromPrefix}/`;
  if (!path.startsWith(prefix)) return path;
  const suffix = path.slice(prefix.length);
  return toPrefix ? `${toPrefix}/${suffix}` : suffix;
}

function folderStateKey(suiteId: string) {
  return `tm:suite-folders:${suiteId}`;
}

function readFolderState(suiteId: string): SuiteFolderState {
  if (typeof window === "undefined") return { ...DEFAULT_FOLDER_STATE };
  try {
    const raw = window.localStorage.getItem(folderStateKey(suiteId));
    if (!raw) return { ...DEFAULT_FOLDER_STATE };
    const parsed = JSON.parse(raw) as SuiteFolderState;
    const { state: normalized, changed } = normalizeFolderStateWithChange({
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      folderIds: parsed.folderIds || {},
      specFolders: parsed.specFolders || {},
      specAliases: parsed.specAliases || {},
      deletedSpecs: parsed.deletedSpecs || {},
    });
    if (changed) {
      writeFolderState(suiteId, normalized);
    }
    return normalized;
  } catch {
    return { ...DEFAULT_FOLDER_STATE };
  }
}

function writeFolderState(suiteId: string, state: SuiteFolderState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(folderStateKey(suiteId), JSON.stringify(state));
}

export default function ProjectSuite() {
  const { projectId } = useParams(); // route: /suite/:projectId
  const pid = projectId ?? "playwright-ts";
  const navigate = useNavigate();
  const location = useLocation();
  const { apiFetch, apiFetchRaw } = useApi();
  const { isLoaded, isSignedIn } = useAuth();
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"copy" | "move">("copy");
  const [pickerSpecPath, setPickerSpecPath] = useState<string | null>(null);
  const [pickerSuiteId, setPickerSuiteId] = useState("");
  const [pickerFolder, setPickerFolder] = useState("");
  const [pickerNewFolder, setPickerNewFolder] = useState("");
  const [pickerNewName, setPickerNewName] = useState("");
  const [pickerBusy, setPickerBusy] = useState(false);
  const [suiteFolderState, setSuiteFolderState] = useState<SuiteFolderState>(() => readFolderState(pid));
  const [specReloadKey, setSpecReloadKey] = useState(0);
  const [renamingSuite, setRenamingSuite] = useState(false);
  const [syncingSuite, setSyncingSuite] = useState<false | "replaceSuite" | "overwriteMatches" | "addMissing">(false);
  const [deletingSpec, setDeletingSpec] = useState(false);
  const [deletingSuite, setDeletingSuite] = useState(false);
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<{
    suiteId: string;
    folderPath: string;
    folderName: string;
    hasSubfolders: boolean;
  } | null>(null);
  const [deleteSubfolders, setDeleteSubfolders] = useState(false);
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
    setSuiteFolderState(readFolderState(pid));
  }, [pid]);

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
    if (!isLoaded || !isSignedIn) return;
    let active = true;
    apiFetchRaw(apiUrl("/tm/suite/projects"))
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
  }, [pid, navigate, apiFetchRaw, isLoaded, isSignedIn]);

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
  const canCopySpec = !!activeSpec && curatedSuites.length > 0;
  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    projects.forEach((project) => {
      map.set(project.id, project.name);
    });
    return map;
  }, [projects]);
  const replaceProjectIds = (rawPath: string) => {
    const normalized = rawPath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    const replaceAt = (idx: number) => {
      const name = projectNameById.get(parts[idx]);
      if (name) parts[idx] = name;
    };
    if (parts[0] === "recordings" && parts.length > 1) {
      replaceAt(1);
    } else {
      replaceAt(0);
    }
    return parts.join("/");
  };
  const getSpecDisplayPath = (spec: SpecFile, state: SuiteFolderState) => {
    const folder = state.specFolders[spec.path];
    const alias = state.specAliases[spec.path];
    const displayPath = replaceProjectIds(spec.path);
    const base = displayPath.split("/").pop() || displayPath;
    if (!folder) {
      if (!alias) return displayPath;
      return displayPath.replace(base, alias.trim());
    }
    const normalizedFolder = normalizeFolderPath(folder);
    const displayBase = alias?.trim() || base;
    if (!normalizedFolder) return displayPath.replace(base, displayBase);
    const renamed = displayPath.replace(base, displayBase);
    return `${normalizedFolder}/${renamed}`;
  };
  const getSpecDisplayFolder = (spec: SpecFile, state: SuiteFolderState) => {
    const displayPath = getSpecDisplayPath(spec, state);
    const parts = displayPath.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
  };
  const formatDisplayPath = (specPath?: string | null) => {
    if (!specPath) return "";
    const displayPath = replaceProjectIds(specPath);
    const alias = suiteFolderState.specAliases[specPath];
    if (!alias) return displayPath;
    const parts = displayPath.split("/");
    parts[parts.length - 1] = alias;
    return parts.join("/");
  };
  const specTree = useMemo(
    () =>
      buildTree(
        specs,
        (spec) => getSpecDisplayPath(spec, suiteFolderState),
        suiteFolderState.folders
      ),
    [specs, suiteFolderState, projectNameById]
  );
  const suiteTree = useMemo(() => {
    const toNode = (proj: SpecProjectOption) => ({
      name: proj.name,
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
  const suiteLookup = useMemo(() => {
    const map = new Map<string, SpecProjectOption>();
    specProjects.forEach((suite) => {
      map.set(suite.id, suite);
    });
    return map;
  }, [specProjects]);
  const curatedSuiteOptions = useMemo(
    () => curatedSuites.map((suite) => ({ id: suite.id, name: suite.name })),
    [curatedSuites]
  );

  useEffect(() => {
    if (!specProjects.length) return;
    if (!specProjects.some((proj) => proj.id === pid)) return;
    if (typeof window === "undefined") return;
    localStorage.setItem("tm:lastSuiteId", pid);
  }, [pid, specProjects]);

  const resolveSuite = (suiteId?: string | null) =>
    specProjects.find((proj) => proj.id === suiteId) || activeSuite || null;

  const formatSpecName = (specPath?: string | null) => {
    if (!specPath) return "spec";
    const normalized = specPath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    return parts[parts.length - 1] || normalized;
  };

  const formatSuiteName = (suiteId?: string | null) => {
    if (!suiteId) return "suite";
    return specProjects.find((proj) => proj.id === suiteId)?.name || suiteId;
  };

  const getSuiteFolderState = (suiteId: string) =>
    suiteId === pid ? suiteFolderState : readFolderState(suiteId);

  const updateSuiteFolderState = (suiteId: string, updater: (state: SuiteFolderState) => SuiteFolderState) => {
    const current = getSuiteFolderState(suiteId);
    const next = normalizeFolderState(updater(current));
    writeFolderState(suiteId, next);
    if (suiteId === pid) {
      setSuiteFolderState(next);
    }
  };

  const listFolderOptions = (suiteId: string) => {
    const state = getSuiteFolderState(suiteId);
    const fromSpecs = Object.values(state.specFolders || {}).filter(Boolean);
    return Array.from(new Set([...state.folders, ...fromSpecs])).sort((a, b) => a.localeCompare(b));
  };

  const addFolderToSuite = (suiteId: string, rawFolder: string) => {
    const normalized = normalizeFolderPath(rawFolder);
    if (!normalized) return false;
    let added = false;
    updateSuiteFolderState(suiteId, (state) => {
      const exists = state.folders.some((folder) => folder === normalized);
      if (!exists) added = true;
      return exists ? state : { ...state, folders: [...state.folders, normalized] };
    });
    return added;
  };

  const setSpecFolder = (suiteId: string, specPath: string, folderPath: string) => {
    const normalized = normalizeFolderPath(folderPath);
    updateSuiteFolderState(suiteId, (state) => ({
      ...state,
      specFolders: { ...state.specFolders, [specPath]: normalized },
    }));
  };

  const setSpecAlias = (suiteId: string, specPath: string, alias: string) => {
    updateSuiteFolderState(suiteId, (state) => ({
      ...state,
      specAliases: { ...state.specAliases, [specPath]: alias },
    }));
  };

  const markSpecDeleted = (suiteId: string, specPath: string) => {
    updateSuiteFolderState(suiteId, (state) => ({
      ...state,
      deletedSpecs: { ...state.deletedSpecs, [specPath]: true },
    }));
  };

  const openDeleteFolderModal = (suiteId: string, folderPath: string, hasSubfolders: boolean) => {
    const normalized = normalizeFolderPath(folderPath);
    if (!normalized) return;
    setDeleteSubfolders(false);
    setFolderDeleteTarget({
      suiteId,
      folderPath: normalized,
      folderName: getFolderName(normalized),
      hasSubfolders,
    });
  };

  const deleteFolderInSuite = (suiteId: string, folderPath: string, options?: { deleteSubfolders?: boolean }) => {
    const normalized = normalizeFolderPath(folderPath);
    if (!normalized) return;
    const parentPath = getFolderParent(normalized);
    updateSuiteFolderState(suiteId, (state) => {
      const nextSpecFolders = { ...state.specFolders };
      if (suiteId === pid) {
        specs.forEach((spec) => {
          const displayFolder = getSpecDisplayFolder(spec, state);
          if (!displayFolder) return;
          if (displayFolder === normalized || displayFolder.startsWith(`${normalized}/`)) {
            const nextFolder = options?.deleteSubfolders
              ? parentPath
              : replaceFolderPrefix(displayFolder, normalized, parentPath);
            if (nextFolder) {
              nextSpecFolders[spec.path] = nextFolder;
            } else {
              delete nextSpecFolders[spec.path];
            }
          }
        });
      }

      const folderMoves = new Map<string, string>();
      const nextFolders = state.folders
        .map((folder) => normalizeFolderPath(folder))
        .filter(Boolean)
        .flatMap((folder) => {
          if (folder === normalized) return [];
          if (folder.startsWith(`${normalized}/`)) {
            if (options?.deleteSubfolders) return [];
            const nextPath = replaceFolderPrefix(folder, normalized, parentPath);
            folderMoves.set(folder, nextPath);
            return [nextPath];
          }
          return [folder];
        });
      const uniqueFolders = Array.from(new Set(nextFolders));
      const nextFolderIds: Record<string, string> = {};
      const nextFolderSet = new Set(uniqueFolders);
      Object.entries(state.folderIds || {}).forEach(([path, id]) => {
        const normalizedPath = normalizeFolderPath(path);
        const nextPath = folderMoves.get(normalizedPath) || normalizedPath;
        if (nextFolderSet.has(nextPath)) {
          nextFolderIds[nextPath] = id;
        }
      });

      return {
        ...state,
        folders: uniqueFolders,
        folderIds: nextFolderIds,
        specFolders: nextSpecFolders,
      };
    });
  };

  const renameFolderInSuite = (suiteId: string, folderPath: string, rawName: string) => {
    const normalized = normalizeFolderPath(folderPath);
    const proposed = normalizeFolderPath(rawName);
    if (!normalized || !proposed) return;
    const parentPath = getFolderParent(normalized);
    const nextPath = parentPath ? `${parentPath}/${proposed}` : proposed;
    if (nextPath === normalized) return;
    updateSuiteFolderState(suiteId, (state) => {
      const nextSpecFolders = { ...state.specFolders };
      if (suiteId === pid) {
        specs.forEach((spec) => {
          const displayFolder = getSpecDisplayFolder(spec, state);
          if (!displayFolder) return;
          if (displayFolder === normalized || displayFolder.startsWith(`${normalized}/`)) {
            const nextFolder = replaceFolderPrefix(displayFolder, normalized, nextPath);
            if (nextFolder) {
              nextSpecFolders[spec.path] = nextFolder;
            } else {
              delete nextSpecFolders[spec.path];
            }
          }
        });
      }

      const folderMoves = new Map<string, string>();
      const nextFolders = state.folders
        .map((folder) => normalizeFolderPath(folder))
        .filter(Boolean)
        .map((folder) => {
          if (folder === normalized || folder.startsWith(`${normalized}/`)) {
            const nextFolder = replaceFolderPrefix(folder, normalized, nextPath);
            folderMoves.set(folder, nextFolder);
            return nextFolder;
          }
          return folder;
        });
      const uniqueFolders = Array.from(new Set(nextFolders));
      const nextFolderIds: Record<string, string> = {};
      const nextFolderSet = new Set(uniqueFolders);
      Object.entries(state.folderIds || {}).forEach(([path, id]) => {
        const normalizedPath = normalizeFolderPath(path);
        const nextFolder = folderMoves.get(normalizedPath) || normalizedPath;
        if (nextFolderSet.has(nextFolder)) {
          nextFolderIds[nextFolder] = id;
        }
      });

      return {
        ...state,
        folders: uniqueFolders,
        folderIds: nextFolderIds,
        specFolders: nextSpecFolders,
      };
    });
  };

  const handleFolderAction = (folderPath: string, actionId: string, hasSubfolders: boolean) => {
    switch (actionId) {
      case "rename_folder": {
        const proposed = window.prompt("Rename folder?", getFolderName(folderPath));
        if (!proposed) return;
        const normalized = normalizeFolderPath(folderPath);
        const nextName = normalizeFolderPath(proposed);
        if (!normalized || !nextName) return;
        const parentPath = getFolderParent(normalized);
        const nextPath = parentPath ? `${parentPath}/${nextName}` : nextName;
        if (nextPath === normalized) return;
        renameFolderInSuite(pid, folderPath, proposed);
        toast.success(`Renamed folder ${getFolderName(folderPath)}`);
        break;
      }
      case "new_subfolder": {
        const proposed = window.prompt("New folder name?");
        if (!proposed) return;
        const normalized = normalizeFolderPath(proposed);
        if (!normalized) return;
        const nextPath = normalizeFolderPath(`${folderPath}/${normalized}`);
        if (addFolderToSuite(pid, nextPath)) {
          toast.success(`Added folder ${nextPath}`);
        }
        break;
      }
      case "delete_folder":
        openDeleteFolderModal(pid, folderPath, hasSubfolders);
        break;
      default:
        break;
    }
  };

  const pickerFolderOptions = useMemo(() => {
    if (!pickerSuiteId) return [];
    return listFolderOptions(pickerSuiteId);
  }, [pickerSuiteId, suiteFolderState]);

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
      const res = await apiFetchRaw(apiUrl("/tm/suite/projects"), {
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
        toast.success(`Created suite ${project.name}`);
      }
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Failed to create suite";
      setSpecProjectErr(message);
      toast.error(message);
    } finally {
      setCreatingSuite(false);
    }
  }

  async function copySpecToSuite(
    specPath: string,
    targetId: string,
    sourceId?: string,
    options?: { silent?: boolean; targetLabel?: string; folderLabel?: string }
  ) {
    setCopyingSpec(true);
    setSpecProjectErr(null);
    try {
      const res = await apiFetchRaw(apiUrl(`/tm/suite/projects/${targetId}/specs`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: specPath, sourceProjectId: sourceId || pid }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Failed to copy spec");
        throw new Error(text);
      }
      if (targetId === pid) {
        setSpecReloadKey((k) => k + 1);
      }
      if (!options?.silent) {
        const specLabel = formatSpecName(specPath);
        const suiteLabel = options?.targetLabel || formatSuiteName(targetId);
        const folderLabel = options?.folderLabel ? ` / ${options.folderLabel}` : "";
        toast.success(`Copied ${specLabel} -> ${suiteLabel}${folderLabel}`);
      }
      setSpecProjectErr(null);
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Failed to copy spec";
      setSpecProjectErr(message);
      if (!options?.silent) {
        toast.error(message);
      }
      throw err;
    } finally {
      setCopyingSpec(false);
    }
  }

  async function handleCopySpec(targetId: string) {
    if (!activeSpec) return;
    if (!curatedSuites.length) {
      setSpecProjectErr("Create a curated suite first.");
      return;
    }
    await copySpecToSuite(activeSpec.path, targetId, pid);
  }

  async function handleToggleLock(nextLocked: boolean, specPath?: string, suiteId?: string | null) {
    const suite = resolveSuite(suiteId);
    if (!suite || suite.type !== "curated") return;
    const spec = specPath ? { path: specPath } : activeSpec;
    if (!spec) return;
    setLockingSpec(true);
    try {
      const res = await apiFetchRaw(apiUrl(`/tm/suite/projects/${suite.id}/specs`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: spec.path, locked: nextLocked }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Failed to update lock status");
        throw new Error(text);
      }
      const data = await res.json().catch(() => null);
      const lockedList = (data?.locked as string[]) || [];
      setSpecProjects((prev) =>
        prev.map((proj) => (proj.id === suite.id ? { ...proj, locked: lockedList } : proj))
      );
      setSpecProjectErr(null);
      toast.success(`${nextLocked ? "Locked" : "Unlocked"} ${formatSpecName(spec.path)}`);
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Failed to update lock";
      setSpecProjectErr(message);
      toast.error(message);
    } finally {
      setLockingSpec(false);
    }
  }

  const handleGlobalAction = (actionId: string) => {
    switch (actionId) {
      case "new_suite":
        void handleCreateSuite();
        break;
      case "copy_spec":
        if (!activeSpec) {
          const message = "Select a spec to copy first.";
          setSpecProjectErr(message);
          toast.error(message);
          break;
        }
        if (!curatedSuites.length) {
          const message = "Create a curated suite first.";
          setSpecProjectErr(message);
          toast.error(message);
          break;
        }
        setPickerMode("copy");
        setPickerSpecPath(activeSpec.path);
        setPickerSuiteId(curatedSuites[0]?.id || "");
        setPickerFolder("");
        setPickerNewFolder("");
        setPickerNewName("");
        setPickerOpen(true);
        break;
      case "new_folder": {
        if (!activeSuite) break;
        const folderName = window.prompt("Folder name?");
        if (!folderName) break;
        const normalized = normalizeFolderPath(folderName);
        if (!normalized) break;
        if (addFolderToSuite(activeSuite.id, normalized)) {
          toast.success(`Added folder ${normalized}`);
        }
        break;
      }
      case "add_regression_folder":
        if (!activeSuite) break;
        if (addFolderToSuite(activeSuite.id, "regression")) {
          toast.success("Added folder regression");
        }
        break;
      case "add_shared_steps_folder":
        if (!activeSuite) break;
        if (addFolderToSuite(activeSuite.id, "shared-steps")) {
          toast.success("Added folder shared-steps");
        }
        break;
      default:
        break;
    }
  };

  const handleSuiteAction = (suiteId: string, actionId: string) => {
    switch (actionId) {
      case "rename_suite":
        void handleRenameSuite(suiteId);
        break;
      case "delete_suite":
        void handleDeleteSuite(suiteId);
        break;
      case "replace_suite_from_generated":
        void handleSyncSuite("replaceSuite", suiteId);
        break;
      case "overwrite_matches_only":
        void handleSyncSuite("overwriteMatches", suiteId);
        break;
      case "add_missing_only":
        void handleSyncSuite("addMissing", suiteId);
        break;
      case "copy_spec_into_suite":
        if (!activeSpec) {
          const message = "Select a spec to copy first.";
          setSpecProjectErr(message);
          toast.error(message);
          break;
        }
        setPickerMode("copy");
        setPickerSpecPath(activeSpec.path);
        setPickerSuiteId(suiteId);
        setPickerFolder("");
        setPickerNewFolder("");
        setPickerNewName("");
        setPickerOpen(true);
        break;
      case "new_folder": {
        const folderName = window.prompt("Folder name?");
        if (!folderName) break;
        const normalized = normalizeFolderPath(folderName);
        if (!normalized) break;
        if (addFolderToSuite(suiteId, normalized)) {
          toast.success(`Added folder ${normalized}`);
        }
        break;
      }
      case "add_regression_folder":
        if (addFolderToSuite(suiteId, "regression")) {
          toast.success("Added folder regression");
        }
        break;
      case "add_shared_steps_folder":
        if (addFolderToSuite(suiteId, "shared-steps")) {
          toast.success("Added folder shared-steps");
        }
        break;
      default:
        break;
    }
  };

  const handleSpecAction = (specPath: string, actionId: string) => {
    switch (actionId) {
      case "edit_spec":
        void handleEditSpec(specPath, pid);
        break;
      case "lock_spec":
        void handleToggleLock(true, specPath, pid);
        break;
      case "unlock_spec":
        void handleToggleLock(false, specPath, pid);
        break;
      case "copy_spec":
        setActiveSpec({ path: specPath });
        if (!curatedSuites.length) {
          const message = "Create a curated suite first.";
          setSpecProjectErr(message);
          toast.error(message);
          break;
        }
        setPickerMode("copy");
        setPickerSpecPath(specPath);
        setPickerSuiteId(curatedSuites[0]?.id || "");
        setPickerFolder("");
        setPickerNewFolder("");
        setPickerNewName("");
        setPickerOpen(true);
        break;
      case "move_spec":
        if (!isActiveCurated) {
          const message = "Move is only available for curated suites.";
          setSpecProjectErr(message);
          toast.error(message);
          break;
        }
        setPickerMode("move");
        setPickerSpecPath(specPath);
        setPickerSuiteId(curatedSuites[0]?.id || "");
        setPickerFolder("");
        setPickerNewFolder("");
        setPickerNewName("");
        setPickerOpen(true);
        break;
      case "delete_spec":
        void handleDeleteSpec(specPath, pid);
        break;
      default:
        break;
    }
  };

  const handlePickerClose = () => {
    if (pickerBusy) return;
    setPickerOpen(false);
  };

  const handlePickerConfirm = async () => {
    if (!pickerSpecPath || !pickerSuiteId) return;
    if (pickerMode === "copy" && pickerSuiteId === pid) {
      const message = "Pick a different suite to copy into.";
      setSpecProjectErr(message);
      toast.error(message);
      return;
    }
    setPickerBusy(true);
    try {
      const targetSuiteId = pickerSuiteId;
      const folderSelection = pickerFolder === NEW_FOLDER_VALUE ? pickerNewFolder : pickerFolder;
      const normalizedFolder = normalizeFolderPath(folderSelection);
      if (normalizedFolder) {
        if (addFolderToSuite(targetSuiteId, normalizedFolder)) {
          toast.success(`Added folder ${normalizedFolder}`);
        }
        setSpecFolder(targetSuiteId, pickerSpecPath, normalizedFolder);
      } else if (pickerMode === "move" && targetSuiteId === pid) {
        setSpecFolder(targetSuiteId, pickerSpecPath, "");
      }
      if (pickerMode === "copy") {
        await copySpecToSuite(pickerSpecPath, targetSuiteId, pid, { silent: true });
        if (pickerNewName.trim()) {
          setSpecAlias(targetSuiteId, pickerSpecPath, pickerNewName.trim());
        }
        const specLabel = pickerNewName.trim() || formatSpecName(pickerSpecPath);
        const suiteLabel = formatSuiteName(targetSuiteId);
        const folderLabel = normalizedFolder ? ` / ${normalizedFolder}` : "";
        toast.success(`Copied ${specLabel} -> ${suiteLabel}${folderLabel}`);
      } else {
        if (targetSuiteId === pid) {
          if (pickerNewName.trim()) {
            setSpecAlias(targetSuiteId, pickerSpecPath, pickerNewName.trim());
          }
          const specLabel = pickerNewName.trim() || formatSpecName(pickerSpecPath);
          const destination = normalizedFolder ? `folder ${normalizedFolder}` : "suite root";
          toast.success(`Moved ${specLabel} to ${destination}`);
        } else {
          await copySpecToSuite(pickerSpecPath, targetSuiteId, pid, { silent: true });
          if (pickerNewName.trim()) {
            setSpecAlias(targetSuiteId, pickerSpecPath, pickerNewName.trim());
          }
          if (isActiveCurated) {
            await handleDeleteSpec(pickerSpecPath, pid, { silent: true });
          }
          const specLabel = pickerNewName.trim() || formatSpecName(pickerSpecPath);
          const suiteLabel = formatSuiteName(targetSuiteId);
          const folderLabel = normalizedFolder ? ` / ${normalizedFolder}` : "";
          toast.success(`Moved ${specLabel} -> ${suiteLabel}${folderLabel}`);
        }
      }
      setPickerOpen(false);
    } catch {
      // errors handled in called functions
    } finally {
      setPickerBusy(false);
    }
  };

  async function handleDeleteSpec(
    specPath?: string,
    suiteId?: string | null,
    options?: { silent?: boolean }
  ) {
    const suite = resolveSuite(suiteId);
    if (!suite) return;
    const spec = specPath ? { path: specPath } : activeSpec;
    if (!spec) return;
    setDeletingSpec(true);
    try {
      const res = await apiFetchRaw(
        apiUrl(`/tm/suite/projects/${suite.id}/specs?path=${encodeURIComponent(spec.path)}`),
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
        }
      );
      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => "Failed to delete spec");
        throw new Error(text);
      }
      setSpecReloadKey((k) => k + 1);
      setSpecProjectErr(null);
      if (activeSpec?.path === spec.path) {
        setActiveSpec(null);
      }
      setSpecs((prev) => prev.filter((item) => item.path !== spec.path));
      updateSuiteFolderState(suite.id, (state) => {
        const { [spec.path]: _removedFolder, ...nextFolders } = state.specFolders;
        const { [spec.path]: _removedAlias, ...nextAliases } = state.specAliases;
        return { ...state, specFolders: nextFolders, specAliases: nextAliases };
      });
      markSpecDeleted(suite.id, spec.path);
      if (!options?.silent) {
        toast.success(`Deleted ${formatSpecName(spec.path)}`);
      }
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Failed to delete spec";
      setSpecProjectErr(message);
      toast.error(message);
    } finally {
      setDeletingSpec(false);
    }
  }

  async function handleSyncSuite(
    mode: "replaceSuite" | "overwriteMatches" | "addMissing",
    suiteId?: string | null
  ) {
    const suite = resolveSuite(suiteId);
    if (!suite || suite.type !== "curated") return;
    setSyncingSuite(mode);
    try {
      const res = await apiFetchRaw(apiUrl(`/tm/suite/projects/${suite.id}/sync-from-generated`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adapterId: "playwright-ts", mode }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Failed to sync suite");
        throw new Error(text);
      }
      const data = await res.json().catch(() => null);
      if (data?.project?.id && data?.project?.name) {
        setSpecProjects((prev) => {
          const filtered = prev.filter((p) => p.id !== data.project.id);
          return [...filtered, data.project];
        });
      }
      if (data?.suiteId && data.suiteId !== suite.id) {
        navigate(`/suite/${data.suiteId}`);
        return;
      }
      setSpecReloadKey((k) => k + 1);
      setSpecProjectErr(null);
      if (mode === "replaceSuite") {
        toast.success(`Synced ${suite.name} from generated`);
      } else if (mode === "overwriteMatches") {
        toast.success(`Overwrote matching specs in ${suite.name}`);
      } else {
        toast.success(`Added missing specs to ${suite.name}`);
      }
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Failed to sync suite";
      setSpecProjectErr(message);
      toast.error(message);
    } finally {
      setSyncingSuite(false);
    }
  }

  async function handleRenameSuite(suiteId?: string | null) {
    const suite = resolveSuite(suiteId);
    if (!suite || suite.type !== "curated") return;
    const proposed = window.prompt("New suite name?", suite.name);
    if (!proposed) return;
    const name = proposed.trim();
    if (!name || name === suite.name) return;
    setRenamingSuite(true);
    try {
      const res = await apiFetchRaw(apiUrl(`/tm/suite/projects/${suite.id}`), {
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
      toast.success(`Renamed suite to ${name}`);
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Failed to rename suite";
      setSpecProjectErr(message);
      toast.error(message);
    } finally {
      setRenamingSuite(false);
    }
  }

  async function handleDeleteSuite(suiteId?: string | null) {
    const suite = resolveSuite(suiteId);
    if (!suite || suite.type !== "curated") return;
    const confirmDelete = window.confirm(`Delete suite "${suite.name}"? This cannot be undone.`);
    if (!confirmDelete) return;
    setDeletingSuite(true);
    try {
      const res = await apiFetchRaw(apiUrl(`/tm/suite/projects/${suite.id}`), { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const text = await res.text().catch(() => "Failed to delete suite");
        throw new Error(text);
      }
      setSpecProjects((prev) => prev.filter((proj) => proj.id !== suite.id));
      if (suite.id === pid) {
        const fallback = specProjects.find((proj) => proj.id !== suite.id)?.id || "playwright-ts";
        navigate(`/suite/${fallback}`);
      }
      setSpecProjectErr(null);
      toast.success(`Deleted suite ${suite.name}`);
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Failed to delete suite";
      setSpecProjectErr(message);
      toast.error(message);
    } finally {
      setDeletingSuite(false);
    }
  }

  async function handleEditSpec(specPath?: string, suiteId?: string | null) {
    const suite = resolveSuite(suiteId);
    const spec = specPath ? { path: specPath } : activeSpec;
    if (specPath && (!activeSpec || activeSpec.path !== specPath)) {
      setActiveSpec({ path: specPath });
    }
    if (!spec) {
      setRunError("Select a spec before editing.");
      return;
    }
    if (!suite || suite.type !== "curated") {
      setSpecProjectErr("Edit is only available for curated suites. Copy this spec into a curated suite first.");
      return;
    }
    if (spec.path.startsWith("(")) {
      setSpecProjectErr("Pick a specific spec (not the suite aggregate) before editing.");
      return;
    }
    if (!suite) {
      setSpecProjectErr("Select a suite before editing.");
      return;
    }
    setEditorLoading(true);
    setEditorPath(spec.path);
    try {
      const qs = new URLSearchParams({ projectId: suite.id, path: spec.path });
      const res = await apiFetchRaw(apiUrl(`/tm/suite/spec-content?${qs.toString()}`));
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
      const res = await apiFetchRaw(apiUrl("/tm/suite/spec-content"), {
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
    if (!isLoaded || !isSignedIn) return;
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
    apiFetchRaw(apiUrl(`/tm/suite/specs?${qs.toString()}`))
      .then(async (r) => {
        if (!r.ok) {
          const text = await r.text().catch(() => "Failed to load specs");
          throw new Error(text);
        }
        return r.json();
      })
      .then((rows: SpecFile[]) => {
        const seen = new Set<string>();
        const deletedSpecs = suiteFolderState.deletedSpecs || {};
        const deduped = rows.filter((row) => {
          const key = row.path.replace(/\\/g, "/");
          if (seen.has(key)) return false;
          seen.add(key);
          if (deletedSpecs[key] || deletedSpecs[row.path]) return false;
          return true;
        });
        setSpecs(deduped);
      })
      .catch((err) => {
        console.error(err);
        setRunError(err instanceof Error ? err.message : "Failed to load specs");
      });
  }, [pid, specReloadKey, specProjects, apiFetchRaw, isLoaded, isSignedIn, suiteFolderState.deletedSpecs]);

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
    if (!isLoaded || !isSignedIn) return;
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
        const res = await apiFetchRaw(apiUrl(`/tm/suite/spec-content?${qs.toString()}`));
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
  }, [specFromQuery, specs, activeSuite, apiFetchRaw, isLoaded, isSignedIn]);

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
    if (!isLoaded || !isSignedIn) return;
    if (!activeSpec || suiteSelected) return;
    const qs = new URLSearchParams({ projectId: pid, path: activeSpec.path });
    apiFetchRaw(apiUrl(`/tm/suite/cases?${qs.toString()}`))
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
  }, [pid, activeSpec, suiteSelected, apiFetchRaw, isLoaded, isSignedIn]);


  const filtered = useMemo(
    () => {
      const source = suiteSelected ? suiteCases : cases;
      return query ? source.filter(c => c.title.toLowerCase().includes(query.toLowerCase())) : source;
    },
    [cases, suiteCases, suiteSelected, query]
  );
  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;

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
        const res = await apiFetchRaw(apiUrl(`/tm/suite/cases?${qs.toString()}`));
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
    const mode = activeSuite?.type === "generated" ? "ai" : "regular";
    const buildGrep = buildLooseGrep;
    try {
      if (suiteSelected) {
        const files = Array.from(
          new Set(
            selectedCases
              .map((c) => c.specPath)
              .filter((p): p is string => !!p)
          )
        );
        const grep = buildGrep(selectedCases.map((c) => c.title));
        const res = await apiFetch<{ id: string }>("/runner/run", {
          method: "POST",
          body: JSON.stringify({
            projectId: runProjectId,
            suiteId: pid,
            files,
            grep,
            mode,
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
        const grep = buildGrep(selectedTitles);
        const res = await apiFetch<{ id: string }>("/runner/run", {
          method: "POST",
          body: JSON.stringify({
            projectId: runProjectId,
            suiteId: pid,
            file: activeSpec.path,
            grep,
            mode,
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
    const mode = activeSuite?.type === "generated" ? "ai" : "regular";
    try {
      const files = specs.map((s) => s.path);
      const res = await apiFetch<{ id: string }>("/runner/run", {
        method: "POST",
        body: JSON.stringify({
          projectId: runProjectId,
          suiteId: pid,
          files,
          mode,
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

  const renderTreeActions = (
    node: TreeNode,
    info: { isFile: boolean; isSuite: boolean; isActiveSuite: boolean; isActiveFile: boolean }
  ) => {
    if (info.isSuite && node.suiteId) {
      const suite = suiteLookup.get(node.suiteId);
      const canEditSuite = suite?.type === "curated";
      const busyAction = node.suiteId === pid ? syncingSuite : false;
      return (
        <SuiteActionsMenu
          disabled={!canEditSuite}
          busyAction={busyAction}
          onAction={(actionId) => handleSuiteAction(node.suiteId!, actionId)}
        />
      );
    }

    if (info.isFile && node.file?.path) {
      const isLocked = !!(activeSuite?.locked || []).includes(node.file.path);
      return (
        <SpecActionsMenu
          canEdit={!!isActiveCurated}
          canDelete={!!activeSuite}
          isLocked={isLocked}
          busyLock={lockingSpec}
          busyDelete={deletingSpec}
          onAction={(actionId) => handleSpecAction(node.file!.path, actionId)}
          onOpenChange={(open) => {
            if (open && node.file) {
              setActiveSpec({ path: node.file.path });
            }
          }}
        />
      );
    }

    if (!info.isFile && !info.isSuite && node.path) {
      const hasSubfolders = !!node.children?.some((child) => !child.file);
      return (
        <FolderActionsMenu
          onAction={(actionId) => handleFolderAction(node.path!, actionId, hasSubfolders)}
        />
      );
    }

    return null;
  };

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
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 justify-center"
              onClick={handleCreateSuite}
              disabled={creatingSuite}
            >
              <Plus className="h-4 w-4 mr-1" /> {creatingSuite ? "Creating..." : "New suite"}
            </Button>
            <GlobalActionsMenu onAction={handleGlobalAction} canCopySpec={canCopySpec} />
          </div>
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
                  renderActions={renderTreeActions}
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
                  renderActions={renderTreeActions}
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
                      {opt.label}
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
            <div className="rounded-lg border border-dashed border-slate-200 bg-white/70 p-4 text-sm text-muted-foreground">
              {specs.length === 0 ? (
                <div className="space-y-2">
                  <div>This suite is empty.</div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled title="Coming soon">
                      New spec
                    </Button>
                    <Button variant="outline" size="sm" disabled title="Select a spec first">
                      Copy spec
                    </Button>
                  </div>
                </div>
              ) : (
                <div>Select a spec on the left to view steps.</div>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3 px-1">
                <div className="text-sm text-muted-foreground">{formatDisplayPath(activeSpec.path)}</div>
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
                    onClick={(e) => {
                      const target = e.target as HTMLElement | null;
                      if (target?.closest("[data-checkbox]")) return;
                      if (c.specPath) {
                        setSuiteSelected(false);
                        setActiveSpec({ path: c.specPath });
                      }
                    }}
                  >
                    <div data-checkbox onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={!!selected[key]}
                        onCheckedChange={(v)=>toggle(key, Boolean(v))}
                        className="mt-1"
                      />
                    </div>
                    <div className="flex-1">
                      <div className="font-medium leading-tight">{c.title}</div>
                      <div className="text-xs text-muted-foreground">line {c.line}</div>
                      {c.specPath && <div className="text-[11px] text-slate-500">{c.specPath}</div>}
                    </div>
                  </div>
                  );
                })}
                {filtered.length === 0 && (
                  <div className="rounded-lg border border-dashed border-slate-200 bg-white/70 p-4 text-sm text-muted-foreground">
                    {hasQuery ? (
                      <div className="flex items-center gap-2">
                        <span>No results for "{trimmedQuery}".</span>
                        <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                          Clear search
                        </Button>
                      </div>
                    ) : (
                      <span>No steps match this view.</span>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </ScrollArea>
      </div>
    </div>
      <SpecPickerModal
        open={pickerOpen}
        mode={pickerMode}
        specPath={pickerSpecPath}
        suites={curatedSuiteOptions}
        suiteId={pickerSuiteId}
        onSuiteChange={(value) => {
          setPickerSuiteId(value);
          setPickerFolder("");
          setPickerNewFolder("");
        }}
        folderOptions={pickerFolderOptions}
        folderValue={pickerFolder}
        onFolderChange={(value) => {
          setPickerFolder(value);
          if (value !== NEW_FOLDER_VALUE) {
            setPickerNewFolder("");
          }
        }}
        newFolderValue={pickerNewFolder}
        onNewFolderChange={setPickerNewFolder}
        newNameValue={pickerNewName}
        onNewNameChange={setPickerNewName}
        busy={pickerBusy || copyingSpec}
        onCancel={handlePickerClose}
        onConfirm={handlePickerConfirm}
      />
      <FolderDeleteModal
        open={!!folderDeleteTarget}
        folderName={folderDeleteTarget?.folderName || ""}
        hasSubfolders={!!folderDeleteTarget?.hasSubfolders}
        deleteSubfolders={deleteSubfolders}
        onDeleteSubfoldersChange={setDeleteSubfolders}
        onCancel={() => {
          setFolderDeleteTarget(null);
          setDeleteSubfolders(false);
        }}
        onConfirm={() => {
          if (!folderDeleteTarget) return;
          deleteFolderInSuite(folderDeleteTarget.suiteId, folderDeleteTarget.folderPath, {
            deleteSubfolders,
          });
          setFolderDeleteTarget(null);
          setDeleteSubfolders(false);
          toast.success(`Deleted folder ${folderDeleteTarget.folderName}`);
        }}
      />
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
