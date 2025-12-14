import type { FastifyInstance } from "fastify";
import { z } from "zod";

type QaJobStatus = "queued" | "running" | "succeeded" | "failed";

type QaJob = {
  id: string;
  projectId: string;
  suiteId?: string;
  baseUrl?: string;
  parallel?: boolean;
  includeApi?: boolean;
  status: QaJobStatus;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  apiRunId?: string;
  error?: string;
};

const jobs = new Map<string, QaJob>();

export default async function qaAgentRoutes(app: FastifyInstance) {
  const StartBody = z.object({
    projectId: z.string().min(1, "projectId is required"),
    suiteId: z.string().min(1, "suiteId is required"),
    baseUrl: z.string().url().optional(),
    parallel: z.boolean().optional(),
    includeApi: z.boolean().optional(),
  });

  app.post("/qa-agent/start", async (req, reply) => {
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: parsed.error.flatten() });
    }

    // capture auth header so internal injections carry user context
    const authHeader =
      (req.headers.authorization as string | undefined) ||
      (req.headers.Authorization as string | undefined);

    const id = typeof crypto !== "undefined" && (crypto as any).randomUUID ? (crypto as any).randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const now = new Date().toISOString();
    const job: QaJob = {
      id,
      projectId: parsed.data.projectId,
      suiteId: parsed.data.suiteId,
      baseUrl: parsed.data.baseUrl,
      parallel: parsed.data.parallel ?? false,
      includeApi: parsed.data.includeApi ?? false,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    jobs.set(id, job);

    // Fire-and-forget: mark running, invoke runner(s), store runId(s), then mark done.
    setTimeout(async () => {
      const originalWorkers = process.env.TM_WORKERS;
      try {
        const running = jobs.get(id);
        if (!running) return;
        running.status = "running";
        running.updatedAt = new Date().toISOString();
        jobs.set(id, running);

        // optional: set workers based on parallel flag (global env tweak)
        if (job.parallel) process.env.TM_WORKERS = "4";
        else process.env.TM_WORKERS = "1";

        // call internal runner API directly
        const res = await app.inject({
          method: "POST",
          url: "/runner/run",
          payload: {
            projectId: job.projectId,
            suiteId: job.suiteId,
            baseUrl: job.baseUrl,
          },
          headers: authHeader ? { authorization: authHeader } : undefined,
        });
        let runId: string | undefined;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const body = res.json() as any;
            runId = body?.id;
          } catch {
            // ignore parse errors
          }
        }

        // optional API run
        let apiRunId: string | undefined;
        if (job.includeApi) {
          const resApi = await app.inject({
            method: "POST",
            url: "/runner/run",
            payload: {
              projectId: job.projectId,
              suiteId: job.suiteId,
              baseUrl: job.baseUrl,
            },
            headers: authHeader ? { authorization: authHeader } : undefined,
          });
          if (resApi.statusCode >= 200 && resApi.statusCode < 300) {
            try {
              const body = resApi.json() as any;
              apiRunId = body?.id;
            } catch {
              // ignore parse errors
            }
          }
          if (!apiRunId) {
            runId = runId; // keep ui runId even if api fails
          }
        }

        const done = jobs.get(id);
        if (!done) return;
        done.runId = runId;
        done.apiRunId = apiRunId;
        const okPrimary = !!runId;
        const okApi = !job.includeApi || !!apiRunId;
        done.status = okPrimary && okApi ? "succeeded" : "failed";
        if (!okPrimary) {
          done.error = res.body?.toString() ?? `Runner failed (${res.statusCode})`;
        } else if (!okApi) {
          done.error = done.error ?? "API run failed";
        } else {
          done.error = undefined;
        }
        done.updatedAt = new Date().toISOString();
        jobs.set(id, done);

        // restore env
        if (originalWorkers === undefined) delete process.env.TM_WORKERS;
        else process.env.TM_WORKERS = originalWorkers;
      } catch (err: any) {
        const fail = jobs.get(id);
        if (!fail) return;
        fail.status = "failed";
        fail.error = err?.message ?? String(err);
        fail.updatedAt = new Date().toISOString();
        jobs.set(id, fail);
        // restore env
        if (originalWorkers === undefined) delete process.env.TM_WORKERS;
        else process.env.TM_WORKERS = originalWorkers;
      }
    }, 10);

    return reply.send({ job });
  });

  app.get("/qa-agent/jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = jobs.get(id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return reply.send({ job });
  });
}
