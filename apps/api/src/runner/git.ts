import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

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
  const localOverride = process.env.TM_LOCAL_REPO_PATH;
  if (localOverride) {
    console.log(`[runner] using local repo snapshot from ${localOverride}`);
    await copyLocalRepo(localOverride, dest);
    return;
  }

  let url = repoUrl;
  // Optional: inject token for private repos (GitHub)
  if (token && /^https:\/\/github\.com\//i.test(repoUrl)) {
    url = repoUrl.replace("https://", `https://${token}@`);
  }
  await execa("git", ["clone", "--depth=1", url, dest], { stdio: "pipe" });
}
