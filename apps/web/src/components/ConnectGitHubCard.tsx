import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { useApi } from "../lib/api";
import { apiHref } from "../lib/env";
import { toast } from "sonner";
import { useUser } from "@clerk/clerk-react";
import { useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

type Repo = { name: string; url: string; private: boolean };

type Props = {
  onPickRepo: (url: string) => void;
};

export default function ConnectGitHubCard({ onPickRepo }: Props) {
  const { apiFetch } = useApi();
  const { user } = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  const prevUserId = useRef<string | null>(null);
  const STORAGE_KEY = "tm:lastGithubUser";
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const showConnected = connected;

  async function disconnect() {
    setLoading(true);
    setError(null);
    try {
      // Clear backend token and status so the next connect forces GitHub auth
      await apiFetch("/auth/github/reset", { method: "POST", auth: "include" }).catch(() => {});
      await apiFetch("/github/status", { method: "DELETE", auth: "include" }).catch(() => {});
      localStorage.removeItem(STORAGE_KEY);
      setConnected(false);
      setRepos([]);
      onPickRepo("");
      toast("Disconnected from GitHub", {
        description: "To connect a different GitHub account, log out of GitHub then click Connect again.",
      });

      window.open("https://github.com/logout", "_blank", "noopener,noreferrer");
    } catch (e: any) {
      const msg = e?.message || "Failed to disconnect GitHub";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const status = await apiFetch<{ connected: boolean }>("/github/status", { auth: "include" });
      console.log("github/status:", status);
      let list: Repo[] = [];
      if (status.connected) {
        const r = await apiFetch<{ repos: Repo[] }>("/github/repos", { auth: "include" });
        list = r.repos || [];
      }

      setConnected(status.connected);
      setRepos(status.connected ? list : []);
    } catch (e: any) {
      const msg = e?.message || "Failed to check GitHub status";
      setConnected(false);
      setRepos([]);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // when user changes (sign in/out), always reset state; if different user, drop any old token
    (async () => {
      setConnected(false);
      setRepos([]);
      setError(null);

      const currentId = user?.id || null;
      if (!currentId) {
        prevUserId.current = null;
        localStorage.removeItem(STORAGE_KEY);
        setLoading(false);
        return;
      }

      localStorage.setItem(STORAGE_KEY, currentId);
      prevUserId.current = currentId;
      // Do not auto-refresh; require explicit connect or ?github=connected
      setLoading(false);
    })();
  }, [user?.id]);

  // If redirected back with ?github=connected, force a status/rep refresh and then clean the URL
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("github") === "connected") {
      (async () => {
        try {
          await refresh();
        } finally {
          params.delete("github");
          navigate({ search: params.toString() }, { replace: true });
        }
      })();
    }
  }, [location.search, user?.id]);

  async function startConnect() {
    setLoading(true);
    setError(null);
    try {
      // Start a fresh auth flow; do not reset here to avoid wiping newly saved tokens
      setConnected(false);
      setRepos([]);
      // Try to fetch a signed GitHub auth URL (uses Clerk auth); if that fails, fallback to direct redirect.
      try {
        const res = await apiFetch<{ url: string }>(
          `/auth/github/start-url?returnTo=/dashboard`
        );
        if (res?.url) {
          window.location.href = res.url;
          return;
        }
        throw new Error("Missing GitHub auth URL");
      } catch (inner: any) {
        const msg = inner?.message || "Starting GitHub connect failed";
        setError(msg);
        toast.error(msg);
        return;
      }
    } catch (e: any) {
      const msg = e?.message || "Failed to start GitHub connect";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border bg-white p-4">
      <h2 className="mb-3 text-sm font-medium text-slate-800">GitHub</h2>

      {loading ? (
        <div className="text-sm text-slate-500">Checking connection...</div>
      ) : !showConnected ? (
        <>
          {error && (
            <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {error}
            </div>
          )}
          <p className="mb-3 text-sm text-slate-600">Connect your account to pick a repo.</p>
          <div className="flex items-center gap-2">
            <Button onClick={startConnect}>Connect GitHub</Button>
            <Button variant="outline" onClick={refresh}>Retry</Button>
          </div>
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
              Select a repo...
            </option>
            {repos.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name} {r.private ? "(private)" : ""}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <Button variant="outline" onClick={refresh}>Refresh</Button>
            <Button variant="outline" onClick={disconnect}>Disconnect</Button>
          </div>
        </div>
      )}
    </div>
  );
}
