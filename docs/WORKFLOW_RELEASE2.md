# Release 2 — Python Automation

Scope is from the original approved Unified Workflow Builder request, sections 6
and 11: Python execution, pytest integration, dataset handling, sandboxing, and
normalized reporting. AI/RAG/Chroma is Release 3; production automation is Release 4.

Implementation tasks (tasks 1–3 and the Python Script node are complete locally):

1. Normalize parsed pytest cases and process outcomes into existing quality gates.
2. Parse bounded JUnit XML and provide isolated pytest execution, as explicitly
   added to Task 2: pinned dependencies, enforced resource/time limits, no network
   or host mounts, verified cancellation and private results.
3. Python Script adapter and declared scoped inputs using the existing sandbox;
   secret bindings and host environment forwarding remain unsupported.
4. Separate Python Script/pytest Suite nodes using existing orchestration, approval,
   reporting and repository support; preserve fixtures, parametrization and selection.
   Python Script is complete; pytest Suite node integration remains pending.
5. Bounded dataset handling, then the Release 2 acceptance/regression gate.

Task 1 does not execute Python, parse XML, register runnable nodes or expose artifacts.
It reuses `ParsedCase`, `TestEvidence`, `assessTestEvidence`, and the existing test
harness. Collection errors require explicit evidence; process exit 2 alone is
inconclusive. Missing/invalid reports, unexpected skips and verification failures
cannot pass. Diagnostic strings remain private pending existing artifact controls.

Task 1 verification:
- `node --test --test-reporter=dot tests/workflows/pytest-results.test.mjs`: 19 passed.
- `pnpm.cmd --filter api exec tsc --noEmit`: passed.
- One test cycle; no failed checks or current task blockers. Release 1 suites were
  not rerun. No runtime, security, production configuration or deployment changes.

Files added: `apps/api/src/runner/pytest-results.ts`,
`tests/workflows/pytest-results.test.mjs`, and this report.

## Task 2 — verified locally, 2026-11-09

- Strict SAX XML parser rejects malformed XML, DTD/entities, unsupported structures,
  inconsistent counts, ambiguous duplicate cases and excessive size/depth/node counts.
  Limit: 2 MiB / 10,000 cases. Failures, collection/setup/teardown errors and skips
  reuse existing evidence gates. Empty results cannot pass; parser errors omit XML.
- Immutable local Docker image, pinned Python base digest and pytest dependencies.
  Linux/cgroup v2/seccomp required. Inspect actual configuration and run a trusted
  in-container preflight before sending code; failure grants no execution permit.
- Non-root, capabilities dropped, no-new-privileges, read-only root, no host mounts,
  no network, no host environment forwarding, no persistent Docker logs. Limits:
  0.5 CPU, 256 MiB memory/no swap, 32 processes, 64 MiB work + 16 MiB temp,
  4 MiB file size, 128 descriptors, maximum 30 seconds per execution.
- Timeout kills the test process group; cancellation removes the owned container.
  Container removal is verified before returning any terminal result, including
  success. No automatic retries. Raw logs/XML stay ephemeral; private normalized
  diagnostics do not create any new artifact route or bypass existing controls.
- No workflow nodes, API endpoints, production enablement, datasets or configuration
  changes. Docker shares its Linux kernel: this is container isolation, not a VM.
  Only the local Linux Docker/cgroup-v2 profile was verified; unavailable or different
  isolation fails closed. Secret injection and custom dependency installation at
  execution time are not supported by this task.

One verification cycle, no repairs or repeated passing tests:

- `node --test tests/workflows/pytest-junit.test.mjs tests/workflows/pytest-sandbox.test.mjs`:
  **13 passed**, zero failed/skipped.
- `pnpm.cmd --filter api exec tsx --test ../../tests/workflows/pytest-sandbox-live.test.mjs`:
  **6 passed**, including eight actual pytest isolation assertions, real collection
  failure, timeout, cancellation of active pytest plus a detached child, rejected
  inputs and pre-cancellation. CPU throttling, OOM kill and process-limit enforcement
  were observed. No owned containers remained after any scenario.
- `pnpm.cmd --filter api exec tsc --noEmit`: **passed**.
- Build: `docker build --tag testmind/pytest-r2-task2:local apps/api/src/runner/python-sandbox`.
  Verified image: `sha256:9391206fec46b10b105b8f26bcf74ded2d29b79e8b7477adff0c2d7a92acc646`.
  Local evidence: `tests/workflows/.scratch/pytest-task2-{unit,live,types}.log`.

Files: `pytest-junit.ts`, `pytest-sandbox.ts`, `python-sandbox/{Dockerfile,.dockerignore,supervisor.py}`
under `apps/api/src/runner`; three corresponding Task 2 test files under
`tests/workflows`; pinned `saxes` dependency in API package/lockfile; `.gitignore`
exception for the supervisor; this report. No Release 1 runtime files changed.

Task blockers: none for this local profile. Next: the Python Script execution adapter
and scoped inputs, followed by separately authorized workflow-node integration.
Design references: [Docker execution controls](https://docs.docker.com/engine/containers/run/)
and [pytest JUnit output](https://docs.pytest.org/en/stable/how-to/output.html).

## Task 3 — Python Script adapter, verified locally

- Scripts implement synchronous `main(inputs)` and return bounded JSON. A fixed
  pytest wrapper uses the existing verified sandbox/image and JUnit normalizer;
  no second execution engine or sandbox change. Structured JUnit properties carry
  output and distinguish script assertions from execution errors.
- Reuses server-supplied `NodeAuthorization`, autonomy checks, workflow output and
  evidence contracts. Authorization is rechecked before execution and before data
  returns. Deadlines, timeout and cancellation cannot produce passing evidence.
- Only declared string/number/boolean/JSON inputs: 32 declarations, 64 KiB per
  value, 128 KiB aggregate, 16 nesting levels. Optional text/JSON files are confined
  to `inputs/`. Traversal, undeclared values, incompatible types, secret bindings,
  sensitive values, unsafe keys, cycles and serialization hooks are rejected.
  Each invocation gets copied inputs and a fresh container. Script limit: 128 KiB;
  structured output limit: 64 KiB. Raw diagnostics and metadata are withheld.
- No registry nodes, routes, datasets, production enablement or Release 1 runtime
  changes. Secret injection remains unsupported. The future workflow-node adapter
  must supply authorization from trusted server policy, never client fields.

Verification (two cycles; no full regression):

1. `node --test tests/workflows/python-script.test.mjs`: **10 passed**.
2. `pnpm.cmd --filter api exec tsx --test ../../tests/workflows/python-script-live.test.mjs`:
   **7 passed**. Actual script/JUnit integration, concurrent input/file isolation,
   host/network exclusion, assertions/errors, sensitive-output blocking, timeout,
   active cancellation with a detached child, and unverified-permit rejection.
   All owned containers were removed before terminal results returned.
3. Review identified inherited `toJSON` hooks; fixed descriptor-based rejection.
   `node --test --test-name-pattern='^inputs:' tests/workflows/python-script.test.mjs`:
   **4 affected tests passed**, including non-invocation of inherited getters/hooks.
4. `pnpm.cmd --filter api exec tsc --noEmit`: **passed**, including after that fix.

Evidence: `tests/workflows/.scratch/python-task3-{unit,live,input-retest,types-final}.log`.
Files: added `python-inputs.ts`, `python-script.ts` under `apps/api/src/runner`;
extended `pytest-results.ts`/`pytest-junit.ts`; added two `python-script*.test.mjs`
files under `tests/workflows`; updated this report. No dependency/image changes.
Blockers: none for the verified local profile. Next: separately authorized Python
and pytest workflow-node integration; datasets remain deferred.

## Task 4 — Python Script workflow node, verified locally

- Registered `python.script` with declared inputs, JSON `values` binding, `data`
  and normalized `result` outputs. The existing editor adds multiline script
  editing, declarations, input bindings, timeout, and save/reopen support.
- Existing graph worker dispatches to the verified adapter/sandbox. Server-side
  ownership, protected-environment approvals, environment fingerprint, pinned
  version and duration are rechecked; authorization monitoring stops revoked work.
  Python evidence participates in existing report/quality gates and run history.
- Disabled unless worker setting `TM_PYTHON_WORKFLOWS_ENABLED=1` and
  `TM_PYTHON_SANDBOX_IMAGE=sha256:<64 lowercase hex digits>` are supplied. Every
  invocation verifies the image's isolation before accepting code. No settings
  were enabled in application/production configuration; tests use isolated settings.
- Explicit retry uses existing atomic retry/dispatch controls. The node is
  idempotent because its verified sandbox has no network or host mounts. Unknown
  interrupted outcomes, completed downstream work, foreign users and exhausted
  limits retain existing retry restrictions. No automatic script recovery added.
- All project secrets are included when redacting Python task inputs before public
  persistence. Python execution/version projections also scrub known project values;
  raw sandbox files, XML and diagnostics gain no download route.

One targeted cycle; no implementation repairs or full regression:

- `node --test tests/workflows/python-node.test.mjs`: **5 passed**.
- `pnpm.cmd --filter api exec tsx --test ../../tests/workflows/python-node-live.test.mjs`:
  **5 passed**. Real graph runner/handlers/routes and Docker; persistence, queue and
  request identity use isolated adapters. Verified successful output binding and
  reporting, assertions, timeout, active cancellation with a detached subprocess,
  and retry after a disabled-execution failure. Concurrent retry requests dispatched
  once, both attempts remained visible, and subsequent delivery did not rerun code.
  Unavailable images and secret-bearing inputs failed closed; containers were removed.
- `node tests/workflows/python-node-editor.mjs`: **passed** in Chromium using the
  existing editor fixture (add/configure/bind/save/reopen; secret binding unavailable).
- `pnpm.cmd --filter api exec tsc --noEmit`: **passed**.
- `pnpm.cmd -C apps/web exec tsc --noEmit`: **passed**. Initial `--filter web`
  matched no package and was not counted as verification. Existing Browserslist and
  isolated-fixture Tailwind warnings did not fail the editor check.

Files: `packages/testmind-core/workflow/registry.js`; API runner
`python-node.ts`, `workflow-handlers.ts`, `workflow-engine.ts`, `workflow-runner.ts`;
`routes/workflowGraphs.ts`; web `graph-model.ts`, `WorkflowEditor.tsx`;
four `tests/workflows/python-node*` fixture/test files; this report.
Evidence: `tests/workflows/.scratch/python-task4-{unit,live,editor,api-types,web-types}.log`.
Blockers: none for the verified local scope. Next: pytest Suite workflow-node
integration, pending authorization. No datasets, production enablement or deployment.
