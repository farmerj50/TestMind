import { execa } from "execa";
import { redactText } from "../security/redaction.js";

// Shared execution guardrails for every subprocess the dev agent runs inside a target
// repo's worktree (dependency install + the configured test command). Both of those run
// code the target repo controls, so they get the same treatment:
//   - an allowlisted environment (never the API's own process.env, which holds DB URLs,
//     LLM keys, auth secrets, etc.)
//   - a wall-clock timeout that kills the WHOLE process tree, not just the direct child
//   - bounded output capture (rolling tail; never an unbounded in-memory buffer)
//   - a V8 heap cap for every Node process in the tree via NODE_OPTIONS

// Only what toolchains genuinely need to locate themselves, their caches, and the OS.
// Anything not on this list - including every *_KEY / *_SECRET / DATABASE_URL / token -
// is dropped. PLAYWRIGHT_BROWSERS_PATH and the per-user app-data dirs are kept so
// already-installed Playwright browsers and package-manager caches are still found.
const ENV_ALLOWLIST = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "OS",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USER",
  "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "CommonProgramFiles", "CommonProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "LANG", "LC_ALL", "TERM", "SHELL",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "PLAYWRIGHT_BROWSERS_PATH", "PNPM_HOME", "COREPACK_HOME", "npm_config_cache", "YARN_CACHE_FOLDER", "BUN_INSTALL",
];

// Belt-and-braces: even an allowlisted name is dropped if it looks secret-bearing.
const SECRET_NAME_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|DATABASE_URL|DSN)/i;

export const DEFAULT_NODE_HEAP_MB = 4096;

export function buildSandboxEnv(extra: Record<string, string> = {}, opts: { nodeHeapMb?: number } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (typeof value === "string" && !SECRET_NAME_PATTERN.test(name)) env[name] = value;
  }
  const heapMb = opts.nodeHeapMb ?? envInt("DEV_AGENT_NODE_HEAP_MB", DEFAULT_NODE_HEAP_MB);
  // Replaces (never inherits) NODE_OPTIONS, so a parent --require/--inspect can't leak in.
  env.NODE_OPTIONS = `--max-old-space-size=${heapMb}`;
  return { ...env, ...extra };
}

export function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

// Splits a configured command into argv without a shell: whitespace separates args,
// single/double quotes group, backslash-escaped quotes inside double quotes are literal.
// No shell means no pipes, redirects, `&&`, or variable expansion - by design.
export function parseCommandLine(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === "\\" && quote === '"' && command[i + 1] === '"') { current += '"'; i++; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasToken = true; continue; }
    if (/\s/.test(ch)) {
      if (hasToken) { args.push(current); current = ""; hasToken = false; }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote) throw new Error(`Unterminated ${quote} quote in command: ${command}`);
  if (hasToken) args.push(current);
  return args;
}

export async function killProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    await execa("taskkill", ["/PID", String(pid), "/T", "/F"], { reject: false, windowsHide: true });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

export type SandboxedRunResult = {
  exitCode: number | null;
  output: string;          // redacted rolling tail of combined stdout+stderr
  outputTruncated: boolean;
  timedOut: boolean;
  killedByAbort: boolean;
  spawnError?: string;
};

export type SandboxedRunOptions = {
  cwd: string;
  timeoutMs: number;
  maxOutputChars: number;
  env?: Record<string, string>;
  // Polled every pollMs; returning true kills the process tree (e.g. run canceled).
  shouldAbort?: () => Promise<boolean>;
  pollMs?: number;
};

export async function runSandboxed(cmd: string, args: string[], opts: SandboxedRunOptions): Promise<SandboxedRunResult> {
  let tail = "";
  let truncated = false;
  let timedOut = false;
  let killedByAbort = false;

  let subprocess;
  try {
    subprocess = execa(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? buildSandboxEnv(),
      extendEnv: false,
      reject: false,
      all: true,
      buffer: false,
      stdin: "ignore",
      windowsHide: true,
      // Own process group on POSIX so the whole tree can be killed with kill(-pid).
      detached: process.platform !== "win32",
    });
  } catch (err: any) {
    return { exitCode: null, output: "", outputTruncated: false, timedOut: false, killedByAbort: false, spawnError: redactText(err?.message ?? String(err)) };
  }

  subprocess.all?.on("data", (chunk: Buffer) => {
    tail += chunk.toString("utf8");
    if (tail.length > opts.maxOutputChars) {
      tail = tail.slice(tail.length - opts.maxOutputChars);
      truncated = true;
    }
  });

  const timer = setTimeout(() => {
    timedOut = true;
    void killProcessTree(subprocess.pid);
  }, opts.timeoutMs);

  let pollId: NodeJS.Timeout | undefined;
  if (opts.shouldAbort) {
    pollId = setInterval(async () => {
      if (await opts.shouldAbort!().catch(() => false)) {
        killedByAbort = true;
        void killProcessTree(subprocess.pid);
      }
    }, opts.pollMs ?? 1000);
  }

  try {
    const result: any = await subprocess;
    const spawnError = result.failed && result.exitCode === undefined && !timedOut && !killedByAbort
      ? redactText(result.shortMessage ?? result.message ?? "failed to start")
      : undefined;
    return {
      exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
      output: redactText(tail),
      outputTruncated: truncated,
      timedOut,
      killedByAbort,
      spawnError,
    };
  } finally {
    clearTimeout(timer);
    if (pollId) clearInterval(pollId);
  }
}
