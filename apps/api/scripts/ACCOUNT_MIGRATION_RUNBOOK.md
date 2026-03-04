# Account Ownership Backfill (Prod-Safe)

This runbook migrates ownership from old user IDs to canonical user IDs in Postgres.
It is safe for environments with persistent volumes because it only updates database rows.

## What it updates

- `Project.ownerId`
- `AgentSession.userId`
- `JiraIntegration.userId` (dedupes on `[userId, projectId]`)
- `TestCaseRun.userId`
- `GitAccount.userId` (dedupes on `[provider, userId]`)
- Copies `User.plan` from source to target when target has no plan.

It does **not** touch runner artifacts/files on disk.

## Script

`apps/api/scripts/migrate-user-ownership-safe.ts`

- Defaults to **dry-run**.
- Use `--apply` to write changes.
- Source users are **not deleted** unless `--delete-sources` is passed.
- Idempotent for repeat runs.

## Usage

Single mapping dry-run:

```bash
pnpm --filter api exec tsx scripts/migrate-user-ownership-safe.ts \
  --from user_old --to user_new
```

Multiple mappings dry-run:

```bash
pnpm --filter api exec tsx scripts/migrate-user-ownership-safe.ts \
  --map user_old1:user_new1,user_old2:user_new2
```

Apply changes:

```bash
pnpm --filter api exec tsx scripts/migrate-user-ownership-safe.ts \
  --map user_old1:user_new1,user_old2:user_new2 \
  --apply
```

Apply + delete source users after successful move:

```bash
pnpm --filter api exec tsx scripts/migrate-user-ownership-safe.ts \
  --map user_old1:user_new1,user_old2:user_new2 \
  --apply --delete-sources
```

## Verification SQL (run before/after)

Per-user ownership counts:

```sql
select 'project' as table, owner_id as user_id, count(*) as n
from "Project"
group by owner_id
union all
select 'agent_session' as table, user_id, count(*) as n
from "AgentSession"
group by user_id
union all
select 'jira_integration' as table, user_id, count(*) as n
from "JiraIntegration"
group by user_id
union all
select 'test_case_run' as table, user_id, count(*) as n
from "TestCaseRun"
where user_id is not null
group by user_id
union all
select 'git_account' as table, user_id, count(*) as n
from "GitAccount"
group by user_id
order by table, user_id;
```

Cross-account integrity check (project-linked rows must match project owner):

```sql
select count(*) as mismatched_agent_sessions
from "AgentSession" s
join "Project" p on p.id = s.project_id
where s.user_id <> p.owner_id;

select count(*) as mismatched_jira_integrations
from "JiraIntegration" j
join "Project" p on p.id = j.project_id
where j.user_id <> p.owner_id;
```

## Prod execution notes

- Run as a one-off job/console command in the API environment with the same `DATABASE_URL`.
- Keep API deployed with compatibility logic while backfill runs.
- Start with dry-run, save JSON output, then run apply.
- Verify with SQL, then decide on `--delete-sources`.
