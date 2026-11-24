#!/usr/bin/env node
// Automated, evidence-based Prisma migration-history reconciliation for an EXISTING database
// (one that was partly built with `db push`, so objects exist without migration records).
//
//   TARGET_DATABASE_URL=... node scripts/release/reconcile-migrations.mjs                 # dry run (default)
//   TARGET_DATABASE_URL=... node scripts/release/reconcile-migrations.mjs --apply --backup-manifest <file>.manifest.json
//
// How it decides (no manual table inspection):
//  1. Replays every migration in apps/api/prisma/migrations, in order, into a disposable Postgres
//     container of the TARGET's major version, recording exactly which tables, columns (type,
//     nullability, default), indexes, constraints and enum values each migration creates or removes.
//  2. Compares those objects with the target, for every migration the target has not recorded:
//       already-present  -> every object exists with an identical definition: record as applied
//       pending          -> none of its objects exist: left for `prisma migrate deploy`
//       present-missing-indexes -> all tables/columns/constraints identical, only indexes missing:
//                           record as applied and create those indexes (non-destructive)
//       conflict         -> anything else: STOP, nothing is changed
//  3. With --apply (and only with a verified backup manifest for this exact database, < 24h old):
//     records already-present migrations (`prisma migrate resolve --applied`), creates missing
//     indexes, runs `prisma migrate deploy` for pending ones, then requires zero schema drift.
// It never drops, resets, truncates or rewrites data, and never prints credentials.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apiDir = path.join(repo, "apps/api");
const migrationsDir = path.join(apiDir, "prisma/migrations");
const require = createRequire(path.join(apiDir, "package.json"));
const { PrismaClient } = require("@prisma/client");
const prismaCli = require.resolve("prisma/build/index.js");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const manifestPath = args.includes("--backup-manifest") ? args[args.indexOf("--backup-manifest") + 1] : null;
const target = process.env.TARGET_DATABASE_URL;
if (!target) { console.error("TARGET_DATABASE_URL is required"); process.exit(2); }
const tUrl = new URL(target);
const where = `${tUrl.hostname}:${tUrl.port || 5432}/${tUrl.pathname.slice(1)}`;
const log = (...a) => console.log("[reconcile]", ...a);

// ── Safety gate for --apply ─────────────────────────────────────────────────
if (APPLY) {
  if (!manifestPath || !fs.existsSync(manifestPath)) { console.error("--apply requires --backup-manifest <verified manifest>"); process.exit(2); }
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const same = m.target?.host === tUrl.hostname && String(m.target?.port) === String(tUrl.port || 5432) && m.target?.database === tUrl.pathname.slice(1);
  const fresh = Date.now() - Date.parse(m.createdAt) < 24 * 3600_000;
  const intact = fs.existsSync(m.file) && createHash("sha256").update(fs.readFileSync(m.file)).digest("hex") === m.sha256;
  if (!m.verified || !same || !fresh || !intact) { console.error(`Backup manifest rejected (verified=${!!m.verified} sameDatabase=${same} under24h=${fresh} fileIntact=${intact})`); process.exit(2); }
  log(`backup verified: ${path.basename(m.file)} (${m.tableDataEntries} tables, sha256 ${m.sha256.slice(0, 12)}...)`);
}

// ── Catalog snapshot ────────────────────────────────────────────────────────
const CATALOG_SQL = {
  tables: `select table_name as k, 'table' as v from information_schema.tables where table_schema='public' and table_type='BASE TABLE' and table_name <> '_prisma_migrations'`,
  columns: `select table_name||'.'||column_name as k, concat_ws('|', data_type, udt_name, is_nullable, coalesce(column_default,''), coalesce(datetime_precision::text,''), coalesce(character_maximum_length::text,'')) as v from information_schema.columns where table_schema='public' and table_name <> '_prisma_migrations'`,
  indexes: `select indexname as k, regexp_replace(indexdef, ' ON public\\.', ' ON ') as v from pg_indexes where schemaname='public' and tablename <> '_prisma_migrations'`,
  constraints: `select c.conrelid::regclass::text||'.'||c.conname as k, pg_get_constraintdef(c.oid) as v from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' and c.contype in ('f','u','c') and c.conrelid::regclass::text <> '"_prisma_migrations"'`,
  enums: `select t.typname||':'||e.enumlabel as k, 'enum' as v from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'`,
};
async function catalog(client) {
  const out = new Map();
  for (const [kind, sql] of Object.entries(CATALOG_SQL)) for (const r of await client.$queryRawUnsafe(sql)) out.set(`${kind}:${r.k}`, String(r.v));
  return out;
}

// ── Disposable shadow database of the target's major version ────────────────
const targetClient = new PrismaClient({ datasourceUrl: target });
const versionNum = Number((await targetClient.$queryRawUnsafe("show server_version_num"))[0].server_version_num);
const major = Math.floor(versionNum / 10000);
const shadowName = `tm-reconcile-shadow-${process.pid}`;
const shadowPort = 55000 + (process.pid % 900);
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { encoding: "utf8", stdio: opts.quiet ? "pipe" : ["ignore", "pipe", "pipe"], ...opts });
log(`target ${where} (PostgreSQL ${major}); shadow postgres:${major} on 127.0.0.1:${shadowPort}`);
sh("docker", ["run", "-d", "--rm", "--name", shadowName, "-e", "POSTGRES_USER=shadow", "-e", "POSTGRES_PASSWORD=shadow", "-e", "POSTGRES_DB=shadow", "-p", `127.0.0.1:${shadowPort}:5432`, `postgres:${major}`]);
const cleanup = () => { try { sh("docker", ["rm", "-f", shadowName], { quiet: true }); } catch {} };
process.on("exit", cleanup);
for (let i = 0; i < 60; i++) { try { sh("docker", ["exec", shadowName, "pg_isready", "-U", "shadow", "-d", "shadow"], { quiet: true }); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
await new Promise((r) => setTimeout(r, 1500));
const shadowUrl = `postgresql://shadow:shadow@127.0.0.1:${shadowPort}/shadow`;
const shadow = new PrismaClient({ datasourceUrl: shadowUrl });

const migrations = fs.readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n) && fs.existsSync(path.join(migrationsDir, n, "migration.sql"))).sort();
const effects = new Map(); // migration -> { added: Map<key, def>, removed: Set<key>, hasData: boolean }
let before = await catalog(shadow);
for (const name of migrations) {
  const sqlText = fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");
  sh("docker", ["exec", "-i", shadowName, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "shadow", "-d", "shadow"], { input: sqlText, quiet: true });
  const after = await catalog(shadow);
  const added = new Map([...after].filter(([k, v]) => before.get(k) !== v));
  const removed = new Set([...before.keys()].filter((k) => !after.has(k)));
  const hasData = /^\s*(insert|update|delete)\b/im.test(sqlText.replace(/--.*$/gm, ""));
  effects.set(name, { added, removed, hasData });
  before = after;
}
log(`replayed ${migrations.length} migrations into the shadow database`);
const finalShadow = before;

// ── Compare with the target ─────────────────────────────────────────────────
const hasTable = (await targetClient.$queryRawUnsafe(`select to_regclass('public._prisma_migrations') is not null as present`))[0].present;
const records = hasTable ? await targetClient.$queryRawUnsafe(`select migration_name, finished_at, rolled_back_at from _prisma_migrations`) : [];
const unresolvedFailed = records.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
if (unresolvedFailed.length) { console.error(`STOP: unresolved failed migration records: ${unresolvedFailed.join(", ")}`); process.exit(1); }
const applied = new Set(records.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
const dbOnly = [...applied].filter((n) => !migrations.includes(n));
const targetCatalog = await catalog(targetClient);

const plan = [];
for (const name of migrations.filter((n) => !applied.has(n))) {
  const { added, removed, hasData } = effects.get(name);
  const present = [...added].filter(([k, v]) => targetCatalog.get(k) === v).map(([k]) => k);
  const missing = [...added].filter(([k]) => !targetCatalog.has(k)).map(([k]) => k);
  const differing = [...added].filter(([k, v]) => targetCatalog.has(k) && targetCatalog.get(k) !== v).map(([k]) => k);
  const stillThere = [...removed].filter((k) => targetCatalog.has(k));
  let status;
  if (!added.size && !removed.size) status = "pending"; // no schema effect (e.g. data-only): let deploy run it
  else if (!differing.length && !missing.length && !stillThere.length) status = "already-present";
  else if (!differing.length && !stillThere.length && missing.length && missing.every((k) => k.startsWith("indexes:")) && present.length) status = "present-missing-indexes";
  else if (!present.length && !differing.length) status = "pending";
  else status = "conflict";
  plan.push({ name, status, objects: added.size, missing, differing, stillThere, hasData });
}
// Indexes that belong to RECORDED migrations but are missing on the target (db push drift).
const recordedIndexGaps = [];
for (const name of migrations.filter((n) => applied.has(n))) for (const [k] of effects.get(name).added) if (k.startsWith("indexes:") && finalShadow.has(k) && !targetCatalog.has(k)) recordedIndexGaps.push(k);

for (const p of plan) log(`${p.status.padEnd(24)} ${p.name} (${p.objects} objects${p.missing.length ? `, missing ${p.missing.length}` : ""}${p.differing.length ? `, DIFFERENT ${p.differing.slice(0, 3).join(", ")}` : ""}${p.hasData ? ", contains data statements" : ""})`);
if (recordedIndexGaps.length) log(`missing indexes from already-recorded migrations: ${recordedIndexGaps.map((k) => k.slice(8)).join(", ")}`);
if (dbOnly.length) log(`recorded on the target but not in this release (kept, informational): ${dbOnly.join(", ")}`);
const conflicts = plan.filter((p) => p.status === "conflict");
const dataRecords = plan.filter((p) => p.status !== "pending" && p.hasData);
if (conflicts.length) { console.error(`STOP: ${conflicts.length} migration(s) partially present or with different definitions - nothing changed.`); for (const c of conflicts) console.error(`  ${c.name}: missing=${c.missing.slice(0, 5).join(",")} different=${c.differing.slice(0, 5).join(",")} notRemoved=${c.stillThere.slice(0, 5).join(",")}`); process.exit(1); }
if (dataRecords.length) { console.error(`STOP: would record data-changing migrations as applied without running them: ${dataRecords.map((p) => p.name).join(", ")}`); process.exit(1); }

const toRecord = plan.filter((p) => p.status === "already-present" || p.status === "present-missing-indexes");
const indexKeys = [...new Set([...plan.filter((p) => p.status === "present-missing-indexes").flatMap((p) => p.missing), ...recordedIndexGaps])];
const pending = plan.filter((p) => p.status === "pending");
log(`plan: record ${toRecord.length} as applied, create ${indexKeys.length} missing index(es), leave ${pending.length} pending for migrate deploy`);

if (!APPLY) { log("dry run only - nothing changed. Re-run with --apply --backup-manifest <file> to execute."); await targetClient.$disconnect(); await shadow.$disconnect(); process.exit(0); }

// ── Apply (history + non-destructive index creation + deploy) ───────────────
const prisma = (a) => sh(process.execPath, [prismaCli, ...a], { cwd: apiDir, env: { ...process.env, DATABASE_URL: target, DIRECT_URL: target }, quiet: true });
if (!hasTable && toRecord.length) log("creating Prisma migration history table via migrate resolve");
for (const p of toRecord) { prisma(["migrate", "resolve", "--applied", p.name]); log(`recorded as applied: ${p.name}`); }
if (indexKeys.length) {
  const file = path.join(os.tmpdir(), `tm-reconcile-indexes-${process.pid}.sql`);
  fs.writeFileSync(file, indexKeys.map((k) => finalShadow.get(k).replace(/^CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX IF NOT EXISTS ") + ";").join("\n"));
  prisma(["db", "execute", "--file", file, "--schema", "prisma/schema.prisma"]);
  fs.rmSync(file, { force: true });
  log(`created missing index(es): ${indexKeys.map((k) => k.slice(8)).join(", ")}`);
}
const deployOut = prisma(["migrate", "deploy"]);
log(deployOut.includes("No pending migrations") ? "migrate deploy: no pending migrations" : `migrate deploy applied pending migrations:\n${deployOut.split("\n").filter((l) => /Applying|applied/i.test(l)).join("\n")}`);
const drift = prisma(["migrate", "diff", "--from-url", target, "--to-schema-datamodel", "prisma/schema.prisma", "--script"]);
const driftStatements = drift.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));
if (driftStatements.length) { console.error(`STOP: schema drift remains after reconciliation:\n${driftStatements.slice(0, 20).join("\n")}`); process.exit(1); }
log("done: migration history reconciled, migrations deployed, zero schema drift");
await targetClient.$disconnect(); await shadow.$disconnect();
