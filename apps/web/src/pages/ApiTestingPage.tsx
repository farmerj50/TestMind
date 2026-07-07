import { useEffect, useRef, useState } from "react";
import { useApi } from "../lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type Project = { id: string; name: string };
type Environment = { id: string; name: string; baseUrl: string };

type ApiTestCase = {
  id: string;
  name: string | null;
  method: string;
  path: string;
  headers: Record<string, string> | null;
  queryParams: Record<string, string> | null;
  bodyJson: string | null;
  expectedStatus: number | null;
  assertions: AssertionRule[] | null;
  authSessionId: string | null;
  timeoutMs: number;
  order: number;
};

type AssertionRule = { type: string; value?: unknown; path?: string; name?: string; schema?: unknown };

type AssertionResult = { type: string; passed: boolean; expected?: unknown; actual?: unknown; error?: string };

type RunSummary = { total: number; passed: number; failed: number; errors: number; durationMs: number };

type ApiCollection = {
  id: string;
  name: string;
  baseUrl: string;
  environmentId: string | null;
  createdAt: string;
  testCases?: ApiTestCase[];
  environment?: Environment | null;
  runs?: RunRecord[];
  _count?: { testCases: number };
};

type RunRecord = {
  id: string;
  status: string;
  createdAt: string;
  summary: RunSummary | null;
};

type TestResult = {
  id: string;
  status: string;
  statusCode: number | null;
  durationMs: number | null;
  assertionResults: AssertionResult[] | null;
  error: string | null;
  testCase: { id: string; name: string | null; method: string; path: string };
};

type FullRun = RunRecord & { results: TestResult[]; collectionId: string };

// ── Method badge ──────────────────────────────────────────────────────────────

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-blue-100 text-blue-800",
  POST: "bg-green-100 text-green-800",
  PUT: "bg-yellow-100 text-yellow-800",
  PATCH: "bg-orange-100 text-orange-800",
  DELETE: "bg-red-100 text-red-800",
  HEAD: "bg-purple-100 text-purple-800",
  OPTIONS: "bg-slate-100 text-slate-700",
};

function MethodBadge({ method }: { method: string }) {
  const cls = METHOD_COLORS[method.toUpperCase()] ?? "bg-slate-100 text-slate-700";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-bold ${cls}`}>
      {method.toUpperCase()}
    </span>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  passed: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
  error: "bg-orange-100 text-orange-800",
  queued: "bg-slate-100 text-slate-700",
  running: "bg-blue-100 text-blue-800",
  completed: "bg-emerald-100 text-emerald-800",
  skipped: "bg-slate-100 text-slate-500",
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_COLORS[status] ?? "bg-slate-100 text-slate-700";
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

// ── Import modal ──────────────────────────────────────────────────────────────

function ImportModal({
  projectId,
  onClose,
  onImported,
}: {
  projectId: string;
  onClose: () => void;
  onImported: (collectionId: string) => void;
}) {
  const { apiFetch } = useApi();
  const [specUrl, setSpecUrl] = useState("");
  const [specJson, setSpecJson] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      let body: Record<string, unknown> = { projectId };
      if (specUrl.trim()) {
        body.specUrl = specUrl.trim();
      } else if (specJson.trim()) {
        try { body.specJson = JSON.parse(specJson.trim()); }
        catch { setError("Invalid JSON"); setLoading(false); return; }
      } else {
        setError("Provide a URL or paste spec JSON");
        setLoading(false);
        return;
      }
      const data = await apiFetch<{ collectionId: string; caseCount: number }>(
        "/api-testing/specs/import",
        { method: "POST", body: JSON.stringify(body) }
      );
      onImported(data.collectionId);
    } catch (e: any) {
      setError(e?.message ?? "Import failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">Import OpenAPI / Swagger spec</h2>
        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
        <label className="block text-sm font-medium mb-1">Spec URL</label>
        <input
          className="w-full border rounded px-3 py-2 text-sm mb-4 dark:bg-slate-800 dark:border-slate-700"
          placeholder="https://api.example.com/openapi.json"
          value={specUrl}
          onChange={(e) => setSpecUrl(e.target.value)}
        />
        <label className="block text-sm font-medium mb-1">— or paste JSON —</label>
        <textarea
          className="w-full border rounded px-3 py-2 text-sm font-mono mb-4 dark:bg-slate-800 dark:border-slate-700"
          rows={6}
          placeholder='{"openapi": "3.0.0", ...}'
          value={specJson}
          onChange={(e) => setSpecJson(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <button className="px-4 py-2 text-sm rounded border" onClick={onClose}>Cancel</button>
          <button
            className="px-4 py-2 text-sm rounded bg-indigo-600 text-white disabled:opacity-50"
            onClick={submit}
            disabled={loading}
          >
            {loading ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Assertion row editor ──────────────────────────────────────────────────────

const ASSERTION_TYPES = [
  "status_equals",
  "response_time_under",
  "json_path_exists",
  "json_path_equals",
  "json_path_contains",
  "header_exists",
];

function AssertionEditor({
  assertion,
  onChange,
  onRemove,
}: {
  assertion: AssertionRule;
  onChange: (a: AssertionRule) => void;
  onRemove: () => void;
}) {
  const needsPath = ["json_path_exists", "json_path_equals", "json_path_contains"].includes(assertion.type);
  const needsValue = ["status_equals", "response_time_under", "json_path_equals", "json_path_contains"].includes(assertion.type);
  const needsName = assertion.type === "header_exists";

  return (
    <div className="flex flex-wrap gap-2 items-center mb-2">
      <select
        className="border rounded px-2 py-1 text-sm dark:bg-slate-800 dark:border-slate-700"
        value={assertion.type}
        onChange={(e) => onChange({ ...assertion, type: e.target.value })}
      >
        {ASSERTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      {needsPath && (
        <input
          className="border rounded px-2 py-1 text-sm dark:bg-slate-800 dark:border-slate-700"
          placeholder="$.data.id"
          value={assertion.path ?? ""}
          onChange={(e) => onChange({ ...assertion, path: e.target.value })}
        />
      )}
      {needsValue && (
        <input
          className="border rounded px-2 py-1 text-sm dark:bg-slate-800 dark:border-slate-700"
          placeholder={assertion.type === "status_equals" ? "200" : "value"}
          value={String(assertion.value ?? "")}
          onChange={(e) => {
            const raw = e.target.value;
            const num = Number(raw);
            onChange({ ...assertion, value: !isNaN(num) && raw !== "" ? num : raw });
          }}
        />
      )}
      {needsName && (
        <input
          className="border rounded px-2 py-1 text-sm dark:bg-slate-800 dark:border-slate-700"
          placeholder="header name"
          value={assertion.name ?? ""}
          onChange={(e) => onChange({ ...assertion, name: e.target.value })}
        />
      )}
      <button className="text-red-500 text-sm" onClick={onRemove}>✕</button>
    </div>
  );
}

// ── Test case editor panel ────────────────────────────────────────────────────

function TestCasePanel({
  tc,
  onSave,
  onClose,
}: {
  tc: ApiTestCase;
  onSave: (updated: ApiTestCase) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ApiTestCase>({ ...tc });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headersText = JSON.stringify(form.headers ?? {}, null, 2);
  const queryText = JSON.stringify(form.queryParams ?? {}, null, 2);

  const save = async () => {
    setSaving(true);
    setError(null);
    try { await onSave(form); }
    catch (e: any) { setError(e?.message ?? "Save failed"); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-lg bg-white dark:bg-slate-900 shadow-2xl z-40 overflow-y-auto flex flex-col">
      <div className="flex items-center justify-between px-5 py-4 border-b dark:border-slate-700">
        <h2 className="font-semibold">{form.name ?? `${form.method} ${form.path}`}</h2>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-900 dark:hover:text-slate-100">✕</button>
      </div>
      <div className="flex-1 px-5 py-4 space-y-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-xs font-medium mb-1">Name</label>
            <input className="w-full border rounded px-2 py-1 text-sm dark:bg-slate-800 dark:border-slate-700" value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
        </div>
        <div className="flex gap-2">
          <div>
            <label className="block text-xs font-medium mb-1">Method</label>
            <select className="border rounded px-2 py-1 text-sm dark:bg-slate-800 dark:border-slate-700" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => <option key={m}>{m}</option>)}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium mb-1">Path</label>
            <input className="w-full border rounded px-2 py-1 text-sm dark:bg-slate-800 dark:border-slate-700" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Expected status</label>
            <input type="number" className="w-20 border rounded px-2 py-1 text-sm dark:bg-slate-800 dark:border-slate-700" value={form.expectedStatus ?? ""} onChange={(e) => setForm({ ...form, expectedStatus: e.target.value ? Number(e.target.value) : null })} />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Headers (JSON)</label>
          <textarea className="w-full border rounded px-2 py-1 text-sm font-mono dark:bg-slate-800 dark:border-slate-700" rows={3}
            defaultValue={headersText}
            onBlur={(e) => { try { setForm({ ...form, headers: JSON.parse(e.target.value) }); } catch {} }}
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Query params (JSON)</label>
          <textarea className="w-full border rounded px-2 py-1 text-sm font-mono dark:bg-slate-800 dark:border-slate-700" rows={2}
            defaultValue={queryText}
            onBlur={(e) => { try { setForm({ ...form, queryParams: JSON.parse(e.target.value) }); } catch {} }}
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Request body (JSON)</label>
          <textarea className="w-full border rounded px-2 py-1 text-sm font-mono dark:bg-slate-800 dark:border-slate-700" rows={4} value={form.bodyJson ?? ""} onChange={(e) => setForm({ ...form, bodyJson: e.target.value || null })} />
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium">Assertions</label>
            <button className="text-xs text-indigo-600" onClick={() => setForm({ ...form, assertions: [...(form.assertions ?? []), { type: "status_equals", value: 200 }] })}>+ Add</button>
          </div>
          {(form.assertions ?? []).map((a, i) => (
            <AssertionEditor
              key={i}
              assertion={a}
              onChange={(updated) => {
                const next = [...(form.assertions ?? [])];
                next[i] = updated;
                setForm({ ...form, assertions: next });
              }}
              onRemove={() => {
                const next = [...(form.assertions ?? [])];
                next.splice(i, 1);
                setForm({ ...form, assertions: next });
              }}
            />
          ))}
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Timeout (ms)</label>
          <input type="number" className="w-32 border rounded px-2 py-1 text-sm dark:bg-slate-800 dark:border-slate-700" value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) || 8000 })} />
        </div>
      </div>
      <div className="px-5 py-4 border-t dark:border-slate-700 flex justify-end gap-2">
        <button className="px-4 py-2 text-sm rounded border" onClick={onClose}>Cancel</button>
        <button className="px-4 py-2 text-sm rounded bg-indigo-600 text-white disabled:opacity-50" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ApiTestingPage() {
  const { apiFetch } = useApi();

  // Project selection
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");

  // Collections list view
  const [collections, setCollections] = useState<ApiCollection[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(false);

  // Collection detail view
  const [selectedCollection, setSelectedCollection] = useState<ApiCollection | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Run result view
  const [selectedRun, setSelectedRun] = useState<FullRun | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Modals / panels
  const [showImport, setShowImport] = useState(false);
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [editingCase, setEditingCase] = useState<ApiTestCase | null>(null);

  // New collection form
  const [newName, setNewName] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newEnvId, setNewEnvId] = useState("");
  const [environments, setEnvironments] = useState<Environment[]>([]);

  // Inline errors
  const [error, setError] = useState<string | null>(null);

  // Expanded result rows
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());

  // ── Load projects on mount ───────────────────────────────────────────────

  useEffect(() => {
    apiFetch<{ projects: Project[] }>("/projects").then((d) => {
      setProjects(d.projects ?? []);
      if (d.projects?.length) setProjectId(d.projects[0].id);
    }).catch(() => {});
  }, []);

  // ── Load collections when project changes ────────────────────────────────

  useEffect(() => {
    if (!projectId) return;
    setCollectionsLoading(true);
    setSelectedCollection(null);
    setSelectedRun(null);
    setError(null);
    apiFetch<{ collections: ApiCollection[] }>(`/api-testing/collections?projectId=${projectId}`)
      .then((d) => setCollections(d.collections ?? []))
      .catch((e) => setError(e?.message ?? "Failed to load collections"))
      .finally(() => setCollectionsLoading(false));

    apiFetch<{ environments: Environment[] }>(`/environments?projectId=${projectId}`)
      .then((d) => setEnvironments(d.environments ?? []))
      .catch(() => {});
  }, [projectId]);

  // ── Load collection detail ────────────────────────────────────────────────

  const openCollection = async (id: string) => {
    setDetailLoading(true);
    setSelectedRun(null);
    setError(null);
    try {
      const d = await apiFetch<{ collection: ApiCollection }>(`/api-testing/collections/${id}`);
      setSelectedCollection(d.collection);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load collection");
    } finally {
      setDetailLoading(false);
    }
  };

  // ── Create collection ─────────────────────────────────────────────────────

  const createCollection = async () => {
    if (!newName.trim() || !newBaseUrl.trim()) return;
    setError(null);
    try {
      await apiFetch("/api-testing/collections", {
        method: "POST",
        body: JSON.stringify({ projectId, name: newName.trim(), baseUrl: newBaseUrl.trim(), environmentId: newEnvId || undefined }),
      });
      setShowNewCollection(false);
      setNewName(""); setNewBaseUrl(""); setNewEnvId("");
      // Refresh list
      const d = await apiFetch<{ collections: ApiCollection[] }>(`/api-testing/collections?projectId=${projectId}`);
      setCollections(d.collections ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Create failed");
    }
  };

  // ── Delete collection ─────────────────────────────────────────────────────

  const deleteCollection = async (id: string) => {
    if (!confirm("Delete this collection and all its test cases?")) return;
    try {
      await apiFetch(`/api-testing/collections/${id}`, { method: "DELETE" });
      setCollections((prev) => prev.filter((c) => c.id !== id));
      if (selectedCollection?.id === id) setSelectedCollection(null);
    } catch (e: any) {
      setError(e?.message ?? "Delete failed");
    }
  };

  // ── Add endpoint manually ─────────────────────────────────────────────────

  const addEndpoint = async (collectionId: string) => {
    try {
      const data = await apiFetch<{ testCase: ApiTestCase }>("/api-testing/test-cases", {
        method: "POST",
        body: JSON.stringify({ collectionId, method: "GET", path: "/", expectedStatus: 200, assertions: [{ type: "status_equals", value: 200 }] }),
      });
      setSelectedCollection((prev) => prev ? { ...prev, testCases: [...(prev.testCases ?? []), data.testCase] } : prev);
    } catch (e: any) {
      setError(e?.message ?? "Failed to add endpoint");
    }
  };

  // ── Save test case ────────────────────────────────────────────────────────

  const saveCase = async (updated: ApiTestCase) => {
    await apiFetch(`/api-testing/test-cases/${updated.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        method: updated.method, path: updated.path, name: updated.name,
        headers: updated.headers, queryParams: updated.queryParams, bodyJson: updated.bodyJson,
        expectedStatus: updated.expectedStatus, assertions: updated.assertions,
        timeoutMs: updated.timeoutMs,
      }),
    });
    setSelectedCollection((prev) =>
      prev ? { ...prev, testCases: (prev.testCases ?? []).map((tc) => tc.id === updated.id ? updated : tc) } : prev
    );
    setEditingCase(null);
  };

  // ── Delete test case ──────────────────────────────────────────────────────

  const deleteCase = async (id: string) => {
    if (!confirm("Delete this test case?")) return;
    try {
      await apiFetch(`/api-testing/test-cases/${id}`, { method: "DELETE" });
      setSelectedCollection((prev) => prev ? { ...prev, testCases: (prev.testCases ?? []).filter((tc) => tc.id !== id) } : prev);
    } catch (e: any) {
      setError(e?.message ?? "Delete failed");
    }
  };

  // ── Trigger run ───────────────────────────────────────────────────────────

  const triggerRun = async (collectionId: string, testCaseIds?: string[]) => {
    setError(null);
    try {
      const data = await apiFetch<{ runId: string }>("/api-testing/runs", {
        method: "POST",
        body: JSON.stringify({ projectId, collectionId, testCaseIds }),
      });
      pollRun(data.runId);
    } catch (e: any) {
      setError(e?.message ?? "Failed to trigger run");
    }
  };

  // ── Poll run ──────────────────────────────────────────────────────────────

  const pollRun = (runId: string) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    const fetch = async () => {
      try {
        const data = await apiFetch<{ run: FullRun }>(`/api-testing/runs/${runId}`);
        setSelectedRun(data.run);
        if (data.run.status === "queued" || data.run.status === "running") {
          pollRef.current = setTimeout(fetch, 2000);
        }
      } catch (e: any) {
        setError(e?.message ?? "Failed to fetch run");
      }
    };
    fetch();
  };

  // ── Cleanup poll ──────────────────────────────────────────────────────────

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 p-6">
      <div className="max-w-6xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">API Testing</h1>
            <p className="text-sm text-slate-500 mt-0.5">Functional endpoint validation, response assertions, and collection runs</p>
          </div>
          <div className="flex gap-2">
            <select
              className="border rounded px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:border-slate-700"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded px-4 py-3 text-sm">
            {error}
            <button className="ml-4 underline text-xs" onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}

        {/* Run results view */}
        {selectedRun && (
          <div>
            <button className="text-sm text-indigo-600 mb-3" onClick={() => setSelectedRun(null)}>
              ← Back to {selectedCollection?.name ?? "collection"}
            </button>
            <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800 overflow-hidden">
              <div className="px-5 py-4 border-b dark:border-slate-700 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <StatusBadge status={selectedRun.status} />
                  <span className="text-sm text-slate-500">{new Date(selectedRun.createdAt).toLocaleString()}</span>
                </div>
                {selectedRun.summary && (
                  <div className="flex gap-4 text-sm">
                    <span className="text-emerald-600 font-medium">{selectedRun.summary.passed} passed</span>
                    <span className="text-rose-600 font-medium">{selectedRun.summary.failed} failed</span>
                    <span className="text-orange-600 font-medium">{selectedRun.summary.errors} errors</span>
                    <span className="text-slate-500">{(selectedRun.summary.durationMs / 1000).toFixed(1)}s</span>
                  </div>
                )}
                {selectedCollection && (
                  <button
                    className="px-3 py-1.5 text-sm rounded bg-indigo-600 text-white"
                    onClick={() => triggerRun(selectedCollection.id)}
                  >
                    Rerun
                  </button>
                )}
              </div>
              {(selectedRun.status === "queued" || selectedRun.status === "running") && (
                <div className="px-5 py-3 text-sm text-slate-500 animate-pulse">Run in progress…</div>
              )}
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800 text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Method</th>
                    <th className="px-4 py-2 text-left">Path</th>
                    <th className="px-4 py-2 text-left">Status</th>
                    <th className="px-4 py-2 text-left">Code</th>
                    <th className="px-4 py-2 text-left">Duration</th>
                    <th className="px-4 py-2 text-left">Assertions</th>
                  </tr>
                </thead>
                <tbody className="divide-y dark:divide-slate-800">
                  {selectedRun.results.map((r) => (
                    <>
                      <tr
                        key={r.id}
                        className="hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                        onClick={() => setExpandedResults((prev) => {
                          const next = new Set(prev);
                          next.has(r.id) ? next.delete(r.id) : next.add(r.id);
                          return next;
                        })}
                      >
                        <td className="px-4 py-2"><MethodBadge method={r.testCase.method} /></td>
                        <td className="px-4 py-2 font-mono text-xs">{r.testCase.path}</td>
                        <td className="px-4 py-2"><StatusBadge status={r.status} /></td>
                        <td className="px-4 py-2 text-slate-500">{r.statusCode ?? "—"}</td>
                        <td className="px-4 py-2 text-slate-500">{r.durationMs != null ? `${r.durationMs}ms` : "—"}</td>
                        <td className="px-4 py-2 text-slate-500">
                          {r.assertionResults
                            ? `${r.assertionResults.filter((a) => a.passed).length}/${r.assertionResults.length}`
                            : "—"}
                        </td>
                      </tr>
                      {expandedResults.has(r.id) && (
                        <tr key={`${r.id}-detail`}>
                          <td colSpan={6} className="px-6 py-3 bg-slate-50 dark:bg-slate-800/50 text-xs">
                            {r.error && <p className="text-red-600 mb-2">Error: {r.error}</p>}
                            {r.assertionResults && r.assertionResults.length > 0 && (
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-slate-500">
                                    <th className="text-left pr-4">Assertion</th>
                                    <th className="text-left pr-4">Expected</th>
                                    <th className="text-left pr-4">Actual</th>
                                    <th className="text-left">Result</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.assertionResults.map((a, i) => (
                                    <tr key={i} className={a.passed ? "text-emerald-700" : "text-rose-700"}>
                                      <td className="pr-4 py-0.5 font-mono">{a.type}</td>
                                      <td className="pr-4 py-0.5">{JSON.stringify(a.expected)}</td>
                                      <td className="pr-4 py-0.5">{JSON.stringify(a.actual)}</td>
                                      <td className="py-0.5">{a.passed ? "✓ pass" : "✗ fail"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Collection detail view */}
        {!selectedRun && selectedCollection && (
          <div>
            <button className="text-sm text-indigo-600 mb-3" onClick={() => setSelectedCollection(null)}>← Collections</button>
            <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800 overflow-hidden">
              <div className="px-5 py-4 border-b dark:border-slate-700 flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h2 className="font-semibold text-lg">{selectedCollection.name}</h2>
                  <p className="text-sm text-slate-500 font-mono">{selectedCollection.baseUrl}</p>
                </div>
                <div className="flex gap-2 items-center flex-wrap">
                  {environments.length > 0 && (
                    <select
                      className="border rounded px-2 py-1.5 text-sm dark:bg-slate-800 dark:border-slate-700"
                      value={selectedCollection.environmentId ?? ""}
                      onChange={async (e) => {
                        const environmentId = e.target.value || undefined;
                        await apiFetch(`/api-testing/collections/${selectedCollection.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ environmentId: environmentId ?? null }),
                        });
                        setSelectedCollection({ ...selectedCollection, environmentId: environmentId ?? null });
                      }}
                    >
                      <option value="">No environment</option>
                      {environments.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
                    </select>
                  )}
                  <button
                    className="px-3 py-1.5 text-sm rounded border"
                    onClick={() => addEndpoint(selectedCollection.id)}
                  >
                    + Add endpoint
                  </button>
                  <button
                    className="px-3 py-1.5 text-sm rounded bg-indigo-600 text-white"
                    onClick={() => triggerRun(selectedCollection.id)}
                  >
                    Run all
                  </button>
                </div>
              </div>
              {detailLoading && <div className="px-5 py-8 text-sm text-slate-400 text-center">Loading…</div>}
              {!detailLoading && (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800 text-xs text-slate-500 uppercase">
                    <tr>
                      <th className="px-4 py-2 text-left">Method</th>
                      <th className="px-4 py-2 text-left">Path</th>
                      <th className="px-4 py-2 text-left">Name</th>
                      <th className="px-4 py-2 text-left">Expected</th>
                      <th className="px-4 py-2 text-left">Assertions</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-slate-800">
                    {(selectedCollection.testCases ?? []).map((tc) => (
                      <tr key={tc.id} className="hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer" onClick={() => setEditingCase(tc)}>
                        <td className="px-4 py-2"><MethodBadge method={tc.method} /></td>
                        <td className="px-4 py-2 font-mono text-xs">{tc.path}</td>
                        <td className="px-4 py-2 text-slate-500">{tc.name ?? "—"}</td>
                        <td className="px-4 py-2 text-slate-500">{tc.expectedStatus ?? "—"}</td>
                        <td className="px-4 py-2 text-slate-500">{(tc.assertions ?? []).length}</td>
                        <td className="px-4 py-2 text-right">
                          <button
                            className="text-xs text-red-500 ml-3"
                            onClick={(e) => { e.stopPropagation(); deleteCase(tc.id); }}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                    {(selectedCollection.testCases ?? []).length === 0 && (
                      <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">No endpoints yet. Add one manually or import an OpenAPI spec.</td></tr>
                    )}
                  </tbody>
                </table>
              )}
              {(selectedCollection.runs ?? []).length > 0 && (
                <div className="border-t dark:border-slate-700 px-5 py-3">
                  <p className="text-xs font-medium text-slate-500 uppercase mb-2">Recent runs</p>
                  <div className="space-y-1">
                    {(selectedCollection.runs ?? []).map((r) => (
                      <div key={r.id} className="flex items-center gap-3 text-sm">
                        <StatusBadge status={r.status} />
                        <span className="text-slate-500 text-xs">{new Date(r.createdAt).toLocaleString()}</span>
                        {r.summary && <span className="text-xs text-slate-500">{r.summary.passed}/{r.summary.total} passed</span>}
                        <button className="text-xs text-indigo-600" onClick={() => pollRun(r.id)}>View</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Collections list view */}
        {!selectedRun && !selectedCollection && (
          <div>
            <div className="flex gap-2 mb-4">
              <button
                className="px-4 py-2 text-sm rounded border bg-white dark:bg-slate-800 dark:border-slate-700"
                onClick={() => setShowNewCollection((v) => !v)}
              >
                + New collection
              </button>
              <button
                className="px-4 py-2 text-sm rounded border bg-white dark:bg-slate-800 dark:border-slate-700"
                onClick={() => setShowImport(true)}
              >
                Import OpenAPI
              </button>
            </div>

            {showNewCollection && (
              <div className="bg-white dark:bg-slate-900 border dark:border-slate-700 rounded-lg p-4 mb-4 flex flex-wrap gap-3 items-end">
                <div>
                  <label className="block text-xs font-medium mb-1">Name</label>
                  <input className="border rounded px-2 py-1.5 text-sm dark:bg-slate-800 dark:border-slate-700" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="My API" />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Base URL</label>
                  <input className="border rounded px-2 py-1.5 text-sm dark:bg-slate-800 dark:border-slate-700 w-64" value={newBaseUrl} onChange={(e) => setNewBaseUrl(e.target.value)} placeholder="https://api.example.com" />
                </div>
                {environments.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium mb-1">Environment</label>
                    <select className="border rounded px-2 py-1.5 text-sm dark:bg-slate-800 dark:border-slate-700" value={newEnvId} onChange={(e) => setNewEnvId(e.target.value)}>
                      <option value="">None</option>
                      {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                    </select>
                  </div>
                )}
                <button className="px-4 py-1.5 text-sm rounded bg-indigo-600 text-white" onClick={createCollection}>Create</button>
                <button className="px-4 py-1.5 text-sm rounded border" onClick={() => setShowNewCollection(false)}>Cancel</button>
              </div>
            )}

            <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800 overflow-hidden">
              {collectionsLoading && <div className="px-5 py-8 text-center text-sm text-slate-400">Loading…</div>}
              {!collectionsLoading && collections.length === 0 && (
                <div className="px-5 py-12 text-center text-sm text-slate-400">
                  No collections yet. Import an OpenAPI spec or create one manually.
                </div>
              )}
              {!collectionsLoading && collections.length > 0 && (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800 text-xs text-slate-500 uppercase">
                    <tr>
                      <th className="px-4 py-2 text-left">Name</th>
                      <th className="px-4 py-2 text-left">Base URL</th>
                      <th className="px-4 py-2 text-left">Endpoints</th>
                      <th className="px-4 py-2 text-left">Last run</th>
                      <th className="px-4 py-2 text-left">Updated</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-slate-800">
                    {collections.map((c) => {
                      const lastRun = c.runs?.[0];
                      return (
                        <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer" onClick={() => openCollection(c.id)}>
                          <td className="px-4 py-3 font-medium">{c.name}</td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-500">{c.baseUrl}</td>
                          <td className="px-4 py-3 text-slate-500">{c._count?.testCases ?? 0}</td>
                          <td className="px-4 py-3">
                            {lastRun ? <StatusBadge status={lastRun.status} /> : <span className="text-slate-400 text-xs">Never</span>}
                          </td>
                          <td className="px-4 py-3 text-slate-400 text-xs">{new Date(c.createdAt).toLocaleDateString()}</td>
                          <td className="px-4 py-3 text-right flex gap-2 justify-end">
                            <button
                              className="px-3 py-1 text-xs rounded bg-indigo-600 text-white"
                              onClick={(e) => { e.stopPropagation(); triggerRun(c.id); openCollection(c.id); }}
                            >
                              Run
                            </button>
                            <button
                              className="text-xs text-red-500"
                              onClick={(e) => { e.stopPropagation(); deleteCollection(c.id); }}
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Modals / panels */}
      {showImport && projectId && (
        <ImportModal
          projectId={projectId}
          onClose={() => setShowImport(false)}
          onImported={async (collectionId) => {
            setShowImport(false);
            const d = await apiFetch<{ collections: ApiCollection[] }>(`/api-testing/collections?projectId=${projectId}`);
            setCollections(d.collections ?? []);
            openCollection(collectionId);
          }}
        />
      )}

      {editingCase && selectedCollection && (
        <TestCasePanel
          tc={editingCase}
          onSave={saveCase}
          onClose={() => setEditingCase(null)}
        />
      )}
    </div>
  );
}
