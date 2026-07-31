import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { runAnomalyBaseline } from "./anomaly-baseline.js";
import { runIntelligentValidation } from "./intelligent-validation.js";
import type {
  IntelligentSecurityScanConfig,
  RouteSecurityContract,
} from "../types.js";

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string, port: number) => Promise<void>
) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function baseConfig(baseUrl: string, port: number): IntelligentSecurityScanConfig {
  return {
    jobId: "job_test",
    projectId: "project_test",
    baseUrl,
    allowedHosts: ["127.0.0.1"],
    allowedPorts: [port],
    maxDurationMinutes: 1,
    enableActive: false,
    safeMode: true,
    scanDepth: "standard",
  };
}

test("runIntelligentValidation flags auth-required protected actions that return 204", async () => {
  await withServer(
    (_req, res) => {
      res.statusCode = 204;
      res.end();
    },
    async (baseUrl, port) => {
      const findings = await runIntelligentValidation({
        ...baseConfig(baseUrl, port),
        authProfiles: [
          {
            label: "Owner",
            role: "user",
            type: "cookie",
            cookieName: "session",
            cookieValue: "owner",
          },
        ],
        apiFixtures: [
          {
            route: "/api/jobs/:id",
            method: "POST",
            ownerObjectId: "1",
            expectedControls: ["auth_required"],
          },
        ],
      });

      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.title, "Broken Authentication");
      assert.equal((findings[0]?.evidence as any)?.testedControl, "auth_required");
    }
  );
});

test("runAnomalyBaseline uses additional captured auth headers during authenticated probes", async () => {
  await withServer(
    (req, res) => {
      const hasCookie = String(req.headers.cookie ?? "").includes("session=owner");
      const hasCsrf = req.headers["x-csrf-token"] === "valid";
      if (req.url === "/api/account" && hasCookie && !hasCsrf) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "csrf required" }));
        return;
      }
      if (req.url === "/api/account") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "acct_1", balance: 100 }));
        return;
      }
      res.statusCode = 404;
      res.end();
    },
    async (baseUrl, port) => {
      const contract: RouteSecurityContract = {
        route: "/api/account",
        method: "GET",
        source: "fixture",
        expectedControls: ["auth_required"],
        expectedDenyStatuses: [401, 403, 404],
        forbiddenFields: [],
        confidence: "declared",
      };
      const result = await runAnomalyBaseline(
        {
          ...baseConfig(baseUrl, port),
          authProfiles: [
            {
              label: "Owner",
              role: "user",
              type: "cookie",
              cookieName: "session",
              cookieValue: "owner",
              additionalHeaders: { "X-CSRF-Token": "valid" },
            },
          ],
        },
        [contract]
      );

      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0]?.title, "Broken Authentication");
      assert.equal(
        result.authMatrix[0]?.probes.find((probe) => probe.label === "owner")?.passed,
        true
      );
    }
  );
});
