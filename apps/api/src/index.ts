// apps/api/src/index.ts
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { clerkPlugin, getAuth } from "@clerk/fastify";
import { z } from "zod";

import { githubRoutes } from "./routes/github";
import { testRoutes } from "./routes/tests";
import runRoutes from "./routes/run";
import reportsRoutes from "./routes/reports";
import integrationsRoutes from "./routes/integrations";
import { prisma } from "./prisma";

// ✅ single source of truth for plan typing + limits
import { getLimitsForPlan } from "./config/plans";
import type { PlanTier } from "./config/plans";
import testmindRoutes from './testmind/routes';


const app = Fastify({ logger: true });

app.register(cors, { origin: ["http://localhost:5173"], credentials: true });

app.register(clerkPlugin, {
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY!,
  secretKey: process.env.CLERK_SECRET_KEY!,
});

app.register(githubRoutes);
app.register(testRoutes);
app.register(runRoutes, { prefix: "/runner" });
app.register(reportsRoutes, { prefix: "/" });
app.register(integrationsRoutes, { prefix: "/" });
app.register(testmindRoutes, { prefix: "/tm" });

app.get("/runner/debug/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const [db] = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
    "select current_database()"
  );
  const proj = await prisma.project.findUnique({
    where: { id },
    select: { id: true, name: true, repoUrl: true, ownerId: true, createdAt: true },
  });
  return {
    currentDb: db?.current_database,
    project: proj,
    databaseUrl: (process.env.DATABASE_URL || "").replace(/:\/\/.*@/, "://***@").split("?")[0],
  };
});

app.get("/health", async () => ({ ok: true }));

// ---------- Schemas ----------
const CreateProjectSchema = z.object({
  name: z.string().min(1, "Project name is required"),
  repoUrl: z.string().url("Enter a valid URL"),
});

const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  repoUrl: z.string().url().optional(),
});
type UpdateProjectBody = z.infer<typeof UpdateProjectSchema>;

// small guard you can reuse
function requireUser(req: any, reply: any) {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

// ---------- List ----------
app.get("/projects", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const projects = await prisma.project.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: "desc" },
  });

  return { projects };
});

// ---------- Read one ----------
app.get<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const { id } = req.params;
  const project = await prisma.project.findFirst({
    where: { id, ownerId: userId },
  });
  if (!project) return reply.code(404).send({ error: "Not found" });
  return { project };
});

// ---------- Create ----------
app.post("/projects", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const parsed = CreateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  // ensure user row exists; rely on @default(free) for plan
  await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId },
  });

  const { name, repoUrl } = parsed.data;
  const project = await prisma.project.create({
    data: { name, repoUrl, ownerId: userId },
  });

  return reply.code(201).send({ project });
});

// ---------- Update ----------
app.patch<{ Params: { id: string }; Body: UpdateProjectBody }>(
  "/projects/:id",
  async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const parsed = UpdateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { id } = req.params;
    const existing = await prisma.project.findFirst({
      where: { id, ownerId: userId },
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });

    const updated = await prisma.project.update({
      where: { id },
      data: parsed.data,
    });

    return { project: updated };
  }
);

// ---------- Delete ----------
app.delete<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  const { id } = req.params;
  const existing = await prisma.project.findFirst({
    where: { id, ownerId: userId },
  });
  if (!existing) return reply.code(404).send({ error: "Not found" });

  await prisma.project.delete({ where: { id } });
  return reply.code(204).send();
});

// debug helpers
app.ready(() => {
  console.log(app.printRoutes());
});
app.get("/runner/debug/list", async () => {
  return await prisma.project.findMany({
    select: { id: true, name: true, repoUrl: true, ownerId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
});

app.post("/runner/seed-project", async (req, reply) => {
  const id = "cmgglhqyx0001z5n41vcvj9s1";
  const repoUrl = "https://github.com/farmerj50/coding-framework";
  const seeded = await prisma.project.upsert({
    where: { id },
    update: { repoUrl },
    create: { id, name: "justicpath", repoUrl, ownerId: "dev-seed" },
    select: { id: true, name: true, repoUrl: true, ownerId: true },
  });
  return { seeded };
});

// --- Billing / Plan ---
app.get("/billing/me", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  // rely on DB default for plan; narrow shape for TS
  const user = (await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId },
    select: { id: true, plan: true, createdAt: true },
  })) as { id: string; plan: PlanTier; createdAt: Date };

  return { plan: user.plan, limits: getLimitsForPlan(user.plan) };
});

// Dev-only helper to switch plans
app.patch("/billing/me", async (req, reply) => {
  const userId = requireUser(req, reply);
  if (!userId) return;

  if (process.env.ALLOW_PLAN_PATCH !== "true") {
    return reply.code(403).send({ error: "Plan switching disabled" });
  }

  const allowed = ["free", "pro", "enterprise"] as const;
  type Body = { plan?: (typeof allowed)[number] };

  const { plan } = (req.body ?? {}) as Body;
  if (!plan || !allowed.includes(plan)) {
    return reply.code(400).send({ error: "Invalid plan" });
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { plan },
    select: { plan: true },
  });

  return { plan: updated.plan, limits: getLimitsForPlan(updated.plan) };
});

app.listen({ host: "0.0.0.0", port: Number(process.env.PORT) || 8787 });
