import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Building2, Users, FolderOpen, Plus, Trash2, ChevronLeft,
  Crown, Shield, User, Eye, AlertCircle, Check, X, Settings,
} from "lucide-react";

type Member = {
  id: string;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer";
  inviteEmail?: string;
  joinedAt: string;
};

type OrgProject = {
  id: string;
  name: string;
  repoUrl: string;
  plan: string;
  createdAt: string;
};

type OrgDetail = {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  plan: string;
  createdAt: string;
  members: Member[];
  projects: OrgProject[];
  currentUserRole: "owner" | "admin" | "member" | "viewer";
};

const ROLE_ICON: Record<string, React.ReactNode> = {
  owner: <Crown className="h-3.5 w-3.5 text-amber-500" />,
  admin: <Shield className="h-3.5 w-3.5 text-blue-500" />,
  member: <User className="h-3.5 w-3.5 text-slate-400" />,
  viewer: <Eye className="h-3.5 w-3.5 text-slate-300" />,
};

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

const ROLE_DESC: Record<string, string> = {
  owner: "Full control of the org",
  admin: "Invite/remove members, manage projects",
  member: "View org projects, add own projects",
  viewer: "Read-only access to org projects",
};

export default function OrganizationDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const { apiFetch } = useApi();
  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Invite state
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUserId, setInviteUserId] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member" | "viewer">("member");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState(false);

  // Add project state
  const [showAddProject, setShowAddProject] = useState(false);
  const [addProjectId, setAddProjectId] = useState("");
  const [addingProject, setAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);

  // Role change state
  const [changingRole, setChangingRole] = useState<string | null>(null);

  const loadOrg = useCallback(async () => {
    if (!slug) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<OrgDetail>(`/orgs/${slug}`);
      setOrg(data);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load organization");
    } finally {
      setLoading(false);
    }
  }, [apiFetch, slug]);

  useEffect(() => { loadOrg(); }, [loadOrg]);

  const canManage = org?.currentUserRole === "owner" || org?.currentUserRole === "admin";

  const handleInvite = async () => {
    if (!slug || (!inviteEmail.trim() && !inviteUserId.trim())) return;
    setInviting(true);
    setInviteError(null);
    try {
      await apiFetch(`/orgs/${slug}/members`, {
        method: "POST",
        body: JSON.stringify({
          ...(inviteUserId.trim() ? { userId: inviteUserId.trim() } : { inviteEmail: inviteEmail.trim() }),
          role: inviteRole,
        }),
      });
      setInviteSuccess(true);
      setInviteEmail("");
      setInviteUserId("");
      setTimeout(() => {
        setInviteSuccess(false);
        setShowInvite(false);
        loadOrg();
      }, 1500);
    } catch (e: any) {
      setInviteError(e?.message ?? "Failed to invite member");
    } finally {
      setInviting(false);
    }
  };

  const handleChangeRole = async (memberId: string, newRole: "admin" | "member" | "viewer") => {
    if (!slug) return;
    setChangingRole(memberId);
    try {
      await apiFetch(`/orgs/${slug}/members/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: newRole }),
      });
      await loadOrg();
    } catch (e: any) {
      alert(e?.message ?? "Failed to change role");
    } finally {
      setChangingRole(null);
    }
  };

  const handleRemoveMember = async (memberId: string, displayName: string) => {
    if (!slug) return;
    if (!confirm(`Remove ${displayName} from this organization?`)) return;
    try {
      await apiFetch(`/orgs/${slug}/members/${memberId}`, { method: "DELETE" });
      await loadOrg();
    } catch (e: any) {
      alert(e?.message ?? "Failed to remove member");
    }
  };

  const handleAddProject = async () => {
    if (!slug || !addProjectId.trim()) return;
    setAddingProject(true);
    setAddProjectError(null);
    try {
      await apiFetch(`/orgs/${slug}/projects`, {
        method: "POST",
        body: JSON.stringify({ projectId: addProjectId.trim() }),
      });
      setShowAddProject(false);
      setAddProjectId("");
      await loadOrg();
    } catch (e: any) {
      setAddProjectError(e?.message ?? "Failed to add project");
    } finally {
      setAddingProject(false);
    }
  };

  const handleRemoveProject = async (projectId: string, projectName: string) => {
    if (!slug) return;
    if (!confirm(`Remove "${projectName}" from this organization? The project itself won't be deleted.`)) return;
    try {
      await apiFetch(`/orgs/${slug}/projects/${projectId}`, { method: "DELETE" });
      await loadOrg();
    } catch (e: any) {
      alert(e?.message ?? "Failed to remove project");
    }
  };

  if (loading) return <div className="p-8 text-sm text-slate-500">Loading…</div>;
  if (error) return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-700">{error}</div>
    </div>
  );
  if (!org) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-8">
      {/* Header */}
      <div>
        <Link to="/organizations" className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4">
          <ChevronLeft className="h-4 w-4" /> Organizations
        </Link>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-violet-100 flex items-center justify-center">
              <Building2 className="h-6 w-6 text-violet-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">{org.name}</h1>
              <p className="text-sm text-slate-500">/{org.slug} · {org.plan} plan · your role: <strong>{org.currentUserRole}</strong></p>
            </div>
          </div>
          {org.currentUserRole === "owner" && (
            <Button variant="outline" size="sm" className="gap-1.5">
              <Settings className="h-4 w-4" /> Settings
            </Button>
          )}
        </div>
      </div>

      {/* Members */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-slate-900 flex items-center gap-2">
            <Users className="h-4 w-4 text-slate-400" /> Members ({org.members.length})
          </h2>
          {canManage && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowInvite(true)}>
              <Plus className="h-3.5 w-3.5" /> Invite
            </Button>
          )}
        </div>

        {/* Invite panel */}
        {showInvite && (
          <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-violet-900">Invite a team member</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-slate-600">Email (for invite)</label>
                <Input
                  value={inviteEmail}
                  onChange={(e) => { setInviteEmail(e.target.value); setInviteUserId(""); }}
                  placeholder="alice@example.com"
                  className="mt-1 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600">Or user ID (if known)</label>
                <Input
                  value={inviteUserId}
                  onChange={(e) => { setInviteUserId(e.target.value); setInviteEmail(""); }}
                  placeholder="user_abc123"
                  className="mt-1 text-sm"
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600">Role</label>
              <div className="flex gap-2 mt-1">
                {(["admin", "member", "viewer"] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => setInviteRole(r)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border transition-colors ${
                      inviteRole === r
                        ? "border-violet-500 bg-violet-100 text-violet-700"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {ROLE_ICON[r]} {ROLE_LABEL[r]}
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-400 mt-1">{ROLE_DESC[inviteRole]}</p>
            </div>
            {inviteError && (
              <p className="text-sm text-red-600 flex gap-1 items-center">
                <AlertCircle className="h-4 w-4 shrink-0" /> {inviteError}
              </p>
            )}
            {inviteSuccess && (
              <p className="text-sm text-green-600 flex gap-1 items-center">
                <Check className="h-4 w-4 shrink-0" /> Invited successfully
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setShowInvite(false); setInviteError(null); }}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleInvite}
                disabled={inviting || (!inviteEmail.trim() && !inviteUserId.trim())}
              >
                {inviting ? "Inviting…" : "Send invite"}
              </Button>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-slate-200 divide-y divide-slate-100 overflow-hidden">
          {org.members.map((member) => {
            const isPending = member.userId.startsWith("pending:");
            const displayName = isPending
              ? `${member.inviteEmail} (pending)`
              : member.userId;
            const isCurrentUserOwner = org.currentUserRole === "owner";
            const canChange = canManage && member.role !== "owner" && member.userId !== org.ownerId;

            return (
              <div key={member.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full bg-slate-100 flex items-center justify-center text-xs font-medium text-slate-500">
                    {isPending ? "?" : displayName.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-slate-800">{displayName}</p>
                    <p className="text-xs text-slate-400">Joined {new Date(member.joinedAt).toLocaleDateString()}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {canChange ? (
                    <select
                      value={member.role}
                      disabled={changingRole === member.id}
                      onChange={(e) => handleChangeRole(member.id, e.target.value as any)}
                      className="text-xs border border-slate-200 rounded-md px-2 py-1 text-slate-700 bg-white disabled:opacity-50"
                    >
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-slate-500">
                      {ROLE_ICON[member.role]} {ROLE_LABEL[member.role]}
                    </span>
                  )}
                  {canChange && (
                    <button
                      onClick={() => handleRemoveMember(member.id, displayName)}
                      className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors"
                      title="Remove member"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Role legend */}
        <div className="mt-3 flex flex-wrap gap-4">
          {["owner", "admin", "member", "viewer"].map((r) => (
            <div key={r} className="flex items-center gap-1.5 text-xs text-slate-500">
              {ROLE_ICON[r]} <span><strong>{ROLE_LABEL[r]}</strong> — {ROLE_DESC[r]}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Projects */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-slate-900 flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-slate-400" /> Projects ({org.projects.length})
          </h2>
          {(canManage || org.currentUserRole === "member") && (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowAddProject(true)}>
              <Plus className="h-3.5 w-3.5" /> Add project
            </Button>
          )}
        </div>

        {showAddProject && (
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-blue-900">Add a project to this organization</h3>
            <p className="text-xs text-slate-500">You can only add projects you own. Paste the project ID from the Projects page.</p>
            <Input
              value={addProjectId}
              onChange={(e) => setAddProjectId(e.target.value)}
              placeholder="Project ID (e.g. cm1abc...)"
              className="text-sm"
            />
            {addProjectError && (
              <p className="text-sm text-red-600 flex gap-1 items-center">
                <AlertCircle className="h-4 w-4 shrink-0" /> {addProjectError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setShowAddProject(false); setAddProjectError(null); }}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleAddProject} disabled={addingProject || !addProjectId.trim()}>
                {addingProject ? "Adding…" : "Add"}
              </Button>
            </div>
          </div>
        )}

        {org.projects.length === 0 ? (
          <p className="text-sm text-slate-400 py-4 text-center">
            No projects in this organization yet.
          </p>
        ) : (
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100 overflow-hidden">
            {org.projects.map((project) => (
              <div key={project.id} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-md bg-blue-50 flex items-center justify-center">
                    <FolderOpen className="h-4 w-4 text-blue-500" />
                  </div>
                  <div>
                    <Link
                      to={`/projects/${project.id}`}
                      className="text-sm font-medium text-slate-800 hover:text-violet-600"
                    >
                      {project.name}
                    </Link>
                    <p className="text-xs text-slate-400">{project.repoUrl}</p>
                  </div>
                </div>
                {canManage && (
                  <button
                    onClick={() => handleRemoveProject(project.id, project.name)}
                    className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors"
                    title="Remove from organization"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
