import { useState } from "react";
import { Button } from "./ui/button";
import { ChevronDown, X } from "lucide-react";

type Suite = { id: string; name: string };

type Props = {
  selectedIds: Set<string>;
  suites: Suite[];
  onAction: (action: string, value?: string) => Promise<void>;
  onClear: () => void;
};

export default function BulkActionToolbar({ selectedIds, suites, onAction, onClear }: Props) {
  const [busy, setBusy] = useState(false);
  const [showSuites, setShowSuites] = useState(false);

  const count = selectedIds.size;
  if (count === 0) return null;

  async function fire(action: string, value?: string) {
    setBusy(true);
    setShowSuites(false);
    try { await onAction(action, value); } finally { setBusy(false); }
  }

  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-xl">
      {/* Count badge */}
      <span className="text-sm font-semibold text-slate-700 whitespace-nowrap mr-1">
        {count} {count === 1 ? "case" : "cases"} selected
      </span>

      <div className="h-4 w-px bg-slate-200" />

      {/* Status */}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => fire("setStatus", "active")}>Active</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => fire("setStatus", "draft")}>Draft</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => fire("setStatus", "archived")}>Archive</Button>

      <div className="h-4 w-px bg-slate-200" />

      {/* Priority */}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => fire("setPriority", "high")}>↑ High</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => fire("setPriority", "medium")}>Med</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => fire("setPriority", "low")}>↓ Low</Button>

      {/* Move to suite */}
      {suites.length > 0 && (
        <>
          <div className="h-4 w-px bg-slate-200" />
          <div className="relative">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setShowSuites((v) => !v)}
              className="gap-1"
            >
              Move to suite <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            {showSuites && (
              <div className="absolute bottom-full mb-1 left-0 bg-white border border-slate-200 rounded-lg shadow-lg min-w-[160px] py-1 z-50">
                {suites.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => fire("moveSuite", s.id)}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50 text-slate-700"
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <div className="h-4 w-px bg-slate-200" />

      {/* Clear selection */}
      <button onClick={onClear} className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors" title="Clear selection">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
