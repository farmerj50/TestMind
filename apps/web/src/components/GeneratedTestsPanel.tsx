import { useEffect, useState } from "react";
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

  if (!files.length) {
    return (
      <div className="rounded-lg border bg-white p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-800">Generated tests</h2>
        <p className="text-sm text-slate-500">No generated files yet. Click <b>Generate</b> on a project.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white p-0 md:col-span-2 xl:col-span-2 overflow-hidden">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-medium text-slate-800">Generated tests ({adapterId})</h2>
      </div>
      <div className="grid grid-cols-12">
        <aside className="col-span-4 border-r max-h-[420px] overflow-auto">
          <ul className="text-sm">
            {files.map(f => (
              <li key={f.path}>
                <button
                  onClick={() => openFile(f.path)}
                  className={`w-full text-left px-3 py-2 hover:bg-slate-50 ${active===f.path ? "bg-slate-100 font-medium" : ""}`}
                >
                  {f.path}
                  <span className="ml-2 text-xs text-slate-400">{f.size}b</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <main className="col-span-8 max-h-[420px] overflow-auto">
          <pre className="p-3 text-[12px] leading-5 whitespace-pre">{content}</pre>
        </main>
      </div>
      <div className="border-t px-4 py-3 flex items-center gap-2">
        <Button variant="outline" onClick={load}>Refresh</Button>
        <a className="ml-auto" href="/tm/download">
          <Button variant="secondary">Download bundle</Button>
        </a>
      </div>
    </div>
  );
}
