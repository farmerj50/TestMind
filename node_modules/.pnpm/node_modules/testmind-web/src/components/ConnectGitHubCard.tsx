import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button"; // if you don't have shadcn Button, swap to a plain <a>
import { useApi } from "@/lib/api";
import { apiHref } from "@/lib/env";
import { toast } from "sonner";

type Repo = { name: string; url: string; private: boolean };

type Props = {
  onPickRepo: (url: string) => void;
};

export default function ConnectGitHubCard({ onPickRepo }: Props) {
  const { apiFetch } = useApi();
  const [connected, setConnected] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      console.log("[GitHubCard] fetching status…");
      const s = await apiFetch<{ connected: boolean }>("/github/status");
      setConnected(s.connected);
      if (s.connected) {
        console.log("[GitHubCard] fetching repos…");
        const r = await apiFetch<{ repos: Repo[] }>("/github/repos");
        setRepos(r.repos);
      }
    } catch (e: any) {
      const msg = e?.message || "Failed to check GitHub status";
      console.error("[GitHubCard] error:", msg);
      setError(msg);
      // still render the card with a retry + connect button
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    console.log("[GitHubCard] mounted");
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded-lg border bg-white p-4">
      <h2 className="mb-3 text-sm font-medium text-slate-800">GitHub</h2>

      {loading ? (
        <div className="text-sm text-slate-500">Checking connection…</div>
      ) : !connected ? (
        <>
          {error && (
            <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {error}
            </div>
          )}
          <p className="mb-3 text-sm text-slate-600">Connect your account to pick a repo.</p>
          <div className="flex items-center gap-2">
            <Button asChild>
              <a href={apiHref("/auth/github/start")}>Connect GitHub</a>
            </Button>
            <Button variant="outline" onClick={refresh}>Retry</Button>
          </div>
        </>
      ) : repos.length === 0 ? (
        <>
          <div className="text-sm text-slate-500">No repos found.</div>
          <Button variant="outline" className="mt-2" onClick={refresh}>Refresh</Button>
        </>
      ) : (
        <div className="space-y-2">
          <label className="text-xs text-slate-600" htmlFor="repo-select">
            Pick a repository
          </label>
          <select
            id="repo-select"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            defaultValue=""
            onChange={(e) => {
              const fullName = e.target.value;
              const match = repos.find((r) => r.name === fullName);
              if (match) {
                onPickRepo(match.url);
                toast("Repository selected", { description: match.name });
              }
            }}
          >
            <option value="" disabled>
              Select a repo…
            </option>
            {repos.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name} {r.private ? "(private)" : ""}
              </option>
            ))}
          </select>
          <Button variant="outline" onClick={refresh}>Refresh</Button>
        </div>
      )}
    </div>
  );
}
