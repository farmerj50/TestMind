import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { validateAndNormalizeRepoUrl } from "../lib/git-url.js";

const LOCAL_REPO_ROOT = process.env.TM_LOCAL_REPO_ROOT?.trim()
  ? path.resolve(process.env.TM_LOCAL_REPO_ROOT)
  : null;

function isLocalRootTarget(dest: string) {
  return !!LOCAL_REPO_ROOT && path.resolve(dest) === LOCAL_REPO_ROOT;
}

async function ensureCleanDest(dest: string) {
  await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(dest, { recursive: true });
}

async function copyLocalRepo(src: string, dest: string) {
  await fs.cp(src, dest, {
    recursive: true,
    filter(source) {
      const rel = path.relative(src, source);
      if (!rel) return true;
      const segments = rel.split(path.sep);
      if (segments[0] === ".git") return false;
      if (segments.includes("node_modules")) return false;
      return true;
    },
  });
}

export async function cloneRepo(repoUrl: string, dest: string, token?: string) {
  const destResolved = path.resolve(dest);
  if (isLocalRootTarget(destResolved)) {
    console.log(`[runner] TM_LOCAL_REPO_ROOT=${destResolved} detected; skipping clone`);
    return;
  }

  await ensureCleanDest(destResolved);

  const localOverride = process.env.TM_LOCAL_REPO_PATH;
  if (localOverride) {
    console.log(`[runner] using local repo snapshot from ${localOverride}`);
    await copyLocalRepo(localOverride, destResolved);
    return;
  }

  const checked = validateAndNormalizeRepoUrl(repoUrl);
  if (!checked.ok) {
    const reason = "reason" in checked ? checked.reason : "Invalid repository URL";
    throw new Error(`Repository URL failed security validation: ${reason}`);
  }

  const url = checked.normalized;
  // Optional: authenticate to private GitHub repos without embedding token in URL.
  if (token && /^https:\/\/github\.com\//i.test(url)) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    await execa(
      "git",
      [
        "-c",
        `http.https://github.com/.extraheader=Authorization: Basic ${basic}`,
        "clone",
        "--depth=1",
        url,
        destResolved,
      ],
      { stdio: "pipe" }
    );
    return;
  }
  await execa("git", ["clone", "--depth=1", url, destResolved], { stdio: "pipe" });
}
