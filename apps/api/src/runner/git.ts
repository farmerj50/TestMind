import { execa } from "execa";

export async function cloneRepo(repoUrl: string, dest: string, token?: string) {
  let url = repoUrl;
  // Optional: inject token for private repos (GitHub)
  if (token && /^https:\/\/github\.com\//i.test(repoUrl)) {
    url = repoUrl.replace("https://", `https://${token}@`);
  }
  await execa("git", ["clone", "--depth=1", url, dest], { stdio: "pipe" });
}
