// recorder-desktop/main.js
// Minimal Electron helper that exposes a local HTTP endpoint to launch Playwright codegen.
// Run: npm install && npm start (or npm run dev). It listens on http://localhost:43117/record.
// The web Recorder page can POST { baseUrl, name, projectId? } to /record to open codegen.

const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const http = require("http");

const PORT = Number(process.env.RECORDER_PORT || 43117);
const WEB_CWD = path.join(process.cwd(), "..", "apps", "web");
const RECORD_ROOT = path.join(process.cwd(), "..", "apps", "api", "testmind-generated", "playwright-ts", "recordings");
const CALLBACK_URL = process.env.RECORDER_CALLBACK || null; // optional: http://localhost:8787/recorder/callback

function slugify(input) {
  return (input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "spec";
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function validateEnv() {
  if (!fs.existsSync(WEB_CWD)) {
    throw new Error(`apps/web not found at ${WEB_CWD}`);
  }
  const isWin = process.platform === "win32";
  return {
    cmd: isWin ? "cmd.exe" : "npx",
    args: isWin ? ["/c", "npx"] : [],
    shell: isWin,
  };
}

function startServer() {
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
      res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end(JSON.stringify({ ok: false, error: "Not found" }));
    }

    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw || "{}");
        const baseUrl = (body.baseUrl || "").trim();
        const name = (body.name || "").trim();
        const projectId = (body.projectId || "PROJECT_ID").trim() || "PROJECT_ID";

        if (!baseUrl || !name) {
          res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          return res.end(JSON.stringify({ ok: false, error: "baseUrl and name are required" }));
        }

        const slug = slugify(name).replace(/\.spec\.ts$/i, "");
        const projectDir = path.join(RECORD_ROOT, projectId);
        ensureDir(projectDir);
        const outputPath = path.join(projectDir, `${slug}.spec.ts`);

        const { cmd, args: baseArgs, shell } = validateEnv();
        const args = [
          ...baseArgs,
          "playwright",
          "codegen",
          baseUrl,
          "--save-storage=state.json",
          "--output",
          outputPath,
        ];

        const child = spawn(cmd, args, {
          cwd: WEB_CWD,
          stdio: "inherit",
          shell,
        });

        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        const payload = {
          ok: true,
          pid: child.pid,
          command: `${cmd} ${args.join(" ")}`,
          cwd: WEB_CWD,
          outputPath,
          projectId,
          baseUrl,
          name,
        };
        res.end(JSON.stringify(payload));

        if (CALLBACK_URL) {
          try {
            const cbData = JSON.stringify({ status: "launched", ...payload });
            const url = new URL(CALLBACK_URL);
            const opts = {
              method: "POST",
              hostname: url.hostname,
              port: url.port || 80,
              path: url.pathname,
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(cbData),
              },
            };
            const reqCb = http.request(opts);
            reqCb.on("error", (err) => console.error("[recorder-helper] callback error", err));
            reqCb.write(cbData);
            reqCb.end();
          } catch (err) {
            console.error("[recorder-helper] callback failed", err);
          }
        }
        return;
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        return res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`[recorder-helper] listening on http://localhost:${PORT}`);
    console.log(`[recorder-helper] POST { baseUrl, name, projectId? } to /record to launch codegen.`);
  });
}

// Minimal hidden window; we just need the app alive for the local server
function createWindow() {
  const win = new BrowserWindow({ show: false });
  win.loadURL("about:blank");
}

app.whenReady().then(() => {
  createWindow();
  startServer();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
