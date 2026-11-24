#!/usr/bin/env node
// Recoverable, verified backup of a TestMind Postgres database (read-only on the database).
//
//   TARGET_DATABASE_URL=postgresql://... node scripts/release/db-backup.mjs [backupDir]
//
// - Uses Docker's official postgres image matching the SERVER's major version (pg_dump must not be
//   older than the server), so no local Postgres tools are needed.
// - Writes a custom-format dump, verifies it with pg_restore --list, records sha256, size, table
//   count and exact per-table row counts, and writes <dump>.manifest.json. The reconciliation script
//   refuses to change a database without a matching, verified manifest.
// - Never prints credentials.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const url = process.env.TARGET_DATABASE_URL;
if (!url) { console.error("TARGET_DATABASE_URL is required"); process.exit(2); }
const backupDir = path.resolve(process.argv[2] ?? "C:/Users/gabby/TestMind-backups");
fs.mkdirSync(backupDir, { recursive: true });

const parsed = new URL(url);
const target = { host: parsed.hostname, port: parsed.port || "5432", database: parsed.pathname.slice(1) };
// Docker containers reach a database on this machine through host.docker.internal.
const dockerUrl = ["localhost", "127.0.0.1"].includes(parsed.hostname) ? url.replace(`@${parsed.hostname}:`, "@host.docker.internal:") : url;
const docker = (image, args, opts = {}) => execFileSync("docker", ["run", "--rm", ...(opts.mount ? ["-v", `${backupDir}:/backup`] : []), image, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: "1" } });

const serverVersionNum = Number(docker("postgres:17", ["psql", dockerUrl, "-XtAc", "show server_version_num"]).trim());
const major = Math.floor(serverVersionNum / 10000);
if (!(major >= 12)) { console.error(`Unsupported server version ${serverVersionNum}`); process.exit(2); }
const image = `postgres:${major}`;
console.log(`[backup] target ${target.host}:${target.port}/${target.database} (PostgreSQL ${major}); tools ${image}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = `testmind-${target.database}-${target.host.replace(/[^a-z0-9.-]/gi, "_")}-${stamp}.dump`;
docker(image, ["pg_dump", "--format=custom", "--no-owner", "--no-privileges", `--file=/backup/${file}`, dockerUrl], { mount: true });

const listing = docker(image, ["pg_restore", "--list", `/backup/${file}`], { mount: true });
const tableData = listing.split("\n").filter((l) => / TABLE DATA /.test(l)).length;
if (!tableData) { console.error("[backup] verification failed: no table data in dump"); process.exit(1); }

const counts = docker(image, ["psql", dockerUrl, "-XtA", "-F", "|", "-c",
  "select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1"]);
const rowCounts = Object.fromEntries(counts.trim().split("\n").filter(Boolean).map((l) => { const [t, c] = l.split("|"); return [t, Number(c)]; }));

const abs = path.join(backupDir, file);
const sha256 = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
const manifest = { file: abs, createdAt: new Date().toISOString(), target, serverMajor: major, bytes: fs.statSync(abs).size, sha256, tableDataEntries: tableData, rowCounts, verified: true };
fs.writeFileSync(`${abs}.manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`[backup] verified: ${tableData} tables, ${manifest.bytes} bytes, sha256 ${sha256.slice(0, 16)}...`);
console.log(`[backup] manifest: ${abs}.manifest.json`);
console.log(`[backup] restore (into an EMPTY database only): pg_restore --no-owner --dbname=<empty-db-url> "${abs}"`);
