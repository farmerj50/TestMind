# TestMind production release runbook (Railway)

Release: branch `release/autonomous-qe`. Every step below is safe to stop after; nothing drops,
resets or rewrites production data.

## 0. Prerequisites (once)
- Docker running locally (the backup and reconciliation tools run Postgres tools in containers).
- Railway CLI: `npm i -g @railway/cli`, then `railway login`, then `railway link` to the TestMind project.
- Production database URL reachable from this machine (Railway Postgres **public** URL,
  `DATABASE_PUBLIC_URL` on the Postgres service). It is only ever passed as an environment variable.

## 1. Backup (required before any database change)
```
TARGET_DATABASE_URL="<production DATABASE_PUBLIC_URL>" node scripts/release/db-backup.mjs <backup-dir>
```
Creates a verified custom-format dump (checked with `pg_restore --list`), sha256, per-table row
counts and `<dump>.manifest.json`. Restore, if ever needed, only into an EMPTY database:
`pg_restore --no-owner --dbname=<empty-db-url> <dump>`.

## 2. Reconciliation dry run (read-only)
```
TARGET_DATABASE_URL="<production DATABASE_PUBLIC_URL>" node scripts/release/reconcile-migrations.mjs
```
Replays all migrations into a disposable Postgres of the same major version and compares every
created object with production. Each unrecorded migration is reported as `already-present`
(recorded as applied), `pending` (applied by `migrate deploy`), `present-missing-indexes`
(recorded + indexes created) or `conflict` (STOP - nothing is changed).

## 3. Reconciliation apply (authorized database change)
```
TARGET_DATABASE_URL="<production DATABASE_PUBLIC_URL>" node scripts/release/reconcile-migrations.mjs --apply --backup-manifest <dump>.manifest.json
```
Refuses to run without a verified manifest for this exact database created in the last 24 hours.
Records history, creates missing indexes, runs `prisma migrate deploy` (additive migrations only),
then requires zero schema drift. The currently running API keeps working: all migrations are additive.

## 4. Deploy the release (authorized)
From a clean export of the release commit (so no local data, reports or node_modules are uploaded):
```
git archive --format=tar release/autonomous-qe | tar -x -C <empty-dir>
cd <empty-dir>
railway up --service <api-service> --detach      # root Dockerfile; CMD runs `prisma migrate deploy` (no-op after step 3)
railway up --service <web-service> --detach      # apps/web/Dockerfile (VITE_* build args from the service)
```
Production variables to confirm on the API service before deploying:
- `TM_EVAL_SERVICE_URL` and `TM_EVAL_SERVICE_API_KEY`: both set or both unset (the boot check fails closed otherwise).
- `TM_APP_CODE_FIX_ENABLED`: leave unset/false (autonomous application-code fixes stay disabled).
- `TM_AUTONOMOUS_QA_ENABLED=1` only if Autonomous QE should be available in production.

## 5. Verify
- `railway logs --service <api-service>`: `prisma migrate deploy` reports no pending migrations; API listening.
- `GET https://<api-host>/health` returns 200; the web app loads and signs in.

## Rollback
- Code: redeploy the previous Railway deployment (Railway dashboard -> Deployments -> previous -> Redeploy).
  The previous code runs against the reconciled schema because every applied migration is additive.
- Data (last resort): restore the step-1 dump into a new, empty Postgres database and point `DATABASE_URL` to it.
