import { useRef } from "react";
import { Search, X } from "lucide-react";
import { Input } from "./ui/input";

export type CaseFilters = {
  q: string;
  status: string;
  priority: string;
  type: string;
  tag: string;
};

export const EMPTY_FILTERS: CaseFilters = { q: "", status: "", priority: "", type: "", tag: "" };

type Props = {
  filters: CaseFilters;
  availableTags: string[];
  onChange: (next: CaseFilters) => void;
  onClear: () => void;
};

const STATUSES = ["draft", "active", "archived"];
const PRIORITIES = ["low", "medium", "high"];
const TYPES = ["functional", "regression", "security", "accessibility", "other"];

const sel =
  "h-8 rounded-md border border-slate-200 bg-white px-2 py-0 text-xs text-slate-700 " +
  "focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50";

export default function CaseFilterBar({ filters, availableTags, onChange, onClear }: Props) {
  const isActive = Object.values(filters).some(Boolean);
  const inputRef = useRef<HTMLInputElement>(null);

  function set(key: keyof CaseFilters, value: string) {
    onChange({ ...filters, [key]: value });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-100 bg-slate-50/60">
      {/* Text search */}
      <div className="relative flex-1 min-w-[140px]">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
        <Input
          ref={inputRef}
          value={filters.q}
          onChange={(e) => set("q", e.target.value)}
          placeholder="Search cases…"
          className="h-8 pl-7 text-xs"
        />
      </div>

      {/* Status */}
      <select value={filters.status} onChange={(e) => set("status", e.target.value)} className={sel}>
        <option value="">All statuses</option>
        {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>

      {/* Priority */}
      <select value={filters.priority} onChange={(e) => set("priority", e.target.value)} className={sel}>
        <option value="">All priorities</option>
        {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>

      {/* Type */}
      <select value={filters.type} onChange={(e) => set("type", e.target.value)} className={sel}>
        <option value="">All types</option>
        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>

      {/* Tag */}
      {availableTags.length > 0 && (
        <select value={filters.tag} onChange={(e) => set("tag", e.target.value)} className={sel}>
          <option value="">All tags</option>
          {availableTags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      )}

      {/* Clear */}
      {isActive && (
        <button
          onClick={onClear}
          className="flex items-center gap-1 h-8 px-2 rounded-md text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <X className="h-3.5 w-3.5" /> Clear
        </button>
      )}
    </div>
  );
}
