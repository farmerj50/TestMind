import { useEffect, useMemo, useState } from "react";
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

const TEST_TYPES = ["Smoke", "Regression", "Accessibility", "Security", "Performance"];
const LANGUAGES: Array<{ value: string; label: string }> = [
  { value: "typescript", label: "TypeScript (Playwright)" },
  { value: "javascript", label: "JavaScript" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
];

export default function TestBuilderPage() {
  const { apiFetch } = useApi();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [docs, setDocs] = useState<Array<{ name: string; size: number; summary: string }>>([]);
  const [selectedTypes, setSelectedTypes] = useState<string[]>(["Smoke", "Regression"]);
  const [language, setLanguage] = useState("typescript");
  const [generated, setGenerated] = useState<GeneratedTest[]>([]);
  const [loadingGen, setLoadingGen] = useState(false);
  const [notes, setNotes] = useState("Add any special flows, risks, or data here.");
  const [manualSteps, setManualSteps] = useState("");
  const [manualTitle, setManualTitle] = useState("");

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

  const handleUpload = async (evt: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(evt.target.files || []);
    const mapped = await Promise.all(
      files.map(async (f) => {
        let summary = f.name;
        try {
          const txt = await f.text();
          summary = txt.slice(0, 180).replace(/\s+/g, " ").trim() || f.name;
        } catch {
          // keep name fallback
        }
        return { name: f.name, size: f.size, summary };
      })
    );
    setDocs(mapped);
  };

  const handleGenerate = async () => {
    if (!projectId || !selectedTypes.length) return;
    setLoadingGen(true);
    try {
      const seeds =
        docs.length > 0
          ? docs
          : [{ name: "Landing page", summary: "happy path login and dashboard" }];
      const combos = seeds
        .flatMap((doc) => selectedTypes.map((type) => ({ doc, type })))
        .slice(0, 6);

      for (const combo of combos) {
        const steps = [
          `Review ${combo.doc.name}`,
          `Navigate through ${combo.doc.summary || "critical flow"}`,
          combo.type === "Performance"
            ? "Capture performance metrics"
            : "Validate behavior expectations",
        ];

        const res = await apiFetch("/test-builder/generate", {
          method: "POST",
          body: JSON.stringify({
            projectId,
            title: `${combo.type} | ${combo.doc.name}`.slice(0, 80),
            steps,
            notes,
            docs,
          }),
        });

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
      const res = await apiFetch("/test-builder/generate", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          title,
          steps,
          notes,
          docs,
        }),
      });
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
    }
  };

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId]
  );

  const handleCurate = async (test: GeneratedTest) => {
    if (!projectId) return;
    try {
      const res = await apiFetch("/test-builder/curate", {
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
        prev.map((t) =>
          t.fileName === test.fileName
            ? { ...t, curatedPath: res.curatedPath, curatedName }
            : t
        )
      );
    } catch (error) {
      console.error("Failed to curate spec", error);
    }
  };

  const handleCuratedNameChange = (test: GeneratedTest, value: string) => {
    setGenerated((prev) =>
      prev.map((t) =>
        t.fileName === test.fileName ? { ...t, curatedName: value } : t
      )
    );
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
                type="file"
                multiple
                accept=".md,.txt,.pdf,.doc,.docx"
                onChange={handleUpload}
                className="bg-white"
              />
              <p className="text-xs text-slate-500">We use document text to craft realistic flows and assertions.</p>
              {docs.length > 0 && (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700 space-y-1">
                  {docs.map((d) => (
                    <div key={d.name} className="flex items-start gap-2">
                      <FileText className="mt-0.5 h-3.5 w-3.5 text-slate-500" />
                      <div>
                        <div className="font-medium">{d.name}</div>
                        <div className="text-slate-500">{d.summary}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
                          setSelectedTypes((prev) =>
                            checked ? [...prev, t] : prev.filter((x) => x !== t)
                          );
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
            {loadingGen ? "Generating…" : "Generate tests"}
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

            {/* Manual steps entry */}
            <div className="mt-4 space-y-2 border-t pt-4">
              <label className="text-sm font-medium text-slate-700">
                Manual test steps (free text)
              </label>
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
                    Saved path:{" "}
                    <code className="rounded bg-slate-100 px-1">{t.path}</code>
                  </div>
                  {t.curatedPath && (
                    <div>
                      Curated path:{" "}
                      <code className="rounded bg-slate-100 px-1">{t.curatedPath}</code>
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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleCurate(t)}
                  >
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
    </div>
  );
}
