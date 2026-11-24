// B4: approved test credentials by REFERENCE. A run stores only the ProjectSecret keys; the
// worker resolves (decrypts) values in memory for one Playwright process. Values never enter
// the plan, generated code, prompts, queue payloads, logs, or artifacts.
import { prisma } from "../prisma.js";
import { decryptSecret } from "./crypto.js";

export type CredentialRef = { emailKey: string; passwordKey: string; loginPath?: string };

export function isCredentialRef(v: unknown): v is CredentialRef {
  const r = v as CredentialRef;
  return !!r && typeof r === "object" && typeof r.emailKey === "string" && !!r.emailKey && typeof r.passwordKey === "string" && !!r.passwordKey
    && (r.loginPath === undefined || (typeof r.loginPath === "string" && r.loginPath.startsWith("/")));
}

/** Verifies both referenced secrets exist for the project (without decrypting them). */
export async function credentialRefExists(projectId: string, ref: CredentialRef): Promise<boolean> {
  const n = await prisma.projectSecret.count({ where: { projectId, key: { in: [ref.emailKey, ref.passwordKey] } } });
  return n === new Set([ref.emailKey, ref.passwordKey]).size;
}

/** Env for ONE test process. Returns {} (auth tests then skip) when the reference can't be resolved. */
export async function resolveCredentialEnv(projectId: string, ref: unknown, names: { email: string; password: string; loginPath: string }): Promise<Record<string, string>> {
  if (!isCredentialRef(ref)) return {};
  const rows = await prisma.projectSecret.findMany({ where: { projectId, key: { in: [ref.emailKey, ref.passwordKey] } }, select: { key: true, value: true } });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const email = byKey.get(ref.emailKey);
  const password = byKey.get(ref.passwordKey);
  if (!email || !password) return {};
  try {
    return { [names.email]: decryptSecret(email), [names.password]: decryptSecret(password), ...(ref.loginPath ? { [names.loginPath]: ref.loginPath } : {}) };
  } catch {
    return {};
  }
}
