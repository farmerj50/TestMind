import type { FastifyInstance } from "fastify";
import { getAuth } from "@clerk/fastify";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { prisma } from "../prisma.js";
import { GENERATED_ROOT } from "../lib/storageRoots.js";
import { writeSpecsFromPlan } from "../testmind/pipeline/codegen.js";
import type { Step, TestPlan } from "../testmind/core/plan.js";
import { ensureCuratedProjectEntry, ensureWithin, slugify } from "../testmind/curated-store.js";

const stepLineSchema = z.string().trim().min(1);

const generateSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1),
  steps: z.array(stepLineSchema).min(1),
  notes: z.string().optional(),
  docs: z.array(z.object({ name: z.string(), summary: z.string().optional() })).optional(),
  baseUrl: z.string().optional(),
});

const curateSchema = z.object({
  projectId: z.string().min(1),
  specPath: z.string().min(1),
  curatedName: z.string().optional(),
});

const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\/+/, "");

const normalizeGeneratedRelPath = (value: string) => {
  const normalized = normalizePath(value);
  return normalized.startsWith("testmind-generated/")
    ? normalized.slice("testmind-generated/".length)
    : normalized;
};

const filenameFromPagePath = (pagePath: string) => {
  const safe = pagePath === "/" ? "home" : pagePath.replace(/\//g, "_").replace(/^_/, "");
  return `${safe || "home"}.spec.ts`;
};

const parseStepLine = (line: string): Step => {
  const raw = line.trim();
  const lower = raw.toLowerCase();

  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("/")) {
    return { kind: "goto", url: raw };
  }

  const gotoMatch = raw.match(/^(go to|goto|navigate|open)\s+(.+)$/i);
  if (gotoMatch) {
    const target = gotoMatch[2]?.trim();
    if (target) {
      const url = target.startsWith("http") || target.startsWith("/") ? target : `/${target}`;
      return { kind: "goto", url };
    }
  }

  const clickMatch = raw.match(/^(click|tap|press)\s+(.+)$/i);
  if (clickMatch) {
    const target = clickMatch[2]?.trim();
    return { kind: "click", selector: target ? `text=${target}` : "text=Continue" };
  }

  const fillMatch = raw.match(/^(type|fill|enter)\s+(.+?)(?:\s+(?:with|as|to)\s+|\s*=\s*)(.+)$/i);
  if (fillMatch) {
    const field = fillMatch[2]?.trim();
    const value = fillMatch[3]?.trim();
    return { kind: "fill", selector: `label=${field || "input"}`, value: value || "TODO" };
  }

  const fillSimple = raw.match(/^(type|fill|enter)\s+(.+)$/i);
  if (fillSimple) {
    const field = fillSimple[2]?.trim();
    return { kind: "fill", selector: `label=${field || "input"}`, value: "TODO" };
  }

  const expectMatch = raw.match(/^(expect|assert|verify|see|should)\s+(.+)$/i);
  if (expectMatch) {
    const text = expectMatch[2]?.trim();
    return { kind: "expect-text", text: text || raw };
  }

  return { kind: "expect-text", text: raw };
};

export default async function testBuilderRoutes(app: FastifyInstance): Promise<void> {
  app.post("/test-builder/generate", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { projectId, title, steps, notes, docs, baseUrl } = parsed.data;
    const project = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true, sharedSteps: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const slug = slugify(title);
    const pagePath = `/manual/${slug}`;
    const parsedSteps = steps.map(parseStepLine);
    const plan: TestPlan = {
      baseUrl:
        baseUrl?.trim() ||
        ((project.sharedSteps as any)?.baseUrl as string | undefined) ||
        "http://localhost:5173",
      cases: [
        {
          id: `manual-${Date.now()}`,
          name: title,
          group: { page: pagePath },
          steps: parsedSteps,
        },
      ],
      meta: { notes, docs },
    };

    const adapterId = "playwright-ts";
    const outDir = path.join(GENERATED_ROOT, `${adapterId}-${userId}`, projectId);
    await fs.mkdir(outDir, { recursive: true });
    await writeSpecsFromPlan(outDir, plan, adapterId);

    const fileName = filenameFromPagePath(pagePath);
    const relativePath = path.posix.join(
      "testmind-generated",
      `${adapterId}-${userId}`,
      projectId,
      fileName
    );

    return reply.send({
      spec: {
        title,
        fileName,
        relativePath,
      },
    });
  });

  app.post("/test-builder/curate", async (req, reply) => {
    const { userId } = getAuth(req);
    if (!userId) return reply.code(401).send({ error: "Unauthorized" });

    const parsed = curateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { projectId, specPath, curatedName } = parsed.data;
    const project = await prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: { id: true },
    });
    if (!project) return reply.code(404).send({ error: "Project not found" });

    const relPath = normalizeGeneratedRelPath(specPath);
    const sourceAbs = path.resolve(GENERATED_ROOT, relPath);
    ensureWithin(GENERATED_ROOT, sourceAbs);
    if (!fsSync.existsSync(sourceAbs)) {
      return reply.code(404).send({ error: "Generated spec not found" });
    }

    const { root } = ensureCuratedProjectEntry(projectId, curatedName?.trim());
    const destFileBase = curatedName?.trim()
      ? `${slugify(curatedName)}.spec.ts`
      : path.posix.basename(relPath);
    const destAbs = path.resolve(root, destFileBase);
    ensureWithin(root, destAbs);

    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.copyFile(sourceAbs, destAbs);

    const curatedPath = path.posix.join("testmind-curated", projectId, destFileBase);
    return reply.send({ fileName: destFileBase, curatedPath });
  });
}
