import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Checkbox } from "../components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import RunNowButton from "../components/RunNowButton";
import { FileText, Sparkles, Upload, Play } from "lucide-react";

type Project = { id: string; name: string; repoUrl?: string | null };
type GeneratedTest = {
  title: string;
  type: string;
  language: string;
  steps: string[];
  runtime: string;
  fileName: string;
  path: string;
  curatedPath?: string;
  curatedName?: string;
};
type SheetCase = { id: string; title: string; steps: string[]; source: string };
type DocItem = { name: string; size: number; summary: string };
type SheetUpload = { name: string; cases: SheetCase[] };

const TEST_TYPES = ["Smoke", "Regression", "Accessibility", "Security", "Performance"];
const LANGUAGES: Array<{ value: string; label: string }> = [
  { value: "typescript", label: "TypeScript (Playwright)" },
  { value: "javascript", label: "JavaScript" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
];

const normalizeHeader = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

const pickByHeader = (row: Record<string, string>, candidates: string[]) => {
  const keys = Object.keys(row);
  const normalizedCandidates = candidates.map(normalizeHeader);
  for (const key of keys) {
    if (normalizedCandidates.includes(normalizeHeader(key))) {
      const val = row[key]?.trim();
      if (val) return val;
    }
  }
  return "";
};

const parseCsv = (input: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(cell.trim());
      if (row.some((v) => v.length > 0)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((v) => v.length > 0)) rows.push(row);
  }
  return rows;
};

const rowsToCases = (rows: Record<string, string>[], source: string): SheetCase[] => {
  const normalizeLocator = (locatorType: string, locator: string) => {
    const value = locator.trim();
    if (!value) return "";
    const lt = locatorType.toLowerCase();
    if (lt.includes("xpath")) {
      if (value.startsWith("xpath=")) return value;
      if (value.startsWith("//")) return `xpath=${value}`;
    }
    return value;
  };

  const groups = new Map<
    string,
    {
      id: string;
      title: string;
      precondition: string;
      steps: Array<{ idx: number; action: string; locatorType: string; locator: string; testData: string; expected: string }>;
    }
  >();
  let lastCaseId = "";
  let lastTitle = "";
  let lastPrecondition = "";

  rows.forEach((row, idx) => {
    const caseIdRaw = pickByHeader(row, ["test case id", "case id", "id"]);
    const titleRaw = pickByHeader(row, ["test case name", "testcase name", "title", "test case", "scenario", "name"]);
    const preconditionRaw = pickByHeader(row, ["preconditions", "precondition"]);
    const prevCaseId = lastCaseId;
    if (caseIdRaw) {
      const isNewCaseBoundary = caseIdRaw !== prevCaseId;
      lastCaseId = caseIdRaw;
      if (isNewCaseBoundary) {
        lastTitle = titleRaw || caseIdRaw;
        lastPrecondition = preconditionRaw || "";
      } else {
        if (titleRaw) lastTitle = titleRaw;
        if (preconditionRaw) lastPrecondition = preconditionRaw;
      }
    } else {
      if (titleRaw) lastTitle = titleRaw;
      if (preconditionRaw) lastPrecondition = preconditionRaw;
    }

    const caseId = caseIdRaw || lastCaseId;
    const title = titleRaw || lastTitle || `Sheet case ${idx + 1}`;
    const precondition = preconditionRaw || lastPrecondition;
    const stepNoRaw = pickByHeader(row, ["step #", "step no", "step number", "sequence"]);
    const stepNo = Number(stepNoRaw);
    const action = pickByHeader(row, ["action", "step action", "keyword", "steps", "step"]);
    const locatorType = pickByHeader(row, ["locator type", "selector type"]);
    const locator = pickByHeader(row, ["locator", "selector", "css", "xpath"]);
    const testData = pickByHeader(row, ["test data", "data", "value", "input"]);
    const expected = pickByHeader(row, ["expected result", "expected", "result", "assertion"]);

    const groupKey = caseId ? `id:${caseId.toLowerCase()}` : `title:${title.toLowerCase()}`;
    const existing = groups.get(groupKey) ?? {
      id: caseId || `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sheet-case"}-${idx + 1}`,
      title,
      precondition,
      steps: [],
    };
    if (!existing.precondition && precondition) existing.precondition = precondition;
    existing.steps.push({
      idx: Number.isFinite(stepNo) && stepNo > 0 ? stepNo : idx + 1,
      action,
      locatorType,
      locator,
      testData,
      expected,
    });
    groups.set(groupKey, existing);
  });

  const grouped = Array.from(groups.values())
    .map((group) => {
      const steps: string[] = [];
      if (group.precondition) {
        steps.push(`Precondition: ${group.precondition}`);
      }

      group.steps
        .sort((a, b) => a.idx - b.idx)
        .forEach((step) => {
          const locator = normalizeLocator(step.locatorType, step.locator);
          const actionUpper = step.action.toUpperCase();
          if (actionUpper.includes("GOTO") || actionUpper.includes("NAVIGATE") || actionUpper.includes("OPEN")) {
            const target = locator || step.testData;
            if (target) {
              steps.push(target.startsWith("http") || target.startsWith("/") ? target : `go to ${target}`);
            }
          } else if (actionUpper.includes("CLICK")) {
            if (locator) {
              steps.push(`click ${locator}`);
            } else {
              steps.push("click Continue");
            }
          } else if (actionUpper.includes("FILL") || actionUpper.includes("TYPE") || actionUpper.includes("ENTER")) {
            if (locator && step.testData) {
              steps.push(`fill ${locator} = ${step.testData}`);
            } else if (locator) {
              steps.push(`fill ${locator}`);
            }
          } else if (actionUpper.includes("ASSERT_URL_CONTAINS")) {
            if (locator) steps.push(`expect url contains ${locator}`);
            else if (step.expected) steps.push(`expect ${step.expected}`);
          } else if (actionUpper.includes("ASSERT_URL_NOT_CONTAINS")) {
            if (locator) steps.push(`expect url not contains ${locator}`);
            else if (step.expected) steps.push(`expect ${step.expected}`);
          } else if (step.action.trim()) {
            if (locator && step.testData) {
              steps.push(`${step.action} ${locator} ${step.testData}`.trim());
            } else if (locator) {
              steps.push(`${step.action} ${locator}`.trim());
            } else {
              steps.push(step.action.trim());
            }
          }

          if (step.expected) {
            steps.push(`Verify: ${step.expected}`);
          }
        });

      if (!steps.length) return null;
      return { id: group.id, title: group.title, steps, source };
    })
    .filter((item): item is SheetCase => !!item);

  return grouped;
};

const isSpreadsheetFile = (name: string) => /\.(xlsx|xls|csv)$/i.test(name);

const listSharedStepNames = (sharedSteps: Record<string, any> | undefined): string[] => {
  if (!sharedSteps || typeof sharedSteps !== "object") return [];
  const buckets = [
    sharedSteps.shared,
    sharedSteps.sharedSteps,
    sharedSteps.functions,
    sharedSteps.steps,
    sharedSteps.flows,
  ];
  const names = new Set<string>();
  buckets.forEach((bucket) => {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return;
    Object.keys(bucket).forEach((key) => {
      if (key && key !== "login") names.add(key);
    });
  });
  return Array.from(names).sort((a, b) => a.localeCompare(b));
};

async function parseSpreadsheetFile(file: File): Promise<SheetCase[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".csv")) {
    const text = await file.text();
    const matrix = parseCsv(text);
    if (!matrix.length) return [];
    const headers = matrix[0] || [];
    const rows = matrix.slice(1).map((cells) => {
      const record: Record<string, string> = {};
      headers.forEach((header, idx) => {
        if (!header?.trim()) return;
        record[header] = (cells[idx] || "").trim();
      });
      return record;
    });
    return rowsToCases(rows, file.name);
  }

  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const allCases: SheetCase[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const rows = rawRows.map((row) => {
      const normalized: Record<string, string> = {};
      Object.entries(row).forEach(([k, v]) => {
        normalized[k] = String(v ?? "").trim();
      });
      return normalized;
    });
    const parsed = rowsToCases(rows, file.name);
    allCases.push(
      ...parsed.map((item) => ({
        ...item,
        id: `${item.id}-${sheetName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      }))
    );
  }
  return allCases;
}

export default function TestBuilderPage() {
  const { apiFetch } = useApi();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [sheetUploads, setSheetUploads] = useState<SheetUpload[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<string[]>(["Smoke", "Regression"]);
  const [language, setLanguage] = useState("typescript");
  const [generated, setGenerated] = useState<GeneratedTest[]>([]);
  const [loadingGen, setLoadingGen] = useState(false);
  const [notes, setNotes] = useState("Add any special flows, risks, or data here.");
  const [manualSteps, setManualSteps] = useState("");
  const [manualTitle, setManualTitle] = useState("");
  const [googleSheetUrl, setGoogleSheetUrl] = useState("");
  const [loadingGoogleSheet, setLoadingGoogleSheet] = useState(false);
  const [sheetModalOpen, setSheetModalOpen] = useState(false);
  const [sheetSourceLabel, setSheetSourceLabel] = useState("");
  const [sheetCases, setSheetCases] = useState<SheetCase[]>([]);
  const [sheetSelection, setSheetSelection] = useState<Record<string, boolean>>({});
  const [sheetGenerating, setSheetGenerating] = useState(false);
  const [sharedStepNames, setSharedStepNames] = useState<string[]>([]);
  const [sharedStepNameInput, setSharedStepNameInput] = useState("");
  const [sharedStepLinesInput, setSharedStepLinesInput] = useState("");
  const [savingSharedStep, setSavingSharedStep] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch<{ projects: Project[] }>("/projects");
        setProjects(res.projects || []);
        if (res.projects?.[0]?.id) setProjectId(res.projects[0].id);
      } catch {
        // ignore
      }
    })();
  }, [apiFetch]);

  useEffect(() => {
    if (!projectId) {
      setSharedStepNames([]);
      return;
    }
    let active = true;
    apiFetch<{ project: { sharedSteps?: Record<string, any> } }>(`/projects/${projectId}`)
      .then((res) => {
        if (!active) return;
        setSharedStepNames(listSharedStepNames(res.project?.sharedSteps));
      })
      .catch(() => {
        if (!active) return;
        setSharedStepNames([]);
      });
    return () => {
      active = false;
    };
  }, [projectId, apiFetch]);

  const handleAddSharedStep = async () => {
    const rawName = sharedStepNameInput.trim();
    const lines = sharedStepLinesInput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!projectId) {
      toast.error("Select a project first");
      return;
    }
    if (!rawName) {
      toast.error("Enter a shared step name");
      return;
    }
    if (!lines.length) {
      toast.error("Enter at least one shared step line");
      return;
    }

    setSavingSharedStep(true);
    try {
      const current = await apiFetch<{ project: { sharedSteps?: Record<string, any> } }>(`/projects/${projectId}`);
      const sharedSteps = (current.project?.sharedSteps ?? {}) as Record<string, any>;
      const next = {
        ...sharedSteps,
        functions: {
          ...(sharedSteps.functions ?? {}),
          [rawName]: { steps: lines },
        },
      };
      await apiFetch(`/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({ sharedSteps: next }),
      });
      setSharedStepNames(listSharedStepNames(next));
      setSharedStepNameInput("");
      setSharedStepLinesInput("");
      toast.success(`Saved shared step "${rawName}"`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to save shared step");
    } finally {
      setSavingSharedStep(false);
    }
  };

  const openSheetModal = (cases: SheetCase[], sourceLabel: string) => {
    const selection: Record<string, boolean> = {};
    cases.forEach((item) => {
      selection[item.id] = true;
    });
    setSheetCases(cases);
    setSheetSourceLabel(sourceLabel);
    setSheetSelection(selection);
    setSheetModalOpen(true);
  };

  const closeSheetModal = () => {
    setSheetModalOpen(false);
    setSheetCases([]);
    setSheetSelection({});
    setSheetSourceLabel("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleUpload = async (evt: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(evt.target.files || []);
    if (!files.length) return;
    const docItems: DocItem[] = [];

    for (const f of files) {
      if (isSpreadsheetFile(f.name)) {
        try {
          const parsedCases = await parseSpreadsheetFile(f);
          if (!parsedCases.length) {
            toast.error(`No test cases found in ${f.name}`);
          } else {
            setSheetUploads((prev) => [
              ...prev.filter((item) => item.name !== f.name),
              { name: f.name, cases: parsedCases },
            ]);
            openSheetModal(parsedCases, f.name);
            toast.success(`Loaded ${parsedCases.length} test cases from ${f.name}`);
          }
        } catch (err: any) {
          toast.error(err?.message || `Failed to read ${f.name}`);
        }
        continue;
      }

      let summary = f.name;
      try {
        const txt = await f.text();
        summary = txt.slice(0, 180).replace(/\s+/g, " ").trim() || f.name;
      } catch {
        // keep name fallback
      }
      docItems.push({ name: f.name, size: f.size, summary });
    }

    setDocs(docItems);
    evt.target.value = "";
  };

  const handleLoadGoogleSheet = async () => {
    const url = googleSheetUrl.trim();
    if (!url) return;
    setLoadingGoogleSheet(true);
    try {
      const res = await apiFetch<{ cases: SheetCase[] }>("/test-builder/google-sheet-preview", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      if (!res.cases?.length) {
        toast.error("No test cases found in this Google Sheet");
        return;
      }
      setSheetUploads((prev) => [
        ...prev.filter((item) => item.name !== "Google Sheet"),
        { name: "Google Sheet", cases: res.cases },
      ]);
      openSheetModal(res.cases, "Google Sheet");
      toast.success(`Loaded ${res.cases.length} test cases from Google Sheet`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to load Google Sheet");
    } finally {
      setLoadingGoogleSheet(false);
    }
  };

  const selectedSheetCases = useMemo(
    () => sheetCases.filter((item) => sheetSelection[item.id]),
    [sheetCases, sheetSelection]
  );

  const handleGenerateSelectedSheetCases = async () => {
    if (!projectId) {
      toast.error("Select a project first");
      return;
    }
    if (!selectedSheetCases.length) {
      toast.error("Select at least one testcase");
      return;
    }
    setSheetGenerating(true);
    try {
      for (const testCase of selectedSheetCases) {
        const res = await apiFetch<{ spec: { title: string; fileName: string; relativePath: string } }>(
          "/test-builder/generate",
          {
            method: "POST",
            body: JSON.stringify({
              projectId,
              title: testCase.title,
              steps: testCase.steps,
              notes,
              docs: [...docs, { name: sheetSourceLabel || testCase.source, summary: testCase.title }],
            }),
          }
        );

        setGenerated((prev) => [
          {
            title: res.spec.title,
            type: "Spreadsheet",
            language,
            runtime: "~",
            fileName: res.spec.fileName,
            steps: testCase.steps,
            path: res.spec.relativePath,
            curatedName: testCase.title,
          },
          ...prev,
        ]);
      }
      closeSheetModal();
      toast.success(`Generated ${selectedSheetCases.length} spec(s)`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to generate specs from selected testcases");
    } finally {
      setSheetGenerating(false);
    }
  };

  const handleGenerate = async () => {
    if (!projectId || !selectedTypes.length) return;
    setLoadingGen(true);
    try {
      const seeds = docs.length > 0 ? docs : [{ name: "Landing page", size: 0, summary: "happy path login and dashboard" }];
      const combos = seeds.flatMap((doc) => selectedTypes.map((type) => ({ doc, type }))).slice(0, 6);

      for (const combo of combos) {
        const steps = [
          `Review ${combo.doc.name}`,
          `Navigate through ${combo.doc.summary || "critical flow"}`,
          combo.type === "Performance" ? "Capture performance metrics" : "Validate behavior expectations",
        ];

        const res = await apiFetch<{ spec: { title: string; fileName: string; relativePath: string } }>(
          "/test-builder/generate",
          {
            method: "POST",
            body: JSON.stringify({
              projectId,
              title: `${combo.type} | ${combo.doc.name}`.slice(0, 80),
              steps,
              notes,
              docs,
            }),
          }
        );

        setGenerated((prev) => [
          {
            title: res.spec.title,
            type: combo.type,
            language,
            runtime: "~",
            fileName: res.spec.fileName,
            steps,
            path: res.spec.relativePath,
            curatedName: `${combo.type} ${combo.doc.name}`,
          },
          ...prev,
        ]);
      }
    } catch (error) {
      console.error(error);
      toast.error("Failed to generate tests");
    } finally {
      setLoadingGen(false);
    }
  };

  const handleManualGenerate = async () => {
    if (!projectId) return;
    const text = manualSteps.trim();
    if (!text) return;
    const title = manualTitle.trim() || "Manual scenario";
    const steps = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!steps.length) return;
    try {
      const res = await apiFetch<{ spec: { title: string; fileName: string; relativePath: string } }>(
        "/test-builder/generate",
        {
          method: "POST",
          body: JSON.stringify({
            projectId,
            title,
            steps,
            notes,
            docs,
          }),
        }
      );
      setGenerated((prev) => [
        {
          title: res.spec.title,
          type: "Manual",
          language,
          runtime: "~",
          fileName: res.spec.fileName,
          steps,
          path: res.spec.relativePath,
          curatedName: title,
        },
        ...prev,
      ]);
      setManualSteps("");
      setManualTitle("");
    } catch (error) {
      console.error(error);
      toast.error("Failed to generate from manual steps");
    }
  };

  const handleCurate = async (test: GeneratedTest) => {
    if (!projectId) return;
    try {
      const res = await apiFetch<{ fileName: string; curatedPath: string }>("/test-builder/curate", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          specPath: test.path,
          title: test.title,
          curatedName: test.curatedName,
        }),
      });
      const curatedName = res.fileName.replace(/\.spec\.ts$/i, "");
      setGenerated((prev) =>
        prev.map((t) => (t.fileName === test.fileName ? { ...t, curatedPath: res.curatedPath, curatedName } : t))
      );
    } catch (error) {
      console.error("Failed to curate spec", error);
      toast.error("Failed to copy to curated suite");
    }
  };

  const handleCuratedNameChange = (test: GeneratedTest, value: string) => {
    setGenerated((prev) => prev.map((t) => (t.fileName === test.fileName ? { ...t, curatedName: value } : t)));
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-500">Test Builder</p>
          <h1 className="text-2xl font-semibold text-slate-900">Generate and run AI-assisted tests</h1>
          <p className="text-sm text-slate-600">
            Upload specs, pick test types, generate cases, and run them against a project.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {projectId && (
            <RunNowButton
              projectId={projectId}
              variant="default"
              size="sm"
              className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
            />
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-slate-800">
              <Upload className="h-4 w-4" />
              Inputs
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">Upload reference docs</label>
              <Input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".md,.txt,.pdf,.doc,.docx,.xlsx,.xls,.csv"
                onChange={handleUpload}
                className="bg-white"
              />
              <p className="text-xs text-slate-500">
                For spreadsheet files (.xlsx/.xls/.csv), we open testcase selection in a popup.
              </p>
              <div className="flex gap-2">
                <Input
                  value={googleSheetUrl}
                  onChange={(e) => setGoogleSheetUrl(e.target.value)}
                  placeholder="Paste Google Sheets URL"
                  className="bg-white"
                />
                <Button size="sm" variant="outline" onClick={handleLoadGoogleSheet} disabled={loadingGoogleSheet}>
                  {loadingGoogleSheet ? "Loading..." : "Load sheet"}
                </Button>
              </div>
              {(docs.length > 0 || sheetUploads.length > 0) && (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 space-y-1">
                  {docs.map((d) => (
                    <div key={`${d.name}-${d.summary}`} className="flex items-start gap-2">
                      <FileText className="mt-0.5 h-3.5 w-3.5 text-slate-500" />
                      <div>
                        <div className="font-medium">{d.name}</div>
                        <div className="text-slate-500">{d.summary}</div>
                      </div>
                    </div>
                  ))}
                  {sheetUploads.map((sheet) => (
                    <div key={`sheet-${sheet.name}`} className="flex items-start gap-2">
                      <FileText className="mt-0.5 h-3.5 w-3.5 text-slate-500" />
                      <div>
                        <button
                          type="button"
                          className="font-medium text-left text-blue-700 hover:underline"
                          onClick={() => openSheetModal(sheet.cases, sheet.name)}
                        >
                          {sheet.name}
                        </button>
                        <div className="text-slate-500">
                          {sheet.cases.length} testcase(s) parsed. Click filename to reopen selector.
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 space-y-2">
                <div className="font-medium">Shared steps for this project</div>
                <div className="text-slate-500">
                  Use precondition syntax `Precondition: shared:step-name` to include one.
                </div>
                {sharedStepNames.length ? (
                  <div className="flex flex-wrap gap-1">
                    {sharedStepNames.map((name) => (
                      <span key={name} className="rounded bg-white px-2 py-0.5 border border-slate-200">
                        {name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-slate-500">No named shared steps found in this project.</div>
                )}
                <div className="border-t border-slate-200 pt-2 space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                    Quick add shared step
                  </div>
                  <Input
                    value={sharedStepNameInput}
                    onChange={(e) => setSharedStepNameInput(e.target.value)}
                    placeholder="step name (e.g. login-admin)"
                    className="bg-white"
                  />
                  <textarea
                    value={sharedStepLinesInput}
                    onChange={(e) => setSharedStepLinesInput(e.target.value)}
                    placeholder={"One line per action\nExample:\nclick a[href=\"/login\"]\nfill input[name=\"email\"] = <ADMIN_EMAIL>"}
                    className="w-full rounded-md border border-slate-200 px-3 py-2 text-xs text-slate-800 bg-white"
                    rows={4}
                  />
                  <Button size="sm" variant="outline" onClick={handleAddSharedStep} disabled={savingSharedStep}>
                    {savingSharedStep ? "Saving..." : "Save shared step"}
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Test types</label>
                <div className="grid grid-cols-2 gap-2">
                  {TEST_TYPES.map((t) => (
                    <label key={t} className="flex items-center gap-2 text-sm text-slate-700">
                      <Checkbox
                        checked={selectedTypes.includes(t)}
                        onCheckedChange={(checked) => {
                          setSelectedTypes((prev) => (checked ? [...prev, t] : prev.filter((x) => x !== t)));
                        }}
                      />
                      {t}
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Language</label>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select language" />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((l) => (
                      <SelectItem key={l.value} value={l.value}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <label className="text-sm font-medium text-slate-700">Notes</label>
                <textarea
                  className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-800 bg-white"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleGenerate}
                disabled={loadingGen}
                className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
              >
                <Sparkles className="mr-2 h-4 w-4" />
                {loadingGen ? "Generating..." : "Generate tests"}
              </Button>
              {projectId && (
                <Button
                  size="sm"
                  variant="default"
                  className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
                  disabled={!generated.length}
                >
                  <Play className="mr-2 h-4 w-4" />
                  Execute selection
                </Button>
              )}
            </div>

            <div className="mt-4 space-y-2 border-t pt-4">
              <label className="text-sm font-medium text-slate-700">Manual test steps (free text)</label>
              <div className="space-y-1">
                <label className="text-xs text-slate-600">Test case name</label>
                <Input
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  placeholder="e.g. Navigate to homepage"
                  className="text-sm"
                />
              </div>
              <textarea
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-800 bg-white"
                rows={4}
                value={manualSteps}
                onChange={(e) => setManualSteps(e.target.value)}
                placeholder="Enter steps in plain language. One action per line works best."
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleManualGenerate}
                  className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
                  disabled={!manualSteps.trim()}
                >
                  Generate from steps
                </Button>
                {projectId && (
                  <RunNowButton
                    projectId={projectId}
                    variant="default"
                    size="sm"
                    className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
                  />
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-slate-800">Generated tests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {generated.length === 0 && (
              <div className="text-sm text-slate-500">No tests yet. Upload a doc and click Generate.</div>
            )}
            {generated.map((t, idx) => (
              <div key={`${t.title}-${idx}`} className="rounded-md border border-slate-200 p-3">
                <div className="flex items-center justify-between text-sm text-slate-700">
                  <span className="font-semibold text-slate-900">{t.title}</span>
                  <span className="text-xs text-slate-500">{t.runtime}</span>
                </div>
                <div className="text-xs text-slate-500">
                  {t.type} • {t.language} • {t.fileName}
                </div>
                <div className="text-xs text-slate-500 space-y-1">
                  <div>
                    Saved path: <code className="rounded bg-slate-100 px-1">{t.path}</code>
                  </div>
                  {t.curatedPath && (
                    <div>
                      Curated path: <code className="rounded bg-slate-100 px-1">{t.curatedPath}</code>
                    </div>
                  )}
                </div>
                <div className="mt-2 space-y-1 text-xs text-slate-500">
                  <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Curated file name
                  </label>
                  <Input
                    value={t.curatedName ?? t.title}
                    onChange={(e) => handleCuratedNameChange(t, e.target.value)}
                    placeholder="custom name (no extension)"
                    className="text-xs"
                  />
                </div>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => handleCurate(t)}>
                    Copy to curated suite
                  </Button>
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-slate-700">
                  {t.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {sheetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-3xl rounded-lg border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">Select testcases to AI-generate</div>
                <div className="text-xs text-slate-500">
                  Source: {sheetSourceLabel || "Spreadsheet"} • {selectedSheetCases.length}/{sheetCases.length} selected
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={closeSheetModal}>
                Close
              </Button>
            </div>
            <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const next: Record<string, boolean> = {};
                  sheetCases.forEach((item) => {
                    next[item.id] = true;
                  });
                  setSheetSelection(next);
                }}
              >
                Select all
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const next: Record<string, boolean> = {};
                  sheetCases.forEach((item) => {
                    next[item.id] = false;
                  });
                  setSheetSelection(next);
                }}
              >
                Clear
              </Button>
            </div>
            <div className="max-h-[55vh] overflow-y-auto px-4 py-3 space-y-2">
              {sheetCases.map((item) => (
                <label key={item.id} className="flex items-start gap-3 rounded-md border border-slate-200 p-3">
                  <Checkbox
                    checked={!!sheetSelection[item.id]}
                    onCheckedChange={(checked) =>
                      setSheetSelection((prev) => ({
                        ...prev,
                        [item.id]: checked === true,
                      }))
                    }
                  />
                  <div>
                    <div className="text-sm font-medium text-slate-900">{item.title}</div>
                    <ul className="mt-1 list-disc pl-4 text-xs text-slate-600 space-y-1">
                      {item.steps.slice(0, 3).map((step, idx) => (
                        <li key={idx}>{step}</li>
                      ))}
                    </ul>
                  </div>
                </label>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
              <Button size="sm" variant="outline" onClick={closeSheetModal}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleGenerateSelectedSheetCases}
                disabled={sheetGenerating || !selectedSheetCases.length}
                className="bg-[#2563eb] text-white hover:bg-[#1d4ed8] shadow-sm"
              >
                {sheetGenerating ? "Generating..." : `Generate ${selectedSheetCases.length} selected`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
