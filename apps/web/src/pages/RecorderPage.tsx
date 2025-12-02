import { useEffect, useState } from "react";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

type SpecMeta = { projectId: string; name: string; path: string; pathRelative?: string };
type Project = { id: string; name: string; repoUrl: string };

export default function RecorderPage() {
  const { apiFetch } = useApi();
  const [specs, setSpecs] = useState<SpecMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchStatus, setLaunchStatus] = useState<string | null>(null);
  const [helperDetected, setHelperDetected] = useState<"unknown" | "online" | "offline">("unknown");
  const [lastCallback, setLastCallback] = useState<string | null>(null);
  const [lastCallbackBody, setLastCallbackBody] = useState<any>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<"typescript" | "javascript" | "python" | "java">("typescript");
  const [content, setContent] = useState("// paste or write your Playwright spec here\n");
  const [command, setCommand] = useState<{ windows: string; unix: string } | null>(null);
  const [headed, setHeaded] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
      const res = await apiFetch<{ specs: SpecMeta[] }>(`/recorder/specs${qs}`);
      setSpecs(res.specs);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load specs");
    } finally {
      setLoading(false);
    }
  };

  // simple probe for helper availability
  const probeHelper = async () => {
    try {
      const res = await fetch("http://localhost:43117/record", { method: "OPTIONS" });
      setHelperDetected(res.ok ? "online" : "offline");
    } catch {
      setHelperDetected("offline");
    }
  };

  useEffect(() => {
    load();
    (async () => {
      try {
        const res = await apiFetch<{ projects: Project[] }>("/projects");
        setProjects(res.projects || []);
      } catch {
        /* ignore */
      }
    })();
    probeHelper();

    const interval = window.setInterval(async () => {
      try {
        const res = await apiFetch<{ lastCallback?: { receivedAt?: string; body?: any } }>("/recorder/callback/last");
        const ts = res.lastCallback?.receivedAt;
        if (ts && ts !== lastCallback) {
          setLastCallback(ts);
          setLastCallbackBody(res.lastCallback?.body ?? null);
          await load();
        }
      } catch {
        /* ignore */
      }
      probeHelper();
    }, 5000) as unknown as number;

    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCallback]);

  const handleProjectSelect = (pid: string) => {
    setProjectId(pid);
    const found = projects.find((p) => p.id === pid);
    if (found?.repoUrl) {
      setBaseUrl(found.repoUrl);
    }
  };

  const ensureProjectId = async () => {
    if (projectId.trim()) return projectId.trim();
    const url = baseUrl.trim();
    if (!url) {
      setErr("Enter Base URL to create a new project.");
      throw new Error("Base URL required");
    }
    try {
      const name = (() => {
        try {
          const host = new URL(url).hostname || "recorded-project";
          return host.replace(/^www\\./, "");
        } catch {
          return "recorded-project";
        }
      })();
      const res = await apiFetch<{ project: Project }>("/projects", {
        method: "POST",
        body: JSON.stringify({ name, repoUrl: url }),
      });
      setProjects((prev) => [...prev, res.project]);
      setProjectId(res.project.id);
      return res.project.id;
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create project from Base URL");
      throw e;
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setErr(null);
      const pid = projectId.trim() || (await ensureProjectId());
      const body: any = { name: name || "recorded-spec", content };
      body.projectId = pid;
      if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
      body.language = language;
      const res = await apiFetch<{ projectId: string; path: string }>(`/recorder/specs`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setProjectId(res.projectId);
      await load();
      alert(`Saved to ${res.path}`);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to save spec");
    }
  };

  const handleCommand = async () => {
    if (!name.trim()) {
      setErr("Enter Spec name to generate a recorder command.");
      return;
    }
    const computedProjectId = projectId.trim();
    const computedBaseUrl =
      baseUrl.trim() || projects.find((p) => p.id === computedProjectId)?.repoUrl || "";
    if (!computedProjectId && !computedBaseUrl) {
      setErr("Enter Base URL (or select a project with a repo URL) to build the command.");
      return;
    }
    try {
      setErr(null);
      const pid = computedProjectId || (await ensureProjectId());
      const res = await apiFetch<{ projectId: string; path: string; commandWindows: string; commandUnix: string }>(
        `/recorder/codegen-command`,
        {
          method: "POST",
          body: JSON.stringify({
            projectId: pid,
            baseUrl: computedBaseUrl || baseUrl.trim(),
            name: name.trim(),
            language,
          }),
        }
      );
      setCommand({ windows: res.commandWindows, unix: res.commandUnix });
      if (!projectId) setProjectId(res.projectId);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to build command");
    }
  };

  const handleLaunch = async () => {
    if (!name.trim()) {
      setErr("Enter Spec name to launch the recorder.");
      return;
    }
    const computedProjectId = projectId.trim();
    const computedBaseUrl =
      baseUrl.trim() || projects.find((p) => p.id === computedProjectId)?.repoUrl || "";
    if (!computedProjectId && !computedBaseUrl) {
      setErr("Enter Base URL (or select a project with a repo URL) to launch.");
      return;
    }
    try {
      setErr(null);
      setLaunchStatus(null);
      setLaunching(true);
      const pid = computedProjectId || (await ensureProjectId());
      const res = await fetch("http://localhost:43117/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: pid || undefined,
          baseUrl: computedBaseUrl,
          name: name.trim(),
          language,
          headed,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data?.error || "Failed to launch recorder");
      }
      setLaunchStatus(`Launched recorder (pid: ${data.pid}) saving to ${data.outputPath}${headed ? " (headed)" : ""}`);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to launch recorder. Make sure recorder-helper is running locally.");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Recorder</h1>
        <p className="text-sm text-slate-600">
          Save recorded or edited specs under the project&apos;s recordings folder. Provide a project ID to attach,
          or a base URL to create a new project on the fly.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <form className="space-y-3 rounded-lg border bg-[var(--tm-input-bg)] p-4 shadow-sm" onSubmit={handleSave}>
          <div className="grid gap-1">
            <label className="text-sm font-medium text-slate-700">Project</label>
            <Select value={projectId} onValueChange={handleProjectSelect}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} ({p.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="Or paste a project ID"
              className="mt-1"
            />
            <p className="text-xs text-slate-500">Required to attach the recorded spec.</p>
          </div>
          <div className="grid gap-1">
            <label className="text-sm font-medium text-slate-700">Base URL (optional)</label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com" />
            <p className="text-xs text-slate-500">
              Required if creating a new project.
            </p>
          </div>
          <div className="grid gap-1">
            <label className="text-sm font-medium text-slate-700">Spec name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-spec" />
          </div>
          <div className="grid gap-1">
            <label className="text-sm font-medium text-slate-700">Language</label>
            <Select value={language} onValueChange={(val) => setLanguage(val as any)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select language" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="typescript">TypeScript</SelectItem>
                <SelectItem value="javascript">JavaScript</SelectItem>
                <SelectItem value="python">Python</SelectItem>
                <SelectItem value="java">Java</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <input
              id="headed"
              type="checkbox"
              checked={headed}
              onChange={(e) => setHeaded(e.target.checked)}
              className="h-4 w-4"
            />
            <label htmlFor="headed">Launch recorder in headed mode</label>
          </div>
          <div className="grid gap-1">
            <label className="text-sm font-medium text-slate-700">Content</label>
            <textarea
              className="min-h-[220px] w-full rounded-md border border-slate-200 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!(projectId.trim() || baseUrl.trim())}>Save spec</Button>
            <Button type="button" size="sm" variant="outline" onClick={load} disabled={loading}>
              Refresh list
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={handleCommand}
              disabled={!(projectId.trim() || baseUrl.trim())}
            >
              Get recorder command
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={handleLaunch}
              disabled={launching || !(projectId.trim() || baseUrl.trim())}
            >
              {launching ? "Launching..." : "Launch recorder"}
            </Button>
          </div>
          <div className="text-xs text-slate-500">
            Helper status:{" "}
            <span className={helperDetected === "online" ? "text-emerald-600" : helperDetected === "offline" ? "text-rose-600" : ""}>
              {helperDetected === "online" ? "online" : helperDetected === "offline" ? "offline (start recorder-helper)" : "checking..."}
            </span>
            {lastCallback && (
              <span className="ml-2 text-xs text-slate-500">last callback at {lastCallback}</span>
            )}
            {helperDetected === "offline" && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-2 h-6 px-2 text-xs"
                onClick={probeHelper}
              >
                Recheck helper
              </Button>
            )}
          </div>
          {err && <div className="text-sm text-rose-600">{err}</div>}
          {command && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700 space-y-1">
              <div className="font-semibold text-slate-800">Run codegen locally</div>
              <div>Windows:</div>
                <pre className="whitespace-pre-wrap break-all">{command.windows}</pre>
                <div>macOS/Linux:</div>
                <pre className="whitespace-pre-wrap break-all">{command.unix}</pre>
                <p className="text-[11px] text-slate-500">This opens Playwright codegen so you can record the flow; the spec will be saved to the recordings folder.</p>
              </div>
            )}
            {launchStatus && (
              <div className="text-sm text-emerald-700 rounded-md border border-emerald-200 bg-emerald-50 p-2">
                {launchStatus}
              </div>
            )}
        </form>

        <div className="space-y-3 rounded-lg border bg-[var(--tm-input-bg)] p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold text-slate-900">Recorded specs</div>
              <p className="text-xs text-slate-500">Saved under recordings for each project.</p>
              {lastCallbackBody?.status && (
                <p className="text-xs text-emerald-700">
                  Helper: {lastCallbackBody.status} {lastCallbackBody.outputPath ? `-> ${lastCallbackBody.outputPath}` : ""}
                </p>
              )}
            </div>
            <Button size="sm" variant="outline" onClick={load} disabled={loading}>
              {loading ? "Loading..." : "Refresh"}
            </Button>
          </div>
          {specs.length === 0 ? (
            <div className="text-sm text-slate-500">No recorded specs found.</div>
          ) : (
            <ul className="divide-y">
              {specs.map((s) => (
                <li key={`${s.projectId}:${s.name}`} className="py-2">
                  <div className="text-sm font-medium text-slate-900">{s.name}</div>
                  <div className="text-xs text-slate-500">
                    Project: {s.projectId} → {s.pathRelative || s.path}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}


