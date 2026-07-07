// apps/api/src/routes/apiTesting.ts
// Functional API validation — separate from Security Scan.
// All routes are ownership-checked: every mutation verifies the requesting
// user owns the parent project before touching any record.

import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import { request } from "undici";
import { prisma } from "../prisma.js";
import { parseApiSpec } from "../security/openapi-parser.js";
import { enqueueApiTestRun } from "../runner/queue.js";

function requireUser(req: any, reply: any): string | null {
  const { userId } = getAuth(req);
  if (!userId) {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

async function ownsProject(projectId: string, userId: string): Promise<boolean> {
  const p = await prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },
    select: { id: true },
  });
  return p !== null;
}

async function collectionProject(collectionId: string): Promise<string | null> {
  const c = await prisma.apiCollection.findUnique({
    where: { id: collectionId },
    select: { projectId: true },
  });
  return c?.projectId ?? null;
}

async function testCaseProject(testCaseId: string): Promise<string | null> {
  const tc = await prisma.apiTestCase.findUnique({
    where: { id: testCaseId },
    include: { collection: { select: { projectId: true } } },
  });
  return tc?.collection?.projectId ?? null;
}

export async function apiTestingRoutes(app: FastifyInstance) {
  // ── OpenAPI import ─────────────────────────────────────────────────────────

  app.post("/api-testing/specs/import", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      projectId: z.string().min(1),
      specUrl: z.string().url().optional(),
      specJson: z.record(z.unknown()).optional(),
      name: z.string().optional(),
    }).refine((d) => d.specUrl || d.specJson, { message: "Provide specUrl or specJson" });

    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { projectId, specUrl, specJson, name } = parsed.data;

    if (!(await ownsProject(projectId, userId))) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    let rawSpec: unknown = specJson;
    if (specUrl) {
      try {
        const resp = await request(specUrl, { method: "GET" });
        const text = await resp.body.text();
        rawSpec = JSON.parse(text);
      } catch (err: any) {
        return reply.code(400).send({ error: `Failed to fetch spec from URL: ${err?.message ?? String(err)}` });
      }
    }

    let spec: ReturnType<typeof parseApiSpec>;
    try {
      spec = parseApiSpec(rawSpec);
    } catch (err: any) {
      return reply.code(400).send({ error: `Invalid OpenAPI/Swagger spec: ${err?.message ?? String(err)}` });
    }

    const collection = await prisma.apiCollection.create({
      data: {
        projectId,
        name: name ?? spec.title,
        baseUrl: spec.baseUrl ?? "",
        testCases: {
          create: spec.endpoints.map((ep, idx) => ({
            method: ep.method,
            path: ep.path,
            name: ep.summary ?? ep.operationId ?? ep.path,
            expectedStatus: 200,
            assertions: [{ type: "status_equals", value: 200 }],
            order: idx,
          })),
        },
      },
      select: { id: true, name: true, _count: { select: { testCases: true } } },
    });

    return reply.code(201).send({ collectionId: collection.id, caseCount: collection._count.testCases });
  });

  // ── Collections ────────────────────────────────────────────────────────────

  app.get("/api-testing/collections", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const { projectId } = (req.query ?? {}) as { projectId?: string };
    if (!projectId) return reply.code(400).send({ error: "projectId required" });
    if (!(await ownsProject(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const collections = await prisma.apiCollection.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        baseUrl: true,
        environmentId: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { testCases: true } },
        runs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true, createdAt: true, summary: true },
        },
      },
    });

    return reply.send({ collections });
  });

  app.post("/api-testing/collections", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      projectId: z.string().min(1),
      name: z.string().min(1),
      baseUrl: z.string().min(1),
      environmentId: z.string().optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { projectId, name, baseUrl, environmentId } = parsed.data;

    if (!(await ownsProject(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const collection = await prisma.apiCollection.create({
      data: { projectId, name, baseUrl, environmentId },
    });
    return reply.code(201).send({ collection });
  });

  app.get<{ Params: { id: string } }>("/api-testing/collections/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const collection = await prisma.apiCollection.findUnique({
      where: { id: req.params.id },
      include: {
        testCases: { orderBy: { order: "asc" } },
        environment: { select: { id: true, name: true, baseUrl: true } },
        runs: {
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, status: true, createdAt: true, summary: true },
        },
      },
    });
    if (!collection) return reply.code(404).send({ error: "Collection not found" });
    if (!(await ownsProject(collection.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    return reply.send({ collection });
  });

  app.patch<{ Params: { id: string } }>("/api-testing/collections/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      name: z.string().min(1).optional(),
      baseUrl: z.string().min(1).optional(),
      environmentId: z.string().nullable().optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const projectId = await collectionProject(req.params.id);
    if (!projectId) return reply.code(404).send({ error: "Collection not found" });
    if (!(await ownsProject(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const collection = await prisma.apiCollection.update({
      where: { id: req.params.id },
      data: parsed.data as any,
    });
    return reply.send({ collection });
  });

  app.delete<{ Params: { id: string } }>("/api-testing/collections/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const projectId = await collectionProject(req.params.id);
    if (!projectId) return reply.code(404).send({ error: "Collection not found" });
    if (!(await ownsProject(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    await prisma.apiCollection.delete({ where: { id: req.params.id } });
    return reply.code(204).send();
  });

  // ── Test cases ─────────────────────────────────────────────────────────────

  app.post("/api-testing/test-cases", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      collectionId: z.string().min(1),
      method: z.string().min(1),
      path: z.string().min(1),
      name: z.string().optional(),
      headers: z.record(z.string()).optional(),
      queryParams: z.record(z.string()).optional(),
      bodyJson: z.string().optional(),
      expectedStatus: z.number().int().optional(),
      assertions: z.array(z.record(z.unknown())).optional(),
      authSessionId: z.string().optional(),
      timeoutMs: z.number().int().optional(),
      order: z.number().int().optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const projectId = await collectionProject(parsed.data.collectionId);
    if (!projectId) return reply.code(404).send({ error: "Collection not found" });
    if (!(await ownsProject(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const tc = await prisma.apiTestCase.create({ data: parsed.data as any });
    return reply.code(201).send({ testCase: tc });
  });

  app.patch<{ Params: { id: string } }>("/api-testing/test-cases/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      method: z.string().optional(),
      path: z.string().optional(),
      name: z.string().nullable().optional(),
      headers: z.record(z.string()).nullable().optional(),
      queryParams: z.record(z.string()).nullable().optional(),
      bodyJson: z.string().nullable().optional(),
      expectedStatus: z.number().int().nullable().optional(),
      assertions: z.array(z.record(z.unknown())).nullable().optional(),
      authSessionId: z.string().nullable().optional(),
      timeoutMs: z.number().int().optional(),
      order: z.number().int().optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const projectId = await testCaseProject(req.params.id);
    if (!projectId) return reply.code(404).send({ error: "Test case not found" });
    if (!(await ownsProject(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const tc = await prisma.apiTestCase.update({
      where: { id: req.params.id },
      data: parsed.data as any,
    });
    return reply.send({ testCase: tc });
  });

  app.delete<{ Params: { id: string } }>("/api-testing/test-cases/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const projectId = await testCaseProject(req.params.id);
    if (!projectId) return reply.code(404).send({ error: "Test case not found" });
    if (!(await ownsProject(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    await prisma.apiTestCase.delete({ where: { id: req.params.id } });
    return reply.code(204).send();
  });

  // ── Runs ───────────────────────────────────────────────────────────────────

  app.post("/api-testing/runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const Body = z.object({
      projectId: z.string().min(1),
      collectionId: z.string().min(1),
      testCaseIds: z.array(z.string()).optional(),
    });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { projectId, collectionId, testCaseIds } = parsed.data;

    if (!(await ownsProject(projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    const collectionExists = await prisma.apiCollection.findFirst({
      where: { id: collectionId, projectId },
      select: { id: true },
    });
    if (!collectionExists) return reply.code(404).send({ error: "Collection not found" });

    const run = await prisma.apiTestRun.create({
      data: { projectId, collectionId, status: "queued" },
    });

    await enqueueApiTestRun({ runId: run.id, collectionId, projectId, testCaseIds });

    return reply.code(202).send({ runId: run.id });
  });

  app.get<{ Params: { id: string } }>("/api-testing/runs/:id", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const run = await prisma.apiTestRun.findUnique({
      where: { id: req.params.id },
      include: {
        results: {
          orderBy: { createdAt: "asc" },
          include: {
            testCase: { select: { id: true, name: true, method: true, path: true, expectedStatus: true } },
          },
        },
      },
    });
    if (!run) return reply.code(404).send({ error: "Run not found" });
    if (!(await ownsProject(run.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });

    return reply.send({ run });
  });

  app.get("/api-testing/runs", async (req, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;

    const { projectId, collectionId } = (req.query ?? {}) as {
      projectId?: string;
      collectionId?: string;
    };

    if (!projectId && !collectionId) {
      return reply.code(400).send({ error: "projectId or collectionId required" });
    }

    if (projectId && !(await ownsProject(projectId, userId))) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    if (collectionId) {
      const col = await prisma.apiCollection.findUnique({
        where: { id: collectionId },
        select: { projectId: true },
      });
      if (!col) return reply.code(404).send({ error: "Collection not found" });
      if (!(await ownsProject(col.projectId, userId))) return reply.code(403).send({ error: "Forbidden" });
    }

    const runs = await prisma.apiTestRun.findMany({
      where: {
        ...(projectId ? { projectId } : {}),
        ...(collectionId ? { collectionId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        projectId: true,
        collectionId: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        summary: true,
        error: true,
        createdAt: true,
      },
    });

    return reply.send({ runs });
  });
}

export default apiTestingRoutes;
