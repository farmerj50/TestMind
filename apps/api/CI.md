# TestMind API CI entrypoint

Use the lightweight CLI to enqueue a run without starting the HTTP server.

```bash
# From repo root
pnpm --filter api ci:run --projectId=<PROJECT_ID> [--headful=true|false] [--grep=\"pattern\"] [--file=\"specRelPath\"]
```

You can also pass the project via env:

```bash
TM_PROJECT_ID=<PROJECT_ID> pnpm --filter api ci:run
```

Outputs JSON:

```json
{
  "runId": "cmxxxxxxxxxxxxx",
  "projectId": "project-id",
  "headful": false,
  "grep": null,
  "file": null
}
```

Notes:
- Respects `START_WORKERS` to decide if the in-process workers should run.
- Uses the same queue/worker flow as the API, so logs/reports land under `apps/api/runner-logs/<runId>/`.
- --file should be relative to the repo root; it is normalized inside the temp workspace.
- Set TM_MULTI_FRAMEWORK=true to allow non-Playwright (jest/vitest) detection; default is Playwright-only.
