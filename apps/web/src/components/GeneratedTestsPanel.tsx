import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { Button } from "../components/ui/button";

type FileItem = { path: string; size: number };

export default function GeneratedTestsPanel() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const adapterId = (localStorage.getItem("tm-adapterId") || "playwright-ts") as string;

  async function load() {
    const qs = new URLSearchParams({ adapterId }).toString();
    const r = await fetch(`/tm/generated/list?${qs}`);
    const d = await r.json();
    setFiles(d.files || []);
    if (d.files?.length && !active) setActive(d.files[0].path);
  }

  async function openFile(p: string) {
    setActive(p);
    const qs = new URLSearchParams({ adapterId, file: p }).toString();
    const r = await fetch(`/tm/generated/file?${qs}`);
    setContent(await r.text());
  }

  useEffect(() => { load(); }, [adapterId]);

  useEffect(() => { if (active) openFile(active); }, [active]);

  const lines = content ? content.split(/\r?\n/) : [];
  const lineCount = lines.length || 0;

  if (!files.length) {
    return (
      <div className="rounded-lg border bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-800">Generated tests</h2>
        <p className="text-sm text-slate-500">No generated files yet. Click <b>Generate</b> on a project.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-white p-0 md:col-span-2 xl:col-span-2">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Generated tests ({adapterId})</h2>
          <p className="text-xs text-slate-500">VS Code-style preview with line numbers</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load}>Refresh</Button>
          <a href="/tm/download">
            <Button variant="secondary" size="sm">Download bundle</Button>
          </a>
        </div>
      </div>

      <div className="grid grid-cols-12">
        <aside className="col-span-4 max-h-[460px] overflow-auto border-r bg-[#252526] text-slate-200">
          <div className="border-b border-[#2d2d2d] px-3 py-2 text-xs uppercase tracking-wide text-slate-400">
            Explorer
          </div>
          <ul className="text-sm">
            {files.map((f) => {
              const isActive = active === f.path;
              return (
                <li key={f.path}>
                  <button
                    onClick={() => openFile(f.path)}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left transition ${
                      isActive ? "bg-[#094771] text-white" : "hover:bg-[#2d2d2d]"
                    }`}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
                      <span className="truncate">{f.path}</span>
                    </span>
                    <span className="text-xs text-slate-400">{f.size}b</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <main className="col-span-8 max-h-[460px] overflow-auto bg-[#1e1e1e]">
          <div className="flex items-center justify-between border-b border-[#2d2d2d] px-3 py-2 text-xs text-slate-300">
            <span className="truncate">{active}</span>
            <span className="text-[11px] text-slate-500">{lineCount} lines</span>
          </div>
          {(() => {
            const lang = active?.endsWith(".feature")
              ? "gherkin"
              : active?.endsWith(".ts")
              ? "typescript"
              : "javascript";
            return (
              <Editor
                height="430px"
                language={lang}
                theme="vs-dark"
                value={content}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 13,
                  fontFamily: "Consolas, 'SFMono-Regular', Menlo, Monaco, monospace",
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  renderLineHighlight: "all",
                  occurrencesHighlight: false,
                  contextmenu: false,
                }}
                wrapperProps={{ className: "border-t border-[#1b1b1b]" }}
              />
            );
          })()}
        </main>
      </div>
    </div>
  );
}
