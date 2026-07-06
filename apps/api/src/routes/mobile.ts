/**
 * Mobile testing routes.
 *
 * Provides configuration management for Appium-based mobile security testing.
 * The mobile security scan works by:
 *   1. Configuring the mobile device to route traffic through TestMind's proxy
 *   2. Driving the app with Appium (user provides the Appium server URL)
 *   3. Intercepting and analyzing the HTTP/S traffic for security issues
 *   4. Running mobile-specific security checks (deep links, intent injection, certificate pinning)
 *
 * Routes:
 *   POST   /mobile/configs             — save Appium config for a project
 *   GET    /mobile/configs?projectId=  — list configs for a project
 *   DELETE /mobile/configs/:id         — delete config
 *   POST   /mobile/scans               — trigger a mobile security scan
 *   GET    /mobile/scans/:id           — poll scan status
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { enqueueSecurityScan } from "../runner/queue.js";

const configSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1).max(80),
  platform: z.enum(["android", "ios"]),
  appiumUrl: z.string().url(),
  appPackage: z.string().optional(),
  appActivity: z.string().optional(),
  bundleId: z.string().optional(),
  deviceName: z.string().optional(),
  platformVersion: z.string().optional(),
  proxyPort: z.number().int().min(1024).max(65535).optional(),
  capabilities: z.record(z.unknown()).optional(),
});

const scanSchema = z.object({
  projectId: z.string(),
  mobileConfigId: z.string(),
  baseUrl: z.string().url(),
  scanDepth: z.enum(["baseline", "standard", "deep"]).optional().default("standard"),
  maxDurationMinutes: z.number().int().min(1).max(60).optional().default(15),
  authSessionId: z.string().optional(),
});

export default async function mobileRoutes(app: FastifyInstance) {

  // POST /mobile/configs
  app.post("/mobile/configs", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const body = parsed.data;

    const project = await prisma.project.findUnique({ where: { id: body.projectId } });
    if (!project || project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });

    const config = await prisma.mobileConfig.create({
      data: {
        projectId: body.projectId,
        name: body.name,
        platform: body.platform,
        appiumUrl: body.appiumUrl,
        appPackage: body.appPackage,
        appActivity: body.appActivity,
        bundleId: body.bundleId,
        deviceName: body.deviceName,
        platformVersion: body.platformVersion,
        proxyPort: body.proxyPort,
        capabilities: body.capabilities ? JSON.parse(JSON.stringify(body.capabilities)) : undefined,
      },
    });

    return reply.code(201).send(config);
  });

  // GET /mobile/configs?projectId=
  app.get<{ Querystring: { projectId?: string } }>("/mobile/configs", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });
    if (!req.query.projectId) return reply.code(400).send({ error: "projectId required" });

    const project = await prisma.project.findUnique({ where: { id: req.query.projectId } });
    if (!project || project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });

    const configs = await prisma.mobileConfig.findMany({
      where: { projectId: req.query.projectId },
      orderBy: { createdAt: "desc" },
    });
    return reply.send(configs);
  });

  // DELETE /mobile/configs/:id
  app.delete<{ Params: { id: string } }>("/mobile/configs/:id", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const config = await prisma.mobileConfig.findUnique({
      where: { id: req.params.id },
      include: { project: { select: { ownerId: true } } },
    });
    if (!config) return reply.code(404).send({ error: "Not found" });
    if (config.project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });

    await prisma.mobileConfig.delete({ where: { id: req.params.id } });
    return reply.send({ ok: true });
  });

  // POST /mobile/scans — start a mobile security scan
  app.post("/mobile/scans", async (req, reply) => {
    const { userId } = (req as any).auth ?? {};
    if (!userId) return reply.code(401).send({ error: "Authentication required" });

    const parsed = scanSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const body = parsed.data;

    const [project, mobileConfig] = await Promise.all([
      prisma.project.findUnique({ where: { id: body.projectId } }),
      prisma.mobileConfig.findUnique({ where: { id: body.mobileConfigId } }),
    ]);
    if (!project || project.ownerId !== userId) return reply.code(403).send({ error: "Forbidden" });
    if (!mobileConfig || mobileConfig.projectId !== body.projectId) return reply.code(404).send({ error: "Mobile config not found" });

    const job = await prisma.securityScanJob.create({
      data: {
        projectId: body.projectId,
        status: "queued",
        config: {
          baseUrl: body.baseUrl,
          scanDepth: body.scanDepth,
          maxDurationMinutes: body.maxDurationMinutes,
          trigger: "mobile",
          mobileConfigId: body.mobileConfigId,
          platform: mobileConfig.platform,
          appiumUrl: mobileConfig.appiumUrl,
          appPackage: mobileConfig.appPackage,
          bundleId: mobileConfig.bundleId,
          proxyPort: mobileConfig.proxyPort,
        },
      },
    });

    await enqueueSecurityScan({
      jobId: job.id,
      projectId: body.projectId,
      baseUrl: body.baseUrl,
      scanDepth: body.scanDepth,
      maxDurationMinutes: body.maxDurationMinutes,
      enableActive: true,
      allowedHosts: [],
      allowedPorts: [],
      authProfiles: [],
      apiFixtures: [],
      authSessionId: body.authSessionId,
      // Mobile-specific context passed through as meta
      mobileConfigId: body.mobileConfigId,
    } as any);

    return reply.code(201).send({
      scanId: job.id,
      status: "queued",
      platform: mobileConfig.platform,
    });
  });

  // GET /mobile/setup-guide — instructions for configuring device proxy
  app.get<{ Querystring: { projectId?: string; configId?: string } }>(
    "/mobile/setup-guide",
    async (req, reply) => {
      const { userId } = (req as any).auth ?? {};
      if (!userId) return reply.code(401).send({ error: "Authentication required" });

      const config = req.query.configId
        ? await prisma.mobileConfig.findUnique({ where: { id: req.query.configId } })
        : null;

      const proxyPort = config?.proxyPort ?? 8888;
      const platform = config?.platform ?? "android";

      const guide = {
        platform,
        proxyPort,
        steps: platform === "android"
          ? [
              "Install TestMind CA certificate on the device: adb shell settings put global http_proxy <your-machine-ip>:" + proxyPort,
              "Download the CA cert from http://<your-machine-ip>:" + proxyPort + "/ca.crt",
              "Install via: Settings → Security → Install from storage → select ca.crt",
              "For Android 7+: add a network_security_config.xml to the app that trusts user-added CAs (or use a debug build)",
              "Start the Appium server and run the mobile scan from TestMind",
            ]
          : [
              "Install TestMind CA certificate on the iOS device/simulator",
              "Set the proxy: Settings → WiFi → (your network) → Configure Proxy → Manual → <your-machine-ip>:" + proxyPort,
              "Navigate to http://<your-machine-ip>:" + proxyPort + "/ca.crt in Safari and install the profile",
              "Trust it: Settings → General → VPN & Device Management → TestMind CA → Trust",
              "Start the Appium server and run the mobile scan from TestMind",
            ],
        appiumCapabilities: config
          ? {
              platformName: config.platform === "android" ? "Android" : "iOS",
              deviceName: config.deviceName ?? "emulator",
              platformVersion: config.platformVersion,
              app: config.appPackage ?? config.bundleId,
              ...(config.platform === "android"
                ? { appPackage: config.appPackage, appActivity: config.appActivity }
                : { bundleId: config.bundleId }),
              ...(config.capabilities as object ?? {}),
            }
          : null,
      };

      return reply.send(guide);
    }
  );
}
