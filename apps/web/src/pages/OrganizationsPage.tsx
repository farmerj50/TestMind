import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Building2, Plus, Users, FolderOpen, ChevronRight, AlertCircle } from "lucide-react";

type OrgSummary = {
  org: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    createdAt: string;
  };
  role: string;
  joinedAt: string;
  memberCount: number;
  projectCount: number;
};

export default function OrganizationsPage() {
  const { apiFetch } = useApi();
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create org modal state
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadOrgs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<OrgSummary[]>("/orgs");
      setOrgs(data ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load organizations");
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { loadOrgs(); }, [loadOrgs]);

  // Auto-generate slug from name
  const handleNameChange = (v: string) => {
    setNewName(v);
    setNewSlug(
      v.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
    );
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await apiFetch("/orgs", {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), slug: newSlug }),
      });
      setShowCreate(false);
      setNewName("");
      setNewSlug("");
      await loadOrgs();
    } catch (e: any) {
      setCreateError(e?.message ?? "Failed to create organization");
    } finally {
      setCreating(false);
    }
  };

  const ROLE_BADGE: Record<string, string> = {
    owner: "bg-violet-100 text-violet-700",
    admin: "bg-blue-100 text-blue-700",
    member: "bg-slate-100 text-slate-600",
    viewer: "bg-slate-100 text-slate-400",
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Organizations</h1>
          <p className="text-sm text-slate-500 mt-1">
            Share projects and control access across your team.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="gap-2">
          <Plus className="h-4 w-4" /> New organization
        </Button>
      </div>

      {/* Create org dialog */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold mb-4">Create organization</h2>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-slate-700">Name</label>
                <Input
                  value={newName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="Acme Corp"
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700">Slug (URL-safe)</label>
                <Input
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  placeholder="acme-corp"
                  className="mt-1"
                />
                <p className="text-xs text-slate-400 mt-1">Used in API paths — cannot be changed.</p>
              </div>
              {createError && (
                <p className="text-sm text-red-600 flex gap-1 items-center">
                  <AlertCircle className="h-4 w-4 shrink-0" /> {createError}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <Button variant="outline" onClick={() => { setShowCreate(false); setCreateError(null); }}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={creating || !newName.trim() || !newSlug.trim()}>
                {creating ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {loading && (
        <p className="text-sm text-slate-500">Loading…</p>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && orgs.length === 0 && (
        <div className="text-center py-20 text-slate-400">
          <Building2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No organizations yet</p>
          <p className="text-sm mt-1">Create one to share projects with your team.</p>
        </div>
      )}

      <div className="space-y-3">
        {orgs.map(({ org, role, memberCount, projectCount }) => (
          <Link
            key={org.id}
            to={`/organizations/${org.slug}`}
            className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-300 hover:shadow-sm transition-all"
          >
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-violet-100 flex items-center justify-center">
                <Building2 className="h-5 w-5 text-violet-600" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-900">{org.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ROLE_BADGE[role] ?? "bg-slate-100 text-slate-500"}`}>
                    {role}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-500">
                  <span className="flex items-center gap-1">
                    <Users className="h-3 w-3" /> {memberCount} {memberCount === 1 ? "member" : "members"}
                  </span>
                  <span className="flex items-center gap-1">
                    <FolderOpen className="h-3 w-3" /> {projectCount} {projectCount === 1 ? "project" : "projects"}
                  </span>
                </div>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-slate-400" />
          </Link>
        ))}
      </div>
    </div>
  );
}
