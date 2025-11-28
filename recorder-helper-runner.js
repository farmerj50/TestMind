#!/usr/bin/env node
/**
 * Auto-start wrapper for recorder-helper.js.
 * Runs the helper, restarts on crash, and exits cleanly on SIGINT/SIGTERM.
 */
const { spawn } = require("child_process");
const path = require("path");

const HELPER_PATH = path.join(__dirname, "recorder-helper.js");
const PORT = process.env.RECORDER_PORT || 43117;
const RESTART_DELAY_MS = 5000;

let child = null;
let shuttingDown = false;

function startHelper() {
  const env = { ...process.env, RECORDER_PORT: PORT };
  child = spawn(process.execPath, [HELPER_PATH], {
    env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.log(`[recorder-autostart] helper exited (code=${code}, signal=${signal}). Restarting in ${RESTART_DELAY_MS}ms...`);
    setTimeout(startHelper, RESTART_DELAY_MS);
  });

  child.on("error", (err) => {
    console.error("[recorder-autostart] failed to start helper:", err);
  });
}

function stopHelper() {
  shuttingDown = true;
  if (child && !child.killed) {
    child.kill("SIGTERM");
  }
}

process.on("SIGINT", () => {
  stopHelper();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopHelper();
  process.exit(0);
});

console.log(`[recorder-autostart] starting recorder-helper on port ${PORT}`);
startHelper();
