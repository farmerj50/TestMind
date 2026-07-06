import { useState, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export type CreateCasePayload = {
  title: string;
  priority: "low" | "medium" | "high";
  type: "functional" | "regression" | "security" | "accessibility" | "other";
  status: "draft" | "active" | "archived";
  suiteId: string | null;
  tags: string[];
};

type Suite = { id: string; name: string };

type Props = {
  open: boolean;
  suites: Suite[];
  defaultSuiteId: string | null;
  onClose: () => void;
  onCreate: (payload: CreateCasePayload) => Promise<void>;
};

const BLANK: CreateCasePayload = {
  title: "", priority: "medium", type: "functional",
  status: "draft", suiteId: null, tags: [],
};

const sel =
  "w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm " +
  "focus:outline-none focus:ring-1 focus:ring-violet-400";

export default function CreateCaseModal({ open, suites, defaultSuiteId, onClose, onCreate }: Props) {
  const [form, setForm] = useState<CreateCasePayload>({ ...BLANK, suiteId: defaultSuiteId });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setForm({ ...BLANK, suiteId: defaultSuiteId });
      setError(null);
      setTimeout(() => titleRef.current?.focus(), 50);
    }
  }, [open, defaultSuiteId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function set<K extends keyof CreateCasePayload>(key: K, value: CreateCasePayload[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) { setError("Title is required"); return; }
    setSaving(true);
    setError(null);
    try {
      await onCreate({ ...form, title: form.title.trim() });
    } catch (err: any) {
      setError(err?.message ?? "Failed to create case");
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-slate-900">New test case</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100 text-slate-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Title <span className="text-red-500">*</span></label>
            <Input
              ref={titleRef}
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Verify login with valid credentials"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Priority</label>
              <select value={form.priority} onChange={(e) => set("priority", e.target.value as any)} className={sel}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
              <select value={form.status} onChange={(e) => set("status", e.target.value as any)} className={sel}>
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Type</label>
            <select value={form.type} onChange={(e) => set("type", e.target.value as any)} className={sel}>
              <option value="functional">Functional</option>
              <option value="regression">Regression</option>
              <option value="security">Security</option>
              <option value="accessibility">Accessibility</option>
              <option value="other">Other</option>
            </select>
          </div>

          {suites.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Suite</label>
              <select
                value={form.suiteId ?? ""}
                onChange={(e) => set("suiteId", e.target.value || null)}
                className={sel}
              >
                <option value="">No suite</option>
                {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Tags <span className="text-slate-400 font-normal">(comma-separated)</span></label>
            <Input
              value={form.tags.join(", ")}
              onChange={(e) =>
                set("tags", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))
              }
              placeholder="smoke, auth, critical"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving || !form.title.trim()}>
              {saving ? "Creating…" : "Create case"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
