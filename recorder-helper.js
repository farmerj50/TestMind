#!/usr/bin/env node
/**
 * Lightweight local helper to launch Playwright codegen from the Recorder page.
 * Run locally: `node recorder-helper.js --port=43117`
 * The web app will call http://localhost:<port>/record with JSON: { baseUrl, name, projectId? }.
 */
const http = require("http");
const https = require("https");
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
const GENERATED_ROOT = process.env.TM_GENERATED_ROOT || path.join(process.cwd(), "testmind-generated");
const RECORD_ROOT = path.join(GENERATED_ROOT, "playwright-ts", "recordings");
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

function wrapCommand(cmd, args) {
  if (process.platform !== "linux") return { cmd, args };
  if (process.env.DISPLAY) return { cmd, args };
  return { cmd: "xvfb-run", args: ["-a", cmd, ...args] };
}

function postSpecToApi({ apiBase, authToken, projectId, name, language, baseUrl, outputPath }) {
  if (!apiBase) return;
  if (!fs.existsSync(outputPath)) return;
  try {
    const content = fs.readFileSync(outputPath, "utf8");
    if (!content.trim()) return;
    const url = new URL("/recorder/specs", apiBase);
    const body = JSON.stringify({
      projectId,
      name,
      content,
      language,
      baseUrl,
    });
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + (url.search || ""),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
      },
      (res) => {
        res.on("data", () => {});
      }
    );
    req.on("error", (err) => {
      console.error("[recorder-helper] API save failed", err);
    });
    req.write(body);
    req.end();
  } catch (err) {
    console.error("[recorder-helper] API save failed", err);
  }
}

function normalizePlaywrightTestTitle(raw, name) {
  const title = (name || "").trim() || "recorded spec";
  const testRe = /\btest(?:\.(?:only|skip))?\s*\(\s*(['"`])test\1\s*,/;
  if (!testRe.test(raw)) return raw;
  return raw.replace(testRe, (match, quote) => {
    return match.replace(`${quote}test${quote}`, `${quote}${title}${quote}`);
  });
}

function ensurePlaywrightTest(outputPath, name) {
  if (!fs.existsSync(outputPath)) return;
  const raw = fs.readFileSync(outputPath, "utf8");
  if (raw.includes("@playwright/test")) {
    const updated = normalizePlaywrightTestTitle(raw, name);
    if (updated !== raw) {
      fs.writeFileSync(outputPath, updated, "utf8");
    }
    return;
  }
  if (!raw.includes("chromium.launch")) return;

  const isTs = outputPath.endsWith(".ts");
  const header = isTs
    ? "import { test, expect } from '@playwright/test';"
    : "const { test, expect } = require('@playwright/test');";
  const withoutRequire = raw.replace(
    /const\s+\{\s*chromium\s*\}\s*=\s*require\(['"]playwright['"]\);\s*\r?\n?/,
    ""
  );
  const withoutWrapper = withoutRequire
    .replace(/\(\s*async\s*\(\)\s*=>\s*\{\s*\r?\n?/, "")
    .replace(/\r?\n?\}\)\(\);\s*$/, "");
  const withoutBrowser = withoutWrapper
    .replace(/const\s+browser\s*=\s*await\s+chromium\.launch\([\s\S]*?\);\s*\r?\n?/, "")
    .replace(/await\s+browser\.close\(\);\s*\r?\n?/, "");
  const indented = withoutBrowser
    .split(/\r?\n/)
    .map((line) => (line ? `  ${line}` : ""))
    .join("\n");
  const testName = (name || "").trim() || "recorded spec";
  const next = `${header}\n\n` +
    `const testName = ${JSON.stringify(testName)};\n\n` +
    `test(testName, async ({ browser }) => {\n${indented}\n});\n`;
  fs.writeFileSync(outputPath, next, "utf8");
}

function mirrorToUserRoot(sourcePath, userId, projectId) {
  if (!userId || !projectId) return null;
  const destDir = path.join(GENERATED_ROOT, `playwright-ts-${userId}`, "recordings", projectId);
  ensureDir(destDir);
  const destPath = path.join(destDir, path.basename(sourcePath));
  try {
    fs.copyFileSync(sourcePath, destPath);
    return destPath;
  } catch (err) {
    console.error("[recorder-helper] mirror failed", err);
    return null;
  }
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  if (req.method === "GET" && req.url === "/status") {
    return send(res, 200, { ok: true, helper: "recorder-helper" });
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
      const userId = (body.userId || "").trim() || null;
      const apiBase = (body.apiBase || "").trim() || null;
      const authToken = (body.authToken || "").trim() || null;
      const language = (body.language || "typescript").toLowerCase();
      const ext = language === "javascript" ? "js" : language === "python" ? "py" : language === "java" ? "java" : "ts";
      const targetValue =
        language === "javascript" || language === "typescript"
          ? "playwright-test"
          : language === "python"
          ? "python"
          : language === "java"
          ? "java"
          : "playwright-test";
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
        "--target",
        targetValue,
        "--save-storage=state.json",
        "--output",
        outputPath,
      ];
      if (headed) {
        args.push("--headed");
      }

      const ensurePlaywrightTestWithRetry = () => {
        let attempts = 0;
        const maxAttempts = 6;
        const delayMs = 500;
        const tryConvert = () => {
          attempts += 1;
          try {
            ensurePlaywrightTest(outputPath, name);
            mirrorToUserRoot(outputPath, userId, projectId);
            postSpecToApi({
              apiBase,
              authToken,
              projectId,
              name,
              language,
              baseUrl,
              outputPath,
            });
            return;
          } catch (err) {
            if (attempts >= maxAttempts) {
              console.error("[recorder-helper] post-process failed", err);
              return;
            }
          }
          setTimeout(tryConvert, delayMs);
        };
        tryConvert();
      };

      try {
        postCallback({ status: "launching", baseUrl, projectId, outputPath, headed });
        const wrapped = wrapCommand(cmd, args);
        const child = spawn(wrapped.cmd, wrapped.args, {
          cwd: WEB_CWD,
          stdio: "inherit",
          shell: process.platform === "win32", // help avoid EINVAL on Windows
        });

        child.on("error", (err) => {
          console.error("[recorder-helper] spawn error", err);
          postCallback({ status: "error", error: err?.message || String(err) });
        });

        child.on("exit", (code, signal) => {
          ensurePlaywrightTestWithRetry();
          postCallback({ status: "exited", code, signal, outputPath });
        });

        postCallback({ status: "launched", pid: child.pid, outputPath, headed, baseUrl, projectId });
        return send(res, 200, {
          ok: true,
          pid: child.pid,
          command: `${wrapped.cmd} ${wrapped.args.join(" ")}`,
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
