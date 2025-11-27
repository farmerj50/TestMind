#!/usr/bin/env node
/**
 * Lightweight local helper to launch Playwright codegen from the Recorder page.
 * Run locally: `node recorder-helper.js --port=43117`
 * The web app will call http://localhost:<port>/record with JSON: { baseUrl, name, projectId? }.
 */
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2).reduce((acc, cur) => {
  const [k, v] = cur.split("=");
  acc[k.replace(/^--/, "")] = v ?? true;
  return acc;
}, {});

const PORT = Number(args.port || process.env.RECORDER_PORT || 43117);
const WEB_CWD = path.join(process.cwd(), "apps", "web");
const RECORD_ROOT = path.join(process.cwd(), "apps", "api", "testmind-generated", "playwright-ts", "recordings");
const CALLBACK = process.env.RECORDER_CALLBACK || args.callback || null;

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function slugify(input) {
  return (input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "spec";
}

function validateEnv() {
  if (!fs.existsSync(WEB_CWD)) {
    throw new Error(`apps/web not found at ${WEB_CWD}`);
  }
  return process.platform === "win32"
    ? { cmd: "cmd.exe", args: ["/c", "npx"] }
    : { cmd: "npx", args: [] };
}

async function postCallback(payload) {
  if (!CALLBACK) return;
  try {
    const url = new URL(CALLBACK);
    const body = JSON.stringify({
      ...payload,
      helper: "recorder-helper",
      sentAt: new Date().toISOString(),
    });
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + (url.search || ""),
        method: "POST",
        protocol: url.protocol,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.on("data", () => {});
      }
    );
    req.on("error", () => {});
    req.write(body);
    req.end();
  } catch {
    // swallow callback errors
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  if (req.method !== "POST" || req.url !== "/record") {
    return send(res, 404, { ok: false, error: "Not found" });
  }

  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    try {
      const body = JSON.parse(raw || "{}");
      const baseUrl = (body.baseUrl || "").trim();
      const name = (body.name || "").trim();
      const projectId = (body.projectId || "PROJECT_ID").trim() || "PROJECT_ID";
      const language = (body.language || "typescript").toLowerCase();
      const ext = language === "javascript" ? "js" : language === "python" ? "py" : language === "java" ? "java" : "ts";
      const targetFlag =
        language === "javascript"
          ? "--target=javascript"
          : language === "python"
          ? "--target=python"
          : language === "java"
          ? "--target=java"
          : "--target=typescript";
      const headed = body.headed === true;

      if (!baseUrl) return send(res, 400, { ok: false, error: "baseUrl is required" });
      if (!name) return send(res, 400, { ok: false, error: "name is required" });

      const slug = slugify(name).replace(/\.spec\.ts$/i, "");
      const projectDir = path.join(RECORD_ROOT, projectId);
      ensureDir(projectDir);
      const outputPath = path.join(projectDir, `${slug}.spec.${ext}`);

      const { cmd, args: baseArgs } = validateEnv();
      const args = [
        ...baseArgs,
        "playwright",
        "codegen",
        baseUrl,
        targetFlag,
        "--save-storage=state.json",
        "--output",
        outputPath,
      ];
      if (headed) {
        args.push("--headed");
      }

      try {
        postCallback({ status: "launching", baseUrl, projectId, outputPath, headed });
        const child = spawn(cmd, args, {
          cwd: WEB_CWD,
          stdio: "inherit",
          shell: process.platform === "win32", // help avoid EINVAL on Windows
        });

        child.on("error", (err) => {
          console.error("[recorder-helper] spawn error", err);
          postCallback({ status: "error", error: err?.message || String(err) });
        });

        child.on("exit", (code, signal) => {
          postCallback({ status: "exited", code, signal, outputPath });
        });

        postCallback({ status: "launched", pid: child.pid, outputPath, headed, baseUrl, projectId });
        return send(res, 200, {
          ok: true,
          pid: child.pid,
          command: `${cmd} ${args.join(" ")}`,
          cwd: WEB_CWD,
          outputPath,
        });
      } catch (err) {
        return send(res, 500, { ok: false, error: err?.message || String(err) });
      }
    } catch (err) {
      return send(res, 500, { ok: false, error: err?.message || String(err) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`[recorder-helper] listening on http://localhost:${PORT}`);
  console.log(`[recorder-helper] run POST /record with { baseUrl, name, projectId? } to launch codegen.`);
});
