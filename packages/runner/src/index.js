import { execa } from "execa";
import fs from "fs-extra";
import path from "path";

const REPO = process.env.PROJECT_REPO;
const REF = process.env.PROJECT_REF || "main";
const TEST_DIR = process.env.TEST_DIR || "tests";
const OUT_JSON = "/runner/out/results.json";

const log = (...a) => console.log("[runner]", ...a);

async function main() {
  if (!REPO) throw new Error("PROJECT_REPO is required");
  const work = "/runner/work";
  await fs.ensureDir(work);
  await fs.ensureDir("/runner/out");

  log("clone", REPO, "ref:", REF);
  try {
    await execa("git", ["clone", "--depth", "1", "--branch", REF, REPO, work], { stdio: "inherit" });
  } catch {
    await execa("git", ["clone", "--depth", "1", REPO, work], { stdio: "inherit" });
    await execa("git", ["-C", work, "fetch", "origin", REF], { stdio: "inherit" });
    await execa("git", ["-C", work, "checkout", REF], { stdio: "inherit" });
  }

  const hasPnpm = await fs.pathExists(path.join(work, "pnpm-lock.yaml"));
  const hasYarn = await fs.pathExists(path.join(work, "yarn.lock"));
  const install = hasPnpm ? ["pnpm","install","--frozen-lockfile"]
               : hasYarn ? ["yarn","install","--frozen-lockfile"]
                         : ["npm","ci"];
  log("install", install.join(" "));
  await execa(install[0], install.slice(1), { cwd: work, stdio: "inherit" });

  try { await execa("npx", ["playwright","install","--with-deps"], { cwd: work, stdio: "inherit" }); } catch {}

  log("run playwright");
  const { stdout } = await execa("npx", ["playwright","test", TEST_DIR, "--reporter=json"], { cwd: work });
  await fs.writeFile(OUT_JSON, stdout, "utf-8");
  log("saved", OUT_JSON);

  const r = JSON.parse(stdout || "{}");
  const failed = (r?.suites ?? []).some(s =>
    (s.specs ?? []).some(sp =>
      (sp.tests ?? []).some(t => (t.results ?? []).some(rr => rr.status !== "passed"))
    )
  );
  process.exitCode = failed ? 2 : 0;
}

main().catch(e => { console.error("[runner] fatal:", e?.stack || e); process.exit(1); });
