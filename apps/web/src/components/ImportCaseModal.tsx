import { useState, useRef, useEffect } from "react";
import { Upload, X, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "./ui/button";

export type ImportRow = {
  title: string;
  priority?: "low" | "medium" | "high";
  type?: "functional" | "regression" | "security" | "accessibility" | "other";
  status?: "draft" | "active" | "archived";
  tags?: string[];
  preconditions?: string;
};

type Suite = { id: string; name: string };

type Props = {
  open: boolean;
  projectId: string;
  suites: Suite[];
  defaultSuiteId: string | null;
  onClose: () => void;
  onImport: (projectId: string, suiteId: string | null, cases: ImportRow[]) => Promise<void>;
};

const VALID_STATUSES = new Set(["draft", "active", "archived"]);
const VALID_PRIORITIES = new Set(["low", "medium", "high"]);
const VALID_TYPES = new Set(["functional", "regression", "security", "accessibility", "other"]);

type ParsedResult = {
  valid: ImportRow[];
  skippedBlank: number;
  invalidRows: Array<{ row: number; reason: string }>;
};

function parseCsv(text: string): ParsedResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { valid: [], skippedBlank: 0, invalidRows: [] };

  const header = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);

  const valid: ImportRow[] = [];
  let skippedBlank = 0;
  const invalidRows: Array<{ row: number; reason: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].match(/("(?:[^"]|"")*"|[^,]*)/g) ?? [];
    const cell = (name: string) => {
      const j = idx(name);
      if (j < 0) return "";
      return (cols[j] ?? "").replace(/^"|"$/g, "").replace(/""/g, '"').trim();
    };

    const title = cell("title");
    if (!title) { skippedBlank++; continue; }

    const priorityRaw = cell("priority").toLowerCase();
    const typeRaw = cell("type").toLowerCase();
    const statusRaw = cell("status").toLowerCase();

    const reasons: string[] = [];
    if (priorityRaw && !VALID_PRIORITIES.has(priorityRaw)) reasons.push(`invalid priority "${priorityRaw}"`);
    if (typeRaw && !VALID_TYPES.has(typeRaw)) reasons.push(`invalid type "${typeRaw}"`);
    if (statusRaw && !VALID_STATUSES.has(statusRaw)) reasons.push(`invalid status "${statusRaw}"`);

    if (reasons.length) {
      invalidRows.push({ row: i + 1, reason: reasons.join("; ") });
      continue;
    }

    const tagsRaw = cell("tags");
    valid.push({
      title,
      priority: (priorityRaw as any) || undefined,
      type: (typeRaw as any) || undefined,
      status: (statusRaw as any) || undefined,
      tags: tagsRaw ? tagsRaw.split("|").map((t) => t.trim()).filter(Boolean) : undefined,
      preconditions: cell("preconditions") || undefined,
    });
  }

  return { valid, skippedBlank, invalidRows };
}

export default function ImportCaseModal({ open, projectId, suites, defaultSuiteId, onClose, onImport }: Props) {
  const [parsed, setParsed] = useState<ParsedResult | null>(null);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string | null>(defaultSuiteId);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setParsed(null); setError(null); setSelectedSuiteId(defaultSuiteId); }
  }, [open, defaultSuiteId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setParsed(parseCsv(text));
    };
    reader.readAsText(file);
  }

  function handlePaste(text: string) {
    setParsed(parseCsv(text));
  }

  async function handleImport() {
    if (!parsed || parsed.valid.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      await onImport(projectId, selectedSuiteId, parsed.valid);
    } catch (e: any) {
      setError(e?.message ?? "Import failed");
      setImporting(false);
    }
  }

  if (!open) return null;

  const hasInvalid = (parsed?.invalidRows.length ?? 0) > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-slate-900">Import test cases from CSV</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 text-slate-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Expected format hint */}
          <p className="text-xs text-slate-500">
            Expected columns: <code className="bg-slate-100 px-1 rounded">title</code>,{" "}
            <code className="bg-slate-100 px-1 rounded">priority</code> (low/medium/high),{" "}
            <code className="bg-slate-100 px-1 rounded">type</code>,{" "}
            <code className="bg-slate-100 px-1 rounded">status</code>,{" "}
            <code className="bg-slate-100 px-1 rounded">tags</code> (pipe-separated),{" "}
            <code className="bg-slate-100 px-1 rounded">preconditions</code>.
          </p>

          {/* File picker */}
          <div
            className="border-2 border-dashed border-slate-200 rounded-lg p-6 text-center cursor-pointer hover:border-violet-300 transition-colors"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          >
            <Upload className="h-8 w-8 mx-auto mb-2 text-slate-300" />
            <p className="text-sm text-slate-500">Drop a CSV file here or click to browse</p>
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
          </div>

          {/* Paste fallback */}
          <details className="text-sm">
            <summary className="cursor-pointer text-slate-500 hover:text-slate-700">Or paste CSV text</summary>
            <textarea
              className="mt-2 w-full rounded-md border border-slate-200 p-2 text-xs font-mono h-28 resize-none"
              placeholder={"title,priority,type\nMy test,high,functional"}
              onChange={(e) => handlePaste(e.target.value)}
            />
          </details>

          {/* Parse results */}
          {parsed && (
            <div className="rounded-lg border border-slate-200 p-3 space-y-1">
              <div className="flex items-center gap-1.5 text-sm text-green-700">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span><strong>{parsed.valid.length}</strong> valid {parsed.valid.length === 1 ? "case" : "cases"}</span>
              </div>
              {parsed.skippedBlank > 0 && (
                <div className="flex items-center gap-1.5 text-sm text-slate-500">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span><strong>{parsed.skippedBlank}</strong> skipped (blank title)</span>
                </div>
              )}
              {parsed.invalidRows.map(({ row, reason }) => (
                <div key={row} className="flex items-start gap-1.5 text-sm text-amber-700">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>Row {row}: {reason}</span>
                </div>
              ))}
            </div>
          )}

          {/* Suite selector */}
          {suites.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Import into suite</label>
              <select
                value={selectedSuiteId ?? ""}
                onChange={(e) => setSelectedSuiteId(e.target.value || null)}
                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-violet-400"
              >
                <option value="">No suite</option>
                {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={handleImport}
            disabled={importing || !parsed || parsed.valid.length === 0}
          >
            {importing ? "Importing…" : `Import ${parsed?.valid.length ?? 0} cases`}
          </Button>
        </div>
      </div>
    </div>
  );
}
