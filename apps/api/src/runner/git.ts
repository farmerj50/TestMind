import { execa } from "execa";

// repoUrl like: https://github.com/org/repo(.git)
export async function cloneRepo(repoUrl: string, dest: string, token?: string) {
  // embed token if present
  const url = token
    ? repoUrl.replace(/^https:\/\//i, `https://${token}@`)
    : repoUrl;

  await execa("git", ["init"], { cwd: dest });
  await execa("git", ["remote", "add", "origin", url], { cwd: dest });
  await execa("git", ["fetch", "--depth=1", "origin", "HEAD"], { cwd: dest });
  await execa("git", ["checkout", "FETCH_HEAD"], { cwd: dest });
}
