// apps/api/src/routes/recorder.ts
import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { ensureCuratedProjectEntry } from "../testmind/curated-store.js";

const RECORD_ROOT = path.join(process.cwd(), "apps", "api", "testmind-generated", "playwright-ts", "recordings");
const HELPER_PING = process.env.RECORDER_HELPER || "http://localhost:43117";
let lastCallback: any = null;

const SaveBody = z.object({
  projectId: z.string().optional(),
  name: z.string().min(1, "name is required"),
  content: z.string().min(1, "content is required"),
  baseUrl: z.string().url().optional(),
  language: z.enum(["typescript", "javascript", "python", "java"]).optional(),
});

const CommandBody = z.object({
  projectId: z.string().optional(),
  baseUrl: z.string().url(),
  name: z.string().min(1, "name is required"),
  language: z.enum(["typescript", "javascript", "python", "java"]).optional(),
});

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "spec";
}

function ensureDir(p: string) {
  fsSync.mkdirSync(p, { recursive: true });
}

function languageToExt(lang?: string) {
  if (lang === "javascript") return "js";
  if (lang === "python") return "py";
  if (lang === "java") return "java";
  return "ts";
}

function languageToTarget(lang?: string) {
  if (lang === "javascript") return "--target=javascript";
  if (lang === "python") return "--target=python";
  if (lang === "java") return "--target=java";
  return "--target=typescript";
}

export default async function recorderRoutes(app: FastifyInstance) {
  app.get("/recorder/specs", async (req, reply) => {
    const { projectId } = (req.query ?? {}) as { projectId?: string };
    const roots = projectId
      ? [path.join(RECORD_ROOT, projectId)]
      : fsSync.existsSync(RECORD_ROOT)
      ? fsSync.readdirSync(RECORD_ROOT).map((d) => path.join(RECORD_ROOT, d))
      : [];

    const specs: { projectId: string; name: string; path: string; pathRelative: string }[] = [];
    for (const root of roots) {
      const pid = path.basename(root);
      if (!fsSync.existsSync(root)) continue;
      for (const file of fsSync.readdirSync(root)) {
        if (file.endsWith(".spec.ts")) {
          const rel = path.join("recordings", pid, file).replace(/\\/g, "/");
          specs.push({
            projectId: pid,
            name: file,
            path: path.join("apps", "api", "testmind-generated", "playwright-ts", "recordings", pid, file),
            pathRelative: rel,
          });
        }
      }
    }
    return reply.send({ specs });
  });

  app.post("/recorder/specs", async (req, reply) => {
    const parsed = SaveBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { projectId: pidInput, name, content, baseUrl, language } = parsed.data;
    if (!pidInput) {
      return reply.code(400).send({ error: "projectId is required to save a recorded spec" });
    }
    const projectId = pidInput;
    const projectExists = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
    if (!projectExists) {
      return reply
        .code(404)
        .send({ error: `Project ${projectId} not found. Select an existing project before saving a recording.` });
    }

    const ext = languageToExt(language);
    const fileSlug = slugify(name).replace(/\.spec\.[a-z]+$/i, "");
    const projectDir = path.join(RECORD_ROOT, projectId);
    ensureDir(projectDir);
    const absPath = path.join(projectDir, `${fileSlug}.spec.${ext}`);
    await fs.writeFile(absPath, content, "utf8");

    const relPath = path.join("apps", "api", "testmind-generated", "playwright-ts", "recordings", projectId, `${fileSlug}.spec.${ext}`);

    // Also copy into a curated suite for visibility in Suites (auto-creates recordings-{projectId})
    try {
      const suiteId = `recordings-${projectId}`;
      const suiteName = `Recordings - ${projectExists.name || projectId}`;
      const { root } = ensureCuratedProjectEntry(suiteId, suiteName);
      const destDir = path.join(root, "recordings");
      fsSync.mkdirSync(destDir, { recursive: true });
      const destPath = path.join(destDir, `${fileSlug}.spec.${ext}`);
      await fs.copyFile(absPath, destPath);
    } catch (err) {
      // non-fatal; fallback is generated path
      app.log.warn({ err }, "[recorder] failed to copy recording into curated suite");
    }

    // Helper command to run Playwright codegen against this target
    const target = languageToTarget(language);
    const codegenCommand =
      process.platform === "win32"
        ? `npx.cmd playwright codegen ${baseUrl || "http://localhost:4173"} ${target} --save-storage=state.json --output=${relPath}`
        : `npx playwright codegen ${baseUrl || "http://localhost:4173"} ${target} --save-storage=state.json --output=${relPath}`;

    return reply.code(201).send({ projectId, path: relPath, codegenCommand });
  });

  app.post("/recorder/codegen-command", async (req, reply) => {
    const parsed = CommandBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
  const { projectId, baseUrl, name, language } = parsed.data;
  if (!projectId) {
    return reply.code(400).send({ error: "projectId is required to launch the recorder" });
  }
  const pid = projectId;
  const projectExists = await prisma.project.findUnique({ where: { id: pid }, select: { id: true } });
  if (!projectExists) {
    return reply
      .code(404)
      .send({ error: `Project ${pid} not found. Select an existing project before launching the recorder.` });
  }
  const slug = slugify(name).replace(/\.spec\.[a-z]+$/i, "");
  const ext = languageToExt(language);
  const target = languageToTarget(language);
  const relPath = path.join(
    "apps",
    "api",
    "testmind-generated",
    "playwright-ts",
    "recordings",
    pid,
    `${slug}.spec.${ext}`
  );
  const cmdWin = `cd apps/web && npx.cmd playwright codegen ${baseUrl} ${target} --save-storage=state.json --output ${relPath}`;
  const cmdNix = `cd apps/web && npx playwright codegen ${baseUrl} ${target} --save-storage=state.json --output ${relPath}`;
  return reply.send({
    projectId: pid,
    path: relPath,
    commandWindows: cmdWin,
    commandUnix: cmdNix,
    helper: HELPER_PING,
    callback: process.env.RECORDER_CALLBACK || null,
  });
});

// Optional helper callback endpoint to auto-refresh UI
// Configure helper with RECORDER_CALLBACK=http://localhost:8787/recorder/callback
app.post("/recorder/callback", async (req, reply) => {
  try {
    const body = req.body ?? {};
    lastCallback = { receivedAt: new Date().toISOString(), body };
    return reply.send({ ok: true });
  } catch (err: any) {
    return reply.code(500).send({ ok: false, error: err?.message ?? String(err) });
  }
});

app.get("/recorder/callback/last", async (_req, reply) => {
  return reply.send({ lastCallback });
});
}
