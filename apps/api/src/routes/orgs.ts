/**
 * Enterprise RBAC — Organization & membership management routes.
 *
 * Role hierarchy (highest to lowest):
 *   owner  — full control; cannot be removed (only org deletion removes owner)
 *   admin  — can invite/remove members, change roles (except owner), manage projects
 *   member — can view org projects and create new ones
 *   viewer — read-only access to org projects; cannot create or modify
 *
 * Permission matrix:
 *   Action                  owner  admin  member  viewer
 *   Create org              ✓      —      —       —
 *   Delete org              ✓      —      —       —
 *   Invite member           ✓      ✓      —       —
 *   Remove member           ✓      ✓*     —       —      (* not other admins)
 *   Change member role      ✓      ✓*     —       —      (* not to/from owner)
 *   Add project to org      ✓      ✓      ✓       —
 *   View org + projects     ✓      ✓      ✓       ✓
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import type { OrgRole } from "@prisma/client";

// ── Permission helpers ────────────────────────────────────────────────────────

async function getMemberRole(orgId: string, userId: string): Promise<OrgRole | null> {
  const m = await prisma.organizationMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { role: true },
  });
  return m?.role ?? null;
}

function canManageMembers(role: OrgRole | null): boolean {
  return role === "owner" || role === "admin";
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ── Route schemas ─────────────────────────────────────────────────────────────

const createOrgSchema = z.object({
  name: z.string().min(2).max(80),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/).optional(),
});

const inviteSchema = z.object({
  userId: z.string().optional(),
  inviteEmail: z.string().email().optional(),
  role: z.enum(["admin", "member", "viewer"]).default("member"),
}).refine((d) => d.userId || d.inviteEmail, { message: "userId or inviteEmail required" });

const changeRoleSchema = z.object({
  role: z.enum(["admin", "member", "viewer"]),
});

const addProjectSchema = z.object({
  projectId: z.string(),
});

// ── Routes ────────────────────────────────────────────────────────────────────

export default async function orgRoutes(app: FastifyInstance) {

  // POST /orgs — create organization
  app.post("/orgs", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const parsed = createOrgSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const body = parsed.data;

    const slug = body.slug ?? slugify(body.name);
    const existing = await prisma.organization.findUnique({ where: { slug } });
    if (existing) return reply.code(409).send({ error: "Organization slug already taken" });

    const org = await prisma.organization.create({
      data: {
        name: body.name,
        slug,
        ownerId: userId,
        members: {
          create: { userId, role: "owner" },
        },
      },
      include: { members: true },
    });

    return reply.code(201).send(org);
  });

  // GET /orgs — list orgs the current user belongs to
  app.get("/orgs", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const memberships = await prisma.organizationMember.findMany({
      where: { userId },
      include: {
        org: {
          include: {
            _count: { select: { members: true, projects: true } },
          },
        },
      },
      orderBy: { joinedAt: "desc" },
    });

    return reply.send(
      memberships.map((m) => ({
        org: m.org,
        role: m.role,
        joinedAt: m.joinedAt,
        memberCount: (m.org as any)._count.members,
        projectCount: (m.org as any)._count.projects,
      }))
    );
  });

  // GET /orgs/:slug — org detail
  app.get<{ Params: { slug: string } }>("/orgs/:slug", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const org = await prisma.organization.findUnique({
      where: { slug: req.params.slug },
      include: {
        members: {
          include: { user: { select: { id: true, createdAt: true } } },
          orderBy: { joinedAt: "asc" },
        },
        projects: {
          select: { id: true, name: true, repoUrl: true, plan: true, createdAt: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });
    if (!org) return reply.code(404).send({ error: "Organization not found" });

    const userRole = org.members.find((m) => m.userId === userId)?.role ?? null;
    if (!userRole) return reply.code(403).send({ error: "You are not a member of this organization" });

    return reply.send({ ...org, currentUserRole: userRole });
  });

  // DELETE /orgs/:slug — delete org (owner only)
  app.delete<{ Params: { slug: string } }>("/orgs/:slug", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const org = await prisma.organization.findUnique({ where: { slug: req.params.slug } });
    if (!org) return reply.code(404).send({ error: "Organization not found" });
    if (org.ownerId !== userId) return reply.code(403).send({ error: "Only the owner can delete an organization" });

    // Detach projects before deletion (SET NULL via FK) then delete
    await prisma.project.updateMany({ where: { orgId: org.id }, data: { orgId: null } });
    await prisma.organization.delete({ where: { id: org.id } });
    return reply.send({ ok: true });
  });

  // GET /orgs/:slug/members
  app.get<{ Params: { slug: string } }>("/orgs/:slug/members", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const org = await prisma.organization.findUnique({ where: { slug: req.params.slug } });
    if (!org) return reply.code(404).send({ error: "Organization not found" });

    const role = await getMemberRole(org.id, userId);
    if (!role) return reply.code(403).send({ error: "Forbidden" });

    const members = await prisma.organizationMember.findMany({
      where: { orgId: org.id },
      include: { user: { select: { id: true, createdAt: true } } },
      orderBy: { joinedAt: "asc" },
    });

    return reply.send(members);
  });

  // POST /orgs/:slug/members — invite member
  app.post<{ Params: { slug: string } }>("/orgs/:slug/members", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const org = await prisma.organization.findUnique({ where: { slug: req.params.slug } });
    if (!org) return reply.code(404).send({ error: "Organization not found" });

    const role = await getMemberRole(org.id, userId);
    if (!canManageMembers(role)) return reply.code(403).send({ error: "Admin or owner required to invite members" });

    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const body = parsed.data;

    // If userId is provided, add directly. Otherwise, store inviteEmail for later claim.
    if (body.userId) {
      const existing = await prisma.organizationMember.findUnique({
        where: { orgId_userId: { orgId: org.id, userId: body.userId } },
      });
      if (existing) return reply.code(409).send({ error: "User is already a member" });

      const member = await prisma.organizationMember.create({
        data: { orgId: org.id, userId: body.userId, role: body.role, invitedBy: userId },
      });
      return reply.code(201).send(member);
    } else {
      // Pending invite by email (user accepts when they log in)
      const member = await prisma.organizationMember.create({
        data: {
          orgId: org.id,
          userId: `pending:${body.inviteEmail}`, // placeholder until claimed
          role: body.role,
          invitedBy: userId,
          inviteEmail: body.inviteEmail,
        },
      });
      return reply.code(201).send({ ...member, pending: true, inviteEmail: body.inviteEmail });
    }
  });

  // PATCH /orgs/:slug/members/:memberId — change role
  app.patch<{ Params: { slug: string; memberId: string } }>("/orgs/:slug/members/:memberId", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const org = await prisma.organization.findUnique({ where: { slug: req.params.slug } });
    if (!org) return reply.code(404).send({ error: "Organization not found" });

    const callerRole = await getMemberRole(org.id, userId);
    if (!canManageMembers(callerRole)) return reply.code(403).send({ error: "Admin or owner required" });

    const target = await prisma.organizationMember.findUnique({ where: { id: req.params.memberId } });
    if (!target || target.orgId !== org.id) return reply.code(404).send({ error: "Member not found" });
    if (target.role === "owner") return reply.code(403).send({ error: "Cannot change the owner's role" });
    if (target.userId === userId && callerRole !== "owner") return reply.code(403).send({ error: "Cannot change your own role" });

    const parsed = changeRoleSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const updated = await prisma.organizationMember.update({
      where: { id: req.params.memberId },
      data: { role: parsed.data.role },
    });
    return reply.send(updated);
  });

  // DELETE /orgs/:slug/members/:memberId — remove member
  app.delete<{ Params: { slug: string; memberId: string } }>("/orgs/:slug/members/:memberId", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const org = await prisma.organization.findUnique({ where: { slug: req.params.slug } });
    if (!org) return reply.code(404).send({ error: "Organization not found" });

    const callerRole = await getMemberRole(org.id, userId);
    if (!canManageMembers(callerRole)) return reply.code(403).send({ error: "Admin or owner required" });

    const target = await prisma.organizationMember.findUnique({ where: { id: req.params.memberId } });
    if (!target || target.orgId !== org.id) return reply.code(404).send({ error: "Member not found" });
    if (target.role === "owner") return reply.code(403).send({ error: "Cannot remove the owner" });
    if (target.userId === userId) return reply.code(400).send({ error: "Cannot remove yourself — transfer ownership first" });

    await prisma.organizationMember.delete({ where: { id: req.params.memberId } });
    return reply.send({ ok: true });
  });

  // POST /orgs/:slug/projects — add an existing project to this org
  app.post<{ Params: { slug: string } }>("/orgs/:slug/projects", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const org = await prisma.organization.findUnique({ where: { slug: req.params.slug } });
    if (!org) return reply.code(404).send({ error: "Organization not found" });

    const callerRole = await getMemberRole(org.id, userId);
    if (!callerRole || callerRole === "viewer") return reply.code(403).send({ error: "Member or above required to add projects" });

    const parsed = addProjectSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const project = await prisma.project.findUnique({ where: { id: parsed.data.projectId } });
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (project.ownerId !== userId && callerRole !== "owner" && callerRole !== "admin") {
      return reply.code(403).send({ error: "You can only add projects you own" });
    }

    await prisma.project.update({
      where: { id: project.id },
      data: { orgId: org.id },
    });
    return reply.send({ ok: true, projectId: project.id, orgId: org.id });
  });

  // DELETE /orgs/:slug/projects/:projectId — remove project from org
  app.delete<{ Params: { slug: string; projectId: string } }>("/orgs/:slug/projects/:projectId", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const org = await prisma.organization.findUnique({ where: { slug: req.params.slug } });
    if (!org) return reply.code(404).send({ error: "Organization not found" });

    const callerRole = await getMemberRole(org.id, userId);
    if (!canManageMembers(callerRole)) return reply.code(403).send({ error: "Admin or owner required" });

    const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
    if (!project || project.orgId !== org.id) return reply.code(404).send({ error: "Project not in this organization" });

    await prisma.project.update({ where: { id: project.id }, data: { orgId: null } });
    return reply.send({ ok: true });
  });
}
